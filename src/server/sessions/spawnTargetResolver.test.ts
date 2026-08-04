import { describe, expect, it } from "vitest";
import type { Project, WorkspaceListing } from "../types.js";
import { ProjectScopedSpawnTargetResolver } from "./spawnTargetResolver.js";

function project(id: string, path: string): Project {
  return { id, name: id, path, createdAt: "2026-01-01T00:00:00.000Z" };
}

function workspace(projectId: string, path: string): WorkspaceListing {
  return { id: `${projectId}:${path}`, projectId, path, label: path, isMain: false };
}

function resolverFor(projects: Project[], workspacesByProject: Record<string, WorkspaceListing[]>): ProjectScopedSpawnTargetResolver {
  return new ProjectScopedSpawnTargetResolver({
    projects: { list: () => Promise.resolve(projects) },
    workspaces: { list: (p) => Promise.resolve(workspacesByProject[p.id] ?? []) },
  });
}

describe("ProjectScopedSpawnTargetResolver", () => {
  it("allows a target that is a workspace of the spawning session's project", async () => {
    const resolver = resolverFor([project("a", "/repos/a"), project("b", "/repos/b")], {
      a: [workspace("a", "/repos/a"), workspace("a", "/repos/a-feature")],
      b: [workspace("b", "/repos/b")],
    });

    await expect(resolver.resolveSpawnTarget("/repos/a", "/repos/a-feature")).resolves.toEqual({ allowed: true, cwd: "/repos/a-feature" });
  });

  it("defaults the target to the spawning cwd when none is requested", async () => {
    const resolver = resolverFor([project("a", "/repos/a")], { a: [workspace("a", "/repos/a")] });

    await expect(resolver.resolveSpawnTarget("/repos/a", undefined)).resolves.toEqual({ allowed: true, cwd: "/repos/a" });
  });

  it("returns the canonical workspace path even when the request differs only by trailing slash", async () => {
    const resolver = resolverFor([project("a", "/repos/a")], { a: [workspace("a", "/repos/a")] });

    await expect(resolver.resolveSpawnTarget("/repos/a", "/repos/a/")).resolves.toEqual({ allowed: true, cwd: "/repos/a" });
  });

  it("rejects a target outside the project's workspaces and lists the allowed ones", async () => {
    const resolver = resolverFor([project("a", "/repos/a")], { a: [workspace("a", "/repos/a"), workspace("a", "/repos/a-feature")] });

    await expect(resolver.resolveSpawnTarget("/repos/a", "/elsewhere")).resolves.toEqual({
      allowed: false,
      reason: "out-of-project",
      allowedCwds: ["/repos/a", "/repos/a-feature"],
    });
  });

  it("rejects when the spawning cwd is in no registered project", async () => {
    const resolver = resolverFor([project("a", "/repos/a")], { a: [workspace("a", "/repos/a")] });

    await expect(resolver.resolveSpawnTarget("/elsewhere", undefined)).resolves.toEqual({ allowed: false, reason: "not-registered" });
  });
});
