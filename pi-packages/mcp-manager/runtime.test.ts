import type { ExtensionAPI, ExtensionContext, ExtensionEvent, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createManagedMcpController, createManagedMcpExtension, type ManagedMcpControllerOptions, type ManagedMcpSnapshot } from "./runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: ManagedMcpControllerOptions = {}) {
  const controller = createManagedMcpController(options);
  const handlers = new Map<string, (event: ExtensionEvent, ctx: ExtensionContext) => unknown>();
  const registrations = new Map<string, ReturnType<ExtensionAPI["getMcpServers"]>[number]>();
  let idle = true;
  const notify = vi.fn();
  // The fake supplies only the public extension lifecycle and registration boundary used here.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const ctx = { isIdle: () => idle, isProjectTrusted: () => false, hasUI: true, ui: { notify } } as unknown as ExtensionContext;
  const register = vi.fn((name: string, config: McpServerConfig) => {
    registrations.set(name, { name, config, extensionPath: "managed" });
  });
  const unregister = vi.fn((name: string) => { registrations.delete(name); });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const pi = {
    on: (name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); },
    registerMcpServer: register, unregisterMcpServer: unregister,
    getMcpServers: () => [...registrations.values()],
  } as unknown as ExtensionAPI;
  async function load() {
    handlers.clear();
    const extension = createManagedMcpExtension(controller);
    await (typeof extension === "function" ? extension : extension.factory)(pi);
  }
  await load();
  return {
    controller, registrations, register, unregister, notify, ctx, load,
    setIdle: (value: boolean) => { idle = value; },
    // These notification handlers read no event payload; the SDK integration covers dispatch.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    emit: async (type: ExtensionEvent["type"]) => { await handlers.get(type)?.({ type } as ExtensionEvent, ctx); },
  };
}

const server = (url = "https://example.test/mcp"): McpServerConfig => ({ url });
const snapshot = (definitions: Record<string, McpServerConfig>, enabled?: Record<string, boolean>): ManagedMcpSnapshot => ({ definitions, ...(enabled ? { enabled } : {}) });

