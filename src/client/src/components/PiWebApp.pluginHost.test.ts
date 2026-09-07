import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
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

  it("leaves plugin-hidden projects out of the list but never the selected one", () => {
    const chat = { id: "p-chat", name: "chat", path: "/home/node/chat", createdAt: "2026-01-01T00:00:00.000Z" };
    const repo = { id: "p-repo", name: "repo", path: "/repo", createdAt: "2026-01-01T00:00:00.000Z" };
    const app = createApp();
    setAppState(app, { ...initialAppState(), projects: [chat, repo] });
    appPluginRegistry(app).register({
      id: "modes",
      plugin: {
        apiVersion: 2,
        name: "Modes",
        activate: () => ({ contributions: { hiddenProjects: [{ id: "roots", projects: () => ["p-chat"] }] } }),
      },
    });

    expect(listedProjectIds(app)).toEqual(["p-repo"]);
    // И панель обязана получить именно этот список, а не state.projects: иначе фильтр
    // существует, но ни на что не влияет (мутация «фильтр не применяется» это показала).
    expect(projectIdsHandedToPanel(app)).toEqual(["p-repo"]);

    // Работая внутри скрытого проекта, человек обязан видеть, где он находится.
    setAppState(app, { ...initialAppState(), projects: [chat, repo], selectedProject: chat });
    expect(listedProjectIds(app)).toEqual(["p-chat", "p-repo"]);
    expect(projectIdsHandedToPanel(app)).toEqual(["p-chat", "p-repo"]);
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

function projectId(value: object): string {
  const id: unknown = Reflect.get(value, "id");
  return typeof id === "string" ? id : "";
}

/* Что панель реально получает в .projects. Узкая лазейка из testing-guide: разбираем
   TemplateResult вместо DOM — поднимать всё приложение в happy-dom ради одного свойства
   дороже и хрупче, чем найти переданный массив проектов среди значений шаблона. */
function projectIdsHandedToPanel(app: PiWebApp): string[] {
  const template: unknown = callAppMethod(app, "renderNavigationPanel");
  if (typeof template !== "object" || template === null || !("values" in template)) throw new Error("PiWebApp navigation panel template was unavailable");
  const values: unknown = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("PiWebApp navigation panel template had no values");
  const looksLikeProjects = (value: unknown): value is object[] =>
    Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === "object" && item !== null && "path" in item && "createdAt" in item && !("projectId" in item));
  const projects = values.find(looksLikeProjects);
  if (projects === undefined) throw new Error("PiWebApp handed the navigation panel no project list");
  return projects.map(projectId);
}

function listedProjectIds(app: PiWebApp): string[] {
  const listed: unknown = callAppMethod(app, "listedProjects");
  if (!Array.isArray(listed)) throw new Error("PiWebApp listed projects were unavailable");
  const length: unknown = Reflect.get(listed, "length");
  const count = typeof length === "number" ? length : 0;
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const project: unknown = Reflect.get(listed, String(index));
    ids.push(typeof project === "object" && project !== null ? projectId(project) : "");
  }
  return ids;
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
