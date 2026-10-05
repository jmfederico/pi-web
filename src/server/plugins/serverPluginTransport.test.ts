import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MachineClient, MachineHttpResponse } from "../machines/machineClient.js";
import { PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS, PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES } from "../../shared/pluginBackendProtocol.js";
import { createServerPluginTransport } from "./serverPluginTransport.js";

function fixture(response: MachineHttpResponse = { statusCode: 200, headers: {}, body: Readable.from(['{"ok":true}']) }) {
  const lifetime = new AbortController();
  const request = vi.fn<MachineClient["request"]>(() => Promise.resolve(response));
  const remoteClient = vi.fn((machineId: string) => Promise.resolve(machineId === "registered" ? {
    request,
    requestJson: vi.fn<MachineClient["requestJson"]>(),
    connectWebSocket: vi.fn<MachineClient["connectWebSocket"]>(),
  } : undefined));
  const transport = createServerPluginTransport({ pluginId: "fixture", packageRoot: "/package", lifetimeSignal: lifetime.signal }, { remoteClient });
  return { transport, request, remoteClient, lifetime };
}

const input = { machineId: "registered", operation: "echo", input: { text: "hello" }, signal: new AbortController().signal };

afterEach(() => { vi.useRealTimers(); });

describe("server plugin transport", () => {
  it("uses the registered host client and captured plugin identity, cloning input before I/O", async () => {
    const f = fixture();
    const mutableInput = { text: "original" };
    const pending = f.transport.request({ ...input, input: mutableInput });
    mutableInput.text = "changed";
    await expect(pending).resolves.toEqual({ ok: true });
    expect(f.remoteClient).toHaveBeenCalledWith("registered");
    expect(f.request.mock.calls[0]?.slice(0, 3)).toEqual(["POST", "/api/plugin-backends/fixture/echo", { version: 1, input: { text: "original" } }]);
    expect(f.request.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    expect(Object.isFrozen(f.transport)).toBe(true);
  });

  it("rejects unknown machines and never sends invalid JSON, operation, or local target", async () => {
    const f = fixture();
    await expect(f.transport.request({ ...input, machineId: "unknown" })).rejects.toThrow("Registered machine not found");
    await expect(f.transport.request({ ...input, input: Number.NaN })).rejects.toThrow("finite JSON numbers");
    await expect(f.transport.request({ ...input, operation: "../escape" })).rejects.toThrow("Plugin backend operation");
    await expect(f.transport.request({ ...input, machineId: "local" })).rejects.toThrow("remote machine id");
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    { statusCode: 409, body: '{"error":"Plugin inactive"}', error: "HTTP 409: Plugin inactive" },
    { statusCode: 404, body: '{"error":"Not Found"}', error: "HTTP 404: Not Found" },
    { statusCode: 200, body: "not json", error: "must be valid JSON" },
  ])("reports upstream failure without retry or fallback: $error", async ({ statusCode, body, error }) => {
    const f = fixture({ statusCode, headers: {}, body: Readable.from([body]) });
    await expect(f.transport.request(input)).rejects.toThrow(error);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("bounds streamed response bytes", async () => {
    const body = Readable.from([Buffer.alloc(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES + 1)]);
    const f = fixture({ statusCode: 200, headers: {}, body });
    await expect(f.transport.request(input)).rejects.toThrow("byte limit");
    expect(body.destroyed).toBe(true);
  });

  it.each(["caller", "lifetime", "deadline"] as const)("cancels pending response consumption on %s", async (source) => {
    vi.useFakeTimers();
    const body = new PassThrough();
    const f = fixture({ statusCode: 200, headers: {}, body });
    const caller = new AbortController();
    const pending = f.transport.request({ ...input, signal: caller.signal });
    const failure = expect(pending).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    if (source === "caller") caller.abort();
    else if (source === "lifetime") f.lifetime.abort();
    else await vi.advanceTimersByTimeAsync(PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS);
    await failure;
    expect(body.destroyed).toBe(true);
  });

  it("revokes retained facades on plugin lifetime cancellation before connecting", async () => {
    const f = fixture();
    f.lifetime.abort(new Error("plugin stopped"));
    await expect(f.transport.request(input)).rejects.toThrow("plugin stopped");
    expect(f.remoteClient).not.toHaveBeenCalled();
  });
});
