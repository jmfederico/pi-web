import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Workspace } from "../api";
import { initialAppState } from "../appState";
import { loadExternalPlugins, type PluginManifestEntry } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import type { PiWebPlugin, PluginRuntimeContext, WorkspacePanelContext } from "../plugins/types";
import { PiWebApp } from "./PiWebApp";

vi.mock("../plugins/external", () => ({ loadExternalPlugins: vi.fn() }));

const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
  effectiveConfig: {},
};

const project: Project = { id: "project-1", name: "repo", path: "/repo", createdAt: "2026-01-01T00:00:00.000Z" };

beforeEach(() => {
  vi.mocked(loadExternalPlugins).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp plugin host", () => {
  it("routes selected-panel, route, activity, and refresh-current invalidation through the generic seam", async () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "browser-only:workspace.panel",
      mainView: "browser-only:workspace.panel",
    });
    const invalidated = vi.fn<(context: WorkspacePanelContext) => void>();
    appPluginRegistry(app).register({ id: "browser-only", plugin: pluginWithPanel("Browser only", invalidated) });

    await callAsyncAppMethod(app, "refreshCurrentWorkspaceSurface");
    await callAsyncAppMethod(app, "refreshRestoredWorkspaceTool", "browser-only:workspace.panel", undefined);
    callAppMethod(app, "refreshSelectedWorkspaceTool", "browser-only:workspace.panel");
    await Promise.resolve();

    const actions = callAppMethod(app, "getDefaultActions");
    if (!Array.isArray(actions)) throw new Error("PiWebApp default actions were unavailable");
    const refreshCurrent = actions.find((candidate): candidate is { id: string; run: () => void | Promise<void> } => isAction(candidate) && candidate.id === "core:workspace.refresh-current");
    await refreshCurrent?.run();

    const inactive = { ...initialAppState(), selectedWorkspace: workspace, workspaces: [workspace], workspaceTool: "browser-only:workspace.panel" as const };
    const active = { ...inactive, activity: { sessionId: "session-1", phase: "active" as const, label: "working", at: "now" } };
    setAppState(app, inactive);
    callAppMethod(app, "handleActivityTransition", active, inactive);
    await Promise.resolve();

    expect(invalidated).toHaveBeenCalledTimes(5);
  });

  it("selects a plugin-named project through the sidebar navigation seam", async () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), projects: [project] });
    const selectProjectOnController = vi.fn(() => Promise.resolve(undefined));
    stubWorkspaceProjectSelection(app, selectProjectOnController);
    const navigated: [string, string][] = [];
    stubNavigationSeam(app, navigated);

    const selected = await createPluginRuntimeContext(app).selectProject(project.id, { workspaceId: workspace.id });

    expect(selected).toBe(true);
    expect(navigated).toEqual([["projects", "workspaces"]]);
    expect(selectProjectOnController).toHaveBeenCalledWith(project, { workspaceId: workspace.id });
  });

  it("reports an unknown project id instead of selecting anything", async () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), projects: [project] });
    const selectProjectOnController = vi.fn(() => Promise.resolve(undefined));
    stubWorkspaceProjectSelection(app, selectProjectOnController);
    const navigated: [string, string][] = [];
    stubNavigationSeam(app, navigated);

    const selected = await createPluginRuntimeContext(app).selectProject("missing-project");

    expect(selected).toBe(false);
    expect(navigated).toEqual([]);
    expect(selectProjectOnController).not.toHaveBeenCalled();
  });

  it("keeps successful registrations while making an incomplete gateway load retryable", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    const stableEntry = manifestEntry("stable");
    const retryEntry = manifestEntry("retry");
    const transientFailure = new Error("temporary module failure");
    let attempt = 0;
    vi.mocked(loadExternalPlugins).mockImplementation((_manifestUrl, options = {}) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve({
          registrations: [{ id: "stable", machineSpecific: false, plugin: emptyPlugin("Stable") }],
          failures: [{ entry: retryEntry, error: transientFailure }],
        });
      }
      expect(options.shouldLoadPlugin?.(stableEntry)).toBe(false);
      return Promise.resolve({
        registrations: [{ id: "retry", machineSpecific: false, plugin: emptyPlugin("Retry") }],
        failures: [],
      });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await ensureGatewayPluginsLoaded(app);

    expect(appPluginRegistry(app).hasPlugin("stable")).toBe(true);
    expect(appPluginRegistry(app).hasPlugin("retry")).toBe(false);
    expect(Reflect.get(app, "gatewayPluginLoadPromise")).toBeUndefined();

    await ensureGatewayPluginsLoaded(app);

    expect(loadExternalPlugins).toHaveBeenCalledTimes(2);
    expect(appPluginRegistry(app).hasPlugin("stable")).toBe(true);
    expect(appPluginRegistry(app).hasPlugin("retry")).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      "Failed to load PI WEB plugin retry (./retry/plugin.js)",
      transientFailure,
    );
  });

  it("retries a plugin whose activation failed without retaining partial contributions", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    let activationAttempts = 0;
    const retryable: PiWebPlugin = {
      apiVersion: 2,
      name: "Retryable",
      activate: () => {
        activationAttempts += 1;
        if (activationAttempts === 1) {
          return {
            contributions: {
              actions: [
                { id: "action", title: "Partial", run: () => undefined },
                { id: "action", title: "Duplicate", run: () => undefined },
              ],
            },
          };
        }
        return { contributions: { actions: [{ id: "action", title: "Ready", run: () => undefined }] } };
      },
    };
    vi.mocked(loadExternalPlugins).mockResolvedValue({
      registrations: [{ id: "retryable", machineSpecific: false, plugin: retryable }],
      failures: [],
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await ensureGatewayPluginsLoaded(app);
    expect(appPluginRegistry(app).hasPlugin("retryable")).toBe(false);
    expect(Reflect.get(app, "gatewayPluginLoadPromise")).toBeUndefined();

    await ensureGatewayPluginsLoaded(app);

    expect(activationAttempts).toBe(2);
    expect(appPluginRegistry(app).hasPlugin("retryable")).toBe(true);
    expect(appPluginRegistry(app).getActions(createPluginRuntimeContext(app)).filter(({ pluginId }) => pluginId === "retryable").map(({ title }) => title)).toEqual(["Ready"]);
  });
});

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function setAppState(app: PiWebApp, state: ReturnType<typeof initialAppState>): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function appPluginRegistry(app: PiWebApp): PluginRegistry {
  const registry: unknown = Reflect.get(app, "plugins");
  if (!(registry instanceof PluginRegistry)) throw new Error("PiWebApp PluginRegistry was unavailable");
  return registry;
}

