// @vitest-environment happy-dom

import { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { Project, SessionInfo, Workspace } from "../api";
import { NavigationOrderController, type NavigationOrderPort, type NavigationOrderScope } from "../controllers/navigationOrderController";
import { PiWebApp } from "./PiWebApp";
import { AppNavigationPanel } from "./appShell/AppNavigationPanel";

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

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-10-01T00:00:00Z" };
}
function session(id: string): SessionInfo {
  return { id, name: id, path: `/sessions/${id}.jsonl`, cwd: "/repo", created: "2026-10-01T00:00:00Z", modified: "2026-10-01T00:00:00Z", messageCount: 1, firstMessage: id };
}
