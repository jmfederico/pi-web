// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesRuntime } from "../../../../pi-web-plugins/files/FilesRuntime";
import type { WorkspaceFilesCapabilityV1, WorkspacePanelContext as PublicWorkspacePanelContext } from "../../../plugin-api";
import type { Machine, Project, Workspace } from "../api";
import { initialAppState } from "../appState";
import type { MachineNavigationSnapshot } from "../controllers/machineNavigationMemory";
import { loadExternalPlugins, type PluginManifestEntry } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import type { PiWebPlugin, PluginRuntimeContext, WorkspaceInvalidation, WorkspacePanelContext, WorkspacePanelNavigationV1 } from "../plugins/types";
import { PiWebApp } from "./PiWebApp";

vi.mock("../plugins/external", () => ({ loadExternalPlugins: vi.fn() }));

const project: Project = { id: "project-1", name: "Project", path: "/repo", createdAt: "now" };
const remoteMachine: Machine = { id: "remote-1", name: "Remote", kind: "remote", createdAt: "now", updatedAt: "now" };

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
  vi.restoreAllMocks();
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
      workspaceTool: "core:workspace.terminal",
      mainView: "chat",
    });
    if (!Reflect.set(app, "gatewayPluginLoadPromise", Promise.resolve())) throw new Error("Could not mark gateway plugins loaded");
    if (!Reflect.set(app, "gatewayPluginLoadAttemptComplete", true)) throw new Error("Could not mark gateway plugin loading complete");

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
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
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
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
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
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
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
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
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
    if (!Reflect.set(app, "refreshActiveTerminals", () => Promise.resolve())) throw new Error("Could not stub terminal refresh");
    if (!Reflect.set(app, "refreshWorkspaceDeletionRuns", () => Promise.resolve())) throw new Error("Could not stub workspace deletion refresh");
    setAppState(app, next);

    callAppMethod(app, "handleWorkspaceChange", previous, next);
    expect(appState(app).workspaceTool).toBeUndefined();

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

    await callAsyncAppMethod(app, "finishWorkspaceRouteRestore", { contributionQuery: {} }, {
      updateUrl: false,
      urlPublication: "current-url",
      normalizeUnavailableRoute: false,
      unavailablePanelViewRoute: false,
      requestedTool: "core:workspace.files",
      requestedView: "core:workspace.files",
    });

    expect(appState(app)).toMatchObject({
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
    });
    expect(browser.url.searchParams.get("tool")).toBe("core:workspace.terminal");
    expect(browser.url.searchParams.get("view")).toBe("core:workspace.terminal");
    expect(mobileTabIds(app)).toEqual(["navigation", "chat", "core:workspace.terminal"]);

    setAppState(app, {
      ...appState(app),
      workspaceTool: "missing:workspace.panel",
      mainView: "chat",
    });
    callAppMethod(app, "reconcileWorkspacePanelSelection");

    expect(appState(app).workspaceTool).toBe("core:workspace.terminal");
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
      workspaceTool: "core:workspace.terminal",
      mainView: "chat",
    });
    if (!Reflect.set(app, "gatewayPluginLoadPromise", Promise.resolve())) throw new Error("Could not mark gateway plugins loaded");

    await callAsyncAppMethod(app, "restoreRouteFor", {
      machineId: undefined,
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: undefined,
      tool: "missing",
      view: "missing",
    }, false, { contributionQuery: {} });

    expect(appState(app)).toMatchObject({
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
    });
    expect(browser.url.searchParams.get("tool")).toBe("core:workspace.terminal");
    expect(browser.url.searchParams.get("view")).toBe("core:workspace.terminal");
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
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
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
      expect(browser.url.searchParams.get("tool")).toBe("core:workspace.terminal");
      expect(browser.url.searchParams.get("view")).toBe("core:workspace.terminal");
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
      registrations: [],
      failures: [{ entry: manifestEntry("files"), error: failure }],
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await ensureGatewayPluginsLoaded(app);

    expect(appState(app)).toMatchObject({
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
    });
    expect(browser.url.searchParams.get("tool")).toBe("core:workspace.terminal");
    expect(browser.url.searchParams.get("view")).toBe("core:workspace.terminal");
    expect(mobileTabIds(app)).toEqual(["navigation", "chat", "core:workspace.terminal"]);
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
  for (const machineId of loadedMachineIds) loaded.add(machineId);
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
