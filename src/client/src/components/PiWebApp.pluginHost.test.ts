// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesRuntime } from "../../../../pi-web-plugins/files/FilesRuntime";
import { TerminalBrowserRuntime } from "../../../../pi-web-plugins/terminal/TerminalBrowserRuntime";
import { TerminalFacade, type RequiredTerminalBrowserFacadeV1, type RequiredTerminalWorkspaceBindingV1 } from "../../../../pi-web-plugins/terminal/TerminalFacade";
import { InMemoryTerminalSelectionMemory } from "../../../../pi-web-plugins/terminal/terminalSelection";
import type { WorkspaceFilesCapabilityV1, WorkspacePanelContext as PublicWorkspacePanelContext } from "../../../plugin-api";
import type { Machine, Project, TerminalCommandRun, Workspace } from "../api";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { initialAppState } from "../appState";
import { browserErrorScopeKey, workspaceBrowserErrorScope } from "../browserErrors";
import type { MachineNavigationSnapshot } from "../controllers/machineNavigationMemory";
import { loadExternalPlugins, type PluginManifestEntry } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import type { PiWebPlugin, PluginRuntimeContext, WorkspaceInvalidation, WorkspacePanelContext, WorkspacePanelNavigationV1 } from "../plugins/types";
import { PiWebApp } from "./PiWebApp";

vi.mock("../plugins/external", () => ({ loadExternalPlugins: vi.fn() }));

const project: Project = { id: "project-1", name: "Project", path: "/repo", createdAt: "now" };
const remoteMachine: Machine = { id: "remote-1", name: "Remote", kind: "remote", createdAt: "now", updatedAt: "now" };
const TERMINAL_PANEL_ID = "terminal:workspace.terminal";

