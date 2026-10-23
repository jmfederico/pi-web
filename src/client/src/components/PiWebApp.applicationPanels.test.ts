// @vitest-environment happy-dom

import { LitElement, html } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationPanelContext, PiWebPlugin, PiWebStatusResponse, PluginProjects, PluginSelectionService, WorkspacePanelContext, WorkspacePanelTerminal, MaintenanceTerminal } from "../../../plugin-api";
import infoPlugin from "../../../../pi-web-plugins/info/pi-web-plugin";
import updatesPlugin from "../../../../pi-web-plugins/updates/pi-web-plugin";
import { TerminalPanel } from "../../../../pi-web-plugins/terminal/TerminalPanel";
import { TerminalBrowserRuntime } from "../../../../pi-web-plugins/terminal/TerminalBrowserRuntime";
import { applicationTerminalContext } from "../../../../pi-web-plugins/terminal/TerminalContext";
import { installTerminalRendererFake } from "../../../../pi-web-plugins/terminal/terminalRenderer.testSupport";
import type { PluginRuntimeContext as InternalPluginRuntimeContext } from "../plugins/types";
import type { RequiredTerminalBrowserComposition, RequiredTerminalBrowserFacadeV1 } from "../plugins/requiredTerminalFacade";
import { initialAppState, type AppState } from "../appState";
import { PI_WEB_PLUGIN_LIFECYCLE_VERSION } from "../../../shared/apiTypes";
import { loadExternalPlugins } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import { PiWebApp } from "./PiWebApp";
import { WorkspacePanel } from "./WorkspacePanel";
import { themeStylesheetFetch } from "./themeStylesheetFetch.testSupport";

// Keep real shell, registry, loader and public callback adaptation; omit socket/API startup.
class ApplicationPanelsApp extends PiWebApp {
  override connectedCallback(): void { LitElement.prototype.connectedCallback.call(this); }
}
customElements.define("application-panels-test-app", ApplicationPanelsApp);
customElements.define("application-host-terminal", class extends TerminalPanel {});

const workspace = { id: "workspace", projectId: "project", path: "/repo", label: "main", isMain: true, effectiveConfig: {} };
const project = { id: "project", name: "Project", path: "/repo", createdAt: "now" };
const remote = { id: "remote", name: "Remote box", kind: "remote" as const, createdAt: "now", updatedAt: "now" };

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // Layout/scroll scheduling is not the behavior under test.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses bundled Info with no project, workspace or session and follows selection without reactivation", async () => {
  const activate = vi.fn(infoPlugin.activate);
  const app = await mount({ ...infoPlugin, activate });
  const panel = toolSurface(app);
  expect(panel.shadowRoot?.textContent).toContain("PI WEB status is not available yet");
  expect(panel.shadowRoot?.textContent).toContain("Machine");
  expect(panel.shadowRoot?.textContent).not.toContain("Workspace");
  expect(navigationTabs(app).querySelector('[aria-label="Info"]')).not.toBeNull();
  const status: PiWebStatusResponse = {
    packageName: "@jmfederico/pi-web", generatedAt: "now",
    components: {
      web: { component: "web", label: "Web/UI", runtimeVersion: "1.202610.0", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true },
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false }, commands: {}, messages: [],
  };
  patchState(app, { piWebStatus: status });
  await settle(app);
  expect(panel.shadowRoot?.textContent).toContain("1.202610.0");
  expect(panel.shadowRoot?.textContent).toContain("Services");

  patchState(app, { selectedMachine: remote, selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  expect(panel.shadowRoot?.textContent).toContain("Remote box");
  expect(panel.shadowRoot?.textContent).toContain("remote machine");
  expect(panel.shadowRoot?.textContent).toContain("Workspace");
  expect(panel.shadowRoot?.textContent).toContain("/repo");
  expect(app.shadowRoot?.querySelector("app-navigation-panel")?.shadowRoot?.querySelector("workspace-list")?.shadowRoot?.textContent).toContain("folder");

  patchState(app, { selectedProject: undefined, selectedWorkspace: undefined });
  await settle(app);
  expect(panel.shadowRoot?.textContent).toContain("Remote box");
  expect(panel.shadowRoot?.textContent).not.toContain("/repo");
  expect(activate).toHaveBeenCalledOnce();
});

