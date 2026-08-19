import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../shared/apiTypes";
import { FEDERATED_HTTP_ROUTES, FEDERATED_WEBSOCKET_ROUTES, SESSION_TREE_FORK_PROXY_TIMEOUT_MS, PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS, SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS, WORKSPACE_FILE_PREVIEW_ROUTE_PATH, WORKSPACE_REMOVAL_FEDERATION_TIMEOUT_MS, type FederatedHttpRouteSpec } from "../../../shared/federatedRoutes";
import { MAX_INLINE_PREVIEW_BYTES } from "../../../shared/workspaceFiles";
import { PLUGIN_BACKEND_BINARY_BODY_MAX_BYTES, PLUGIN_BACKEND_BINARY_REVISION_HEADER, PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES, PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES } from "../../../shared/pluginBackendProtocol";
import { configApi, filesApi, machineStatusApi, piPackagesApi, piWebApi, pluginsApi, projectsApi, sessionsApi, terminalsApi, trustApi, workspacesApi } from "./clients";
import { globalSessionEvents, realtimeEvents, sessionEvents, terminalSocket } from "./sockets";
import { requestPluginBackend } from "./pluginBackends";
import { workspaceFilePreviewUrl } from "./urls";

const machineId = "remote-a";
const workspace: Workspace = {
  id: "w 1",
  projectId: "p 1",
  path: "/repo",
  label: "repo",
  isMain: true,
  effectiveConfig: {},
};
const session = { id: "s 1", cwd: workspace.path };

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("federated route contract", () => {
  it("allowlists notification HTTP routes without adding a notification WebSocket", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path.includes("notifications"))).toEqual([
      { method: "GET", path: "/sessions/notifications" },
      { method: "GET", path: "/sessions/:sessionId/notifications" },
      { method: "POST", path: "/sessions/:sessionId/notifications/dismiss" },
      { method: "POST", path: "/sessions/:sessionId/notifications/dismiss-all" },
    ]);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("notifications"))).toBe(false);
  });

  it("allowlists both ask routes without adding an ask WebSocket", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path.includes("/ask/"))).toEqual([
      { method: "POST", path: "/sessions/:sessionId/ask/submit" },
      { method: "POST", path: "/sessions/:sessionId/ask/cancel" },
    ]);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("ask"))).toBe(false);
  });

  it("allowlists both extension dialog routes on the existing session WebSocket", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path.includes("/dialogs/"))).toEqual([
      { method: "POST", path: "/sessions/:sessionId/dialogs/answer" },
      { method: "POST", path: "/sessions/:sessionId/dialogs/cancel" },
    ]);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("dialogs"))).toBe(false);
  });

  it("allowlists daemon-authoritative unread HTTP routes on the existing global socket", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path.includes("unread"))).toEqual([
      { method: "GET", path: "/sessions/unread" },
      { method: "POST", path: "/sessions/:sessionId/unread/acknowledge" },
    ]);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("unread"))).toBe(false);
  });

  it("allowlists session tree mutations with long model-operation timeouts and no new WebSocket", () => {
    expect(FEDERATED_HTTP_ROUTES.find((route) => route.path === "/sessions/:sessionId/tree/navigate")).toEqual({
      method: "POST",
      path: "/sessions/:sessionId/tree/navigate",
      timeoutMs: SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS,
    });
    expect(FEDERATED_HTTP_ROUTES.find((route) => route.path === "/sessions/:sessionId/tree/fork")).toEqual({
      method: "POST",
      path: "/sessions/:sessionId/tree/fork",
      timeoutMs: SESSION_TREE_FORK_PROXY_TIMEOUT_MS,
    });
    expect(SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS).toBe(5 * 60_000);
    expect(SESSION_TREE_FORK_PROXY_TIMEOUT_MS).toBe(5 * 60_000);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("tree"))).toBe(false);
  });

  it("gives workspace removal a bounded cancellable federation hop", () => {
    expect(FEDERATED_HTTP_ROUTES.find((route) => route.path === "/projects/:projectId/workspaces/:workspaceId")).toEqual({
      method: "DELETE",
      path: "/projects/:projectId/workspaces/:workspaceId",
      timeoutMs: WORKSPACE_REMOVAL_FEDERATION_TIMEOUT_MS,
      propagateCancellation: true,
    });
  });

  it("gives workspace file previews the inline byte bound and a cancellable hop", () => {
    expect(FEDERATED_HTTP_ROUTES.find((route) => route.path === WORKSPACE_FILE_PREVIEW_ROUTE_PATH)).toEqual({
      method: "GET",
      path: WORKSPACE_FILE_PREVIEW_ROUTE_PATH,
      responseBodyLimit: MAX_INLINE_PREVIEW_BYTES,
      propagateCancellation: true,
    });
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("preview"))).toBe(false);
  });

  it("allowlists exactly the bounded workspace provider backend routes", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path.includes("plugin-backends"))).toEqual([
      {
        method: "POST",
        path: "/plugin-backends/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation",
        timeoutMs: PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS,
        bodyLimit: PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES,
        responseBodyLimit: PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
      },
      {
        method: "POST",
        path: "/plugin-backends/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation/binary",
        timeoutMs: PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS,
        bodyLimit: PLUGIN_BACKEND_BINARY_BODY_MAX_BYTES,
        responseBodyLimit: PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
        forwardHeaders: [PLUGIN_BACKEND_BINARY_REVISION_HEADER],
      },
    ]);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("plugin-backends"))).toBe(false);
  });

  it("allowlists only workspace trust reads and writes without adding a trust WebSocket", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path.includes("trust"))).toEqual([
      { method: "GET", path: "/projects/trust" },
      { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/trust" },
      { method: "PUT", path: "/projects/:projectId/workspaces/:workspaceId/trust" },
    ]);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("trust"))).toBe(false);
  });

  it("allowlists the model catalog read and per-model enable edit without a new WebSocket", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path.includes("/models"))).toEqual([
      { method: "GET", path: "/sessions/:sessionId/models" },
      { method: "GET", path: "/sessions/:sessionId/models/catalog" },
      { method: "POST", path: "/sessions/:sessionId/models/enabled" },
    ]);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("models"))).toBe(false);
  });

  it("covers machine-scoped client HTTP calls with remote proxy routes", async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      ignoreParseFailure(piWebApi.piWebStatus(machineId)),
      ignoreParseFailure(piWebApi.checkForUpdates(machineId)),
      ignoreParseFailure(configApi.config(machineId)),
      ignoreParseFailure(configApi.saveConfig({ spawnSessions: true }, machineId)),
      ignoreParseFailure(pluginsApi.plugins(machineId)),
      ignoreParseFailure(piPackagesApi.packages(machineId)),
      ignoreParseFailure(piPackagesApi.install("npm:@acme/tools", machineId)),
      ignoreParseFailure(piPackagesApi.remove("npm:@acme/tools", "user", machineId)),
      ignoreParseFailure(piPackagesApi.update("npm:@acme/tools", machineId)),
      ignoreParseFailure(machineStatusApi.machineStatus(machineId)),
      ignoreParseFailure(projectsApi.projects(machineId)),
      ignoreParseFailure(projectsApi.addProject("/repo", "Repo", false, machineId)),
      ignoreParseFailure(projectsApi.closeProject("p 1", machineId)),
      ignoreParseFailure(projectsApi.projectDirectories("/r", machineId)),
      ignoreParseFailure(workspacesApi.workspaces("p 1", machineId)),
      ignoreParseFailure(workspacesApi.deleteWorkspace("p 1", "w 1", "v1.confirmed", machineId)),
      ignoreParseFailure(workspacesApi.workspaceTree("p 1", "w 1", "src", machineId)),
      ignoreParseFailure(workspacesApi.workspaceFile("p 1", "w 1", "README.md", machineId)),
      ignoreParseFailure(workspacesApi.writeWorkspaceFile("p 1", "w 1", "README.md", "hello", { overwrite: false }, machineId)),
      ignoreParseFailure(workspacesApi.deleteWorkspaceFile("p 1", "w 1", "README.md", machineId)),
      ignoreParseFailure(workspacesApi.moveWorkspaceFile("p 1", "w 1", "README.md", "docs/README.md", { overwrite: false }, machineId)),
      ignoreParseFailure(trustApi.workspaceTrust("p 1", "w 1", machineId)),
      ignoreParseFailure(trustApi.setWorkspaceTrust("p 1", "w 1", true, machineId)),
      ignoreParseFailure(trustApi.projectTrust("/repo", machineId)),
      ignoreParseFailure(requestPluginBackend({ pluginId: "board-tools", backendRevision: "server-r1", machineId, projectId: "p 1", workspaceId: "w 1" }, "cards.summary", { includeClosed: false })),
      ignoreParseFailure(filesApi.files("README", { kind: "tracked", mode: "file", projectId: "p 1", workspaceId: "w 1", machineId })),
      ignoreParseFailure(sessionsApi.sessions("/repo", machineId)),
      ignoreParseFailure(sessionsApi.unreadCatalog(machineId)),
      ignoreParseFailure(sessionsApi.acknowledgeUnread(session, "catalog-a", 7, machineId)),
      ignoreParseFailure(sessionsApi.startSession("/repo", machineId)),
      ignoreParseFailure(sessionsApi.cleanupPreview({ archiveIdleDays: 14 }, machineId)),
      ignoreParseFailure(sessionsApi.cleanup({ archiveIdleDays: 14, deleteArchivedDays: 30, projectCwds: ["/repo"] }, machineId)),
      ignoreParseFailure(sessionsApi.archiveMany([session], machineId)),
      ignoreParseFailure(sessionsApi.deleteArchivedMany([session], machineId)),
      ignoreParseFailure(sessionsApi.messages(session, { limit: 20, before: 10 }, machineId)),
      ignoreParseFailure(sessionsApi.status(session, machineId)),
      ignoreParseFailure(sessionsApi.streamSnapshot(session, machineId)),
      ignoreParseFailure(sessionsApi.clearQueue(session, machineId)),
      ignoreParseFailure(sessionsApi.dismissWarning(session, "anthropicExtraUsage", machineId)),
      ignoreParseFailure(sessionsApi.submitAsk(session, "ask 1", { answers: [{ id: "q1", values: ["pg"] }] }, machineId)),
      ignoreParseFailure(sessionsApi.cancelAsk(session, "ask 1", machineId)),
      ignoreParseFailure(sessionsApi.answerDialog(session, "dialog 1", true, machineId)),
      ignoreParseFailure(sessionsApi.cancelDialog(session, "dialog 1", machineId)),
      ignoreParseFailure(sessionsApi.models(session, machineId)),
      ignoreParseFailure(sessionsApi.modelCatalog(session, machineId)),
      ignoreParseFailure(sessionsApi.setModelEnabled(session, "openai", "gpt", true, machineId)),
      ignoreParseFailure(sessionsApi.setModel(session, "openai", "gpt", machineId)),
      ignoreParseFailure(sessionsApi.cycleModel(session, "forward", machineId)),
      ignoreParseFailure(sessionsApi.thinkingLevels(session, machineId)),
      ignoreParseFailure(sessionsApi.setThinkingLevel(session, "medium", machineId)),
      ignoreParseFailure(sessionsApi.cycleThinkingLevel(session, machineId)),
      ignoreParseFailure(sessionsApi.commands(session, machineId)),
      ignoreParseFailure(sessionsApi.prompt(session, "hello", "followUp", machineId)),
      ignoreParseFailure(sessionsApi.saveAttachments(session, [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }], machineId, "uploads")),
      ignoreParseFailure(sessionsApi.shell(session, "ls", machineId)),
      ignoreParseFailure(sessionsApi.runCommand(session, "/help", machineId)),
      ignoreParseFailure(sessionsApi.respondToCommand(session, "req 1", "yes", machineId)),
      ignoreParseFailure(sessionsApi.navigateTree(session, { targetId: "entry-1", expectedLeafId: "leaf-1", summary: { mode: "none" } }, machineId)),
      ignoreParseFailure(sessionsApi.forkTree(session, { entryId: "entry-1", expectedLeafId: "leaf-1" }, machineId)),
      ignoreParseFailure(sessionsApi.abort(session, machineId)),
      ignoreParseFailure(sessionsApi.stop(session, machineId)),
      ignoreParseFailure(sessionsApi.archive(session, machineId)),
      ignoreParseFailure(sessionsApi.archiveWithDescendants(session, machineId)),
      ignoreParseFailure(sessionsApi.restore(session, machineId)),
      ignoreParseFailure(sessionsApi.reloadSession(session, machineId)),
      ignoreParseFailure(sessionsApi.detachParent(session, machineId)),
      ignoreParseFailure(sessionsApi.authProviders({ mode: "login", authType: "oauth", machineId })),
      ignoreParseFailure(sessionsApi.startInteractiveApiKeyLogin("amazon-bedrock", machineId)),
      ignoreParseFailure(sessionsApi.logoutProvider("openai", machineId)),
      ignoreParseFailure(sessionsApi.startOAuthLogin("openai", machineId)),
      ignoreParseFailure(sessionsApi.oauthFlow("flow 1", machineId)),
      ignoreParseFailure(sessionsApi.respondOAuthFlow("flow 1", "req 1", "code", machineId)),
      ignoreParseFailure(sessionsApi.cancelOAuthFlow("flow 1", machineId)),
      ignoreParseFailure(terminalsApi.terminals("p 1", "w 1", machineId)),
      ignoreParseFailure(terminalsApi.startTerminal("p 1", "w 1", { cols: 120, rows: 40 }, machineId)),
      ignoreParseFailure(terminalsApi.closeWorkspaceTerminals("p 1", "w 1", machineId)),
      ignoreParseFailure(terminalsApi.closeTerminal("p 1", "w 1", "t 1", machineId)),
      ignoreParseFailure(terminalsApi.continueTerminal("p 1", "w 1", "t 1", machineId)),
      ignoreParseFailure(terminalsApi.runTerminalCommand("core", { workspace, title: "Build", command: "npm test" }, machineId)),
      ignoreParseFailure(terminalsApi.listCommandRuns({ projectId: "p 1", workspaceId: "w 1", statuses: ["running"], metadata: { "pi.operation": "test" } }, machineId)),
      ignoreParseFailure(terminalsApi.getCommandRun("run 1", machineId)),
      ignoreParseFailure(terminalsApi.cancelCommandRun("run 1", machineId)),
    ]);

    const observedRoutes = uniqueHttpRoutes([
      ...fetchMock.mock.calls.map((call) => fetchCallToRoute(call, machineId)),
      routeFromMachineUrl("GET", workspaceFilePreviewUrl("p 1", "w 1", "diagram.svg", { machineId, modifiedAt: "2026-05-25T00:00:00.000Z" }), machineId),
    ]);
    const unmatched = observedRoutes.filter((route) => !matchesHttpRoute(route, FEDERATED_HTTP_ROUTES));

    expect(unmatched).toEqual([]);
  });

  it("covers machine-scoped client WebSocket calls with remote proxy routes", () => {
    const webSocketUrls: string[] = [];
    function FakeWebSocket(url: string): void {
      webSocketUrls.push(url);
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    sessionEvents(session, machineId);
    globalSessionEvents(machineId);
    realtimeEvents(machineId);
    terminalSocket("p 1", "w 1", "t 1", { cols: 120, rows: 40 }, machineId);

    const observedPaths = uniqueStrings(webSocketUrls.map((url) => routeFromMachineUrl("GET", url, machineId).path));
    const unmatched = observedPaths.filter((path) => !FEDERATED_WEBSOCKET_ROUTES.some((route) => pathMatchesPattern(path, route)));

    expect(unmatched).toEqual([]);
  });
});

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ObservedHttpRoute {
  method: string;
  path: string;
}

