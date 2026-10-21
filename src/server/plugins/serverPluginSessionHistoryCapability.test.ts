import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY } from "../../shared/pluginSessionHistoryTypes.js";
import type { PluginSessionSnapshot } from "../../shared/pluginCatalogTypes.js";
import { createServerPluginSessionHistoryCapabilityFactory } from "./serverPluginSessionHistoryCapability.js";

const cwd = resolve("/repo");
const selection = { projectId: "p", workspaceId: "w", sessionId: "cold" };

function fixture() {
  const projects = { requireProject: vi.fn((id: string) => Promise.resolve({ id, name: "Project", path: cwd, createdAt: "2026-01-01T00:00:00.000Z" })) };
  const workspaces = { resolve: vi.fn((project: { id: string }) => Promise.resolve({
    projectId: project.id,
    status: "provider" as const,
    diagnostics: [],
    workspaces: [{ id: "w", projectId: project.id, path: cwd, label: "Main", isMain: true }],
  })) };
  const sessions = {
    listCatalogSessions: vi.fn((path: string): Promise<readonly PluginSessionSnapshot[]> => Promise.resolve([
      { id: "cold", cwd: path, archived: true, runtime: "not-hosted" },
    ])),
    inspectionMessages: vi.fn(() => Promise.resolve({ messages: [{ role: "user", content: "history" }], start: 0, total: 1 })),
  };
  const lifetime = new AbortController();
  const instance = createServerPluginSessionHistoryCapabilityFactory({ projects, workspaces, sessions }).create({
    pluginId: "consumer", packageRoot: "/plugins/consumer", lifetimeSignal: lifetime.signal,
  });
  const history = PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY.parse(instance.value);
  return { projects, workspaces, sessions, lifetime, instance, history };
}

describe("server plugin session history capability", () => {
  it("rechecks project, workspace and session scope before bounded observational reads", async () => {
    const f = fixture();
    await expect(f.history.readMessages(selection, { before: 4, limit: 10 })).resolves.toMatchObject({
      messages: [{ role: "user", content: "history" }], start: 0, total: 1,
    });
    expect(f.sessions.inspectionMessages).toHaveBeenCalledWith({ id: "cold", cwd }, { before: 4, limit: 10 }, expect.any(AbortSignal));
    await expect(f.history.readMessages({ ...selection, sessionId: "missing" })).rejects.toThrow("stale or unavailable");
    expect(f.sessions.inspectionMessages).toHaveBeenCalledTimes(1);
  });

  it("fails closed for duplicate or out-of-workspace session rows", async () => {
    const f = fixture();
    f.sessions.listCatalogSessions.mockResolvedValue([
      { id: "cold", cwd, archived: false, runtime: "not-hosted" },
      { id: "cold", cwd, archived: true, runtime: "not-hosted" },
    ]);
    await expect(f.history.readMessages(selection)).rejects.toThrow("ambiguous");
    f.sessions.listCatalogSessions.mockResolvedValue([{ id: "cold", cwd: "/other", archived: false, runtime: "not-hosted" }]);
    await expect(f.history.readMessages(selection)).rejects.toThrow("outside selected workspace");
    expect(f.sessions.inspectionMessages).not.toHaveBeenCalled();
  });

  it("honors capability lifetime revocation", async () => {
    const f = fixture();
    f.lifetime.abort();
    await expect(f.history.readMessages(selection)).rejects.toThrow("aborted");
    await f.instance.dispose?.(new AbortController().signal);
  });
});