describe("managed MCP runtime", () => {
  it("registers before prompts, preserves OAuth names, and exposes only intent", async () => {
    const f = await fixture();
    const definitions = { "team-docs": { ...server(), oauth: { clientSecret: "secret" }, headers: { Authorization: "secret" } } };
    expect(f.controller.apply(snapshot(definitions)).pending).toBe(true);
    expect(f.register).not.toHaveBeenCalled();
    await f.emit("session_start");
    expect(f.register).toHaveBeenCalledWith("team-docs", { ...definitions["team-docs"], enabled: true });
    expect(f.controller.getState()).toEqual({
      bound: true, pending: false, errors: [],
      servers: [{ name: "team-docs", configured: true, enabled: true, registered: true, registeredEnabled: true, pending: false }],
    });
    expect(JSON.stringify(f.controller.getState())).not.toContain("secret");
  });

  it("applies idle changes, retains disabled definitions, and unregisters only removed owned servers", async () => {
    const f = await fixture();
    f.controller.apply(snapshot({ docs: server(), removed: server() }));
    await f.emit("session_start");
    f.register.mockClear();
    f.controller.apply(snapshot({ docs: server(), removed: server() }));
    expect(f.register).not.toHaveBeenCalled();
    f.controller.apply(snapshot({ docs: server() }, { docs: false }));
    expect(f.unregister).toHaveBeenCalledExactlyOnceWith("removed");
    expect(f.register).toHaveBeenCalledExactlyOnceWith("docs", { ...server(), enabled: false });
    expect(f.controller.getState().pending).toBe(false);
  });

  it("coalesces busy updates until final settlement, not agent_end", async () => {
    const f = await fixture();
    f.controller.apply(snapshot({ docs: server() }));
    await f.emit("session_start");
    f.register.mockClear();
    f.setIdle(false);
    f.controller.apply(snapshot({ docs: server("https://first.test") }));
    f.controller.apply(snapshot({ final: server() }));
    expect(f.controller.getState().pending).toBe(true);
    await f.emit("agent_end");
    expect(f.register).not.toHaveBeenCalled();
    expect(f.unregister).not.toHaveBeenCalled();
    f.setIdle(true);
    await f.emit("agent_settled");
    expect([...f.registrations.keys()]).toEqual(["final"]);
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.controller.getState().pending).toBe(false);
  });

  it.each(["team_docs", "team-docs"])("does not take over another extension's %s registration", async (foreignName) => {
    const f = await fixture();
    f.registrations.set(foreignName, { name: foreignName, config: server(), extensionPath: "other" });
    f.controller.apply(snapshot({ "team-docs": server() }));
    await f.emit("session_start");
    expect(f.register).not.toHaveBeenCalled();
    expect(f.controller.getState().errors).toMatchObject([{ code: "name_conflict", name: "team-docs" }]);
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.controller.apply(snapshot({}));
    expect(f.unregister).not.toHaveBeenCalled();
    expect(f.registrations.has(foreignName)).toBe(true);
  });

  it("resolves with the public trust context on startup, before a run, and reload", async () => {
    const resolve = vi.fn((ctx: ExtensionContext) => snapshot(ctx.isProjectTrusted() ? { project: server() } : { global: server() }));
    const f = await fixture({ resolve });
    await f.emit("session_start");
    expect([...f.registrations.keys()]).toEqual(["global"]);
    f.setIdle(false); // Pi marks startup busy before this hook.
    await f.emit("before_agent_start");
    expect(resolve).toHaveBeenCalledTimes(2);
    await f.emit("session_shutdown");
    f.registrations.clear(); // The native runtime owns registry teardown.
    expect(f.controller.getState().bound).toBe(false);
    await f.load();
    f.setIdle(true);
    await f.emit("session_start");
    expect(resolve).toHaveBeenCalledTimes(3);
    expect([...f.registrations.keys()]).toEqual(["global"]);
  });

  it("withdraws registrations on resolver failure and never publishes exception secrets", async () => {
    let fail = false;
    const onError = vi.fn();
    const f = await fixture({ resolve: () => {
      if (fail) throw new Error("Authorization: secret");
      return snapshot({ docs: server() });
    }, onError });
    await f.emit("session_start");
    fail = true;
    await f.controller.refresh();
    expect(f.registrations.size).toBe(0);
    expect(f.controller.getState().errors).toMatchObject([{ code: "resolve_failed" }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([f.controller.getState(), onError.mock.calls, f.notify.mock.calls])).not.toContain("secret");
    fail = false;
    await f.controller.refresh();
    expect(f.controller.getState().errors).toEqual([]);
    expect(f.registrations.has("docs")).toBe(true);
  });

  it("reports registration/removal failures and retries pending intent", async () => {
    const f = await fixture();
    await f.emit("session_start");
    f.register.mockImplementationOnce(() => { throw new Error("secret"); });
    expect(f.controller.apply(snapshot({ docs: server() }))).toMatchObject({ pending: true, errors: [{ code: "register_failed" }] });
    await f.controller.refresh();
    f.unregister.mockImplementationOnce(() => { throw new Error("secret"); });
    expect(f.controller.apply(snapshot({}))).toMatchObject({ pending: true, errors: [{ code: "unregister_failed" }] });
    await f.controller.refresh();
    expect(f.controller.getState()).toMatchObject({ pending: false, errors: [], servers: [] });
    expect(JSON.stringify(f.notify.mock.calls)).not.toContain("secret");
  });

  it("defers an idle refresh that finishes during a run, and lets newer apply win", async () => {
    const next = deferred<ManagedMcpSnapshot>();
    const resolve = vi.fn<NonNullable<ManagedMcpControllerOptions["resolve"]>>().mockReturnValueOnce(snapshot({ docs: server() })).mockReturnValue(next.promise);
    const f = await fixture({ resolve });
    await f.emit("session_start");
    const refreshing = f.controller.refresh();
    f.setIdle(false);
    f.controller.apply(snapshot({ newer: server() }));
    next.resolve(snapshot({ stale: server() }));
    await refreshing;
    expect([...f.registrations.keys()]).toEqual(["docs"]);
    f.setIdle(true);
    await f.emit("agent_settled");
    expect([...f.registrations.keys()]).toEqual(["newer"]);
  });

  it("registers a newer apply before startup returns even when its resolver is stale", async () => {
    const initial = deferred<ManagedMcpSnapshot>();
    const f = await fixture({ resolve: () => initial.promise });
    const starting = f.emit("session_start");
    f.controller.apply(snapshot({ newer: server() }));
    initial.resolve(snapshot({ stale: server() }));
    await starting;
    expect([...f.registrations.keys()]).toEqual(["newer"]);
    expect(f.controller.getState().pending).toBe(false);
  });

  it("queues busy refreshes without resolving configuration until settled", async () => {
    const resolve = vi.fn(() => snapshot({ docs: server() }));
    const f = await fixture({ resolve });
    await f.emit("session_start");
    f.setIdle(false);
    await f.controller.refresh();
    await f.controller.refresh();
    expect(f.controller.getState().pending).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    f.setIdle(true);
    await f.emit("agent_settled");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(f.controller.getState().pending).toBe(false);
  });

  it("does not let a pre-shutdown resolver write into a replacement runtime", async () => {
    const old = deferred<ManagedMcpSnapshot>();
    const resolve = vi.fn<NonNullable<ManagedMcpControllerOptions["resolve"]>>()
      .mockReturnValueOnce(snapshot({ initial: server() }))
      .mockReturnValueOnce(old.promise)
      .mockReturnValue(snapshot({ replacement: server() }));
    const f = await fixture({ resolve });
    await f.emit("session_start");
    const refreshing = f.controller.refresh();
    await f.emit("session_shutdown");
    f.registrations.clear();
    await f.load();
    await f.emit("session_start");
    old.resolve(snapshot({ stale: server() }));
    await refreshing;
    expect([...f.registrations.keys()]).toEqual(["replacement"]);
    expect(f.controller.getState().pending).toBe(false);
  });
});