it("gives public callbacks fresh basic selections and keeps workspace-only tabs out until selected", async () => {
  const contexts: ApplicationPanelContext[] = [];
  const plugin: PiWebPlugin = {
    apiVersion: 4, name: "Selection probe",
    activate: () => ({ contributions: { applicationPanels: [{
      id: "workspace.info", title: "Info", badge: (context) => context.state.selectedProject?.name,
      render: (context) => { contexts.push(context); return html`<p>${context.state.selectedSession?.name ?? "No session"}</p>`; },
    }] } }),
  };
  const app = await mount(plugin);
  const registry = registryFor(app);
  const workspaceRender = vi.fn(() => html`<p>Workspace only</p>`);
  await registry.register({ id: "workspace-only", plugin: { apiVersion: 4, name: "Workspace only", activate: () => ({
    contributions: { workspacePanels: [{ id: "panel", title: "Workspace only", render: workspaceRender }] },
  }) } });
  patchState(app, { error: "Unrelated update" });
  await settle(app);
  expect(navigationTabs(app).textContent).not.toContain("Workspace only");
  expect(workspaceRender).not.toHaveBeenCalled();
  expect(contexts.at(-1)?.workspace).toBeUndefined();
  expect(contexts.at(-1)?.terminal).toBeUndefined();

  const session = { id: "session", name: "Conversation", cwd: "/repo", path: "/private/session.jsonl", created: "now", modified: "now", messageCount: 1, firstMessage: "private" };
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, selectedSession: session, workspaces: [workspace] });
  await settle(app);
  const context = contexts.at(-1);
  expect(context?.state.selectedProject).toEqual({ id: "project", name: "Project", path: "/repo" });
  expect(context?.state.selectedWorkspace).not.toHaveProperty("effectiveConfig");
  expect(context?.state.selectedSession).toEqual({ id: "session", name: "Conversation", cwd: "/repo", archived: false, pending: false });
  expect(context?.state).not.toHaveProperty("messages");
  expect(context?.state.selectedSession).not.toHaveProperty("path");
  expect(context?.workspace?.id).toBe("workspace");
  expect(context?.terminal).toBeUndefined(); // Terminal-disabled recovery still supplies workspace information.
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Conversation");
  expect(navigationTabs(app).textContent).toContain("Workspace only");
  expect(navigationTabs(app).querySelector('[aria-label="Info, Project"]')).not.toBeNull();

  patchState(app, { selectedSession: { ...session, name: "Renamed" } });
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Renamed");
  contexts.at(-1)?.host.requestRender();
  await settle(app);
  expect(contexts.at(-1)).not.toBe(context);
});

it("supplies an external plugin live selection while its panel is closed, with early and lifetime unsubscribe", async () => {
  let selection: PluginSelectionService | undefined;
  const received = vi.fn();
  const early = vi.fn();
  let unsubscribe: () => void = () => undefined;
  const render = vi.fn(() => html`<p>Selection observer</p>`);
  const activate = vi.fn<Extract<PiWebPlugin, { apiVersion: 4 }>["activate"]>((context) => {
    expect(context.apiVersion).toBe(4);
    selection = context.selection;
    if (selection === undefined) throw new Error("Missing public selection service");
    selection.subscribe(received);
    unsubscribe = selection.subscribe(early);
    return { contributions: { applicationPanels: [
      { id: "workspace.selection", title: "Selection", render },
      { id: "other", title: "Other", render: () => html`<p>Other tab</p>` },
    ] } };
  });
  const app = await mount({ apiVersion: 4, name: "Selection observer", activate }, {
    id: "selection", state: { workspaceTool: "selection:other" },
  });
  expect(selection?.getSnapshot()).toEqual({});
  expect(received).not.toHaveBeenCalled(); // subscribe is not an initial notification.
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Other tab");
  expect(render).not.toHaveBeenCalled();

  patchState(app, { selectedMachine: remote });
  expect(selection?.getSnapshot().selectedMachine).toEqual({ id: "remote", name: "Remote box", kind: "remote" });
  await settle(app);
  expect(received).toHaveBeenLastCalledWith({ selectedMachine: { id: "remote", name: "Remote box", kind: "remote" } });
  unsubscribe();
  unsubscribe();
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  expect(received).toHaveBeenLastCalledWith({
    selectedMachine: { id: "remote", name: "Remote box", kind: "remote" },
    selectedProject: { id: "project", name: "Project", path: "/repo" },
    selectedWorkspace: { id: "workspace", projectId: "project", path: "/repo", label: "main", isMain: true },
  });
  expect(early).toHaveBeenCalledOnce();

  const session = { id: "session", name: "Conversation", cwd: "/repo", path: "/private/session.jsonl",
    created: "now", modified: "now", messageCount: 1, firstMessage: "private" };
  // Exercise the same state commit used by host controllers, not a service-only publish.
  const setState: unknown = Reflect.get(app, "setState");
  if (typeof setState !== "function") throw new Error("Expected host state commit");
  Reflect.apply(setState, app, [{ selectedSession: session }]);
  expect(selection?.getSnapshot().selectedSession).toEqual({ id: "session", name: "Conversation", cwd: "/repo", archived: false, pending: false });
  await settle(app);
  expect(received).toHaveBeenLastCalledWith(expect.objectContaining({
    selectedSession: { id: "session", name: "Conversation", cwd: "/repo", archived: false, pending: false },
  }));
  patchState(app, { selectedSession: { ...session, name: "Renamed", archived: true } });
  await settle(app);
  expect(selection?.getSnapshot().selectedSession).toEqual({ id: "session", name: "Renamed", cwd: "/repo", archived: true, pending: false });
  const notifications = received.mock.calls.length;
  patchState(app, { error: "Unrelated update", mainView: "chat", piWebStatus: updatesStatus });
  await settle(app);
  expect(received).toHaveBeenCalledTimes(notifications);
  expect(selection?.getSnapshot()).not.toHaveProperty("mainView");
  expect(selection?.getSnapshot()).not.toHaveProperty("piWebStatus");
  expect(render).not.toHaveBeenCalled();

  patchState(app, { selectedMachine: undefined, selectedProject: undefined, selectedWorkspace: undefined, selectedSession: undefined });
  await settle(app);
  expect(received).toHaveBeenLastCalledWith({});
  navigationButton(app, "Selection").click();
  await settle(app);
  expect(render).toHaveBeenCalled();
  expect(activate).toHaveBeenCalledOnce();
  const beforeShutdown = received.mock.calls.length;
  app.remove(); // Real host disconnect aborts the plugin lifetime before disposal.
  const late = vi.fn();
  selection?.subscribe(late);
  patchState(app, { selectedMachine: remote });
  registryFor(app).notifySelectionChanged();
  expect(received).toHaveBeenCalledTimes(beforeShutdown);
  expect(late).not.toHaveBeenCalled();
});

