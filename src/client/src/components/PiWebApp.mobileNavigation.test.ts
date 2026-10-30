// @vitest-environment happy-dom

import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Project, type SessionInfo, type Workspace } from "../api";
import { initialAppState } from "../appState";
import { AppShellController } from "../appShell/appShellController";
import * as themeCatalogApi from "../themeCatalog";
import { PiWebApp } from "./PiWebApp";
import { themeStylesheetFetch } from "./themeStylesheetFetch.testSupport";

// Same render-only boundary as PiWebApp.rendering.test.ts: retain the real
// shell, event wiring and navigation controllers, without startup/socket work.
class MobileNavigationApp extends PiWebApp {
  override connectedCallback(): void { LitElement.prototype.connectedCallback.call(this); }
}
customElements.define("mobile-navigation-test-app", MobileNavigationApp);

const firstProject = project("first");
const secondProject = project("second");
const unexpectedRequest = vi.fn(() => Promise.reject(new Error("Unexpected navigation fixture request")));
const finishPending: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/");
  unexpectedRequest.mockClear();
  vi.stubGlobal("fetch", themeStylesheetFetch(unexpectedRequest));
  vi.spyOn(themeCatalogApi, "loadThemeBootstrap").mockResolvedValue({ catalog: { themes: [], themePairs: [] }, stylesheets: [] });
  vi.spyOn(themeCatalogApi, "loadThemeCatalog").mockResolvedValue({ themes: [], themePairs: [] });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => { callback(0); }, 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { window.clearTimeout(id); });
});

afterEach(async () => {
  // Settle outstanding selection work even when an assertion fails midway.
  for (const finish of finishPending.splice(0)) finish();
  await vi.advanceTimersByTimeAsync(100);
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unexpectedRequest).not.toHaveBeenCalled();
});

