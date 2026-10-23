import { afterEach, describe, expect, it, vi } from "vitest";
import { McpAuthFlowService } from "./mcpAuthFlowService.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const services: McpAuthFlowService[] = [];
function service(options?: ConstructorParameters<typeof McpAuthFlowService>[0]) {
  const result = new McpAuthFlowService(options);
  services.push(result);
  return result;
}
afterEach(() => { for (const item of services.splice(0)) item.dispose(); vi.useRealTimers(); });

function operation(run: () => Promise<void>, identity = {}) {
  return { sessionId: "session", identity, isCurrent: () => true, run };
}

describe("MCP auth operation transport", () => {
  it("routes selection/input, validates responses, dedupes literal URLs and preserves final notices", async () => {
    const flows = service();
    const flow = flows.start(operation(async () => {
      const ui = required(McpAuthFlowService.current());
      expect(await ui.select("Server", ["alpha", "beta"])).toBe("beta");
      ui.notify("Open https://example.test/authorize?q=1");
      ui.openUrl("https://example.test/authorize?q=1");
      expect(await ui.input("Redirect", "https://localhost/callback")).toBe("redirect");
      ui.notify("Signed in, but reconnect failed");
    }));
    expect(flow.select).toBeDefined();
    expect(() => flows.respond(flow.flowId, required(flow.select).requestId, "unknown")).toThrow("Invalid");
    expect(() => flows.respond(flow.flowId, "stale", "alpha")).toThrow("no longer pending");
    flows.respond(flow.flowId, required(flow.select).requestId, "beta");
    await vi.waitFor(() => { expect(flows.get(flow.flowId).prompt).toBeDefined(); });
    const current = flows.get(flow.flowId);
    expect(current.auth?.url).toBe("https://example.test/authorize?q=1");
    expect(current.progress).toEqual([]);
    flows.respond(flow.flowId, required(current.prompt).requestId, "redirect");
    await vi.waitFor(() => { expect(flows.get(flow.flowId).status).toBe("complete"); });
    expect(flows.get(flow.flowId).progress).toEqual(["Signed in, but reconnect failed"]);
  });

  it("signal cleanup dismisses only the input when the browser callback wins", async () => {
    const flows = service();
    const controller = new AbortController();
    const reconnect = deferred();
    const flow = flows.start(operation(async () => {
      expect(await required(McpAuthFlowService.current()).input("Redirect", undefined, { signal: controller.signal })).toBeUndefined();
      await reconnect.promise;
      required(McpAuthFlowService.current()).notify("Pi final message");
    }));
    controller.abort();
    expect(flows.get(flow.flowId)).toMatchObject({ status: "running" });
    expect(flows.get(flow.flowId).cancelRequested).toBeUndefined();
    expect(flows.get(flow.flowId).prompt).toBeUndefined();
    reconnect.resolve();
    await vi.waitFor(() => { expect(flows.get(flow.flowId).status).toBe("complete"); });
  });

  it.each(["select", "input"] as const)("cancel settles %s undefined, rejects future prompts and keeps running through reconnect", async (kind) => {
    const flows = service();
    const reconnect = deferred();
    const flow = flows.start(operation(async () => {
      const ui = required(McpAuthFlowService.current());
      const result = kind === "select" ? await ui.select("Server", ["a"]) : await ui.input("Redirect");
      expect(result).toBeUndefined();
      expect(await ui.input("Late redirect")).toBeUndefined();
      expect(await ui.select("Late selection", ["b"])).toBeUndefined();
      expect(await ui.confirm("Late confirmation", "Continue?")).toBe(false);
      await reconnect.promise;
      ui.notify("Credentials may already have been saved");
    }));
    expect(flows.cancel(flow.flowId)).toMatchObject({ status: "running", cancelRequested: true });
    expect(() => flows.start(operation(() => Promise.resolve()))).toThrow("already running");
    reconnect.resolve();
    await vi.waitFor(() => { expect(flows.get(flow.flowId).status).toBe("complete"); });
    expect(flows.get(flow.flowId)).toMatchObject({ cancelRequested: true, progress: ["Credentials may already have been saved"] });
  });

  it("serializes scoped operations across sessions sharing Pi credentials until the real command ends", async () => {
    const flows = service();
    const command = deferred();
    const first = flows.start(operation(() => command.promise));
    const other = { ...operation(() => Promise.resolve()), sessionId: "other-session" };
    expect(() => flows.start(other)).toThrow("running on this machine");
    flows.cancel(first.flowId);
    expect(() => flows.start(other)).toThrow("running on this machine");
    command.resolve();
    await vi.waitFor(() => { expect(flows.get(first.flowId).status).toBe("complete"); });
    expect(flows.start(other).target).toBe("mcp");
  });

  it("cancel before discovery completes prevents the first prompt", async () => {
    const flows = service();
    const discovery = deferred();
    const flow = flows.start(operation(async () => {
      await discovery.promise;
      expect(await required(McpAuthFlowService.current()).input("Redirect")).toBeUndefined();
    }));
    flows.cancel(flow.flowId);
    discovery.resolve();
    await vi.waitFor(() => { expect(flows.get(flow.flowId).status).toBe("complete"); });
    expect(flows.get(flow.flowId).prompt).toBeUndefined();
  });

  it("guards runtime identity and retires stale async ancestry in finally", async () => {
    const flows = service();
    const later = deferred();
    const identity = {};
    let current = true;
    let stale: Promise<void> | undefined;
    const flow = flows.start({ ...operation(() => {
      expect(McpAuthFlowService.current({})).toBeUndefined();
      expect(McpAuthFlowService.current(identity)).toBeDefined();
      current = false;
      expect(McpAuthFlowService.current(identity)).toBeUndefined();
      current = true;
      stale = later.promise.then(() => { expect(McpAuthFlowService.current(identity)).toBeUndefined(); });
      return Promise.resolve();
    }, identity), isCurrent: () => current });
    await vi.waitFor(() => { expect(flows.get(flow.flowId).status).toBe("complete"); });
    later.resolve();
    await stale;
    expect(McpAuthFlowService.current()).toBeUndefined();
  });

  it("captures emitted command errors even when SDK resolves; does not classify notices", async () => {
    const flows = service();
    const flow = flows.start(operation(() => { required(McpAuthFlowService.current()).error("command failed"); return Promise.resolve(); }));
    await vi.waitFor(() => { expect(flows.get(flow.flowId).status).toBe("error"); });
    expect(flows.get(flow.flowId).error).toBe("command failed");
    const notice = flows.start(operation(() => { required(McpAuthFlowService.current()).notify("Sign-in failed: invalid state"); return Promise.resolve(); }));
    await vi.waitFor(() => { expect(flows.get(notice.flowId).status).toBe("complete"); });
  });

  it("bounds progress, TTL cancels waits without claiming completion, and evicts terminal flows", async () => {
    vi.useFakeTimers();
    const flows = service({ runningTtlMs: 10, terminalTtlMs: 20 });
    const flow = flows.start(operation(async () => {
      const ui = required(McpAuthFlowService.current());
      for (let i = 0; i < 150; i++) ui.notify(String(i));
      await ui.input("Redirect");
    }));
    expect(flow.progress).toHaveLength(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(flows.get(flow.flowId)).toMatchObject({ status: "complete", cancelRequested: true });
    await vi.advanceTimersByTimeAsync(20);
    expect(() => flows.get(flow.flowId)).toThrow("not found");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposal settles waits, retires scope, clears timers and refuses starts", async () => {
    vi.useFakeTimers();
    const flows = service();
    const finished = deferred();
    flows.start(operation(async () => {
      expect(await required(McpAuthFlowService.current()).input("Redirect", undefined, { timeout: 500 })).toBeUndefined();
      expect(McpAuthFlowService.current()).toBeUndefined();
      finished.resolve();
    }));
    flows.dispose();
    await finished.promise;
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => flows.start(operation(() => Promise.resolve()))).toThrow("disposed");
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value");
  return value;
}