it("discovers registered projects and directories through a portable public panel with captured machine targets", async () => {
  const contexts: ApplicationPanelContext[] = [];
  const workspaceContexts: WorkspacePanelContext[] = [];
  let actionProjects: PluginProjects | undefined;
  let discovery = "";
  const activate = vi.fn<Extract<PiWebPlugin, { apiVersion: 4 }>["activate"]>(() => ({ contributions: {
    applicationPanels: [{
      id: "workspace.discovery", title: "Discovery",
      render: (context) => {
        contexts.push(context);
        return html`<button @click=${async () => {
          if (context.projects === undefined) throw new Error("Missing public project discovery");
          const projects = await context.projects.listProjects();
          const directories = await context.projects.suggestDirectories("/repo & docs");
          discovery = `${projects[0]?.name ?? "No projects"}: ${directories[0]?.path ?? "No directories"}`;
          context.host.requestRender();
        }}>Discover projects</button><p>${discovery}</p>`;
      },
    }],
    actions: [{ id: "discover", title: "Discover", run: (context) => { actionProjects = context.projects; } }],
    workspacePanels: [{ id: "workspace-only", title: "Workspace discovery", render: (context) => {
      workspaceContexts.push(context); return html`Workspace discovery`;
    } }],
  } }));
  const app = await mount({ apiVersion: 4, name: "Discovery", activate }, { id: "discovery" });
  const fetch = projectDiscoveryTransport();
  const localProjects = contexts.at(-1)?.projects;
  if (localProjects === undefined) throw new Error("Expected public projects on the host context");
  expect(localProjects.machineId).toBe("local");
  expect(Object.isFrozen(localProjects)).toBe(true);
  expect(localProjects).not.toHaveProperty("addProject");
  toolSurface(app).shadowRoot?.querySelector<HTMLButtonElement>(".panel-content button")?.click();
  await vi.waitFor(() => {
    expect(toolSurface(app).shadowRoot?.textContent).toContain("local project: /local/directory");
  });
  expect(fetch.mock.calls.map(([url]) => discoveryRequestUrl(url))).toEqual([
    "http://localhost:3000/api/machines/local/projects",
    "http://localhost:3000/api/machines/local/project-directories?q=%2Frepo%20%26%20docs",
  ]);
  expect(await localProjects.listProjects()).toEqual([{ id: "project", name: "local project", path: "/local/repo" }]);

  let resolveLocal: (response: Response) => void = () => { throw new Error("Missing pending request"); };
  fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveLocal = resolve; }));
  const pendingLocal = localProjects.listProjects();
  patchState(app, { selectedMachine: remote });
  await settle(app);
  const remoteProjects = contexts.at(-1)?.projects;
  if (remoteProjects === undefined) throw new Error("Expected remote public projects");
  expect(remoteProjects.machineId).toBe("remote");
  resolveLocal(new Response(JSON.stringify([{ ...project, name: "Pending local project" }])));
  expect(await pendingLocal).toEqual([{ id: "project", name: "Pending local project", path: "/repo" }]);
  expect(await remoteProjects.listProjects()).toEqual([{ id: "project", name: "remote project", path: "/remote/repo" }]);
  expect(await remoteProjects.suggestDirectories("/remote/query")).toEqual([{ path: "/remote/directory" }]);
  expect(await localProjects.listProjects()).toEqual([{ id: "project", name: "local project", path: "/local/repo" }]);
  expect(localProjects.machineId).toBe("local"); // Capturing a service never captures live selection.
  expect(activate).toHaveBeenCalledOnce();

  // Action and workspace callbacks receive the same direct, host-bound public service.
  const createRuntime: unknown = Reflect.get(app, "createPluginRuntimeContext");
  if (typeof createRuntime !== "function") throw new Error("Expected runtime context creation");
  const runtime: unknown = Reflect.apply(createRuntime, app, []);
  if (!isRuntimeContext(runtime)) throw new Error("Expected runtime context");
  const actions = registryFor(app).getActions(runtime);
  await actions.find(({ id }) => id === "discovery:discover")?.run();
  expect(actionProjects?.machineId).toBe("remote");
  expect(await actionProjects?.listProjects()).toEqual([{ id: "project", name: "remote project", path: "/remote/repo" }]);
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  navigationButton(app, "Workspace discovery").click();
  await settle(app);
  expect(workspaceContexts.at(-1)?.projects?.machineId).toBe("remote");
  expect(await workspaceContexts.at(-1)?.projects?.suggestDirectories("/workspace/query"))
    .toEqual([{ path: "/remote/directory" }]);

  fetch.mockClear();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Remote unavailable" }), { status: 502 }));
  await expect(remoteProjects.listProjects()).rejects.toThrow("Remote unavailable");
  fetch.mockRejectedValueOnce(new TypeError("Network failure"));
  await expect(remoteProjects.suggestDirectories("/failed")).rejects.toThrow("Network failure");
  expect(fetch.mock.calls.map(([url]) => new URL(discoveryRequestUrl(url)).pathname)).toEqual([
    "/api/machines/remote/projects", "/api/machines/remote/project-directories",
  ]); // No gateway retry and no substitution from the host's loaded project state.
});