describe("mobile project selection", () => {
  it("keeps Projects expanded while workspace resolution is pending", async () => {
    const { app, resolution } = await mountNavigation();
    await clickProject(app, firstProject);

    expect(resolution).toHaveBeenCalledWith(firstProject.id, "local");
    expectExpanded(app, "projects");
    expect(list(app, "projects").shadowRoot?.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(list(app, "projects").shadowRoot?.querySelector('[role="status"]')).not.toBeNull();
  });

  it.each([1, 2])("opens the resolved destination for %s worktrees before sessions finish loading", async (count) => {
    const { app, resolveFirst, sessionRequests, finishSessions } = await mountNavigation();
    await clickProject(app, firstProject);
    resolveFirst(count);
    await flush(app);

    expect(sessionRequests).toHaveBeenCalledOnce();
    expectExpanded(app, count === 1 ? "sessions" : "workspaces");
    expect(list(app, "sessions").shadowRoot?.querySelector('[aria-busy="true"]') !== null).toBe(count === 1);

    finishSessions([]);
    await flush(app);
    expectExpanded(app, count === 1 ? "sessions" : "workspaces");
    expect(list(app, "sessions").shadowRoot?.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it.each(["resolution", "sessions"] as const)("clears loading feedback after a %s failure", async (phase) => {
    const { app, resolveFirst, failFirst, failSessions } = await mountNavigation();
    await clickProject(app, firstProject);
    if (phase === "resolution") failFirst(new Error("Worktree lookup failed"));
    else {
      resolveFirst(1);
      await flush(app);
      failSessions(new Error("Session lookup failed"));
    }
    await flush(app);
    expectExpanded(app, phase === "resolution" ? "workspaces" : "sessions");
    for (const section of ["projects", "sessions"] as const) {
      expect(list(app, section).shadowRoot?.querySelector('[aria-busy="true"]')).toBeNull();
    }
  });

  it.each(["resolution", "sessions"] as const)("does not override an explicit section choice during %s loading", async (phase) => {
    const { app, resolveFirst, finishSessions } = await mountNavigation();
    await clickProject(app, firstProject);
    if (phase === "sessions") {
      resolveFirst(2);
      await flush(app);
    }
    // Use the actual disclosure, not the app's private section controller.
    const projects = sectionToggle(app, "projects");
    if (projects.getAttribute("aria-expanded") !== "true") {
      projects.click();
      await flush(app);
    }
    projects.click();
    await flush(app);
    expectExpanded(app, undefined);

    if (phase === "resolution") resolveFirst(2);
    finishSessions([]);
    await flush(app);
    expectExpanded(app, undefined);
  });

  it("does not let an older project's response replace a newer project's destination", async () => {
    const { app, resolveFirst, resolveSecond, finishSessions } = await mountNavigation();
    await clickProject(app, firstProject);
    const projects = sectionToggle(app, "projects");
    if (projects.getAttribute("aria-expanded") !== "true") {
      projects.click();
      await flush(app);
    }
    await clickProject(app, secondProject);
    resolveSecond(2);
    await flush(app);
    expectExpanded(app, "workspaces");

    resolveFirst(1);
    finishSessions([]);
    await flush(app);
    expectExpanded(app, "workspaces");
    sectionToggle(app, "projects").click();
    await flush(app);
    expect(list(app, "projects").shadowRoot?.querySelector('[aria-current="true"]')?.getAttribute("data-project-id")).toBe(secondProject.id);
  });
});

async function mountNavigation() {
  const first = deferred<Awaited<ReturnType<typeof api.workspaceResolution>>>();
  const second = deferred<Awaited<ReturnType<typeof api.workspaceResolution>>>();
  const sessions = deferred<SessionInfo[]>();
  finishPending.push(() => { first.resolve(resolutionFor(firstProject, 1)); second.resolve(resolutionFor(secondProject, 2)); sessions.resolve([]); });
  const resolution = vi.spyOn(api, "workspaceResolution").mockImplementation((id) => {
    if (id === firstProject.id) return first.promise;
    if (id === secondProject.id) return second.promise;
    throw new Error(`Unexpected project ${id}`);
  });
  const sessionRequests = vi.spyOn(api, "sessions").mockReturnValue(sessions.promise);
  const app = new MobileNavigationApp();
  // Plugin discovery is unrelated to project/section selection; do not replace
  // route restoration or the WorkspaceController that publishes resolution.
  Reflect.set(app, "loadPluginsForSelectedMachine", () => Promise.resolve());
  Reflect.set(app, "state", { ...initialAppState(), projects: [firstProject, secondProject], mainView: "navigation" });
  const shell: unknown = Reflect.get(app, "appShell");
  if (!(shell instanceof AppShellController)) throw new Error("Missing shell controller");
  shell.isMobileNavigationLayout = true;
  shell.isDesktopSideBySideLayout = false;
  document.body.append(app);
  await flush(app);
  return {
    app, resolution, sessionRequests,
    resolveFirst: (count: number) => { first.resolve(resolutionFor(firstProject, count)); },
    resolveSecond: (count: number) => { second.resolve(resolutionFor(secondProject, count)); },
    finishSessions: sessions.resolve,
    failFirst: first.reject,
    failSessions: sessions.reject,
  };
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-10-01T00:00:00Z" };
}

function resolutionFor(project: Project, count: number): Awaited<ReturnType<typeof api.workspaceResolution>> {
  const workspaces: Workspace[] = Array.from({ length: count }, (_, index) => ({
    id: `${project.id}-${String(index)}`, projectId: project.id, label: index === 0 ? "main" : "branch",
    path: `${project.path}/${String(index)}`, isMain: index === 0, effectiveConfig: {},
  }));
  return { projectId: project.id, status: "provider", ownerPluginId: "git", diagnostics: [], workspaces };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}

type Section = "projects" | "workspaces" | "sessions";

function list(app: PiWebApp, section: Section): LitElement {
  const panel = app.shadowRoot?.querySelector("app-navigation-panel");
  const element = panel?.shadowRoot?.querySelector(`${section === "projects" ? "project" : section === "workspaces" ? "workspace" : "session"}-list`);
  if (!(element instanceof LitElement)) throw new Error(`Missing ${section} list`);
  return element;
}

function sectionToggle(app: PiWebApp, section: Section): HTMLButtonElement {
  const button = list(app, section).shadowRoot?.querySelector("h2 button[aria-expanded]");
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${section} disclosure`);
  return button;
}

function expectExpanded(app: PiWebApp, expected: Section | undefined): void {
  for (const section of ["projects", "workspaces", "sessions"] as const) {
    const element = app.shadowRoot?.querySelector("app-navigation-panel")?.shadowRoot?.querySelector(`${section === "projects" ? "project" : section === "workspaces" ? "workspace" : "session"}-list`);
    // Providers can hide the workspace chooser; absence is not expansion.
    if (element === null || element === undefined) {
      expect(section).not.toBe(expected);
      continue;
    }
    expect(sectionToggle(app, section).getAttribute("aria-expanded"), section).toBe(String(section === expected));
  }
}

async function clickProject(app: PiWebApp, project: Project): Promise<void> {
  const row = list(app, "projects").shadowRoot?.querySelector(`[data-project-id="${project.id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`Missing project row ${project.id}`);
  row.click();
  await flush(app);
}

async function settle(element: LitElement): Promise<void> {
  await element.updateComplete;
  for (const child of element.shadowRoot?.querySelectorAll("*") ?? []) {
    if (child instanceof LitElement) await settle(child);
  }
  await element.updateComplete;
}

async function flush(app: PiWebApp): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await settle(app);
  // Drive the two real navigation/focus animation-frame boundaries, not sleeps.
  await vi.advanceTimersByTimeAsync(64);
  await settle(app);
}
