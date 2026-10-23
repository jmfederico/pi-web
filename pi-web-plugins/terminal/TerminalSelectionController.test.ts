import { describe, expect, it, vi } from "vitest";
import type { TerminalContext } from "./TerminalContext";
import { TerminalSelectionController } from "./TerminalSelectionController";
import { InMemoryTerminalSelectionMemory } from "./terminalSelection";
import type { TerminalInfo } from "./terminalProtocol";

function terminal(id: string, scope: "workspace" | "maintenance" = "workspace"): TerminalInfo {
  return { id, scope, cwd: "/repo", name: id, createdAt: "now", exited: false };
}

function fixture(route?: string) {
  const memory = new InMemoryTerminalSelectionMemory();
  const remember = vi.spyOn(memory, "rememberTerminal");
  const render = vi.fn();
  const set = vi.fn<(...args: unknown[]) => boolean | undefined>(() => undefined);
  const context: TerminalContext = {
    machine: { id: "local", kind: "local", name: "Local" }, host: { requestRender: render },
    maintenance: { scope: "maintenance", peer: { request: vi.fn() } },
    workspace: {
      scope: "workspace", peer: { request: vi.fn() },
      workspace: { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true },
      navigation: { version: 1, contributionId: "terminal", query: route === undefined ? {} : { terminal: route }, set },
    },
  };
  return { controller: new TerminalSelectionController(memory), context, memory, remember, render, set };
}

function routed(context: TerminalContext, id: string | undefined): TerminalContext {
  if (context.workspace?.navigation === undefined) throw new Error("Missing workspace navigation");
  return { ...context, workspace: { ...context.workspace, navigation: { ...context.workspace.navigation, query: id === undefined ? {} : { terminal: id } } } };
}

describe("Terminal selection coordinator", () => {
  it("makes accepted selection, list, and fresh context reapplication effect-free", () => {
    const { controller, context, set, render, remember } = fixture();
    const terminals = [terminal("shell")];
    expect(controller.loaded(context, terminals).terminalId).toBe("shell");
    const revision = controller.synchronize(context).revision;
    for (let i = 0; i < 5; i += 1) {
      const fresh = routed(context, undefined);
      expect(controller.loaded(fresh, [...terminals])).toEqual({ terminalId: "shell", revision });
      expect(controller.select(fresh, "shell")).toBe(true);
    }
    expect(set).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(remember).toHaveBeenCalledOnce();
  });

  it.each([undefined, "route"])("resolves route %s before remembered selection and defaults", (route) => {
    const { controller, context, memory } = fixture(route);
    memory.rememberTerminal("local:/repo", "remembered");
    expect(controller.loaded(context, [terminal("default"), terminal("remembered"), terminal("route")]).terminalId)
      .toBe(route ?? "remembered");
  });

  it("hydrates deep links and responds to acknowledged history transitions", () => {
    const { controller, context, set } = fixture("one");
    controller.loaded(context, [terminal("one"), terminal("two")]);
    expect(set).toHaveBeenCalledExactlyOnceWith("terminal", "one", { replace: true });
    controller.select(context, "two");
    expect(controller.synchronize(routed(context, "two")).terminalId).toBe("two");
    expect(controller.synchronize(routed(context, "one")).terminalId).toBe("one");
  });

  it("retains an explicit maintenance open through rejection, stale routes, and one pending reload", () => {
    const { controller, context, set, memory } = fixture("workspace");
    controller.requestMaintenanceTerminal("local", "maintenance");
    set.mockReturnValue(false);
    controller.loaded(context, [terminal("workspace")]);
    expect(controller.takeReload(context)).toBe(true);
    expect(controller.takeReload(context)).toBe(false);
    expect(controller.requested(context)).toBe("maintenance");
    expect(controller.loaded(context, [terminal("workspace"), terminal("maintenance", "maintenance")]).terminalId).toBeUndefined();
    expect(memory.latestTerminalId('["maintenance","local"]')).toBeUndefined();
    set.mockReturnValue(true);
    expect(controller.synchronize(routed(context, "workspace")).terminalId).toBe("maintenance");
    expect(controller.synchronize(routed(context, "workspace")).terminalId).toBe("maintenance");
    expect(controller.requested(context)).toBe("maintenance");
  });

  it("rejects stale hydration even when the deep link already names the available terminal", () => {
    const { controller, context, set, render, remember } = fixture("shell");
    set.mockReturnValue(false);
    expect(controller.loaded(context, [terminal("shell")]).terminalId).toBeUndefined();
    expect(remember).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    set.mockReturnValue(true);
    expect(controller.synchronize(routed(context, "shell")).terminalId).toBe("shell");
  });

  it("falls back only after the pending intent's reload settles and does not reload again", () => {
    const { controller, context } = fixture("missing");
    controller.loaded(context, [terminal("fallback")]);
    expect(controller.takeReload(context)).toBe(true);
    expect(controller.synchronize(context).terminalId).toBeUndefined();
    expect(controller.loaded(context, [terminal("fallback")]).terminalId).toBe("fallback");
    expect(controller.takeReload(context)).toBe(false);
  });

  it("falls back immediately on an explicit close, without a missing-target reload", () => {
    const { controller, context } = fixture("one");
    controller.loaded(context, [terminal("one"), terminal("two")]);
    controller.closed(context, "one", [terminal("two")]);
    expect(controller.synchronize(context).terminalId).toBe("two");
    expect(controller.takeReload(context)).toBe(false);
  });

  it("preserves maintenance selection when moving to a different workspace", () => {
    const { controller, context } = fixture();
    controller.loaded(context, [terminal("maintenance", "maintenance")]);
    const workspace = context.workspace;
    if (workspace === undefined) throw new Error("Missing workspace");
    const next = { ...context, workspace: { ...workspace, workspace: { ...workspace.workspace, id: "next", path: "/next" } } };
    expect(controller.loaded(next, [terminal("workspace"), terminal("maintenance", "maintenance")]).terminalId).toBe("maintenance");
  });

  it("consumes accepted auto-start once and never creates a maintenance shell", () => {
    const { controller, context, set } = fixture();
    const workspace = context.workspace;
    if (workspace?.navigation === undefined) throw new Error("Missing navigation");
    const start = { ...context, workspace: { ...workspace, navigation: { ...workspace.navigation, query: { start: "request" } } } };
    controller.loaded(start, []);
    set.mockReturnValue(false);
    expect(controller.takeAutoStart(start)).toBe(false);
    set.mockReturnValue(true);
    expect(controller.takeAutoStart(start)).toBe(true);
    expect(controller.takeAutoStart(start)).toBe(false);
    const maintenance: TerminalContext = { machine: context.machine, host: context.host, ...(context.maintenance === undefined ? {} : { maintenance: context.maintenance }) };
    controller.loaded(maintenance, []);
    expect(controller.takeAutoStart(maintenance)).toBe(false);
  });
});