it.each([false, true])("keeps machine-specific discovery bound under existing loading and visibility rules (gateway specific: %s)", async (gatewaySpecific) => {
  const gatewayContexts: ApplicationPanelContext[] = [];
  const remoteContexts: ApplicationPanelContext[] = [];
  const plugin = (contexts: ApplicationPanelContext[], label: string): PiWebPlugin => ({
    apiVersion: 4, name: "Discovery", activate: () => ({ contributions: { applicationPanels: [{
      id: "workspace.discovery", title: "Discovery", render: (context) => { contexts.push(context); return html`<p>${label}</p>`; },
    }] } }),
  });
  const app = await mount(plugin(gatewayContexts, "Gateway discovery"), { id: "discovery", machineSpecific: gatewaySpecific });
  const fetch = projectDiscoveryTransport();
  const registry = registryFor(app);
  const moduleLoader = vi.fn(() => Promise.resolve({ default: plugin(remoteContexts, "Remote discovery") }));
  const manifest = (machineSpecific: boolean) => new Response(JSON.stringify({
    lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION, terminalMode: "recovery-disabled",
    plugins: [{ id: "discovery", module: "discovery/pi-web-plugin.js", machineSpecific }],
  }));
  const loadRemote = () => loadExternalPlugins(undefined, {
    machineId: "remote", moduleLoader,
    shouldLoadPlugin: (entry) => registry.shouldLoadRemotePlugin(entry.id, entry.machineSpecific),
  });
  if (!gatewaySpecific) {
    fetch.mockResolvedValueOnce(manifest(false));
    expect((await loadRemote()).registrations).toEqual([]); // Gateway portable duplicates are not imported.
    expect(moduleLoader).not.toHaveBeenCalled();
  }
  fetch.mockResolvedValueOnce(manifest(true));
  const loaded = await loadRemote();
  expect(loaded.failures).toEqual([]);
  expect((await registry.registerBatch(loaded.registrations, { declarations: loaded.declarations })).failures).toEqual([]);
  const gatewayProjects = gatewayContexts.at(-1)?.projects;
  const gatewayRenders = gatewayContexts.length;

  Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"]]));
  patchState(app, { selectedMachine: remote });
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).not.toContain("Remote discovery");
  expect(remoteContexts).toHaveLength(0); // No callbacks until the selected machine's loading gate opens.
  Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"], ["remote", "recovery-disabled"]]));
  invalidateToolSurface(app);
  await settle(app);
  navigationButton(app, "Discovery").click();
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Remote discovery");
  expect(toolSurface(app).shadowRoot?.textContent).not.toContain("Gateway discovery");
  expect(gatewayContexts).toHaveLength(gatewayRenders);
  const remoteProjects = remoteContexts.at(-1)?.projects;
  expect(remoteProjects?.machineId).toBe("remote");
  expect(await remoteProjects?.listProjects()).toEqual([{ id: "project", name: "remote project", path: "/remote/repo" }]);
  expect(await gatewayProjects?.listProjects()).toEqual([{ id: "project", name: "local project", path: "/local/repo" }]);

  const remoteRenders = remoteContexts.length;
  patchState(app, { selectedMachine: undefined });
  await settle(app);
  navigationButton(app, "Discovery").click();
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Gateway discovery");
  expect(remoteContexts).toHaveLength(remoteRenders);
  expect(await remoteProjects?.suggestDirectories("/retained/remote"))
    .toEqual([{ path: "/remote/directory" }]); // Retained machine-specific access cannot drift to local.
  expect(gatewayContexts.at(-1)?.projects?.machineId).toBe("local");
});

