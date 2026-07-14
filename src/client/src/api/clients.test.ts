import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import type { PiWebConfigValues, TerminalCommandRun, Workspace } from "../../../shared/apiTypes";
import { configApi, filesApi, machinesApi, piPackagesApi, piWebApi, pluginsApi, sessionsApi, terminalsApi, workspacesApi } from "./clients";

const workspace: Workspace = {
  id: "w/1",
  projectId: "p 1",
  path: "/repo",
  label: "repo",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
};

function piWebStatusResponse() {
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt: "now",
    components: {
      web: { component: "web", label: "PI WEB", available: true, stale: false },
      sessiond: { component: "sessiond", label: "PI WEB Session Daemon", available: true, stale: false },
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
    commands: {},
    messages: [],
  };
}

const commandRun: TerminalCommandRun = {
  id: "run1",
  origin: "core",
  projectId: workspace.projectId,
  workspaceId: workspace.id,
  terminalId: "t1",
  title: "Build",
  command: "npm test",
  status: "running",
  createdAt: "2026-05-25T00:00:00.000Z",
  metadata: {},
};

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("machine-scoped runtime API", () => {
  it("reads machine PI WEB status through the gateway route", async () => {
    const fetchMock = stubJsonFetch(piWebStatusResponse());

    await piWebApi.piWebStatus("remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20a/pi-web/status");
  });

  it("requests an uncached update check through the local status route", async () => {
    const fetchMock = stubJsonFetch(piWebStatusResponse());

    await piWebApi.checkForUpdates();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/pi-web/status?refresh=1");
    expect(fetchCall(fetchMock, 0)[1]?.cache).toBe("no-store");
  });

  it("requests an uncached update check through the selected machine route", async () => {
    const fetchMock = stubJsonFetch(piWebStatusResponse());

    await piWebApi.checkForUpdates("remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20a/pi-web/status?refresh=1");
    expect(fetchCall(fetchMock, 0)[1]?.cache).toBe("no-store");
  });

  it("reads machine runtime through the gateway route", async () => {
    const response = { machineId: "remote a", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] };
    const fetchMock = stubSequenceFetch([jsonResponse(response), jsonResponse(response)]);

    await machinesApi.runtime("remote a");
    await machinesApi.runtime("remote a", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20a/runtime");
    expect(fetchCall(fetchMock, 1)[0]).toBe("https://pi.example.test/api/machines/remote%20a/runtime?refresh=1");
    expect(fetchCall(fetchMock, 1)[1]?.cache).toBe("no-store");
  });
});

describe("settings config and plugin APIs", () => {
  it("preserves gateway config and plugin routes by default", async () => {
    const fetchMock = stubSequenceFetch([
      jsonResponse(piWebConfigResponse({ host: "127.0.0.1" })),
      jsonResponse(piWebConfigResponse({ spawnSessions: true })),
      jsonResponse(piWebPluginsResponse()),
    ]);

    await expect(configApi.config()).resolves.toMatchObject({ config: { host: "127.0.0.1" } });
    await expect(configApi.saveConfig({ spawnSessions: true })).resolves.toMatchObject({ config: { spawnSessions: true } });
    await expect(pluginsApi.plugins()).resolves.toEqual(piWebPluginsResponse());

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://pi.example.test/api/config",
      "https://pi.example.test/api/config",
      "https://pi.example.test/api/plugins",
    ]);
    expect(fetchCall(fetchMock, 1)[1]?.method).toBe("PUT");
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 1)[1]))).toEqual({ config: { spawnSessions: true } });
  });

  it("uses machine-scoped config and plugin routes when a machine id is provided", async () => {
    const fetchMock = stubSequenceFetch([
      jsonResponse(piWebConfigResponse({ spawnSessions: false })),
      jsonResponse(piWebConfigResponse({ spawnSessions: true })),
      jsonResponse(piWebPluginsResponse()),
    ]);

    await expect(configApi.config("remote a")).resolves.toMatchObject({ config: { spawnSessions: false } });
    await expect(configApi.saveConfig({ spawnSessions: true }, "remote a")).resolves.toMatchObject({ config: { spawnSessions: true } });
    await expect(pluginsApi.plugins("remote a")).resolves.toEqual(piWebPluginsResponse());

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://pi.example.test/api/machines/remote%20a/config",
      "https://pi.example.test/api/machines/remote%20a/config",
      "https://pi.example.test/api/machines/remote%20a/plugins",
    ]);
    expect(fetchCall(fetchMock, 1)[1]?.method).toBe("PUT");
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 1)[1]))).toEqual({ config: { spawnSessions: true } });
  });
});

