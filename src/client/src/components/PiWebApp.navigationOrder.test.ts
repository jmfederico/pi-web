// @vitest-environment happy-dom

import { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { Project, SessionInfo, Workspace } from "../api";
import { NavigationOrderController, type NavigationOrderPort, type NavigationOrderScope } from "../controllers/navigationOrderController";
import { PiWebApp } from "./PiWebApp";
import { RealtimeSocket } from "../sessionSocket";
import { AppNavigationPanel } from "./appShell/AppNavigationPanel";
import { WorkspaceList } from "./WorkspaceList";
import { SessionList } from "./SessionList";

class NavigationOrderApp extends PiWebApp {
  override connectedCallback(): void { LitElement.prototype.connectedCallback.call(this); }
}
customElements.define("navigation-order-test-app", NavigationOrderApp);

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders saved scoped orders and saves menu moves and root pins without ordering other sessions", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const app = new NavigationOrderApp();
  const secondProject = project("b");
  const projects = [project("a"), secondProject];
  const workspace: Workspace = { id: "ws", projectId: "a", label: "main", path: "/repo", isMain: true, effectiveConfig: {} };
  const root = session("root");
  const sessions = [root, session("other")];
  Reflect.set(app, "state", { ...initialAppState(), projects, selectedProject: projects[0], workspaces: [workspace], selectedWorkspace: workspace, sessions, mainView: "navigation" });
  const save = vi.fn<NavigationOrderPort["save"]>((_scope, ids, revision) => Promise.resolve({ ids: [...ids], revision: revision + 1 }));
  const load = vi.fn<NavigationOrderPort["load"]>((scope) => Promise.resolve({ ids: scope.kind === "projects" ? ["b", "a"] : [], revision: 0 }));
  const controller = new NavigationOrderController({ load, save }, { onChange: () => { Reflect.set(app, "navigationOrderVersion", Number(Reflect.get(app, "navigationOrderVersion")) + 1); } });
  Reflect.set(app, "navigationOrder", controller);
  const projectScope: NavigationOrderScope = { kind: "projects", machineId: "local" };
  await controller.ensure(projectScope);
  document.body.append(app);
  await app.updateComplete;
  const panel = app.shadowRoot?.querySelector("app-navigation-panel");
  if (!(panel instanceof AppNavigationPanel)) throw new Error("Missing navigation panel");
  await panel.updateComplete;
  expect(panel.projects.map((item) => item.id)).toEqual(["b", "a"]);
  Reflect.set(app, "navigationOrderConnected", true);
  const setState: unknown = Reflect.get(app, "setState");
  if (typeof setState !== "function") throw new Error("Missing state setter");
  const patch: Partial<AppState> = { error: "Unrelated state update" };
  Reflect.apply(setState, app, [patch]);
  expect(load).toHaveBeenCalledOnce();
  panel.onMoveProject?.(secondProject, 1);
  // Explicit scope load joins the controller's serialized mutation queue.
  await controller.mutate(projectScope, (ids) => ids);
  await app.updateComplete;
  await panel.updateComplete;
  expect(panel.projects.map((item) => item.id)).toEqual(["a", "b"]);
  expect(save).toHaveBeenCalledWith(projectScope, ["a", "b"], 0);

  panel.onPinSession?.(root);
  const pinScope: NavigationOrderScope = { kind: "sessionPins", machineId: "local", projectId: "a", workspaceId: "ws" };
  await controller.mutate(pinScope, (ids) => ids);
  await app.updateComplete;
  await panel.updateComplete;
  expect(panel.pinnedRootIds).toEqual(["root"]);
  expect(panel.sessions).toBe(sessions);
  expect(save).toHaveBeenLastCalledWith(pinScope, ["root"], 0);

  panel.onPinSession?.({ ...session("child"), parentSessionPath: root.path });
  await controller.mutate(pinScope, (ids) => ids);
  expect(save).toHaveBeenCalledTimes(2);
});