function projectDiscoveryTransport() {
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const url = new URL(discoveryRequestUrl(input));
    const match = /^\/api\/machines\/([^/]+)\/(projects|project-directories)$/u.exec(url.pathname);
    if (match === null) throw new Error(`Unexpected discovery URL: ${url.href}`);
    const machineId = decodeURIComponent(match[1] ?? "");
    return Promise.resolve(new Response(JSON.stringify(match[2] === "projects"
      ? [{ ...project, name: `${machineId} project`, path: `/${machineId}/repo` }]
      : [{ path: `/${machineId}/directory`, kind: "other" }])));
  });
  vi.stubGlobal("fetch", themeStylesheetFetch(fetch));
  return fetch;
}

function isRuntimeContext(value: unknown): value is InternalPluginRuntimeContext {
  return typeof value === "object" && value !== null && "navigate" in value && typeof value.navigate === "function";
}

function discoveryRequestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

it("opens an application tab through existing navigation without a workspace and retains invalid-tool errors", async () => {
  const app = await mount(infoPlugin);
  navigationButton(app, "Info").click();
  await settle(app);
  expect(new URL(window.location.href).searchParams.get("tool")).toBe("info:workspace.info");
  expect(new URL(window.location.href).searchParams.get("view")).toBe("workspace");
  expect(toolSurface(app).shadowRoot?.querySelector(".panel-content")?.textContent).toContain("Machine");

  window.history.replaceState(null, "", "?tool=missing%3Apanel&view=workspace");
  app.requestUpdate();
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Workspace panel unavailable: missing:panel");
  expect(toolSurface(app).shadowRoot?.querySelector(".panel-content")).toBeNull();
  navigationButton(app, "Info").click();
  await settle(app);
  expect(toolSurface(app).shadowRoot?.querySelector(".panel-content")?.textContent).toContain("Machine");
});

it("shows bundled Updates guidance and Copy without selections, retaining visibility, badges and identity", async () => {
  const activate = vi.fn(updatesPlugin.activate);
  const app = await mount({ ...updatesPlugin, activate }, { id: "updates", state: { piWebStatus: updatesStatus } });
  const panel = toolSurface(app);
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  expect(panel.shadowRoot?.textContent).toContain("PI WEB update available");
  expect(panel.shadowRoot?.textContent).toContain("Installed services");
  expect(navigationTabs(app).querySelector('[aria-label="Updates, 1"]')).not.toBeNull();
  expect(commandButtons(panel, "Run")).toHaveLength(0);
  commandButtons(panel, "Copy")[0]?.click();
  expect(writeText).toHaveBeenCalledExactlyOnceWith("node /workspace/dist/cli.js update");
  expect(registryFor(app).resolveWorkspacePanelRouteId("updates:workspace.updates", "local")).toBe("updates:workspace.updates");
  expect(registryFor(app).getWorkspacePanels()).toEqual([]);
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  expect(commandButtons(panel, "Run")).toHaveLength(0); // Workspace selection alone cannot enable Terminal-disabled recovery.
  patchState(app, { selectedProject: undefined, selectedWorkspace: undefined });
  await settle(app);

  navigationButton(app, "Updates, 1").click();
  await settle(app);
  expect(new URL(window.location.href).searchParams.get("tool")).toBe("updates:workspace.updates");

  patchState(app, { piWebStatus: { ...updatesStatus, messages: [] } });
  await settle(app);
  expect(navigationTabs(app).querySelector('[aria-label="Updates"]')).not.toBeNull();
  const managed = { kind: "pi-package" as const };
  patchState(app, { piWebStatus: {
    ...updatesStatus, messages: [],
    components: {
      web: { ...updatesStatus.components.web, installation: managed },
      sessiond: { ...updatesStatus.components.sessiond, installation: managed },
    },
  } });
  await settle(app);
  expect(navigationTabs(app).querySelector('[aria-label="Updates"]')).toBeNull();
  expect(activate).toHaveBeenCalledOnce();
});

