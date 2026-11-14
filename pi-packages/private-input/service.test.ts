import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue, PiWebHostPiSessionEventsV1, PluginSessionStateV1, ServerPluginPeerRequestContextV5 } from "@jmfederico/pi-web/server-plugin-api";
import { PrivateInputService } from "./service.js";
import { CHECK_EVENT, NOTIFY_EVENT, REPLY_EVENT, type PrivateInputRecord } from "./protocol.js";
import type { WriteOutcome } from "./destination.js";

function fixture() {
  const record: PrivateInputRecord = { requestId: randomUUID(), sessionId: "session", destination: "/confirmed/key", purpose: "API key", status: "waiting" };
  let value: JsonValue = { ...record };
  let revision = "initial";
  const persisted: JsonValue[] = [];
  const messages: unknown[] = [];
  let ready = true;
  let delivered = true;
  const state: PluginSessionStateV1 = {
    version: 1,
    read: () => Promise.resolve({ value, revision }),
    write: (_target, _namespace, input) => {
      if (input.revision !== revision) return Promise.reject(new Error("conflict"));
      value = input.value; persisted.push(value); revision = randomUUID();
      return Promise.resolve({ value, revision });
    },
  };
  const events: PiWebHostPiSessionEventsV1 = {
    version: 1,
    connect: () => {
      const listeners = new Map<string, (data: unknown) => void | Promise<void>>();
      return Promise.resolve({
        signal: new AbortController().signal,
        on: (channel, handler) => { listeners.set(channel, handler); return () => { listeners.delete(channel); }; },
        emit: (channel, data) => {
          messages.push({ channel, data });
          if (typeof data !== "object" || data === null || !("nonce" in data)) throw new Error("bad test request");
          void listeners.get(REPLY_EVENT)?.({ nonce: data.nonce, accepted: channel === CHECK_EVENT ? ready : delivered });
        },
        close: () => { listeners.clear(); },
      });
    },
  };
  const writer = vi.fn((): Promise<WriteOutcome> => Promise.resolve({ status: "saved" }));
  const lifetime = new AbortController();
  const service = new PrivateInputService(state, events, lifetime.signal, writer);
  function request(operation: string, extra: Record<string, JsonValue> = {}, signal = new AbortController().signal) {
    const scope: ServerPluginPeerRequestContextV5["scope"] = {
      kind: "workspace", project: { id: "project", path: "/project", name: "Project" },
      workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true },
    };
    return service.request({ operation, scope, input: { sessionId: record.sessionId, requestId: record.requestId, ...extra }, signal });
  }
  const submit = { confirmedDestination: record.destination, secret: "FAKE-SENTINEL-secret" };
  return { record, request, submit, writer, messages, persisted, state, lifetime,
    replace: (next: JsonValue) => { value = next; },
    ready: (next: boolean) => { ready = next; }, delivered: (next: boolean) => { delivered = next; },
  };
}

describe("private input service", () => {
  it("persists only non-secret admission/outcome and notifies only after a successful write", async () => {
    const f = fixture();
    let finish!: (result: WriteOutcome) => void;
    f.writer.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.request("submit", f.submit);
    await vi.waitFor(() => { expect(f.writer).toHaveBeenCalledOnce(); });
    expect(f.messages).toHaveLength(1);
    expect(f.persisted).toEqual([{ ...f.record, status: "writing" }]);
    expect(await f.request("cancel")).toMatchObject({ active: true });
    finish({ status: "saved" });
    expect(await pending).toMatchObject({ record: { status: "saved" }, delivered: true });
    expect(f.persisted.at(-1)).toMatchObject({ status: "saved" });
    expect(f.messages.at(-1)).toMatchObject({ channel: NOTIFY_EVENT });
    expect(JSON.stringify([f.persisted, f.messages])).not.toContain(f.submit.secret);
    await f.request("submit", { ...f.submit, secret: "different" });
    expect(f.writer).toHaveBeenCalledOnce();
  });

  it("cancels without writing and distinguishes filesystem failure from success", async () => {
    const cancelled = fixture();
    expect(await cancelled.request("cancel")).toMatchObject({ record: { status: "cancelled" } });
    expect(cancelled.writer).not.toHaveBeenCalled();
    const failed = fixture();
    failed.writer.mockResolvedValue({ status: "failed", failure: "exists" });
    expect(await failed.request("submit", failed.submit)).toMatchObject({ record: { status: "failed", failure: "exists" } });
    expect(failed.messages.at(-1)).toMatchObject({ channel: NOTIFY_EVENT });
  });

  it("requires destination confirmation and a ready companion before admitting any write", async () => {
    const f = fixture();
    await expect(f.request("submit", { ...f.submit, confirmedDestination: "/elsewhere" })).rejects.toThrow("could not be confirmed");
    await expect(f.request("submit", { ...f.submit, secret: "x".repeat(65537) })).rejects.toThrow("could not be confirmed");
    f.ready(false);
    expect(await f.request("submit", f.submit)).toMatchObject({ unavailable: true });
    expect(f.writer).not.toHaveBeenCalled();
    expect(f.persisted).toEqual([]);
  });

  it("finishes admitted writes after browser disconnect, retaining an outcome for notification retry", async () => {
    const f = fixture();
    const browser = new AbortController();
    f.delivered(false);
    f.writer.mockImplementation(() => { browser.abort(); return Promise.resolve({ status: "saved" }); });
    expect(await f.request("submit", f.submit, browser.signal)).toMatchObject({ record: { status: "saved" }, delivered: false });
    f.delivered(true);
    expect(await f.request("notify")).toMatchObject({ record: { status: "saved" }, delivered: true });
    expect(f.writer).toHaveBeenCalledOnce();
  });

  it("recovers interrupted admissions as uncertain instead of replaying the write", async () => {
    const f = fixture();
    f.replace({ ...f.record, status: "writing" });
    expect(await f.request("status")).toMatchObject({ record: { status: "writing" }, active: false });
    expect(await f.request("notify")).toMatchObject({ record: { status: "failed", failure: "write_uncertain" } });
    expect(f.writer).not.toHaveBeenCalled();
  });

  it("does not leak raw writer/host failures, including errors containing the submitted value", async () => {
    const f = fixture();
    f.writer.mockRejectedValue(new Error(f.submit.secret));
    const result = await f.request("submit", f.submit);
    expect(result).toMatchObject({ record: { status: "failed", failure: "write_uncertain" } });
    expect(JSON.stringify([result, f.persisted, f.messages])).not.toContain(f.submit.secret);
    vi.spyOn(f.state, "read").mockRejectedValue(new Error(f.submit.secret));
    await expect(f.request("submit", f.submit)).rejects.toThrow(/^Private input operation could not be confirmed\./u);
  });

  it("rejects state belonging to another session and shutdown without writing", async () => {
    const f = fixture();
    f.replace({ ...f.record, sessionId: "other" });
    await expect(f.request("submit", f.submit)).rejects.toThrow("could not be confirmed");
    f.lifetime.abort();
    await expect(f.request("submit", f.submit)).rejects.toThrow("could not be confirmed");
    expect(f.writer).not.toHaveBeenCalled();
  });
});
