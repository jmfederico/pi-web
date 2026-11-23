import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { Project } from "../types.js";
import { createServerPluginSessionStateCapabilityFactory } from "./serverPluginSessionStateCapability.js";

function fixture() {
  const project: Project = { id: "p", name: "Project", path: resolve("/repo"), createdAt: "2026-09-10T00:00:00.000Z" };
  const workspace = { id: "w", projectId: project.id, path: resolve("/repo/worktree"), label: "Worktree", isMain: false };
  const projects = { requireProject: vi.fn((id: string) => id === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found"))) };
  const workspaces = { checkCurrent: vi.fn(() => Promise.resolve({ status: "folder" as const, projectId: project.id, workspaces: [workspace], diagnostics: [] })) };
  const sessions = {
    readSessionState: vi.fn(() => Promise.resolve({ revision: "old", value: { private: true } })),
    writeSessionState: vi.fn(() => Promise.resolve({ revision: "new", value: null })),
  };
  const lifetime = new AbortController();
  const instance = createServerPluginSessionStateCapabilityFactory({ projects, workspaces, sessions })
    .create({ pluginId: "example", packageRoot: "/plugins/example", lifetimeSignal: lifetime.signal });
  const selection = { projectId: "p", workspaceId: "w", sessionId: "s" };
  return { instance, capability: instance.value, selection, sessions, lifetime, projects, workspaces, workspace };
}

it("resolves authoritative scope for every private state call and delegates hosting/guarded mutation", async () => {
  const f = fixture();
  expect(await f.capability.read(f.selection, "example")).toEqual({ revision: "old", value: { private: true } });
  expect(f.sessions.readSessionState).toHaveBeenCalledWith({ id: "s", cwd: f.workspace.path }, "example", expect.any(AbortSignal));
  const input = { value: null, inherit: true, revision: "old" };
  expect(await f.capability.write(f.selection, "example", input)).toEqual({ revision: "new", value: null });
  expect(f.sessions.writeSessionState).toHaveBeenCalledWith({ id: "s", cwd: f.workspace.path }, "example", input, expect.any(AbortSignal));
  expect(f.workspaces.checkCurrent).toHaveBeenCalledTimes(2);
  await f.instance.dispose?.(new AbortController().signal);
  await expect(f.capability.read(f.selection, "example")).rejects.toThrow();
  expect(f.sessions.readSessionState).toHaveBeenCalledTimes(1);
});

it("rejects stale scope and cancellation before opening or mutating sessions", async () => {
  const f = fixture();
  await expect(f.capability.read({ ...f.selection, projectId: "unknown" }, "example")).rejects.toThrow();
  await expect(f.capability.read({ ...f.selection, workspaceId: "unknown" }, "example")).rejects.toThrow();
  await expect(f.capability.read({ ...f.selection, sessionId: "" }, "example")).rejects.toThrow();
  await expect(f.capability.read(f.selection, "example", { signal: AbortSignal.abort() })).rejects.toThrow();
  f.workspaces.checkCurrent.mockImplementation(() => {
    f.lifetime.abort();
    return Promise.resolve({ status: "folder", projectId: "p", workspaces: [f.workspace], diagnostics: [] });
  });
  await expect(f.capability.write(f.selection, "example", { value: null, inherit: false, revision: "" })).rejects.toThrow();
  expect(f.sessions.readSessionState).not.toHaveBeenCalled();
  expect(f.sessions.writeSessionState).not.toHaveBeenCalled();
});