it("runs Updates in maintenance scope without a workspace, on the current machine, and rejects stale clicks", async () => {
  const app = await mount(updatesPlugin, { id: "updates", state: { piWebStatus: updatesStatus } });
  const panel = toolSurface(app);
  const { createWorkspaceTerminal, createMaintenanceTerminal, runCommand } = installTerminal(app, "local");
  app.requestUpdate();
  await settle(app);
  expect(commandButtons(panel, "Run").length).toBeGreaterThan(0);
  expect(createMaintenanceTerminal.mock.calls.at(-1)?.[0]).toMatchObject({ origin: "updates", machineId: "local" });
  commandButtons(panel, "Run")[0]?.click();
  expect(runCommand).toHaveBeenCalledOnce();
  expect(createWorkspaceTerminal).not.toHaveBeenCalled();
  runCommand.mockClear();
  createMaintenanceTerminal.mockClear();

  window.history.replaceState(null, "", "?project=project&workspace=workspace&tool=updates%3Aworkspace.updates&view=workspace");
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  const run = commandButtons(panel, "Run")[0];
  if (run === undefined) throw new Error("Expected Updates Run with a maintenance Terminal");
  run.click();
  expect(createMaintenanceTerminal).toHaveBeenCalled();
  expect(createMaintenanceTerminal.mock.calls.at(-1)?.[0]).toMatchObject({ origin: "updates", machineId: "local" });
  expect(createWorkspaceTerminal).not.toHaveBeenCalled();
  expect(runCommand).toHaveBeenCalledExactlyOnceWith({
    title: "Update PI WEB", command: "node /workspace/dist/cli.js update", open: true, metadata: { "pi.plugin": "updates" },
  });

  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.history.replaceState(null, "", "?machine=remote&project=project&workspace=workspace&tool=updates%3Aworkspace.updates&view=workspace");
  patchState(app, { selectedMachine: remote });
  run.click(); // A retained local callback must not run after selection changed, even before rerender.
  await vi.waitFor(() => {
    expect(error).toHaveBeenCalledWith(
      'Updates plugin failed to run "Update PI WEB"', expect.objectContaining({ message: "Maintenance terminal context is no longer current" }),
    );
  });
  expect(runCommand).toHaveBeenCalledOnce();
  await settle(app);
  expect(commandButtons(panel, "Run")).toHaveLength(0); // Never borrow the gateway Terminal.
  expect(commandButtons(panel, "Copy").length).toBeGreaterThan(0);

  const { createMaintenanceTerminal: remoteTerminal } = installTerminal(app, "remote");
  app.requestUpdate();
  await settle(app);
  const remoteRun = commandButtons(panel, "Run")[0];
  expect(remoteRun).toBeDefined();
  expect(new URL(window.location.href).searchParams.get("machine")).toBe("remote");
  remoteRun?.click();
  expect(remoteTerminal).toHaveBeenCalled();
  expect(remoteTerminal.mock.calls.at(-1)?.[0]).toMatchObject({ origin: "updates", machineId: "remote" });
  expect(createWorkspaceTerminal).not.toHaveBeenCalled();

  patchState(app, { selectedProject: undefined, selectedWorkspace: undefined });
  await settle(app);
  expect(commandButtons(panel, "Run").length).toBeGreaterThan(0);
  expect(commandButtons(panel, "Copy").length).toBeGreaterThan(0);
});

it("scopes application queries per contribution and refreshes restored queries without Terminal ids", async () => {
  const contexts: ApplicationPanelContext[] = [];
  const invalidated: ApplicationPanelContext[] = [];
  const app = await mount({ apiVersion: 4, name: "Probe", activate: () => ({ contributions: { applicationPanels: [{
    id: "workspace.probe", title: "Probe",
    render: (context) => { contexts.push(context); return html`Probe`; },
    onInvalidate: (context) => { invalidated.push(context); },
  }] } }) }, { id: "probe" });
  expect(contexts.at(-1)?.navigation).toBeUndefined();
  const refreshCurrent: unknown = Reflect.get(app, "refreshCurrentWorkspaceSurface");
  if (typeof refreshCurrent !== "function") throw new Error("Expected current surface refresh boundary");
  await Reflect.apply(refreshCurrent, app, []);
  expect(invalidated).toHaveLength(1);
  expect(invalidated[0]?.workspace).toBeUndefined();
  window.history.replaceState(null, "", "/?project=project&workspace=workspace&tool=probe%3Aworkspace.probe&probe.workspace.probe--terminal=restored");
  patchState(app, { selectedProject: project, selectedWorkspace: workspace });
  await settle(app);
  const navigation = contexts.at(-1)?.navigation;
  expect(navigation?.contributionId).toBe("probe:workspace.probe");
  expect(navigation?.query).toEqual({ terminal: "restored" });
  expect(navigation?.set("terminal", "selected")).toBe(true);
  expect(new URL(window.location.href).searchParams.get("probe.workspace.probe--terminal")).toBe("selected");
  const refresh: unknown = Reflect.get(app, "invalidateWorkspacePanels");
  if (typeof refresh !== "function") throw new Error("Expected panel refresh boundary");
  await Reflect.apply(refresh, app, ["probe:workspace.probe", {
    identity: { machineId: "local", projectId: "project", workspaceId: "workspace" },
    query: { "probe.workspace.probe--terminal": "history" },
  }]);
  expect(invalidated.at(-1)?.navigation?.query).toEqual({ terminal: "history" });
  patchState(app, { selectedMachine: remote });
  expect(navigation?.set("terminal", "stale")).toBe(false);
});

