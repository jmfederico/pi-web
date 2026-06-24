import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import type { TerminalCommandRun, Workspace } from "../../../shared/apiTypes";
import { filesApi, machinesApi, piWebApi, sessionsApi, terminalsApi, workspacesApi } from "./clients";

const workspace: Workspace = {
  id: "w/1",
  projectId: "p 1",
  path: "/repo",
  label: "repo",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
};

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("machine-scoped runtime API", () => {
  it("reads machine PI WEB status through the gateway route", async () => {
    const fetchMock = stubJsonFetch({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "PI WEB", available: true, stale: false },
        sessiond: { component: "sessiond", label: "PI WEB Session Daemon", available: true, stale: false },
      },
      release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
      commands: {},
      messages: [],
    });

    await piWebApi.piWebStatus("remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote%20a/pi-web/status");
  });

  it("reads machine runtime through the gateway route", async () => {
    const fetchMock = stubJsonFetch({ machineId: "remote a", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] });

    await machinesApi.runtime("remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote%20a/runtime");
  });
});

describe("session API compatibility", () => {
  it("keeps legacy session-id calls free of cwd context", async () => {
    const fetchMock = stubJsonFetch({ accepted: true });

    await sessionsApi.prompt("s 1", "hello", "followUp", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/sessions/s%201/prompt");
    expect(JSON.parse(requestBody(init))).toEqual({ text: "hello", streamingBehavior: "followUp" });
  });

  it("adds cwd context when session refs include a workspace", async () => {
    const fetchMock = stubJsonFetch({ accepted: true });

    await sessionsApi.prompt({ id: "s 1", cwd: "/repo" }, "hello", undefined, "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/sessions/s%201/prompt");
    expect(JSON.parse(requestBody(init))).toEqual({ cwd: "/repo", text: "hello" });
  });
});

describe("machine-scoped file suggestion API", () => {
  it("uses the workspace-scoped route when the caller has enabled workspace-scoped suggestions", async () => {
    const fetchMock = stubJsonFetch([]);

    await filesApi.files("/repo", "README", { projectId: "p 1", workspaceId: "w/1", scope: "tracked", machineId: "remote a", workspaceScoped: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/files?q=README&scope=tracked");
  });

  it("falls back to the legacy cwd route when workspace-scoped suggestions are not enabled", async () => {
    const fetchMock = stubJsonFetch([]);

    await filesApi.files("/repo", "README", { projectId: "p 1", workspaceId: "w/1", scope: "tracked", machineId: "remote a" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote%20a/files?q=README&scope=tracked&cwd=%2Frepo");
  });
});

describe("machine-scoped terminal command-run API", () => {
  it("deletes workspaces through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch(commandRun);

    await workspacesApi.deleteWorkspace("p 1", "w/1", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/projects/p%201/workspaces/w%2F1");
    expect(init?.method).toBe("DELETE");
  });

  it("creates command runs through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch(commandRun);

    await terminalsApi.runTerminalCommand("core", { workspace, title: "Build", command: "npm test", open: true }, "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/terminal-command-runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(requestBody(init))).toEqual({ origin: "core", title: "Build", command: "npm test", metadata: {} });
  });

  it("closes all workspace terminals through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch({ closed: true });

    await terminalsApi.closeWorkspaceTerminals("p 1", "w/1", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/terminals");
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
      "/api/machines/remote%20a/terminal-command-runs?projectId=p+1&workspaceId=w%2F1&statuses=running&metadata=%7B%22pi.operation%22%3A%22workspace.delete%22%7D",
      "/api/machines/remote%20a/terminal-command-runs/run%201",
      "/api/machines/remote%20a/terminal-command-runs/run%201/cancel",
    ]);
    expect(fetchCall(fetchMock, 2)[1]?.method).toBe("POST");
  });

  it("returns undefined for missing command runs in the selected machine scope", async () => {
    const fetchMock = stubResponseFetch(new Response("{}", { status: 404 }));

    await expect(terminalsApi.getCommandRun("missing", "remote-a")).resolves.toBeUndefined();

    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote-a/terminal-command-runs/missing");
  });
});

describe("workspace file write API", () => {
  it("sends text content with Content-Type text/plain", async () => {
    const fetchMock = stubJsonFetch({ path: "hello.txt", size: 11, modifiedAt: "2026-06-10T00:00:00.000Z", created: true });

    await workspacesApi.writeWorkspaceFile("p 1", "w/1", "hello.txt", "hello world");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/local/projects/p%201/workspaces/w%2F1/file?path=hello.txt");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("content-type")).toBe("text/plain");
  });

  it("sends binary content with Content-Type application/octet-stream", async () => {
    const fetchMock = stubJsonFetch({ path: "image.png", size: 4, modifiedAt: "2026-06-10T00:00:00.000Z", created: true });
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await workspacesApi.writeWorkspaceFile("p 1", "w/1", "image.png", binary);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/local/projects/p%201/workspaces/w%2F1/file?path=image.png");
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
    expect(url).toContain("/api/machines/remote%20a/");
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
