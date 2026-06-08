import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../shared/apiTypes";
import { FEDERATED_HTTP_ROUTES, FEDERATED_WEBSOCKET_ROUTES, type FederatedHttpRouteSpec } from "../../../shared/federatedRoutes";
import { activityApi, filesApi, gitApi, projectsApi, sessionsApi, terminalsApi, workspacesApi } from "./clients";
import { globalSessionEvents, realtimeEvents, sessionEvents, terminalSocket } from "./sockets";
import { workspaceImagePreviewUrl } from "./urls";

const machineId = "remote-a";
const workspace: Workspace = {
  id: "w 1",
  projectId: "p 1",
  path: "/repo",
  label: "repo",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("federated route contract", () => {
  it("covers machine-scoped client HTTP calls with remote proxy routes", async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      ignoreParseFailure(activityApi.workspaceActivity(machineId)),
      ignoreParseFailure(projectsApi.projects(machineId)),
      ignoreParseFailure(projectsApi.addProject("/repo", "Repo", false, machineId)),
      ignoreParseFailure(projectsApi.closeProject("p 1", machineId)),
      ignoreParseFailure(projectsApi.projectDirectories("/r", machineId)),
      ignoreParseFailure(workspacesApi.workspaces("p 1", machineId)),
      ignoreParseFailure(workspacesApi.deleteWorkspace("p 1", "w 1", machineId)),
      ignoreParseFailure(workspacesApi.workspaceTree("p 1", "w 1", "src", machineId)),
      ignoreParseFailure(workspacesApi.workspaceFile("p 1", "w 1", "README.md", machineId)),
      ignoreParseFailure(filesApi.files("/repo", "README", { kind: "tracked", mode: "file", machineId })),
      ignoreParseFailure(gitApi.gitStatus("p 1", "w 1", machineId)),
      ignoreParseFailure(gitApi.gitDiff("p 1", "w 1", { path: "README.md", staged: true }, machineId)),
      ignoreParseFailure(sessionsApi.sessions("/repo", machineId)),
      ignoreParseFailure(sessionsApi.startSession("/repo", machineId)),
      ignoreParseFailure(sessionsApi.messages("s 1", { limit: 20, before: 10 }, machineId)),
      ignoreParseFailure(sessionsApi.status("s 1", machineId)),
      ignoreParseFailure(sessionsApi.models("s 1", machineId)),
      ignoreParseFailure(sessionsApi.setModel("s 1", "openai", "gpt", machineId)),
      ignoreParseFailure(sessionsApi.cycleModel("s 1", "forward", machineId)),
      ignoreParseFailure(sessionsApi.thinkingLevels("s 1", machineId)),
      ignoreParseFailure(sessionsApi.setThinkingLevel("s 1", "medium", machineId)),
      ignoreParseFailure(sessionsApi.cycleThinkingLevel("s 1", machineId)),
      ignoreParseFailure(sessionsApi.commands("s 1", machineId)),
      ignoreParseFailure(sessionsApi.prompt("s 1", "hello", "followUp", machineId)),
      ignoreParseFailure(sessionsApi.shell("s 1", "ls", machineId)),
      ignoreParseFailure(sessionsApi.runCommand("s 1", "/help", machineId)),
      ignoreParseFailure(sessionsApi.respondToCommand("s 1", "req 1", "yes", machineId)),
      ignoreParseFailure(sessionsApi.abort("s 1", machineId)),
      ignoreParseFailure(sessionsApi.stop("s 1", machineId)),
      ignoreParseFailure(sessionsApi.archive("s 1", machineId)),
      ignoreParseFailure(sessionsApi.archiveWithDescendants("s 1", machineId)),
      ignoreParseFailure(sessionsApi.restore("s 1", machineId)),
      ignoreParseFailure(sessionsApi.deleteArchived("s 1", machineId)),
      ignoreParseFailure(sessionsApi.detachParent("s 1", machineId)),
      ignoreParseFailure(sessionsApi.authProviders({ mode: "login", authType: "oauth", machineId })),
      ignoreParseFailure(sessionsApi.saveApiKey("openai", "key", machineId)),
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
      routeFromMachineUrl("GET", workspaceImagePreviewUrl("p 1", "w 1", "diagram.svg", { machineId, modifiedAt: "2026-05-25T00:00:00.000Z" }), machineId),
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
    vi.stubGlobal("location", { protocol: "https:", host: "pi.example.test" });

    sessionEvents("s 1", machineId);
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
  if (!url.pathname.startsWith(prefix)) throw new Error(`Expected machine-scoped URL, got ${url.pathname}`);
  return { method, path: url.pathname.slice(prefix.length) || "/" };
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