describe("Pi package API", () => {
  it("preserves the legacy local Pi package-management routes by default", async () => {
    const packages = [{ source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/tools" }];
    const fetchMock = stubSequenceFetch([
      jsonResponse({ packages }),
      jsonResponse({ action: "install", source: "npm:@acme/new-tools", packages }),
      jsonResponse({ action: "remove", source: "../project-tools", scope: "project", removed: true, packages }),
      jsonResponse({ action: "update", source: "npm:@acme/tools", packages }),
      jsonResponse({ action: "update", packages }),
    ]);

    await expect(piPackagesApi.packages()).resolves.toEqual({ packages });
    await piPackagesApi.install("npm:@acme/new-tools");
    await piPackagesApi.remove("../project-tools", "project");
    await piPackagesApi.update("npm:@acme/tools");
    await piPackagesApi.update();

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://pi.example.test/api/pi-packages",
      "https://pi.example.test/api/pi-packages/install",
      "https://pi.example.test/api/pi-packages/remove",
      "https://pi.example.test/api/pi-packages/update",
      "https://pi.example.test/api/pi-packages/update",
    ]);
    expect(fetchCall(fetchMock, 1)[1]?.method).toBe("POST");
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 1)[1]))).toEqual({ source: "npm:@acme/new-tools" });
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 2)[1]))).toEqual({ source: "../project-tools", scope: "project" });
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 3)[1]))).toEqual({ source: "npm:@acme/tools" });
    expect(fetchCall(fetchMock, 4)[1]?.body).toBeUndefined();
  });

  it("uses machine-scoped Pi package-management routes when a machine id is provided", async () => {
    const packages = [{ source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/tools" }];
    const fetchMock = stubSequenceFetch([
      jsonResponse({ packages }),
      jsonResponse({ packages }),
      jsonResponse({ action: "install", source: "npm:@acme/new-tools", packages }),
      jsonResponse({ action: "remove", source: "../project-tools", removed: true, packages }),
      jsonResponse({ action: "update", packages }),
    ]);

    await expect(piPackagesApi.packages("local")).resolves.toEqual({ packages });
    await expect(piPackagesApi.packages("remote a")).resolves.toEqual({ packages });
    await piPackagesApi.install("npm:@acme/new-tools", "remote a");
    await piPackagesApi.remove("../project-tools", undefined, "remote a");
    await piPackagesApi.update(undefined, "remote a");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://pi.example.test/api/machines/local/pi-packages",
      "https://pi.example.test/api/machines/remote%20a/pi-packages",
      "https://pi.example.test/api/machines/remote%20a/pi-packages/install",
      "https://pi.example.test/api/machines/remote%20a/pi-packages/remove",
      "https://pi.example.test/api/machines/remote%20a/pi-packages/update",
    ]);
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 2)[1]))).toEqual({ source: "npm:@acme/new-tools" });
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 3)[1]))).toEqual({ source: "../project-tools" });
    expect(fetchCall(fetchMock, 4)[1]?.body).toBeUndefined();
  });
});