it("keeps real Terminal selection stable across no-project host rerenders and workspace changes", async () => {
  installTerminalRendererFake();
  const runtime = new TerminalBrowserRuntime();
  const maintenance = { id: "maintenance-output", scope: "maintenance", cwd: "/maintenance", name: "Update", createdAt: "now", exited: true };
  const maintenanceRequest = vi.fn((operation: string) => Promise.resolve(operation === "terminal.list" ? [maintenance] : []));
  const workspaceRequest = vi.fn(() => Promise.resolve([]));
  let hostRenders = 0;
  let panelContexts = 0;
  const peer = {
    request: maintenanceRequest,
    openChannel: vi.fn(() => Promise.resolve({ closed: new Promise<never>(() => undefined), send: vi.fn(), close: vi.fn() })),
  };
  const backend = { machineId: "local", forScope: (scope: { kind: string }) => scope.kind === "machine" ? peer : { ...peer, request: workspaceRequest } };
  const app = await mount({ apiVersion: 4, name: "Terminal lifecycle", activate: () => ({ contributions: { applicationPanels: [{
    id: "workspace.terminal", title: "Terminal",
    render: (context) => {
      panelContexts += 1;
      const host = { requestRender: () => {
        hostRenders += 1;
        if (hostRenders > 20) throw new Error("Terminal selection triggered a host-render loop");
        context.host.requestRender();
      } };
      return html`<application-host-terminal .runtime=${runtime} .context=${applicationTerminalContext({ ...context, backend, host })}></application-host-terminal>`;
    },
  }] } }) }, { id: "terminal-lifecycle", state: { workspaceTool: "terminal-lifecycle:workspace.terminal" } });
  try {
    const terminal = toolSurface(app).shadowRoot?.querySelector("application-host-terminal");
    if (!(terminal instanceof TerminalPanel)) throw new Error("Expected the real Terminal panel");
    await vi.waitFor(() => { expect(terminal.shadowRoot?.querySelector("button.selected")?.textContent).toContain("Update"); });
    await settle(app);
    const settledRenders = hostRenders;
    const settledRequests = maintenanceRequest.mock.calls.length;
    const settledContexts = panelContexts;
    for (let i = 0; i < 4; i += 1) {
      invalidateToolSurface(app);
      app.requestUpdate();
      await settle(app);
    }
    expect(panelContexts).toBeGreaterThan(settledContexts);
    expect(hostRenders).toBe(settledRenders);
    expect(maintenanceRequest).toHaveBeenCalledTimes(settledRequests);

    window.history.replaceState(null, "", "?project=project&workspace=workspace&tool=terminal-lifecycle%3Aworkspace.terminal&view=workspace");
    patchState(app, { selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
    invalidateToolSurface(app);
    app.requestUpdate();
    await settle(app);
    await vi.waitFor(() => { expect(terminal.shadowRoot?.querySelector("button.selected")?.textContent).toContain("Update"); });
    window.history.replaceState(null, "", "?tool=terminal-lifecycle%3Aworkspace.terminal&view=workspace");
    patchState(app, { selectedProject: undefined, selectedWorkspace: undefined });
    invalidateToolSurface(app);
    app.requestUpdate();
    await settle(app);
    await vi.waitFor(() => { expect(terminal.shadowRoot?.querySelector("button.selected")?.textContent).toContain("Update"); });
    const afterReturn = hostRenders;
    invalidateToolSurface(app);
    app.requestUpdate();
    await settle(app);
    expect(hostRenders).toBe(afterReturn);
    expect(maintenanceRequest.mock.calls.some(([operation]) => operation === "terminal.create")).toBe(false);
  } finally {
    app.remove();
    runtime.dispose();
  }
});

it("opens the unified Terminal contribution without a workspace and ignores retained host navigation", async () => {
  const app = await mount({ apiVersion: 4, name: "Terminal", activate: () => ({ contributions: { applicationPanels: [{
    id: "workspace.terminal", title: "Terminal", render: () => html`Terminal output`,
  }] } }) }, { id: "terminal-probe", state: { workspaceTool: undefined } });
  const { createMaintenanceTerminal, createWorkspaceTerminal } = installTerminal(app, "local", "terminal-probe");
  createMaintenanceTerminal.mockClear();
  const open: unknown = Reflect.get(app, "openTerminal");
  if (typeof open !== "function") throw new Error("Expected Terminal action boundary");
  Reflect.apply(open, app, []);
  const binding = createMaintenanceTerminal.mock.calls.at(-1)?.[0];
  expect(binding?.registrationPluginId).toBe("terminal-probe");
  expect(createWorkspaceTerminal).not.toHaveBeenCalled();
  binding?.host.navigateApplicationContribution("terminal-probe:workspace.terminal");
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Terminal output");
  patchState(app, { selectedMachine: remote, workspaceTool: undefined });
  binding?.host.navigateApplicationContribution("terminal-probe:workspace.terminal");
  expect(Reflect.get(app, "state")).toMatchObject({ selectedMachine: remote, workspaceTool: undefined });
});

const updatesStatus: PiWebStatusResponse = {
  packageName: "@jmfederico/pi-web", generatedAt: "now",
  components: {
    web: { component: "web", label: "Web/UI", stale: false, available: true, installation: { kind: "docker" } },
    sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true, installation: { kind: "docker" } },
  },
  release: { packageName: "@jmfederico/pi-web", updateAvailable: true },
  commands: { update: "node /workspace/dist/cli.js update" },
  messages: [{ id: "update", severity: "info", title: "PI WEB update available", body: "Update and restart to use the new release." }],
};

// Inject only Terminal's command boundary; the shell, public loader, registry and freshness facade remain real.
function installTerminal(app: PiWebApp, machineId: string, registrationPluginId = machineId === "local" ? "pi-web.terminal" : "remote-terminal") {
  const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>((input) => {
    const run = {
      id: "run", origin: "updates", scope: "maintenance" as const,
      terminalId: "terminal", title: input.title, command: input.command, status: "succeeded" as const, createdAt: "now", metadata: {},
    };
    return Promise.resolve({ run, completed: Promise.resolve(run) });
  });
  const createWorkspaceTerminal = vi.fn<RequiredTerminalBrowserFacadeV1["createWorkspaceTerminal"]>(() => ({
    open: () => undefined,
    runCommand: vi.fn<WorkspacePanelTerminal["runCommand"]>(() => Promise.reject(new Error("Unexpected workspace command"))),
  }));
  const createMaintenanceTerminal = vi.fn<NonNullable<RequiredTerminalBrowserFacadeV1["createMaintenanceTerminal"]>>(() => ({
    open: () => undefined, runCommand,
  }));
  const composition: RequiredTerminalBrowserComposition = {
    binding: {
      registrationPluginId,
      sourcePluginId: "pi-web.terminal", backendRevision: `${machineId}-revision`, pairedRequestVersion: 1, pairedChannelVersion: 1,
    },
    facade: {
      version: 1, createWorkspaceTerminal, createMaintenanceTerminal, listCommandRuns: () => Promise.resolve([]),
      parseCommandRun: () => { throw new Error("Unexpected command parsing"); },
    },
  };
  const compositions: unknown = Reflect.get(app, "requiredTerminalByMachine");
  if (!(compositions instanceof Map)) throw new Error("Expected Terminal compositions");
  compositions.set(machineId, composition);
  invalidateToolSurface(app);
  return { createWorkspaceTerminal, createMaintenanceTerminal, runCommand };
}

function invalidateToolSurface(app: PiWebApp): void {
  // Production plugin loading invalidates the guarded surface when composition becomes available.
  const invalidate: unknown = Reflect.get(app, "invalidateWorkspaceSurface");
  if (typeof invalidate !== "function") throw new Error("Expected workspace surface invalidation");
  Reflect.apply(invalidate, app, []);
}

function commandButtons(panel: WorkspacePanel, label: string): HTMLButtonElement[] {
  return [...panel.shadowRoot?.querySelectorAll<HTMLButtonElement>(".updates-command-actions button") ?? []].filter((button) => button.textContent === label);
}

async function mount(plugin: PiWebPlugin, { id = "info", state = {}, machineSpecific = false }: { id?: string; state?: Partial<AppState>; machineSpecific?: boolean } = {}): Promise<ApplicationPanelsApp> {
  vi.stubGlobal("fetch", themeStylesheetFetch(vi.fn().mockResolvedValue(new Response(JSON.stringify({
    lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION, terminalMode: "recovery-disabled",
    plugins: [{ id, module: `${id}/pi-web-plugin.js`, machineSpecific }],
  })))));
  const app = new ApplicationPanelsApp();
  Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"], ["remote", "recovery-disabled"]]));
  const loaded = await loadExternalPlugins(undefined, { moduleLoader: () => Promise.resolve({ default: plugin }) });
  expect(loaded.failures).toEqual([]);
  await registryFor(app).registerBatch(loaded.registrations, { declarations: loaded.declarations });
  Reflect.set(app, "state", { ...initialAppState(), workspaceTool: `${id}:workspace.${id}`, ...state });
  document.body.append(app);
  await settle(app);
  return app;
}

function registryFor(app: PiWebApp): PluginRegistry {
  const registry: unknown = Reflect.get(app, "plugins");
  if (!(registry instanceof PluginRegistry)) throw new Error("Expected plugin registry");
  return registry;
}

// The harness uses the stacked layout: tool content and navigation have separate hosts.
function navigationTabs(app: PiWebApp): ShadowRoot {
  const root = app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot;
  if (root === undefined || root === null) throw new Error("Expected stacked navigation tabs");
  return root;
}

function navigationButton(app: PiWebApp, label: string): HTMLButtonElement {
  const button = [...navigationTabs(app).querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (button === undefined) throw new Error(`Expected navigation button: ${label}`);
  return button;
}

function toolSurface(app: PiWebApp): WorkspacePanel {
  const panel = app.shadowRoot?.querySelector("workspace-panel");
  if (!(panel instanceof WorkspacePanel)) throw new Error("Expected tool surface");
  return panel;
}

function patchState(app: PiWebApp, patch: Partial<AppState>): void {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("Expected app state");
  Reflect.set(app, "state", { ...state, ...patch });
}

async function settle(element: LitElement): Promise<void> {
  await element.updateComplete;
  for (const child of element.shadowRoot?.querySelectorAll("*") ?? []) {
    if (child instanceof LitElement) await settle(child);
  }
  await element.updateComplete;
}