it("wires workspace and pinned-root drops to their durable scopes without pruning hidden entries", async () => {
  const app = new NavigationOrderApp();
  const firstWorkspace: Workspace = { id: "ws-a", projectId: "a", label: "main", path: "/repo", isMain: true, effectiveConfig: {} };
  const secondWorkspace: Workspace = { ...firstWorkspace, id: "ws-b", label: "branch", isMain: false };
  const first = session("first");
  const second = session("second");
  const recent = session("recent");
  const child = { ...session("child"), parentSessionPath: first.path };
  Reflect.set(app, "state", {
    ...initialAppState(), projects: [project("a")], selectedProject: project("a"),
    workspaces: [firstWorkspace, secondWorkspace], selectedWorkspace: firstWorkspace,
    sessions: [first, child, second, recent], mainView: "navigation",
  });
  const save = vi.fn<NavigationOrderPort["save"]>((_scope, ids, revision) => Promise.resolve({ ids: [...ids], revision: revision + 1 }));
  const controller = new NavigationOrderController({
    load: (scope) => Promise.resolve({ ids: scope.kind === "workspaces" ? ["hidden-workspace", "ws-a", "ws-b"] : ["hidden-pin", "first", "second"], revision: 4 }),
    save,
  }, { onChange: () => { Reflect.set(app, "navigationOrderVersion", Number(Reflect.get(app, "navigationOrderVersion")) + 1); } });
  Reflect.set(app, "navigationOrder", controller);
  const workspaceScope: NavigationOrderScope = { kind: "workspaces", machineId: "local", projectId: "a" };
  const pinScope: NavigationOrderScope = { kind: "sessionPins", machineId: "local", projectId: "a", workspaceId: "ws-a" };
  await Promise.all([controller.ensure(workspaceScope), controller.ensure(pinScope)]);
  document.body.append(app);
  await app.updateComplete;
  const panel = app.shadowRoot?.querySelector("app-navigation-panel");
  if (!(panel instanceof AppNavigationPanel)) throw new Error("Missing navigation panel");
  await panel.updateComplete;
  const workspaces = panel.shadowRoot?.querySelector("workspace-list");
  const sessions = panel.shadowRoot?.querySelector("session-list");
  if (!(workspaces instanceof WorkspaceList) || !(sessions instanceof SessionList)) throw new Error("Missing navigation lists");
  await Promise.all([workspaces.updateComplete, sessions.updateComplete]);
  expect(workspaces.projectId).toBe("a");
  expect([sessions.machineId, sessions.projectId, sessions.workspaceId]).toEqual(["local", "a", "ws-a"]);
  workspaces.onReorder?.(secondWorkspace, firstWorkspace, "before");
  sessions.onReorderPin?.(second, first, "before");
  await Promise.all([controller.mutate(workspaceScope, (ids) => ids), controller.mutate(pinScope, (ids) => ids)]);
  expect(save).toHaveBeenCalledWith(workspaceScope, ["hidden-workspace", "ws-b", "ws-a"], 4);
  expect(save).toHaveBeenCalledWith(pinScope, ["hidden-pin", "second", "first"], 4);
  // Neither a recent root nor a child becomes a pin through the reorder boundary.
  sessions.onReorderPin?.(recent, first, "before");
  sessions.onReorderPin?.(child, first, "before");
  await controller.mutate(pinScope, (ids) => ids);
  expect(save).toHaveBeenCalledTimes(2);
  panel.onReorderWorkspace = undefined;
  panel.onReorderSessionPin = undefined;
  await panel.updateComplete;
  await Promise.all([workspaces.updateComplete, sessions.updateComplete]);
  expect(workspaces.onReorder).toBeUndefined();
  expect(sessions.onReorderPin).toBeUndefined();
});

it.each(["handleRealtimeEvent", "handleMachineActivityEvent"])("refreshes explicitly scoped pins through %s without using selected workspace", async (handler) => {
  const app = new NavigationOrderApp();
  const load = vi.fn<NavigationOrderPort["load"]>().mockResolvedValue({ ids: [], revision: 0 });
  const controller = new NavigationOrderController({ load, save: vi.fn() });
  Reflect.set(app, "navigationOrder", controller);
  const scope: NavigationOrderScope = { kind: "sessionPins", machineId: "remote", projectId: "background-project", workspaceId: "background-workspace" };
  await controller.ensure(scope);
  load.mockClear().mockResolvedValue({ ids: ["external-pin"], revision: 2 });
  const handle: unknown = Reflect.get(app, handler);
  if (typeof handle !== "function") throw new Error("Missing event handler");
  Reflect.apply(handle, app, ["remote", { type: "session-pins.changed", projectId: scope.projectId, workspaceId: scope.workspaceId, revision: 2 }]);
  // Join the same serialized queue to observe the event-triggered refresh.
  await controller.mutate(scope, (ids) => ids);
  expect(load).toHaveBeenCalledExactlyOnceWith(scope);
  expect(controller.ids(scope)).toEqual(["external-pin"]);
  expect(controller.ids({ ...scope, machineId: "local" })).toEqual([]);
});

it("reloads cached pins for the captured machine on socket opens without following selection", () => {
  const app = new NavigationOrderApp();
  const controller = new NavigationOrderController({ load: vi.fn(), save: vi.fn() });
  Reflect.set(app, "navigationOrder", controller);
  const refreshPins = vi.spyOn(controller, "refreshSessionPins").mockResolvedValue(undefined);
  for (const name of ["sessions", "workspaces", "sessionUnread", "serverNotices"]) {
    const target: unknown = Reflect.get(app, name);
    if (typeof target !== "object" || target === null) throw new Error("Missing controller");
    for (const method of ["refreshCurrentWorkspaceSessions", "refreshSelectedProjectTopology", "refresh"]) {
      if (Reflect.has(target, method)) Reflect.set(target, method, vi.fn().mockResolvedValue(undefined));
    }
  }
  const connect = vi.spyOn(RealtimeSocket.prototype, "connect").mockImplementation(() => undefined);
  const connectRealtime: unknown = Reflect.get(app, "connectRealtime");
  if (typeof connectRealtime !== "function") throw new Error("Missing realtime connection");
  Reflect.apply(connectRealtime, app, []);
  const onOpen = connect.mock.calls[0]?.[1];
  if (onOpen === undefined) throw new Error("Missing socket open handler");
  Reflect.set(app, "state", { ...initialAppState(), selectedMachine: { id: "remote", name: "Remote", kind: "remote", createdAt: "now", updatedAt: "now" } });
  onOpen();
  onOpen();
  expect(refreshPins.mock.calls).toEqual([["local"], ["local"]]);
});

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-10-01T00:00:00Z" };
}
function session(id: string): SessionInfo {
  return { id, name: id, path: `/sessions/${id}.jsonl`, cwd: "/repo", created: "2026-10-01T00:00:00Z", modified: "2026-10-01T00:00:00Z", messageCount: 1, firstMessage: id };
}