const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
  effectiveConfig: {},
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(loadExternalPlugins).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
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
    installTestTerminalComposition(app, "local");
    const invalidated = vi.fn<(context: WorkspacePanelContext, invalidation?: WorkspaceInvalidation) => void>();
    appPluginRegistry(app).register({ id: "browser-only", plugin: pluginWithPanel("Browser only", invalidated) });

    await callAsyncAppMethod(app, "refreshCurrentWorkspaceSurface");
    await callAsyncAppMethod(app, "refreshRestoredWorkspaceTool", "browser-only:workspace.panel");
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
    const agentCall = invalidated.mock.calls[4];
    expect(agentCall?.[0].machine.id).toBe("local");
    expect(agentCall?.[0].workspace.id).toBe("workspace-1");
    expect(agentCall?.[1]).toEqual({ reason: "agent-activity", resources: ["workspace.files"] });
  });

  it("keeps legacy refreshFiles behavior through scoped workspace.files invalidation", async () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "core:workspace.files",
    });
    installTestTerminalComposition(app, "local");
    let finishSubscription: () => void = () => undefined;
    const subscription = new Promise<void>((resolve) => { finishSubscription = resolve; });
    const subscribed = vi.fn<(context: WorkspacePanelContext, invalidation?: WorkspaceInvalidation) => Promise<void>>(() => subscription);
    const legacy = vi.fn();
    appPluginRegistry(app).register({
      id: "browser-only",
      plugin: {
        apiVersion: 2,
        name: "Browser only",
        activate: ({ html }) => ({
          contributions: {
            workspacePanels: [
              { id: "resource", title: "Resource", invalidationResources: ["workspace.files"], onInvalidate: subscribed, render: () => html`<p>Resource</p>` },
              { id: "legacy", title: "Legacy", onInvalidate: legacy, render: () => html`<p>Legacy</p>` },
            ],
          },
        }),
      },
    });
    const runtime = createPluginRuntimeContext(app);
    const refreshFiles: unknown = Reflect.get(runtime, "refreshFiles");
    if (!isAsyncVoidCallback(refreshFiles)) throw new Error("Legacy refreshFiles runtime alias was unavailable");
    let aliasSettled = false;
    const aliasCompletion = Promise.resolve(refreshFiles()).then(() => { aliasSettled = true; });
    await Promise.resolve();

    expect(subscribed).toHaveBeenCalledOnce();
    expect(aliasSettled).toBe(false);
    finishSubscription();
    await aliasCompletion;
    expect(aliasSettled).toBe(true);
    expect(subscribed).toHaveBeenCalledOnce();
    const call = subscribed.mock.calls[0];
    expect(call?.[0].machine.id).toBe("local");
    expect(call?.[0].workspace.id).toBe("workspace-1");
    expect(call?.[1]).toEqual({ reason: "manual", resources: ["workspace.files"] });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("binds panel navigation snapshots and writes to the selected machine/workspace only", () => {
    const browser = installBrowserWindow("http://localhost/app?machine=remote-1&project=project-1&workspace=workspace-1&browser-only.workspace.panel--file=canonical.ts&legacy.workspace.panel--file=legacy.ts&legacy.workspace.panel--mode=preview");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: remoteMachine,
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "browser-only:workspace.panel",
      mainView: "browser-only:workspace.panel",
    });
    setVerifiedPluginMode(app, "local", "recovery-disabled");
    setVerifiedPluginMode(app, remoteMachine.id, "recovery-disabled");
    let navigation: WorkspacePanelNavigationV1 | undefined;
    appPluginRegistry(app).register({
      id: "browser-only",
      plugin: {
        apiVersion: 2,
        name: "Browser only",
        activate: ({ html }) => ({
          contributions: {
            workspacePanels: [{
              id: "workspace.panel",
              title: "Panel",
              navigationAliases: ["legacy:workspace.panel"],
              render: (context) => {
                navigation = context.navigation;
                return html`<p>Panel</p>`;
              },
            }],
          },
        }),
      },
    });
    const panel = appPluginRegistry(app).getWorkspacePanels().find(({ id }) => id === "browser-only:workspace.panel");
    const context = workspacePanelContextFromApp(app);

    panel?.render(context);

    expect(navigation).toMatchObject({
      version: 1,
      contributionId: "browser-only:workspace.panel",
      query: { file: "canonical.ts", mode: "preview" },
    });
    const firstSnapshot = navigation;
    firstSnapshot?.set("file", "src/main.ts");
    expect(browser.pushed).toHaveLength(1);
    expect(browser.url.searchParams.get("browser-only.workspace.panel--file")).toBe("src/main.ts");
    expect(browser.url.searchParams.has("legacy.workspace.panel--file")).toBe(false);
    expect(machineNavigationSnapshot(app, "remote-1")?.surface.contributionQuery).toMatchObject({
      "browser-only.workspace.panel--file": "src/main.ts",
      "legacy.workspace.panel--mode": "preview",
    });

    browser.navigate("http://localhost/app?machine=remote-1&project=project-1&workspace=workspace-1&browser-only.workspace.panel--file=back.ts");
    panel?.render(workspacePanelContextFromApp(app));
    expect(navigation?.query).toEqual({ file: "back.ts" });
    expect(firstSnapshot?.query).toEqual({ file: "canonical.ts", mode: "preview" });

    browser.navigate("http://localhost/app?machine=other&project=project-1&workspace=workspace-1&browser-only.workspace.panel--file=other.ts");
    panel?.render(workspacePanelContextFromApp(app));
    expect(navigation?.query).toEqual({});
    const writesBeforeStaleSet = browser.pushed.length;
    firstSnapshot?.set("mode", "raw");
    expect(browser.pushed).toHaveLength(writesBeforeStaleSet);
    expect(browser.url.searchParams.get("browser-only.workspace.panel--mode")).toBeNull();
  });

  it("restores Files legacy routes and query-only history through the real runtime invalidation path", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=files&view=core%3Aworkspace.files&core.workspace.files--file=legacy.ts&core.workspace.files--mode=preview");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: "chat",
    });
    if (!Reflect.set(app, "gatewayPluginLoadPromise", Promise.resolve())) throw new Error("Could not mark gateway plugins loaded");
    if (!Reflect.set(app, "gatewayPluginLoadAttemptComplete", true)) throw new Error("Could not mark gateway plugin loading complete");
    installTestTerminalComposition(app, "local");

    const runtime = new FilesRuntime();
    const readFile = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path) => Promise.resolve({
      path,
      encoding: "utf8",
      size: path.length,
      modifiedAt: "2026-06-25T00:00:00.000Z",
      content: `loaded:${path}`,
      truncated: false,
      binary: false,
    }));
    const files = testWorkspaceFiles({ readFile });
    const contexts: PublicWorkspacePanelContext[] = [];
    registerFilesRuntimePanel(app, runtime, files, contexts);

    await callAsyncAppMethod(app, "restoreRoute", false);
    const legacyContext = contexts[0];
    if (legacyContext === undefined) throw new Error("Files did not receive the legacy route context");
    await vi.waitFor(() => { expect(runtime.snapshot(legacyContext).selectedFileContent?.content).toBe("loaded:legacy.ts"); });

    expect(appState(app)).toMatchObject({
      workspaceTool: "files:workspace.files",
      mainView: "files:workspace.files",
    });
    expect(contexts[0]?.navigation).toMatchObject({
      version: 1,
      contributionId: "files:workspace.files",
      query: { file: "legacy.ts", mode: "preview" },
    });

    browser.navigate("http://localhost/app?project=project-1&workspace=workspace-1&tool=files&view=core%3Aworkspace.files&files.workspace.files--file=back.ts");
    callAppMethod(app, "onPopState");
    await vi.waitFor(() => { expect(contexts).toHaveLength(2); });
    const backContext = contexts[1];
    if (backContext === undefined) throw new Error("Files did not receive the query-only history context");
    await vi.waitFor(() => { expect(runtime.snapshot(backContext).selectedFileContent?.content).toBe("loaded:back.ts"); });

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.navigation).toMatchObject({
      version: 1,
      contributionId: "files:workspace.files",
      query: { file: "back.ts" },
    });
    expect(readFile.mock.calls.map(([path]) => path)).toEqual(["legacy.ts", "back.ts"]);
  });

  it("restores Terminal query-only history through its real runtime invalidation", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=core%3Aworkspace.terminal&view=core%3Aworkspace.terminal&core.workspace.terminal--terminal=terminal-1");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    if (!Reflect.set(app, "gatewayPluginLoadPromise", Promise.resolve())) throw new Error("Could not mark gateway plugins loaded");
    if (!Reflect.set(app, "gatewayPluginLoadAttemptComplete", true)) throw new Error("Could not mark gateway plugin loading complete");
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const restoredTerminalIds: (string | undefined)[] = [];
    appPluginRegistry(app).register({
      id: "terminal",
      sourcePluginId: "terminal",
      machineSpecific: true,
      backendRevision: "local-terminal-r1",
      backendCapabilityVersion: 1,
      channelVersion: 1,
      plugin: {
        apiVersion: 2,
        name: "Terminal",
        activate: ({ html }) => ({
          requiredTerminalFacade: testTerminalFacade(),
          contributions: {
            workspacePanels: [{
              id: "workspace.terminal",
              title: "Terminal",
              routeAliases: ["core:workspace.terminal"],
              navigationAliases: ["core:workspace.terminal"],
              onInvalidate: (context) => {
                const runtimeContext: PublicWorkspacePanelContext = {
                  machine: context.machine,
                  workspace: context.workspace,
                  files: context.files,
                  ...(context.backend === undefined ? {} : { backend: context.backend }),
                  host: context.host,
                  prompt: context.prompt,
                  terminal: context.terminal,
                  ...(context.navigation === undefined ? {} : { navigation: context.navigation }),
                };
                restoredTerminalIds.push(runtime.selectedTerminalId(runtimeContext));
                return runtime.invalidate(runtimeContext);
              },
              render: () => html`<p>Terminal</p>`,
            }],
          },
        }),
      },
    });
    const compositions: unknown = Reflect.get(app, "requiredTerminalByMachine");
    if (!(compositions instanceof Map)) throw new Error("PiWebApp required Terminal composition map was unavailable");
    compositions.set("local", {
      binding: {
        registrationPluginId: "terminal",
        sourcePluginId: "terminal",
        backendRevision: "local-terminal-r1",
        backendCapabilityVersion: 1,
        channelVersion: 1,
      },
      facade: testTerminalFacade(),
    });
    setVerifiedPluginMode(app, "local", "required");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }))));

    await callAsyncAppMethod(app, "restoreRoute", false);
    expect(restoredTerminalIds).toEqual(["terminal-1"]);

    browser.navigate("http://localhost/app?project=project-1&workspace=workspace-1&tool=terminal%3Aworkspace.terminal&view=terminal%3Aworkspace.terminal&terminal.workspace.terminal--terminal=terminal-2");
    callAppMethod(app, "onPopState");
    await vi.waitFor(() => { expect(restoredTerminalIds).toEqual(["terminal-1", "terminal-2"]); });
  });

  it("restores remembered Files navigation through machine A→B→A before each selection settles", async () => {
    const machineA: Machine = { id: "local", name: "Machine A", kind: "local", createdAt: "now", updatedAt: "now" };
    const machineB: Machine = { id: "remote-b", name: "Machine B", kind: "remote", createdAt: "now", updatedAt: "now" };
    const projectA: Project = { id: "project-a", name: "Project A", path: "/repo-a", createdAt: "now" };
    const projectB: Project = { id: "project-b", name: "Project B", path: "/repo-b", createdAt: "now" };
    const workspaceA: Workspace = { id: "workspace-a", projectId: projectA.id, path: "/repo-a", label: "A", isMain: true, effectiveConfig: {} };
    const workspaceB: Workspace = { id: "workspace-b", projectId: projectB.id, path: "/repo-b", label: "B", isMain: true, effectiveConfig: {} };
    const browser = installBrowserWindow("http://localhost/app?project=project-a&workspace=workspace-a&tool=files%3Aworkspace.files&view=files%3Aworkspace.files&core.workspace.files--file=a.ts&core.workspace.files--mode=raw");
    const app = new PiWebApp();
    if (!Reflect.set(app, "schedulePiWebStatusRefresh", () => undefined)) throw new Error("Could not stub deferred status refresh");
    setAppState(app, {
      ...initialAppState(),
      machines: [machineA, machineB],
      selectedMachine: machineA,
      projects: [projectA],
      selectedProject: projectA,
      workspaces: [workspaceA],
      selectedWorkspace: workspaceA,
      workspaceTool: "files:workspace.files",
      mainView: "files:workspace.files",
    });
    markPluginLoadingReady(app, [machineB.id]);
    if (!Reflect.set(app, "restoreRouteMachine", (route: { machineId?: string | undefined }) => {
      const target = (route.machineId ?? "local") === machineB.id
        ? { machine: machineB, project: projectB, workspace: workspaceB }
        : { machine: machineA, project: projectA, workspace: workspaceA };
      setAppState(app, {
        ...appState(app),
        selectedMachine: target.machine,
        projects: [target.project],
        selectedProject: target.project,
        workspaces: [target.workspace],
        selectedWorkspace: target.workspace,
        selectedSession: undefined,
        error: "",
      });
      return Promise.resolve();
    })) throw new Error("Could not stub machine route selection");

    type TestFileContent = Awaited<ReturnType<WorkspaceFilesCapabilityV1["readFile"]>>;
    const pendingReads: { path: string; resolve: (content: TestFileContent) => void }[] = [];
    const readFile = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path) => new Promise<TestFileContent>((resolve) => {
      pendingReads.push({ path, resolve });
    }));
    const resolveRead = (index: number) => {
      const request = pendingReads[index];
      if (request === undefined) throw new Error(`Missing pending file read ${String(index)}`);
      request.resolve({
        path: request.path,
        encoding: "utf8",
        size: request.path.length,
        modifiedAt: "2026-06-25T00:00:00.000Z",
        content: `loaded:${request.path}`,
        truncated: false,
        binary: false,
      });
    };
    const runtime = new FilesRuntime();
    const contexts: PublicWorkspacePanelContext[] = [];
    registerFilesRuntimePanel(app, runtime, testWorkspaceFiles({ readFile }), contexts);
    rememberMachineNavigationSnapshot(app, {
      machineId: machineB.id,
      projectId: projectB.id,
      workspaceId: workspaceB.id,
      tool: "files:workspace.files",
      view: "files:workspace.files",
      surface: {
        contributionQuery: {
          "files.workspace.files--file": "b.ts",
          "files.workspace.files--mode": "preview",
        },
      },
    });

    let toBSettled = false;
    const toB = callAsyncAppMethod(app, "selectMachineWithMemory", machineB);
    void toB.then(() => { toBSettled = true; });
    await vi.waitFor(() => { expect(pendingReads).toHaveLength(1); });
    const contextB = latestFilesContext(contexts, machineB.id);

    expect(toBSettled).toBe(false);
    expect(contextB.navigation?.query).toEqual({ file: "b.ts", mode: "preview" });
    expect(browser.url.searchParams.get("project")).toBe(projectA.id);
    expect(browser.url.searchParams.get("core.workspace.files--file")).toBe("a.ts");
    resolveRead(0);
    await toB;

    expect(appState(app).selectedMachine?.id).toBe(machineB.id);
    expect(runtime.snapshot(contextB)).toMatchObject({
      selectedFilePath: "b.ts",
      selectedFileContent: { path: "b.ts", content: "loaded:b.ts" },
    });
    expect(browser.url.searchParams.get("machine")).toBe(machineB.id);
    expect(browser.url.searchParams.get("files.workspace.files--file")).toBe("b.ts");
    expect(browser.url.searchParams.get("files.workspace.files--mode")).toBe("preview");
    expect(browser.url.searchParams.has("core.workspace.files--file")).toBe(false);

    let toASettled = false;
    const toA = callAsyncAppMethod(app, "selectMachineWithMemory", machineA);
    void toA.then(() => { toASettled = true; });
    await vi.waitFor(() => { expect(pendingReads).toHaveLength(2); });
    const contextA = latestFilesContext(contexts, machineA.id);

    expect(toASettled).toBe(false);
    expect(contextA.navigation?.query).toEqual({ file: "a.ts", mode: "raw" });
    expect(browser.url.searchParams.get("machine")).toBe(machineB.id);
    expect(browser.url.searchParams.get("files.workspace.files--file")).toBe("b.ts");
    resolveRead(1);
    await toA;

    expect(appState(app).selectedMachine?.id).toBe(machineA.id);
    expect(runtime.snapshot(contextA)).toMatchObject({
      selectedFilePath: "a.ts",
      selectedFileContent: { path: "a.ts", content: "loaded:a.ts" },
    });
    expect(readFile.mock.calls.map(([path]) => path)).toEqual(["b.ts", "a.ts"]);
    expect(browser.url.searchParams.has("machine")).toBe(false);
    expect(browser.url.searchParams.get("core.workspace.files--file")).toBe("a.ts");
    expect(browser.url.searchParams.get("core.workspace.files--mode")).toBe("raw");
    expect(browser.url.searchParams.has("files.workspace.files--file")).toBe(false);
    expect(browser.pushed).toHaveLength(2);
    expect(browser.replaced).toHaveLength(2);
    expect(historyUrl(browser.replaced, 0).searchParams.get("files.workspace.files--file")).toBe("b.ts");
    expect(historyUrl(browser.replaced, 0).searchParams.has("core.workspace.files--file")).toBe(false);
    expect(historyUrl(browser.replaced, 1).searchParams.get("core.workspace.files--file")).toBe("a.ts");
    expect(historyUrl(browser.replaced, 1).searchParams.has("files.workspace.files--file")).toBe(false);
  });

  it("preserves the origin history entry when remembered Files is unavailable", async () => {
    const machineA: Machine = { id: "local", name: "Machine A", kind: "local", createdAt: "now", updatedAt: "now" };
    const machineB: Machine = { id: "remote-b", name: "Machine B", kind: "remote", createdAt: "now", updatedAt: "now" };
    const projectA: Project = { id: "project-a", name: "Project A", path: "/repo-a", createdAt: "now" };
    const projectB: Project = { id: "project-b", name: "Project B", path: "/repo-b", createdAt: "now" };
    const workspaceA: Workspace = { id: "workspace-a", projectId: projectA.id, path: "/repo-a", label: "A", isMain: true, effectiveConfig: {} };
    const workspaceB: Workspace = { id: "workspace-b", projectId: projectB.id, path: "/repo-b", label: "B", isMain: true, effectiveConfig: {} };
    const browser = installBrowserWindow("http://localhost/app?project=project-a&workspace=workspace-a&tool=core%3Aworkspace.terminal&view=core%3Aworkspace.terminal");
    const originUrl = browser.url.href;
    const historyLength = window.history.length;
    const app = new PiWebApp();
    if (!Reflect.set(app, "schedulePiWebStatusRefresh", () => undefined)) throw new Error("Could not stub deferred status refresh");
    setAppState(app, {
      ...initialAppState(),
      machines: [machineA, machineB],
      selectedMachine: machineA,
      projects: [projectA],
      selectedProject: projectA,
      workspaces: [workspaceA],
      selectedWorkspace: workspaceA,
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    markPluginLoadingReady(app, [machineB.id]);
    stubRouteMachineSelection(app, () => {
      setAppState(app, {
        ...appState(app),
        selectedMachine: machineB,
        projects: [projectB],
        selectedProject: projectB,
        workspaces: [workspaceB],
        selectedWorkspace: workspaceB,
        selectedSession: undefined,
        error: "",
      });
    });
    rememberMachineNavigationSnapshot(app, {
      machineId: machineB.id,
      projectId: projectB.id,
      workspaceId: workspaceB.id,
      tool: "files:workspace.files",
      view: "files:workspace.files",
      surface: { contributionQuery: { "files.workspace.files--file": "b.ts" } },
    });

    await callAsyncAppMethod(app, "selectMachineWithMemory", machineB);

    expect(appState(app)).toMatchObject({
      selectedMachine: { id: machineB.id },
      selectedWorkspace: { id: workspaceB.id },
      workspaceTool: `${machineScopedPluginId(machineB.id, "terminal")}:workspace.terminal`,
      mainView: `${machineScopedPluginId(machineB.id, "terminal")}:workspace.terminal`,
    });
    expect(window.history.length).toBe(historyLength + 1);
    expect(browser.pushed).toHaveLength(1);
    expect(browser.replaced).toHaveLength(1);
    expect([...browser.pushed, ...browser.replaced].every((href) => new URL(href).searchParams.get("machine") === machineB.id)).toBe(true);
    expect(browser.url.searchParams.get("files.workspace.files--file")).toBe("b.ts");

    window.history.back();
    await vi.waitFor(() => { expect(window.location.href).toBe(originUrl); });
  });

  it("does not publish a missing workspace query under its fallback workspace identity", async () => {
    const machineA: Machine = { id: "local", name: "Machine A", kind: "local", createdAt: "now", updatedAt: "now" };
    const machineB: Machine = { id: "remote-b", name: "Machine B", kind: "remote", createdAt: "now", updatedAt: "now" };
    const projectA: Project = { id: "project-a", name: "Project A", path: "/repo-a", createdAt: "now" };
    const projectB: Project = { id: "project-b", name: "Project B", path: "/repo-b", createdAt: "now" };
    const workspaceA: Workspace = { id: "workspace-a", projectId: projectA.id, path: "/repo-a", label: "A", isMain: true, effectiveConfig: {} };
    const fallbackWorkspace: Workspace = { id: "workspace-fallback", projectId: projectB.id, path: "/repo-b", label: "Fallback", isMain: true, effectiveConfig: {} };
    const browser = installBrowserWindow("http://localhost/app?project=project-a&workspace=workspace-a&tool=core%3Aworkspace.terminal&view=core%3Aworkspace.terminal");
    const originUrl = browser.url.href;
    const app = new PiWebApp();
    if (!Reflect.set(app, "schedulePiWebStatusRefresh", () => undefined)) throw new Error("Could not stub deferred status refresh");
    setAppState(app, {
      ...initialAppState(),
      machines: [machineA, machineB],
      selectedMachine: machineA,
      projects: [projectA],
      selectedProject: projectA,
      workspaces: [workspaceA],
      selectedWorkspace: workspaceA,
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    markPluginLoadingReady(app, [machineB.id]);
    stubRouteMachineSelection(app, () => {
      setAppState(app, {
        ...appState(app),
        selectedMachine: machineB,
        projects: [projectB],
        selectedProject: undefined,
        workspaces: [],
        selectedWorkspace: undefined,
        selectedSession: undefined,
        error: "",
      });
    });
    stubWorkspaceProjectSelection(app, () => {
      setAppState(app, {
        ...appState(app),
        selectedProject: projectB,
        workspaces: [fallbackWorkspace],
        selectedWorkspace: fallbackWorkspace,
        error: "",
      });
    });
    rememberMachineNavigationSnapshot(app, {
      machineId: machineB.id,
      projectId: projectB.id,
      workspaceId: "workspace-missing",
      tool: "files:workspace.files",
      view: "files:workspace.files",
      surface: { contributionQuery: { "files.workspace.files--file": "missing.ts" } },
    });

    await callAsyncAppMethod(app, "selectMachineWithMemory", machineB);

    expect(appState(app).selectedWorkspace?.id).toBe(fallbackWorkspace.id);
    expect(browser.url.searchParams.get("machine")).toBe(machineB.id);
    expect(browser.url.searchParams.get("workspace")).toBe(fallbackWorkspace.id);
    expect(browser.url.searchParams.has("files.workspace.files--file")).toBe(false);
    expect([...browser.pushed, ...browser.replaced].some((href) => {
      const url = new URL(href);
      return url.searchParams.get("workspace") === fallbackWorkspace.id
        && url.searchParams.has("files.workspace.files--file");
    })).toBe(false);

    window.history.back();
    await vi.waitFor(() => { expect(window.location.href).toBe(originUrl); });
  });

  it("keeps load-error preservation on the remembered identity without replacing its origin", async () => {
    const machineA: Machine = { id: "local", name: "Machine A", kind: "local", createdAt: "now", updatedAt: "now" };
    const machineB: Machine = { id: "remote-b", name: "Machine B", kind: "remote", createdAt: "now", updatedAt: "now" };
    const projectA: Project = { id: "project-a", name: "Project A", path: "/repo-a", createdAt: "now" };
    const fallbackProject: Project = { id: "project-fallback", name: "Fallback", path: "/fallback", createdAt: "now" };
    const workspaceA: Workspace = { id: "workspace-a", projectId: projectA.id, path: "/repo-a", label: "A", isMain: true, effectiveConfig: {} };
    const fallbackWorkspace: Workspace = { id: "workspace-fallback", projectId: fallbackProject.id, path: "/fallback", label: "Fallback", isMain: true, effectiveConfig: {} };
    const browser = installBrowserWindow("http://localhost/app?project=project-a&workspace=workspace-a&tool=core%3Aworkspace.terminal&view=core%3Aworkspace.terminal");
    const originUrl = browser.url.href;
    const app = new PiWebApp();
    if (!Reflect.set(app, "schedulePiWebStatusRefresh", () => undefined)) throw new Error("Could not stub deferred status refresh");
    setAppState(app, {
      ...initialAppState(),
      machines: [machineA, machineB],
      selectedMachine: machineA,
      projects: [projectA],
      selectedProject: projectA,
      workspaces: [workspaceA],
      selectedWorkspace: workspaceA,
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    markPluginLoadingReady(app, [machineB.id]);
    stubRouteMachineSelection(app, () => {
      setAppState(app, {
        ...appState(app),
        selectedMachine: machineB,
        projects: [fallbackProject],
        selectedProject: fallbackProject,
        workspaces: [fallbackWorkspace],
        selectedWorkspace: fallbackWorkspace,
        selectedSession: undefined,
        error: "Failed to load the remembered project",
      });
    });
    rememberMachineNavigationSnapshot(app, {
      machineId: machineB.id,
      projectId: "project-missing",
      workspaceId: "workspace-missing",
      tool: "files:workspace.files",
      view: "files:workspace.files",
      surface: { contributionQuery: { "files.workspace.files--file": "missing.ts" } },
    });

    await callAsyncAppMethod(app, "selectMachineWithMemory", machineB);

    expect(browser.pushed).toHaveLength(1);
    expect(browser.replaced).toHaveLength(1);
    expect(browser.url.searchParams.get("project")).toBe("project-missing");
    expect(browser.url.searchParams.get("workspace")).toBe("workspace-missing");
    expect(browser.url.searchParams.get("files.workspace.files--file")).toBe("missing.ts");
    expect([...browser.pushed, ...browser.replaced].some((href) => {
      const url = new URL(href);
      return url.searchParams.get("workspace") === fallbackWorkspace.id
        && url.searchParams.has("files.workspace.files--file");
    })).toBe(false);

    window.history.back();
    await vi.waitFor(() => { expect(window.location.href).toBe(originUrl); });
  });

  it("waits for gateway contributions before choosing the first default workspace panel", () => {
    const app = createApp();
    const previous = initialAppState();
    const next = { ...previous, selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] };
    if (!Reflect.set(app, "gatewayPluginLoadPromise", new Promise<void>(() => undefined))) throw new Error("Could not mark gateway plugins loading");
    if (!Reflect.set(app, "gatewayPluginLoadAttemptComplete", false)) throw new Error("Could not mark gateway plugin loading incomplete");
    if (!Reflect.set(app, "refreshWorkspaceDeletionRuns", () => Promise.resolve())) throw new Error("Could not stub workspace deletion refresh");
    setAppState(app, next);

    callAppMethod(app, "handleWorkspaceChange", previous, next);
    expect(appState(app).workspaceTool).toBeUndefined();

    installTestTerminalComposition(app, "local");
    appPluginRegistry(app).register({
      id: "first",
      plugin: {
        apiVersion: 2,
        name: "First panel",
        activate: ({ html }) => ({
          contributions: { workspacePanels: [{ id: "workspace.first", title: "First", order: 10, render: () => html`<p>First</p>` }] },
        }),
      },
    });
    callAppMethod(app, "reconcileWorkspacePanelSelection");

    expect(appState(app).workspaceTool).toBe("first:workspace.first");
    expect(appState(app).mainView).toBe("chat");
  });

  it("falls back to the first visible panel and keeps Chat available when a requested panel is unavailable", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=core%3Aworkspace.files&view=core%3Aworkspace.files");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "core:workspace.files",
      mainView: "core:workspace.files",
    });
    expect(appPluginRegistry(app).getWorkspacePanels().some(({ id }) => id === "core:workspace.files")).toBe(false);
    markPluginLoadingReady(app);

    await callAsyncAppMethod(app, "finishWorkspaceRouteRestore", { contributionQuery: {} }, {
      updateUrl: false,
      urlPublication: "current-url",
      normalizeUnavailableRoute: false,
      unavailablePanelViewRoute: false,
      requestedTool: "core:workspace.files",
      requestedView: "core:workspace.files",
    });

    expect(appState(app)).toMatchObject({
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    expect(browser.url.searchParams.get("tool")).toBe(TERMINAL_PANEL_ID);
    expect(browser.url.searchParams.get("view")).toBe(TERMINAL_PANEL_ID);
    expect(mobileTabIds(app)).toEqual(["navigation", "chat", TERMINAL_PANEL_ID]);

    setAppState(app, {
      ...appState(app),
      workspaceTool: "missing:workspace.panel",
      mainView: "chat",
    });
    callAppMethod(app, "reconcileWorkspacePanelSelection");

    expect(appState(app).workspaceTool).toBe(TERMINAL_PANEL_ID);
    expect(appState(app).mainView).toBe("chat");
  });

  it("replaces an unresolved panel deep link after plugin loading completes", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=missing&view=missing");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: "chat",
    });
    markPluginLoadingReady(app);

    await callAsyncAppMethod(app, "restoreRouteFor", {
      machineId: undefined,
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: undefined,
      tool: "missing",
      view: "missing",
    }, false, { contributionQuery: {} });

    expect(appState(app)).toMatchObject({
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    expect(browser.url.searchParams.get("tool")).toBe(TERMINAL_PANEL_ID);
    expect(browser.url.searchParams.get("view")).toBe(TERMINAL_PANEL_ID);
    expect(browser.replaced.length).toBeGreaterThan(0);
  });

  it("normalizes an unavailable panel on popstate without replacing the adjacent history entries", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=core%3Aworkspace.terminal&view=core%3Aworkspace.terminal&step=origin");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    markPluginLoadingReady(app);
    window.history.pushState({}, "", "?project=project-1&workspace=workspace-1&tool=missing%3Aworkspace.panel&view=missing%3Aworkspace.panel&step=unavailable");
    window.history.pushState({}, "", "?project=project-1&workspace=workspace-1&tool=core%3Aworkspace.terminal&view=core%3Aworkspace.terminal&step=later");
    browser.pushed.splice(0);
    browser.replaced.splice(0);

    window.history.back();
    await vi.waitFor(() => { expect(browser.url.searchParams.get("step")).toBe("unavailable"); });
    callAppMethod(app, "onPopState");
    await vi.waitFor(() => {
      expect(browser.url.searchParams.get("tool")).toBe(TERMINAL_PANEL_ID);
      expect(browser.url.searchParams.get("view")).toBe(TERMINAL_PANEL_ID);
    });

    expect(browser.replaced).toHaveLength(1);
    expect(browser.url.searchParams.get("step")).toBe("unavailable");
    window.history.back();
    await vi.waitFor(() => { expect(browser.url.searchParams.get("step")).toBe("origin"); });
  });

  it("keeps the generic shell and host files available when the Files module fails to load", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=core%3Aworkspace.files&view=core%3Aworkspace.files");
    const app = new PiWebApp();
    stubPluginLoadRendering(app);
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "core:workspace.files",
      mainView: "core:workspace.files",
    });
    const failure = new Error("Files module unavailable");
    vi.mocked(loadExternalPlugins).mockResolvedValue({
      terminalMode: "required",
      registrations: [{
        id: "terminal",
        machineSpecific: true,
        backendRevision: "terminal-r1",
        backendCapabilityVersion: 1,
        channelVersion: 1,
        plugin: requiredTerminalPlugin(),
      }],
      failures: [{ entry: manifestEntry("files"), error: failure }],
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await ensureGatewayPluginsLoaded(app);

    expect(appState(app)).toMatchObject({
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    expect(browser.url.searchParams.get("tool")).toBe(TERMINAL_PANEL_ID);
    expect(browser.url.searchParams.get("view")).toBe(TERMINAL_PANEL_ID);
    expect(mobileTabIds(app)).toEqual(["navigation", "chat", TERMINAL_PANEL_ID]);
    expect(workspacePanelContextFromApp(app).files.capabilityVersion).toBe(1);
    expect(warning).toHaveBeenCalledWith(
      "Failed to load PI WEB plugin files (./files/plugin.js)",
      failure,
    );
  });

  it("keeps successful registrations while making an incomplete gateway load retryable", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    const stableEntry = manifestEntry("stable");
    const retryEntry = manifestEntry("retry");
    const stablePlugin = pluginWithAction("Stable", "act");
    const retryPlugin = pluginWithAction("Retry", "act");
    const transientFailure = new Error("temporary module failure");
    let attempt = 0;
    vi.mocked(loadExternalPlugins).mockImplementation((_manifestUrl, options = {}) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve({
          terminalMode: "recovery-disabled",
          registrations: [{ id: "stable", machineSpecific: false, plugin: stablePlugin }],
          failures: [{ entry: retryEntry, error: transientFailure }],
        });
      }
      expect(options.shouldLoadPlugin?.(stableEntry)).toBe(false);
      return Promise.resolve({
        terminalMode: "recovery-disabled",
        registrations: [{ id: "retry", machineSpecific: false, plugin: retryPlugin }],
        failures: [],
      });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await ensureGatewayPluginsLoaded(app);

    expect(appPluginRegistry(app).hasPlugin("stable")).toBe(true);
    expect(appPluginRegistry(app).hasPlugin("retry")).toBe(false);
    expect(callAppMethod(app, "getDefaultActions")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stable:act" }),
    ]));
    expect(Reflect.get(app, "gatewayPluginLoadPromise")).toBeUndefined();

    await ensureGatewayPluginsLoaded(app);

    expect(loadExternalPlugins).toHaveBeenCalledTimes(2);
    expect(appPluginRegistry(app).hasPlugin("stable")).toBe(true);
    expect(appPluginRegistry(app).hasPlugin("retry")).toBe(true);
    expect(callAppMethod(app, "getDefaultActions")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stable:act" }),
      expect.objectContaining({ id: "retry:act" }),
    ]));
    expect(warning).toHaveBeenCalledWith(
      "Failed to load PI WEB plugin retry (./retry/plugin.js)",
      transientFailure,
    );
  });

  it("completes workspace-removal polling when the deleted target no longer resolves", async () => {
    const commandWorkspace: Workspace = { ...workspace, id: "workspace-command", path: "/repo", label: "main", isMain: true };
    const targetWorkspace: Workspace = { ...workspace, id: "workspace-target", path: "/repo-target", label: "target", isMain: false };
    const runningRun = {
      id: "deletion-run",
      origin: "core",
      projectId: project.id,
      workspaceId: commandWorkspace.id,
      terminalId: "deletion-terminal",
      title: "Remove target",
      command: "remove-target",
      status: "running" as const,
      createdAt: "now",
      metadata: { "pi.operation": "workspace.delete", "target.workspaceId": targetWorkspace.id },
    };
    const completedRun = { ...runningRun, status: "succeeded" as const, exitCode: 0, completedAt: "later" };
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: commandWorkspace,
      workspaces: [commandWorkspace, targetWorkspace],
      workspaceDeletionRuns: { [targetWorkspace.id]: runningRun },
    });
    markPluginLoadingReady(app);
    const compositions: unknown = Reflect.get(app, "requiredTerminalByMachine");
    if (!(compositions instanceof Map)) throw new Error("PiWebApp required Terminal composition map was unavailable");
    const composition: unknown = compositions.get("local");
    if (!isRequiredTerminalComposition(composition)) throw new Error("Local Terminal composition was unavailable");
    compositions.set("local", { ...composition, facade: new TerminalFacade() });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes(`/workspaces/${targetWorkspace.id}/`)) {
        return Promise.resolve(new Response(JSON.stringify({ error: "Workspace not found" }), { status: 404, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify([completedRun]), { status: 200, headers: { "content-type": "application/json" } }));
    }));
    const workspaceController: unknown = Reflect.get(app, "workspaces");
    if (typeof workspaceController !== "object" || workspaceController === null) throw new Error("Workspace controller was unavailable");
    const refreshAfterDeleted = vi.fn<(
      projectId: string,
      workspaceId: string,
      machineId?: string,
      options?: { signal?: AbortSignal; isCurrent?: () => boolean },
    ) => Promise<void>>().mockResolvedValue(undefined);
    if (!Reflect.set(workspaceController, "refreshAfterWorkspaceDeleted", refreshAfterDeleted)) throw new Error("Could not observe deletion completion refresh");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await callAsyncAppMethod(app, "refreshWorkspaceDeletionRuns");

    expect(refreshAfterDeleted).toHaveBeenCalledOnce();
    const reconciliationOptions = refreshAfterDeleted.mock.calls[0]?.[3];
    expect(refreshAfterDeleted.mock.calls[0]?.slice(0, 3)).toEqual([project.id, targetWorkspace.id, "local"]);
    expect(reconciliationOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(reconciliationOptions?.isCurrent).toBeTypeOf("function");
    expect(appState(app).workspaceDeletionRuns[targetWorkspace.id]).toBeUndefined();
    expect(Reflect.get(app, "workspaceDeletionPollTimer")).toBeUndefined();
  });

  it("aborts an old project deletion refresh and lets the new scope refresh immediately", async () => {
    const otherProject: Project = { id: "project-2", name: "Other", path: "/other", createdAt: "now" };
    const otherWorkspace: Workspace = { ...workspace, id: "workspace-2", projectId: otherProject.id, path: "/other", label: "other" };
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      projects: [project, otherProject],
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
    });
    markPluginLoadingReady(app);
    const oldRefresh = deferredValue<TerminalCommandRun[]>();
    const signals: (AbortSignal | undefined)[] = [];
    let requestCount = 0;
    const listCommandRuns = vi.fn<RequiredTerminalBrowserFacadeV1["listCommandRuns"]>((query) => {
      signals.push(query.signal);
      requestCount += 1;
      return requestCount === 1 ? oldRefresh.promise : Promise.resolve([]);
    });
    replaceTestTerminalFacade(app, { ...testTerminalFacade(), listCommandRuns });

    const firstRefresh = callAsyncAppMethod(app, "refreshWorkspaceDeletionRuns");
    await vi.waitFor(() => { expect(listCommandRuns).toHaveBeenCalledOnce(); });
    callAppMethod(app, "setState", {
      selectedProject: otherProject,
      selectedWorkspace: otherWorkspace,
      workspaces: [otherWorkspace],
    });

    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => { expect(listCommandRuns).toHaveBeenCalledTimes(2); });
    oldRefresh.resolve([{
      id: "stale-run",
      origin: "core",
      projectId: project.id,
      workspaceId: workspace.id,
      terminalId: "stale-terminal",
      title: "Stale",
      command: "true",
      status: "running",
      createdAt: "now",
      metadata: { "pi.operation": "workspace.delete", "target.workspaceId": "stale-target" },
    }]);
    await firstRefresh;

    expect(appState(app).selectedProject?.id).toBe(otherProject.id);
    expect(appState(app).workspaceDeletionRuns).toEqual({});
  });

  it("fences a deferred deletion reconciliation across cancellation and an A-to-B-to-A scope return", async () => {
    const otherProject: Project = { id: "project-2", name: "Other", path: "/other", createdAt: "now" };
    const targetWorkspace: Workspace = { ...workspace, id: "workspace-target", path: "/repo-target", label: "target", isMain: false };
    const fallbackWorkspace: Workspace = { ...workspace, id: "workspace-main", path: "/repo", label: "main", isMain: true };
    const otherWorkspace: Workspace = { ...workspace, id: "workspace-other", projectId: otherProject.id, path: "/other", label: "other", isMain: true };
    const completedRun: TerminalCommandRun = {
      id: "completed-run",
      origin: "core",
      projectId: project.id,
      workspaceId: fallbackWorkspace.id,
      terminalId: "completed-terminal",
      title: "Remove target",
      command: "true",
      status: "succeeded",
      exitCode: 0,
      createdAt: "now",
      completedAt: "later",
      metadata: { "pi.operation": "workspace.delete", "target.workspaceId": targetWorkspace.id },
    };
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      projects: [project, otherProject],
      selectedProject: project,
      selectedWorkspace: targetWorkspace,
      workspaces: [targetWorkspace],
      workspaceDeletionRuns: { [targetWorkspace.id]: completedRun },
    });
    markPluginLoadingReady(app);
    const workspaceController: unknown = Reflect.get(app, "workspaces");
    if (typeof workspaceController !== "object" || workspaceController === null) throw new Error("Workspace controller was unavailable");
    const controllerApi: unknown = Reflect.get(workspaceController, "api");
    if (typeof controllerApi !== "object" || controllerApi === null) throw new Error("Workspace controller API was unavailable");
    const pendingWorkspaces = deferredValue<Workspace[]>();
    let reconciliationOptions: { signal?: AbortSignal; isCurrent?: () => boolean } | undefined;
    const loadWorkspaces = vi.fn((_projectId: string, _machineId?: string, options?: { signal?: AbortSignal }) => {
      reconciliationOptions = options;
      return pendingWorkspaces.promise;
    });
    const loadSessions = vi.fn(() => Promise.resolve([]));
    if (!Reflect.set(workspaceController, "api", { ...controllerApi, workspaces: loadWorkspaces, sessions: loadSessions })) {
      throw new Error("Could not control workspace reconciliation requests");
    }

    const refreshing = callAsyncAppMethod(app, "refreshWorkspaceDeletionRuns");
    await vi.waitFor(() => { expect(loadWorkspaces).toHaveBeenCalledOnce(); });
    callAppMethod(app, "setState", { selectedProject: otherProject, selectedWorkspace: otherWorkspace, workspaces: [otherWorkspace] });
    callAppMethod(app, "setState", { selectedProject: project, selectedWorkspace: targetWorkspace, workspaces: [targetWorkspace] });
    pendingWorkspaces.resolve([fallbackWorkspace]);
    await refreshing;

    expect(reconciliationOptions?.signal?.aborted).toBe(true);
    expect(appState(app).selectedProject).toBe(project);
    expect(appState(app).selectedWorkspace).toBe(targetWorkspace);
    expect(appState(app).workspaces).toEqual([targetWorkspace]);
    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("retries successful deletion reconciliation before marking the run handled", async () => {
    vi.useFakeTimers();
    const completedRun: TerminalCommandRun = {
      id: "completed-run",
      origin: "core",
      projectId: project.id,
      workspaceId: workspace.id,
      terminalId: "completed-terminal",
      title: "Remove target",
      command: "true",
      status: "succeeded",
      exitCode: 0,
      createdAt: "now",
      completedAt: "later",
      metadata: { "pi.operation": "workspace.delete", "target.workspaceId": "target-workspace" },
    };
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceDeletionRuns: { "target-workspace": completedRun },
    });
    markPluginLoadingReady(app);
    const workspaceController: unknown = Reflect.get(app, "workspaces");
    if (typeof workspaceController !== "object" || workspaceController === null) throw new Error("Workspace controller was unavailable");
    const refreshAfterDeleted = vi.fn()
      .mockRejectedValueOnce(new Error("topology unavailable"))
      .mockResolvedValueOnce(undefined);
    if (!Reflect.set(workspaceController, "refreshAfterWorkspaceDeleted", refreshAfterDeleted)) throw new Error("Could not control deletion reconciliation");

    await callAsyncAppMethod(app, "refreshWorkspaceDeletionRuns");

    expect(appState(app).workspaceDeletionRuns["target-workspace"]).toEqual(completedRun);
    const errorScope = workspaceBrowserErrorScope("local", project.id, "target-workspace");
    expect(appState(app).browserErrors[browserErrorScopeKey(errorScope)]?.message).toContain("Retrying");
    expect(refreshAfterDeleted).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => { expect(refreshAfterDeleted).toHaveBeenCalledTimes(2); });
    await vi.waitFor(() => { expect(appState(app).workspaceDeletionRuns["target-workspace"]).toBeUndefined(); });
    expect(appState(app).browserErrors[browserErrorScopeKey(errorScope)]).toBeUndefined();
  });

  it("publishes a cross-workspace command terminal atomically on the target route", async () => {
    const originWorkspace: Workspace = { ...workspace, id: "workspace-origin", path: "/repo-origin", label: "origin" };
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-origin&tool=core%3Aworkspace.terminal&view=core%3Aworkspace.terminal");
    const originUrl = browser.url.href;
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: originWorkspace,
      workspaces: [originWorkspace, workspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    markPluginLoadingReady(app);
    if (!Reflect.set(app, "restoreRouteFor", () => {
      setAppState(app, { ...appState(app), selectedWorkspace: workspace });
      return Promise.resolve();
    })) throw new Error("Could not stub successful Terminal workspace restoration");

    workspacePanelContextFromApp(app).terminal.open({ terminalId: "target-terminal-2" });
    await vi.waitFor(() => { expect(browser.url.searchParams.get("terminal.workspace.terminal--terminal")).toBe("target-terminal-2"); });

    expect(browser.url.searchParams.get("project")).toBe(project.id);
    expect(browser.url.searchParams.get("workspace")).toBe(workspace.id);
    expect(browser.url.searchParams.get("tool")).toBe(TERMINAL_PANEL_ID);
    expect(browser.url.searchParams.get("terminal.workspace.terminal--terminal")).toBe("target-terminal-2");
    expect(browser.url.searchParams.get("terminal.workspace.terminal--start")).toBeNull();
    expect(browser.pushed).toHaveLength(1);
    expect(browser.pushed[0]).not.toBe(originUrl);
  });

  it("adds a one-shot start request only when the Terminal surface is explicitly opened", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=files%3Aworkspace.files&view=files%3Aworkspace.files");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "files:workspace.files",
      mainView: "files:workspace.files",
    });
    markPluginLoadingReady(app);

    callAppMethod(app, "openWorkspaceTool", TERMINAL_PANEL_ID);
    await vi.waitFor(() => { expect(appState(app).workspaceTool).toBe(TERMINAL_PANEL_ID); });

    expect(browser.url.searchParams.get("terminal.workspace.terminal--start")).toBe("1");
    expect(browser.url.searchParams.get("terminal.workspace.terminal--terminal")).toBeNull();
  });

  it("does not publish a command terminal after its workspace restore is superseded", async () => {
    const otherWorkspace: Workspace = { ...workspace, id: "workspace-2", label: "other" };
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-2&tool=core%3Aworkspace.terminal&view=core%3Aworkspace.terminal");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: otherWorkspace,
      workspaces: [workspace, otherWorkspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    markPluginLoadingReady(app);
    let finishRestore: () => void = () => undefined;
    let restoreStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { restoreStarted = resolve; });
    const pendingRestore = new Promise<void>((resolve) => { finishRestore = resolve; });
    if (!Reflect.set(app, "restoreRouteFor", () => {
      setAppState(app, { ...appState(app), selectedWorkspace: workspace });
      restoreStarted();
      return pendingRestore;
    })) throw new Error("Could not stub Terminal workspace restoration");
    const publishWorkspaceTool = vi.fn();
    if (!Reflect.set(app, "publishWorkspaceTool", publishWorkspaceTool)) throw new Error("Could not observe Terminal panel publication");

    const opening = callAsyncAppMethod(app, "navigateRuntimeWorkspaceContribution", "local", workspace, {
      contributionId: TERMINAL_PANEL_ID,
      navigationAliases: ["core:workspace.terminal"],
      query: { terminal: "terminal-from-command", start: undefined },
    });
    await started;
    setAppState(app, { ...appState(app), selectedWorkspace: otherWorkspace });
    finishRestore();
    await opening;

    expect(publishWorkspaceTool).not.toHaveBeenCalled();
    expect(browser.url.searchParams.get("terminal.workspace.terminal--terminal")).toBeNull();
    expect(appState(app).selectedWorkspace?.id).toBe(otherWorkspace.id);
  });

  it("binds a remote Terminal facade to the matching machine and backend revision", async () => {
    installBrowserWindow("http://localhost/app?machine=remote-1&project=project-1&workspace=workspace-1");
    const app = new PiWebApp();
    stubPluginLoadRendering(app);
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: remoteMachine,
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
    });
    const runtimePluginId = machineScopedPluginId(remoteMachine.id, "terminal");
    const run = {
      id: "run-1",
      origin: runtimePluginId,
      projectId: project.id,
      workspaceId: workspace.id,
      terminalId: "terminal-1",
      title: "Build",
      command: "npm run build",
      status: "succeeded",
      exitCode: 0,
      createdAt: "now",
      completedAt: "later",
      metadata: {},
    };
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedInit = init;
      return Promise.resolve(new Response(JSON.stringify(run), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await callAsyncAppMethod(app, "registerExternalPlugins", "Remote plugins", () => Promise.resolve({
      terminalMode: "required",
      registrations: [{
        id: runtimePluginId,
        sourcePluginId: "terminal",
        machineId: remoteMachine.id,
        machineSpecific: true,
        backendRevision: "remote-terminal-r7",
        backendCapabilityVersion: 1,
        channelVersion: 1,
        plugin: requiredTerminalPlugin(new TerminalFacade()),
      }],
      failures: [],
    }), remoteMachine.id);

    const handle = await workspacePanelContextFromApp(app).terminal.runCommand({ title: "Build", command: "npm run build" });

    await expect(handle.completed).resolves.toEqual(run);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestedUrl).toBe(`${window.location.origin}/api/machines/remote-1/plugin-backends/terminal/projects/project-1/workspaces/workspace-1/terminal.run`);
    const requestBody = requestedInit?.body;
    if (typeof requestBody !== "string") throw new Error("Expected serialized Terminal backend request body");
    expect(JSON.parse(requestBody)).toEqual({
      revision: "remote-terminal-r7",
      input: { origin: "core", title: "Build", command: "npm run build", metadata: {} },
    });
  });

  it("gates portable contributions against remote required mode and fences stale callbacks", async () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: remoteMachine,
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
    });
    markPluginLoadingReady(app); // local healthy; remote is still unverified
    if (!Reflect.set(app, "loadPluginsForSelectedMachine", () => Promise.resolve())) {
      throw new Error("Could not isolate selected-machine plugin loading");
    }
    const run = vi.fn();
    appPluginRegistry(app).register({
      id: "portable",
      machineSpecific: false,
      plugin: {
        apiVersion: 2,
        name: "Portable",
        activate: () => ({ contributions: { actions: [{ id: "act", title: "Portable", run }] } }),
      },
    });
    const portableAction = (): { id: string; run: () => void | Promise<void> } | undefined => {
      const actions = callAppMethod(app, "getDefaultActions");
      if (!isActionArray(actions)) throw new Error("Expected app actions");
      return actions.find((action) => action.id === "portable:act");
    };

    expect(portableAction()).toBeUndefined();
    installTestTerminalComposition(app, remoteMachine.id);
    const stale = portableAction();
    expect(stale).toBeDefined();
    callAppMethod(app, "setState", {
      selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" },
    });
    await stale?.run();
    expect(run).not.toHaveBeenCalled();
    callAppMethod(app, "setState", { selectedMachine: remoteMachine });

    callAppMethod(app, "clearRequiredTerminal", "local");
    verifiedPluginModes(app).delete("local");
    expect(portableAction()).toBeDefined(); // local failure must not hide a healthy remote

    callAppMethod(app, "clearRequiredTerminal", remoteMachine.id);
    verifiedPluginModes(app).delete(remoteMachine.id);
    expect(portableAction()).toBeUndefined();
    await stale?.run();
    expect(run).not.toHaveBeenCalled();

    installTestTerminalComposition(app, remoteMachine.id);
    await portableAction()?.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails closed while required Terminal manifest verification is pending", async () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });

    expect(mobileTabIds(app)).toEqual(["navigation", "chat"]);
    await expect(workspacePanelContextFromApp(app).terminal.runCommand({ title: "Pending", command: "true" }))
      .rejects.toThrow("Required Terminal plugin is unavailable");
  });

  it("keeps a missing manifest failed closed until a valid required manifest retry succeeds", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(loadExternalPlugins)
      .mockRejectedValueOnce(new Error("Failed to load plugin manifest (404 Not Found)"))
      .mockResolvedValueOnce({
        terminalMode: "required",
        registrations: [{
          id: "terminal",
          machineSpecific: true,
          backendRevision: "terminal-r1",
          backendCapabilityVersion: 1,
          channelVersion: 1,
          plugin: requiredTerminalPlugin(),
        }],
        failures: [],
      });

    await ensureGatewayPluginsLoaded(app);
    expect(displayedError(app)).toContain("404 Not Found");
    expect(mobileTabIds(app)).toEqual(["navigation", "chat"]);
    expect(Reflect.get(app, "gatewayPluginLoadPromise")).toBeUndefined();

    await ensureGatewayPluginsLoaded(app);
    expect(mobileTabIds(app)).toContain(TERMINAL_PANEL_ID);
    expect(loadExternalPlugins).toHaveBeenCalledTimes(2);
  });

  it("preserves an attributable required-load failure through deep-link restoration until valid retry", async () => {
    installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=core%3Aworkspace.terminal");
    const app = new PiWebApp();
    stubPluginLoadRendering(app);
    setAppState(app, { ...initialAppState(), projects: [project] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await callAsyncAppMethod(app, "registerExternalPlugins", "PI WEB plugins", () =>
      Promise.reject(new Error("Invalid plugin manifest lifecycle payload")));
    expect(displayedError(app)).toContain("Invalid plugin manifest lifecycle payload");

    if (!Reflect.set(app, "loadPluginsForSelectedMachine", () => Promise.resolve())) {
      throw new Error("Could not isolate deep-link plugin loading");
    }
    stubWorkspaceProjectSelection(app, () => {
      callAppMethod(app, "setState", {
        selectedProject: project,
        selectedWorkspace: workspace,
        workspaces: [workspace],
        error: "",
      });
    });
    await callAsyncAppMethod(app, "restoreRouteFor", {
      machineId: undefined,
      projectId: project.id,
      workspaceId: workspace.id,
      sessionId: undefined,
      tool: "core:workspace.terminal",
      view: undefined,
    }, false, { contributionQuery: {} });

    expect(appState(app).selectedWorkspace?.id).toBe(workspace.id);
    expect(appState(app).error).toBe("");
    expect(displayedError(app)).toContain("Invalid plugin manifest lifecycle payload");
    callAppMethod(app, "setState", { error: "temporary workspace error" });
    expect(displayedError(app)).toBe("temporary workspace error");
    callAppMethod(app, "setState", { error: "" });
    expect(displayedError(app)).toContain("Invalid plugin manifest lifecycle payload");

    callAppMethod(app, "setState", { error: "unrelated workspace warning" });
    await callAsyncAppMethod(app, "registerExternalPlugins", "PI WEB plugins", () => Promise.resolve({
      terminalMode: "required",
      registrations: [{
        id: "terminal",
        machineSpecific: true,
        backendRevision: "terminal-r1",
        backendCapabilityVersion: 1,
        channelVersion: 1,
        plugin: requiredTerminalPlugin(),
      }],
      failures: [],
    }));
    expect(appState(app).error).toBe("unrelated workspace warning");
    expect(displayedError(app)).toBe("unrelated workspace warning");
    callAppMethod(app, "setState", { error: "" });
    expect(displayedError(app)).toBe("");
  });

  it("hides the core Terminal surface and rejects helpers in no-plugin recovery", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    vi.mocked(loadExternalPlugins).mockResolvedValue({
      terminalMode: "recovery-disabled",
      registrations: [],
      failures: [],
    });

    await ensureGatewayPluginsLoaded(app);

    expect(mobileTabIds(app)).toEqual(["navigation", "chat"]);
    const context = workspacePanelContextFromApp(app);
    await expect(context.terminal.runCommand({ title: "Unavailable", command: "true" }))
      .rejects.toThrow("Required Terminal plugin is unavailable");
    context.terminal.open();
    expect(appState(app).error).toContain("Required Terminal plugin is unavailable");
  });

  it("hides a failed registered Terminal contribution and re-enables the same paired revision on retry", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: TERMINAL_PANEL_ID,
      mainView: TERMINAL_PANEL_ID,
    });
    const registration = {
      id: "terminal",
      machineSpecific: true,
      backendRevision: "terminal-r1",
      backendCapabilityVersion: 1 as const,
      channelVersion: 1 as const,
      plugin: requiredTerminalPlugin(),
    };
    const ordinaryRegistration = {
      id: "ordinary",
      machineSpecific: false,
      plugin: {
        apiVersion: 2 as const,
        name: "Ordinary",
        activate: () => ({
          contributions: {
            actions: [{ id: "act", title: "Ordinary action", run: () => undefined }],
          },
        }),
      },
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await callAsyncAppMethod(app, "registerExternalPlugins", "Initial", () => Promise.resolve({
      terminalMode: "required",
      registrations: [registration, ordinaryRegistration],
      failures: [],
    }));
    expect(mobileTabIds(app)).toContain(TERMINAL_PANEL_ID);
    expect(callAppMethod(app, "getDefaultActions")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ordinary:act" }),
    ]));

    await callAsyncAppMethod(app, "registerExternalPlugins", "Failed retry", () => Promise.resolve({
      terminalMode: "required",
      registrations: [],
      failures: [{ entry: manifestEntry("terminal"), error: new Error("manifest unavailable") }],
    }));
    expect(mobileTabIds(app)).toEqual(["navigation", "chat"]);
    expect(appPluginRegistry(app).hasPlugin("ordinary")).toBe(true);
    expect(callAppMethod(app, "getDefaultActions")).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ id: "terminal:view.terminal" }),
      expect.objectContaining({ id: "ordinary:act" }),
    ]));

    await callAsyncAppMethod(app, "registerExternalPlugins", "Recovered", () => Promise.resolve({
      terminalMode: "required",
      registrations: [registration],
      failures: [],
    }));
    expect(mobileTabIds(app)).toContain(TERMINAL_PANEL_ID);
    expect(callAppMethod(app, "getDefaultActions")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "terminal:view.terminal" }),
      expect.objectContaining({ id: "ordinary:act" }),
    ]));
  });

  it("surfaces required Terminal activation failure and does not register ordinary plugins", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    const terminalFailure = new Error("Terminal activation failed");
    vi.mocked(loadExternalPlugins).mockResolvedValue({
      terminalMode: "required",
      registrations: [
        {
          id: "terminal",
          machineSpecific: true,
          backendRevision: "terminal-r1",
          backendCapabilityVersion: 1,
          channelVersion: 1,
          plugin: {
            apiVersion: 2,
            name: "Terminal",
            activate: () => { throw terminalFailure; },
          },
        },
        { id: "info", machineSpecific: false, plugin: emptyPlugin("Info") },
      ],
      failures: [],
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await ensureGatewayPluginsLoaded(app);

    expect(appPluginRegistry(app).hasPlugin("terminal")).toBe(false);
    expect(appPluginRegistry(app).hasPlugin("info")).toBe(false);
    expect(displayedError(app)).toContain("Required Terminal plugin failed to activate");
    expect(displayedError(app)).toContain("Terminal activation failed");
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
      terminalMode: "required",
      registrations: [
        {
          id: "terminal",
          machineSpecific: true,
          backendRevision: "terminal-r1",
          backendCapabilityVersion: 1,
          channelVersion: 1,
          plugin: requiredTerminalPlugin(),
        },
        { id: "retryable", machineSpecific: false, plugin: retryable },
      ],
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
  installBrowserWindow("http://localhost/app");
  return new PiWebApp();
}

function installBrowserWindow(href: string): {
  readonly url: URL;
  readonly pushed: string[];
  readonly replaced: string[];
  navigate(next: string): void;
} {
  const originalPush = window.history.pushState.bind(window.history);
  const originalReplace = window.history.replaceState.bind(window.history);
  const appRelativeUrl = (target: string) => {
    const url = new URL(target, window.location.href);
    return `${url.pathname}${url.search}${url.hash}`;
  };
  originalPush({}, "", appRelativeUrl(href));
  const pushed: string[] = [];
  const replaced: string[] = [];
  vi.spyOn(window.history, "pushState").mockImplementation((state, title, next) => {
    originalPush(state, title, next);
    pushed.push(window.location.href);
  });
  vi.spyOn(window.history, "replaceState").mockImplementation((state, title, next) => {
    originalReplace(state, title, next);
    replaced.push(window.location.href);
  });
  return {
    get url() { return new URL(window.location.href); },
    pushed,
    replaced,
    navigate: (next) => { originalReplace({}, "", appRelativeUrl(next)); },
  };
}

function setAppState(app: PiWebApp, state: ReturnType<typeof initialAppState>): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function appState(app: PiWebApp): ReturnType<typeof initialAppState> {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebApp state was unavailable");
  return state;
}

function displayedError(app: PiWebApp): string {
  const value = callAppMethod(app, "displayedError");
  if (typeof value !== "string") throw new Error("PiWebApp displayed error was unavailable");
  return value;
}

function workspacePanelContextFromApp(app: PiWebApp): WorkspacePanelContext {
  const createContext: unknown = Reflect.get(app, "createWorkspacePanelContext");
  if (typeof createContext !== "function") throw new Error("PiWebApp workspace-panel context factory was unavailable");
  const context: unknown = Reflect.apply(createContext, app, [workspace]);
  if (!isWorkspacePanelContext(context)) throw new Error("PiWebApp workspace-panel context was invalid");
  return context;
}

function machineNavigationSnapshot(app: PiWebApp, machineId: string): MachineNavigationSnapshot | undefined {
  const memory: unknown = Reflect.get(app, "machineNavigation");
  if (typeof memory !== "object" || memory === null) throw new Error("PiWebApp machine-navigation memory was unavailable");
  const latest: unknown = Reflect.get(memory, "latest");
  if (typeof latest !== "function") throw new Error("PiWebApp machine-navigation latest lookup was unavailable");
  const snapshot: unknown = Reflect.apply(latest, memory, [machineId]);
  if (snapshot === undefined) return undefined;
  if (!isMachineNavigationSnapshot(snapshot)) throw new Error("PiWebApp machine-navigation snapshot was invalid");
  return snapshot;
}

function isAppState(value: unknown): value is ReturnType<typeof initialAppState> {
  return typeof value === "object" && value !== null && "mainView" in value && "workspaceTool" in value;
}

function isWorkspacePanelContext(value: unknown): value is WorkspacePanelContext {
  return typeof value === "object" && value !== null && "workspace" in value && "machine" in value && "files" in value;
}

function isMachineNavigationSnapshot(value: unknown): value is MachineNavigationSnapshot {
  return typeof value === "object" && value !== null && "machineId" in value && "surface" in value;
}

function mobileTabIds(app: PiWebApp): string[] {
  const tabs = callAppMethod(app, "mobileMainTabs");
  if (!Array.isArray(tabs)) throw new Error("PiWebApp mobile tabs were unavailable");
  return tabs.map((tab: unknown) => {
    if (typeof tab !== "object" || tab === null || !("id" in tab) || typeof tab.id !== "string") throw new Error("PiWebApp mobile tab was invalid");
    return tab.id;
  });
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

function isAsyncVoidCallback(value: unknown): value is () => void | Promise<void> {
  return typeof value === "function";
}

function isPluginRuntimeContext(value: unknown): value is PluginRuntimeContext {
  if (typeof value !== "object" || value === null) return false;
  return "refreshWorkspacePanels" in value && typeof value.refreshWorkspacePanels === "function";
}

function stubPluginLoadRendering(app: PiWebApp): void {
  if (!Reflect.set(app, "applyPreferredTheme", () => undefined)) throw new Error("Could not stub theme application");
  if (!Reflect.set(app, "requestUpdate", () => undefined)) throw new Error("Could not stub Lit update scheduling");
}

function pluginWithPanel(name: string, onInvalidate: (context: WorkspacePanelContext, invalidation?: WorkspaceInvalidation) => void): PiWebPlugin {
  return {
    apiVersion: 2,
    name,
    activate: ({ html }) => ({
      contributions: {
        workspacePanels: [{ id: "workspace.panel", title: name, invalidationResources: ["workspace.files"], onInvalidate, render: () => html`<p>${name}</p>` }],
      },
    }),
  };
}

function registerFilesRuntimePanel(
  app: PiWebApp,
  runtime: FilesRuntime,
  files: WorkspaceFilesCapabilityV1,
  contexts: PublicWorkspacePanelContext[],
): void {
  appPluginRegistry(app).register({
    id: "files",
    plugin: {
      apiVersion: 2,
      name: "Files host integration",
      activate: ({ html }) => ({
        contributions: {
          workspacePanels: [{
            id: "workspace.files",
            title: "Files",
            routeAliases: ["files", "core:workspace.files"],
            navigationAliases: ["core:workspace.files"],
            invalidationResources: ["workspace.files"],
            onInvalidate: (context, invalidation) => {
              const runtimeContext: PublicWorkspacePanelContext = {
                machine: context.machine,
                workspace: context.workspace,
                files,
                ...(context.backend === undefined ? {} : { backend: context.backend }),
                host: context.host,
                prompt: context.prompt,
                terminal: context.terminal,
                ...(context.navigation === undefined ? {} : { navigation: context.navigation }),
              };
              contexts.push(runtimeContext);
              return runtime.invalidate(runtimeContext, invalidation);
            },
            render: () => html`<p>Files</p>`,
          }],
        },
      }),
    },
  });
}

function markPluginLoadingReady(app: PiWebApp, loadedMachineIds: readonly string[] = []): void {
  if (!Reflect.set(app, "gatewayPluginLoadPromise", Promise.resolve())) throw new Error("Could not mark gateway plugins loaded");
  if (!Reflect.set(app, "gatewayPluginLoadAttemptComplete", true)) throw new Error("Could not mark gateway plugin loading complete");
  const loaded: unknown = Reflect.get(app, "loadedMachinePluginIds");
  if (!(loaded instanceof Set)) throw new Error("PiWebApp loaded-machine plugin set was unavailable");
  installTestTerminalComposition(app, "local");
  for (const machineId of loadedMachineIds) {
    loaded.add(machineId);
    installTestTerminalComposition(app, machineId);
  }
}

function installTestTerminalComposition(app: PiWebApp, machineId: string): void {
  const runtimePluginId = machineId === "local" ? "terminal" : machineScopedPluginId(machineId, "terminal");
  const registry = appPluginRegistry(app);
  if (!registry.hasPlugin(runtimePluginId)) {
    registry.register({
      id: runtimePluginId,
      sourcePluginId: "terminal",
      ...(machineId === "local" ? {} : { machineId }),
      machineSpecific: true,
      backendRevision: `${machineId}-terminal-r1`,
      backendCapabilityVersion: 1,
      channelVersion: 1,
      plugin: requiredTerminalPlugin(),
    });
  }
  const compositions: unknown = Reflect.get(app, "requiredTerminalByMachine");
  if (!(compositions instanceof Map)) throw new Error("PiWebApp required Terminal composition map was unavailable");
  compositions.set(machineId, {
    binding: {
      registrationPluginId: runtimePluginId,
      sourcePluginId: "terminal",
      backendRevision: `${machineId}-terminal-r1`,
      backendCapabilityVersion: 1,
      channelVersion: 1,
    },
    facade: testTerminalFacade(),
  });
  setVerifiedPluginMode(app, machineId, "required");
}

function setVerifiedPluginMode(app: PiWebApp, machineId: string, mode: "required" | "recovery-disabled"): void {
  verifiedPluginModes(app).set(machineId, mode);
}

function verifiedPluginModes(app: PiWebApp): Map<unknown, unknown> {
  const modes: unknown = Reflect.get(app, "verifiedPluginModeByMachine");
  if (!(modes instanceof Map)) throw new Error("PiWebApp verified plugin mode map was unavailable");
  return modes;
}

function stubRouteMachineSelection(app: PiWebApp, applySelection: () => void): void {
  if (!Reflect.set(app, "restoreRouteMachine", () => {
    applySelection();
    return Promise.resolve();
  })) throw new Error("Could not stub machine route selection");
}

function stubWorkspaceProjectSelection(app: PiWebApp, applySelection: () => void): void {
  const controller: unknown = Reflect.get(app, "workspaces");
  if (typeof controller !== "object" || controller === null) throw new Error("PiWebApp workspace controller was unavailable");
  if (!Reflect.set(controller, "selectProject", () => {
    applySelection();
    return Promise.resolve();
  })) throw new Error("Could not stub workspace project selection");
}

function rememberMachineNavigationSnapshot(app: PiWebApp, snapshot: MachineNavigationSnapshot): void {
  const memory: unknown = Reflect.get(app, "machineNavigation");
  if (typeof memory !== "object" || memory === null) throw new Error("PiWebApp machine-navigation memory was unavailable");
  const remember: unknown = Reflect.get(memory, "remember");
  if (typeof remember !== "function") throw new Error("PiWebApp machine-navigation remember operation was unavailable");
  Reflect.apply(remember, memory, [snapshot]);
}

function latestFilesContext(contexts: readonly PublicWorkspacePanelContext[], machineId: string): PublicWorkspacePanelContext {
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    const context = contexts[index];
    if (context?.machine.id === machineId) return context;
  }
  throw new Error(`Files did not receive a context for ${machineId}`);
}

function historyUrl(entries: readonly string[], index: number): URL {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`Missing history entry ${String(index)}`);
  return new URL(entry);
}

function testWorkspaceFiles(overrides: Partial<WorkspaceFilesCapabilityV1> = {}): WorkspaceFilesCapabilityV1 {
  return {
    capabilityVersion: 1,
    defaultUploadFolder: ".pi-web/uploads",
    maxInlinePreviewBytes: 1024 * 1024,
    readFile: () => Promise.reject(new Error("Unexpected file read")),
    listFiles: (path) => Promise.resolve({ path, entries: [], scannedAt: "2026-06-25T00:00:00.000Z", truncated: false }),
    writeFile: () => Promise.reject(new Error("Unexpected file write")),
    deleteFile: () => Promise.reject(new Error("Unexpected file delete")),
    moveFile: () => Promise.reject(new Error("Unexpected file move")),
    previewUrl: (path) => `https://example.test/preview/${encodeURIComponent(path)}`,
    downloadUrl: (path) => `https://example.test/download/${encodeURIComponent(path)}`,
    uploadFile: () => { throw new Error("Unexpected file upload"); },
    ...overrides,
  };
}

function requiredTerminalPlugin(facade: RequiredTerminalBrowserFacadeV1 = testTerminalFacade()): PiWebPlugin {
  return {
    apiVersion: 2,
    name: "Terminal",
    activate: ({ html, runtimePluginId }) => ({
      requiredTerminalFacade: facade,
      contributions: {
        workspacePanels: [{
          id: "workspace.terminal",
          title: "Terminal",
          order: 30,
          routeAliases: ["core:workspace.terminal"],
          navigationAliases: ["core:workspace.terminal"],
          render: () => html`<p>Terminal</p>`,
        }],
        actions: [{
          id: "view.terminal",
          title: "Go to Terminal",
          shortcut: "mod+4",
          shortcutAliases: ["core:view.terminal"],
          run: (context) => { context.selectMainView(`${runtimePluginId}:workspace.terminal`); },
        }],
      },
    }),
  };
}

function testTerminalFacade(): RequiredTerminalBrowserFacadeV1 {
  const facade = new TerminalFacade();
  return {
    version: 1 as const,
    createWorkspaceTerminal: (binding: RequiredTerminalWorkspaceBindingV1) => {
      const terminal = facade.createWorkspaceTerminal(binding);
      return {
        open: (options) => { terminal.open(options); },
        runCommand: () => Promise.reject(new Error("Test Terminal command execution was not configured")),
      };
    },
    listCommandRuns: () => Promise.resolve([]),
    parseCommandRun: () => { throw new Error("Test Terminal command parsing was not configured"); },
  };
}

function replaceTestTerminalFacade(app: PiWebApp, facade: RequiredTerminalBrowserFacadeV1): void {
  const compositions: unknown = Reflect.get(app, "requiredTerminalByMachine");
  if (!(compositions instanceof Map)) throw new Error("PiWebApp required Terminal composition map was unavailable");
  const composition: unknown = compositions.get("local");
  if (!isRequiredTerminalComposition(composition)) throw new Error("Local Terminal composition was unavailable");
  compositions.set("local", { ...composition, facade });
}

function deferredValue<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function isRequiredTerminalComposition(value: unknown): value is { binding: unknown; facade: unknown } {
  return typeof value === "object" && value !== null && "binding" in value && "facade" in value;
}

function emptyPlugin(name: string): PiWebPlugin {
  return { apiVersion: 2, name, activate: () => ({ contributions: {} }) };
}

function pluginWithAction(name: string, actionId: string): PiWebPlugin {
  return {
    apiVersion: 2,
    name,
    activate: () => ({ contributions: { actions: [{ id: actionId, title: name, run: () => undefined }] } }),
  };
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

function isActionArray(value: unknown): value is { id: string; run: () => void | Promise<void> }[] {
  return Array.isArray(value) && value.every((candidate: unknown) => isAction(candidate));
}

function manifestEntry(id: string): PluginManifestEntry {
  return { id, module: `./${id}/plugin.js`, machineSpecific: false };
}