describe("session API compatibility", () => {
  it("posts session cleanup preview and execute requests through the selected machine", async () => {
    const preview = { generatedAt: "2026-06-25T12:00:00.000Z", thresholds: { archiveIdleDays: 7 }, projects: [{ cwd: "/repo", archiveCount: 2, deleteCount: 0 }], totals: { archiveCount: 2, deleteCount: 0 } };
    const executed = { ...preview, archivedSessionIds: ["s1", "s2"], deletedSessionIds: [] };
    const fetchMock = stubSequenceFetch([jsonResponse(preview), jsonResponse(executed)]);

    await expect(sessionsApi.cleanupPreview({ archiveIdleDays: 7, deleteArchivedDays: null }, "remote a")).resolves.toEqual(preview);
    await expect(sessionsApi.cleanup({ archiveIdleDays: 7, projectCwds: ["/repo"] }, "remote a")).resolves.toEqual(executed);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20a/sessions/cleanup/preview");
    expect(fetchCall(fetchMock, 0)[1]?.method).toBe("POST");
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 0)[1]))).toEqual({ archiveIdleDays: 7, deleteArchivedDays: null });
    expect(fetchCall(fetchMock, 1)[0]).toBe("https://pi.example.test/api/machines/remote%20a/sessions/cleanup");
    expect(fetchCall(fetchMock, 1)[1]?.method).toBe("POST");
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 1)[1]))).toEqual({ archiveIdleDays: 7, projectCwds: ["/repo"] });
  });

  it("posts bulk session mutation requests through the selected machine", async () => {
    const archived = { archived: true, archivedSessionIds: ["s 1"], failures: [{ sessionId: "s 2", error: "busy" }], generatedAt: "now" };
    const deleted = { deleted: true, deletedSessionIds: ["s 1"], failures: [], generatedAt: "later" };
    const fetchMock = stubSequenceFetch([jsonResponse(archived), jsonResponse(deleted)]);

    await expect(sessionsApi.archiveMany([{ id: "s 1", cwd: "/repo" }, "s 2"], "remote a")).resolves.toEqual(archived);
    await expect(sessionsApi.deleteArchivedMany([{ id: "s 1", cwd: "/repo" }], "remote a")).resolves.toEqual(deleted);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20a/sessions/bulk/archive");
    expect(fetchCall(fetchMock, 0)[1]?.method).toBe("POST");
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 0)[1]))).toEqual({ sessions: [{ id: "s 1", cwd: "/repo" }, { id: "s 2" }] });
    expect(fetchCall(fetchMock, 1)[0]).toBe("https://pi.example.test/api/machines/remote%20a/sessions/bulk/delete-archived");
    expect(fetchCall(fetchMock, 1)[1]?.method).toBe("POST");
    expect(JSON.parse(requestBody(fetchCall(fetchMock, 1)[1]))).toEqual({ sessions: [{ id: "s 1", cwd: "/repo" }] });
  });

  it("keeps legacy session-id calls free of cwd context", async () => {
    const fetchMock = stubJsonFetch({ accepted: true });

    await sessionsApi.prompt("s 1", "hello", "followUp", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://pi.example.test/api/machines/remote%20a/sessions/s%201/prompt");
    expect(JSON.parse(requestBody(init))).toEqual({ text: "hello", streamingBehavior: "followUp" });
  });

  it("adds cwd context when session refs include a workspace", async () => {
    const fetchMock = stubJsonFetch({ accepted: true });

    await sessionsApi.prompt({ id: "s 1", cwd: "/repo" }, "hello", undefined, "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://pi.example.test/api/machines/remote%20a/sessions/s%201/prompt");
    expect(JSON.parse(requestBody(init))).toEqual({ cwd: "/repo", text: "hello" });
  });

  it("clears a session queue through an encoded machine route and parses the returned status", async () => {
    const fetchMock = stubJsonFetch({
      sessionId: "s /?",
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, total: 6 },
      cost: 0.25,
      ignored: "not part of SessionStatus",
    });

    await expect(sessionsApi.clearQueue({ id: "s /?", cwd: "/repo with spaces" }, "remote /?")).resolves.toEqual({
      sessionId: "s /?",
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, total: 6 },
      cost: 0.25,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://pi.example.test/api/machines/remote%20%2F%3F/sessions/s%20%2F%3F/queue/clear");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(requestBody(init))).toEqual({ cwd: "/repo with spaces" });
  });
});

