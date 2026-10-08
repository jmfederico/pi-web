import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createCompanionBackend, type ServerPluginBackend } from "../../server-plugin-api.js";
import { PluginBackendRegistry } from "../plugins/pluginBackendRegistry.js";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";

function fixture() {
  const request = vi.fn<ServerPluginBackend["request"]>(
    ({ input }) => input,
  );
  const registry = new PluginBackendRegistry({
    contributions: [], machineContributions: [{ pluginId: "example.transport", backend: { request } }],
    workspaces: { resolve: () => { throw new Error("Machine requests must not resolve workspaces"); } },
  });
  const sessions = new PiSessionEventConnections(registry);
  const session = {}, bus = createEventBus();
  sessions.register(session, bus);
  return { request, registry, sessions, session, bus, backend: createCompanionBackend(bus, "example.transport") };
}

describe("hosted companion current-machine backend", () => {
  it("dispatches frozen JSON to the requested package without project, workspace or remote routing", async () => {
    const f = fixture();
    try {
      const input = { text: "hello" };
      expect(await f.backend.request("echo", input)).toEqual(input);
      const received = f.request.mock.calls[0]?.[0];
      expect(received).toMatchObject({ operation: "echo", input });
      expect(Object.keys(received ?? {}).sort()).toEqual(["input", "operation", "signal"]);
      expect(Object.isFrozen(received?.input)).toBe(true);
      expect(received?.input).not.toBe(input);
      expect(Object.isFrozen(f.backend)).toBe(true);
      await expect(createCompanionBackend(f.bus, "missing").request("echo", null)).rejects.toMatchObject({ code: "inactive-plugin" });
      await expect(f.backend.request("Invalid/operation", null)).rejects.toMatchObject({ code: "invalid-operation" });
      await expect(f.backend.request("echo", { bad: NaN })).rejects.toMatchObject({ code: "invalid-input" });
      expect(f.request).toHaveBeenCalledOnce();
    } finally { f.sessions.close(f.session); await f.registry.closeAll(); }
  });

  it("propagates caller cancellation and revokes retained services at native runtime replacement", async () => {
    const f = fixture();
    f.request.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error("Request aborted"));
      }, { once: true });
    }));
    try {
      const controller = new AbortController();
      const pending = f.backend.request("wait", null, { signal: controller.signal });
      await vi.waitFor(() => { expect(f.request).toHaveBeenCalledOnce(); });
      controller.abort(new Error("Tool cancelled"));
      await expect(pending).rejects.toMatchObject({ code: "request-cancelled" });
      const replaced = f.backend.request("wait", null);
      await vi.waitFor(() => { expect(f.request).toHaveBeenCalledTimes(2); });
      const nextBus = createEventBus();
      f.sessions.register(f.session, nextBus);
      await expect(replaced).rejects.toMatchObject({ code: "request-cancelled" });
      await expect(f.backend.request("echo", null)).rejects.toThrow("lifetime ended");
      expect(() => createCompanionBackend(f.bus, "example.transport")).toThrow("unavailable");
      f.request.mockImplementation(({ input }) => input);
      expect(await createCompanionBackend(nextBus, "example.transport").request("echo", "next")).toBe("next");
    } finally { f.sessions.close(f.session); await f.registry.closeAll(); }
  });

  it("fails immediately in unhosted sessions and on invalid package identity, without opening networking", async () => {
    const f = fixture();
    try {
      expect(() => createCompanionBackend(createEventBus(), "example.transport")).toThrow("hosted session");
      expect(() => createCompanionBackend(f.bus, "invalid/id")).toThrow("unavailable");
      expect(f.request).not.toHaveBeenCalled();
    } finally { f.sessions.close(f.session); await f.registry.closeAll(); }
  });
});