async function ignoreParseFailure(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => undefined);
}

function fetchCallToRoute(call: Parameters<FetchLike>, scopedMachineId: string): ObservedHttpRoute {
  const [url, init] = call;
  return routeFromMachineUrl((init?.method ?? "GET").toUpperCase(), url, scopedMachineId);
}

function routeFromMachineUrl(method: string, input: string | URL | Request, scopedMachineId: string): ObservedHttpRoute {
  const url = toUrl(input);
  const prefix = `/api/machines/${encodeURIComponent(scopedMachineId)}`;
  const prefixIndex = url.pathname.lastIndexOf(prefix);
  if (prefixIndex === -1) throw new Error(`Expected machine-scoped URL, got ${url.pathname}`);
  return { method, path: url.pathname.slice(prefixIndex + prefix.length) || "/" };
}

function toUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input, "https://pi.example.test");
}

function matchesHttpRoute(route: ObservedHttpRoute, specs: readonly FederatedHttpRouteSpec[]): boolean {
  return specs.some((spec) => spec.method === route.method && pathMatchesPattern(route.path, spec.path));
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const pathSegments = path.split("/").filter((segment) => segment !== "");
  const patternSegments = pattern.split("/").filter((segment) => segment !== "");
  return pathSegments.length === patternSegments.length
    && patternSegments.every((segment, index) => segment.startsWith(":") || segment === pathSegments[index]);
}

function uniqueHttpRoutes(routes: ObservedHttpRoute[]): ObservedHttpRoute[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