function createPluginRuntimeContext(app: PiWebApp): PluginRuntimeContext {
  const createContext: unknown = Reflect.get(app, "createPluginRuntimeContext");
  if (typeof createContext !== "function") throw new Error("PiWebApp plugin runtime context factory was unavailable");
  const context: unknown = Reflect.apply(createContext, app, []);
  if (!isPluginRuntimeContext(context)) throw new Error("PiWebApp returned an invalid plugin runtime context");
  return context;
}

async function ensureGatewayPluginsLoaded(app: PiWebApp): Promise<void> {
  const ensure: unknown = Reflect.get(app, "ensureGatewayPluginsLoaded");
  if (typeof ensure !== "function") throw new Error("PiWebApp gateway plugin loader was unavailable");
  const result: unknown = Reflect.apply(ensure, app, []);
  if (!(result instanceof Promise)) throw new Error("PiWebApp gateway plugin loader did not return a promise");
  await result;
}

function isPluginRuntimeContext(value: unknown): value is PluginRuntimeContext {
  if (typeof value !== "object" || value === null) return false;
  return "refreshWorkspacePanels" in value && typeof value.refreshWorkspacePanels === "function";
}

/* The seam under test is which navigation path a plugin selection takes, so the
   controller call and the section advance are stubbed rather than the network: a real
   selectProject would fetch workspaces and a real navigation advance would need a DOM. */
function stubWorkspaceProjectSelection(app: PiWebApp, selectProject: (project: Project, target?: { workspaceId?: string }) => Promise<void>): void {
  const workspaces: unknown = Reflect.get(app, "workspaces");
  if (typeof workspaces !== "object" || workspaces === null) throw new Error("PiWebApp workspace controller was unavailable");
  if (!Reflect.set(workspaces, "selectProject", selectProject)) throw new Error("Could not stub workspace project selection");
}

function stubNavigationSeam(app: PiWebApp, navigated: [string, string][]): void {
  const seam = async (section: string, nextTarget: string, action: () => Promise<void>): Promise<void> => {
    navigated.push([section, nextTarget]);
    await action();
  };
  if (!Reflect.set(app, "selectNavigationItem", seam)) throw new Error("Could not stub navigation selection");
}

function stubPluginLoadRendering(app: PiWebApp): void {
  if (!Reflect.set(app, "applyPreferredTheme", () => undefined)) throw new Error("Could not stub theme application");
  if (!Reflect.set(app, "requestUpdate", () => undefined)) throw new Error("Could not stub Lit update scheduling");
}

function pluginWithPanel(name: string, onInvalidate: (context: WorkspacePanelContext) => void): PiWebPlugin {
  return {
    apiVersion: 2,
    name,
    activate: ({ html }) => ({
      contributions: {
        workspacePanels: [{ id: "workspace.panel", title: name, onInvalidate, render: () => html`<p>${name}</p>` }],
      },
    }),
  };
}

function emptyPlugin(name: string): PiWebPlugin {
  return { apiVersion: 2, name, activate: () => ({ contributions: {} }) };
}

function callAppMethod(app: PiWebApp, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`PiWebApp.${name} is not callable`);
  return Reflect.apply(method, app, args);
}

async function callAsyncAppMethod(app: PiWebApp, name: string, ...args: unknown[]): Promise<void> {
  await callAppMethod(app, name, ...args);
}

function isAction(value: unknown): value is { id: string; run: () => void | Promise<void> } {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "run" in value && typeof value.run === "function";
}

function manifestEntry(id: string): PluginManifestEntry {
  return { id, module: `./${id}/plugin.js`, machineSpecific: false };
}