describe("machine-scoped file suggestion API", () => {
  it("uses the workspace-scoped route when the caller has enabled workspace-scoped suggestions", async () => {
    const fetchMock = stubJsonFetch([]);

    await filesApi.files("/repo", "README", { projectId: "p 1", workspaceId: "w/1", scope: "tracked", machineId: "remote a", workspaceScoped: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/files?q=README&scope=tracked");
  });

  it("falls back to the legacy cwd route when workspace-scoped suggestions are not enabled", async () => {
    const fetchMock = stubJsonFetch([]);

    await filesApi.files("/repo", "README", { projectId: "p 1", workspaceId: "w/1", scope: "tracked", machineId: "remote a" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20a/files?q=README&scope=tracked&cwd=%2Frepo");
  });
});

describe("machine-scoped workspace API", () => {
  it("keeps project ids in one encoded route segment when listing workspaces", async () => {
    const fetchMock = stubJsonFetch([]);

    await workspacesApi.workspaces("../p /?", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote%20a/projects/..%2Fp%20%2F%3F/workspaces");
  });
});

describe("machine-scoped terminal command-run API", () => {
  it("deletes workspaces through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch(commandRun);

    await workspacesApi.deleteWorkspace("p 1", "w/1", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://pi.example.test/api/machines/remote%20a/projects/p%201/workspaces/w%2F1");
    expect(init?.method).toBe("DELETE");
  });

  it("creates command runs through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch(commandRun);

    await terminalsApi.runTerminalCommand("core", { workspace, title: "Build", command: "npm test", open: true }, "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://pi.example.test/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/terminal-command-runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(requestBody(init))).toEqual({ origin: "core", title: "Build", command: "npm test", metadata: {} });
  });

  it("closes all workspace terminals through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch({ closed: true });

    await terminalsApi.closeWorkspaceTerminals("p 1", "w/1", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://pi.example.test/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/terminals");
    expect(init?.method).toBe("DELETE");
  });

  it("lists, reads, and cancels command runs through the selected machine scope", async () => {
    const fetchMock = stubSequenceFetch([
      jsonResponse([commandRun]),
      jsonResponse(commandRun),
      jsonResponse(commandRun),
    ]);

    await terminalsApi.listCommandRuns({ projectId: "p 1", workspaceId: "w/1", statuses: ["running"], metadata: { "pi.operation": "workspace.delete" } }, "remote a");
    await terminalsApi.getCommandRun("run 1", "remote a");
    await terminalsApi.cancelCommandRun("run 1", "remote a");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://pi.example.test/api/machines/remote%20a/terminal-command-runs?projectId=p+1&workspaceId=w%2F1&statuses=running&metadata=%7B%22pi.operation%22%3A%22workspace.delete%22%7D",
      "https://pi.example.test/api/machines/remote%20a/terminal-command-runs/run%201",
      "https://pi.example.test/api/machines/remote%20a/terminal-command-runs/run%201/cancel",
    ]);
    expect(fetchCall(fetchMock, 2)[1]?.method).toBe("POST");
  });

  it("returns undefined for missing command runs in the selected machine scope", async () => {
    const fetchMock = stubResponseFetch(new Response("{}", { status: 404 }));

    await expect(terminalsApi.getCommandRun("missing", "remote-a")).resolves.toBeUndefined();

    expect(fetchCall(fetchMock, 0)[0]).toBe("https://pi.example.test/api/machines/remote-a/terminal-command-runs/missing");
  });
});

describe("workspace file write API", () => {
  it("sends text content with Content-Type text/plain", async () => {
    const fetchMock = stubJsonFetch({ path: "hello.txt", size: 11, modifiedAt: "2026-06-10T00:00:00.000Z", created: true });

    await workspacesApi.writeWorkspaceFile("p 1", "w/1", "hello.txt", "hello world");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://pi.example.test/api/machines/local/projects/p%201/workspaces/w%2F1/file?path=hello.txt");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("content-type")).toBe("text/plain");
  });

  it("sends binary content with Content-Type application/octet-stream", async () => {
    const fetchMock = stubJsonFetch({ path: "image.png", size: 4, modifiedAt: "2026-06-10T00:00:00.000Z", created: true });
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await workspacesApi.writeWorkspaceFile("p 1", "w/1", "image.png", binary);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("https://pi.example.test/api/machines/local/projects/p%201/workspaces/w%2F1/file?path=image.png");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/octet-stream");
  });

  it("sends createDirs and overwrite query parameters", async () => {
    const fetchMock = stubJsonFetch({ path: "config/new.json", size: 10, modifiedAt: "2026-06-10T00:00:00.000Z", created: true });

    await workspacesApi.writeWorkspaceFile("p 1", "w/1", "config/new.json", "{\"a\":1}", { createDirs: false, overwrite: false });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchCall(fetchMock, 0);
    expect(url).toContain("createDirs=false");
    expect(url).toContain("overwrite=false");
  });

  it("parses WriteWorkspaceFileResponse correctly", async () => {
    const fetchMock = stubJsonFetch({ path: "output/result.txt", size: 42, modifiedAt: "2026-06-10T12:00:00.000Z", created: true });

    const result = await workspacesApi.writeWorkspaceFile("p 1", "w/1", "output/result.txt", "content");

    expect(fetchMock).toHaveBeenCalledOnce();

    expect(result).toEqual({
      path: "output/result.txt",
      size: 42,
      modifiedAt: "2026-06-10T12:00:00.000Z",
      created: true,
    });
  });

  it("routes through machine prefix for remote machines", async () => {
    const fetchMock = stubJsonFetch({ path: "file.txt", size: 5, modifiedAt: "2026-06-10T00:00:00.000Z", created: false });

    await workspacesApi.writeWorkspaceFile("p 1", "w/1", "file.txt", "data", undefined, "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchCall(fetchMock, 0);
    expect(url).toContain("api/machines/remote%20a/");
  });
});

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

function stubJsonFetch(value: unknown): FetchMock {
  return stubResponseFetch(jsonResponse(value));
}

function stubSequenceFetch(responses: Response[]): FetchMock {
  const fetchMock = vi.fn<FetchLike>(() => {
    const response = responses.shift();
    if (response === undefined) throw new Error("No fetch response queued");
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubResponseFetch(response: Response): FetchMock {
  const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchCall(fetchMock: FetchMock, index: number): Parameters<FetchLike> {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${String(index)}`);
  return call;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("Expected string request body");
  return init.body;
}

function piWebConfigResponse(config: PiWebConfigValues) {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}

function piWebPluginsResponse() {
  return { plugins: [{ id: "info", module: "/pi-web-plugins/info/plugin.js", source: "test", scope: "local", machineSpecific: false, enabled: true }] };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
