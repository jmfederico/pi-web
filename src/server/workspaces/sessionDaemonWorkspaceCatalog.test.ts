import { describe, expect, it, vi } from "vitest";
import type { SessionDaemonRequestClient } from "../../sessiond/sessionDaemonClient.js";
import { SessionDaemonWorkspaceCatalog } from "./sessionDaemonWorkspaceCatalog.js";
import {
  WorkspaceCatalogProtocolError,
  WorkspaceCatalogRequestError,
  WorkspaceCatalogUnavailableError,
  workspaceCatalogHttpStatus,
} from "./workspaceCatalog.js";

const providerWorkspace = {
  id: "w/1",
  projectId: "project a",
  path: "/repo linked",
  label: "feature/one",
  branch: "legacy-top-level",
  isMain: true,
  provider: {
    pluginId: "replacement",
    capabilities: { request: false, remove: true },
    metadata: {
      isGitRepo: true,
      isGitWorktree: true,
      branch: "feature/one",
      detached: false,
    },
  },
  removal: {
    actionLabel: "Disconnect view",
    confirmation: "Disconnect this view?",
    precondition: "v1.confirmed",
  },
};

describe("SessionDaemonWorkspaceCatalog", () => {
  it("uses encoded daemon operations and preserves provider metadata without restoring removed top-level aliases", async () => {
    const request = vi.fn<SessionDaemonRequestClient["request"]>((_method, path) => Promise.resolve(jsonResponse(
      path.endsWith("/w%2F1") ? providerWorkspace : providerResolution([providerWorkspace]),
    )));
    const catalog = new SessionDaemonWorkspaceCatalog({ request });

    const resolution = await catalog.resolveProject("project a");
    const listed = await catalog.list("project a");
    const resolved = await catalog.resolve("project a", "w/1");

    expect(request).toHaveBeenNthCalledWith(1, "GET", "/workspace-catalog/projects/project%20a/workspaces");
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/workspace-catalog/projects/project%20a/workspaces");
    expect(request).toHaveBeenNthCalledWith(3, "GET", "/workspace-catalog/projects/project%20a/workspaces/w%2F1");
    expect(resolution).toMatchObject({
      status: "provider",
      projectId: "project a",
      ownerPluginId: "replacement",
      diagnostics: [{ code: "probe-failed", tier: "primary", pluginId: "passing-provider" }],
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      label: "feature/one",
      provider: { pluginId: "replacement", metadata: { branch: "feature/one", detached: false } },
      removal: { precondition: "v1.confirmed" },
    });
    expect(listed[0]).not.toHaveProperty("branch");
    expect(resolved).toEqual(listed[0]);
    expect(resolved).not.toHaveProperty("branch");
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.workspaces)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(Object.isFrozen(listed[0]?.provider)).toBe(true);
    expect(Object.isFrozen(listed[0]?.provider?.capabilities)).toBe(true);
    expect(Object.isFrozen(listed[0]?.provider?.metadata)).toBe(true);
    expect(Object.isFrozen(listed[0]?.removal)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("parses the immutable provider runtime and startup-health snapshot", async () => {
    const request = vi.fn<SessionDaemonRequestClient["request"]>(() => Promise.resolve(jsonResponse({
      protocolVersion: 1,
      safeStart: "bundled-only",
      records: [{
        pluginId: "git",
        source: "bundled",
        scope: "bundled",
        moduleRevision: "sha256:abc",
        browserRevision: "sha256:browser",
        settingsRevision: "sha256:settings",
        machineSpecific: true,
        state: "active",
        name: "Git",
      }],
      health: [{ pluginId: "git", health: { status: "degraded", message: "Git is old", details: { version: 1, nested: ["ok", { ready: true }] } } }],
      diagnostics: [{ code: "duplicate-id", source: "local", message: "Duplicate PI WEB plugin id: git", pluginId: "git" }],
    })));
    const catalog = new SessionDaemonWorkspaceCatalog({ request });

    const snapshot = await catalog.providerRuntime();

    expect(request).toHaveBeenCalledWith("GET", "/workspace-catalog/provider-runtime");
    expect(snapshot).toEqual({
      protocolVersion: 1,
      safeStart: "bundled-only",
      records: [{ pluginId: "git", source: "bundled", scope: "bundled", moduleRevision: "sha256:abc", browserRevision: "sha256:browser", settingsRevision: "sha256:settings", machineSpecific: true, state: "active", name: "Git" }],
      health: [{ pluginId: "git", health: { status: "degraded", message: "Git is old", details: { version: 1, nested: ["ok", { ready: true }] } } }],
      diagnostics: [{ code: "duplicate-id", source: "local", message: "Duplicate PI WEB plugin id: git", pluginId: "git" }],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.health)).toBe(true);
    const details = snapshot.health[0]?.health.details;
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details?.["nested"])).toBe(true);
  });

  it("rejects mismatched or malformed authority responses before filesystem consumers use them", async () => {
    const mismatched = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve(jsonResponse({ ...providerWorkspace, projectId: "another-project" })),
    });
    const relative = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve(jsonResponse(providerResolution([{ ...providerWorkspace, path: "relative" }]))),
    });
    const missingPrecondition = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve(jsonResponse(providerResolution([{
        ...providerWorkspace,
        removal: { actionLabel: "Disconnect view", confirmation: "Disconnect this view?" },
      }]))),
    });

    await expect(mismatched.resolve("project a", "w/1")).rejects.toBeInstanceOf(WorkspaceCatalogProtocolError);
    await expect(relative.list("project a")).rejects.toThrow("path must be absolute");
    await expect(missingPrecondition.list("project a")).rejects.toThrow("removal precondition must be a non-empty string");
  });

  it("rejects a pre-lifecycle provider snapshot as an explicit mixed-version protocol error", async () => {
    const oldDaemon = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve(jsonResponse({ records: [], health: [] })),
    });

    const error: unknown = await oldDaemon.providerRuntime().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WorkspaceCatalogProtocolError);
    if (!(error instanceof Error)) throw new Error("Expected provider runtime protocol error");
    expect(error.message).toContain("provider runtime protocol is unsupported");
  });

  it("distinguishes daemon unavailability, upstream failures, and invalid JSON for route status mapping", async () => {
    const unavailable = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    const quiescing = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve({ statusCode: 503, headers: {}, body: JSON.stringify({ error: "Session daemon is shutting down" }) }),
    });
    const invalid = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve({ statusCode: 200, headers: {}, body: "not-json" }),
    });
    const missingWorkspace = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve({ statusCode: 404, headers: {}, body: JSON.stringify({ error: "Workspace not found" }) }),
    });
    const oldDaemon = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve({
        statusCode: 404,
        headers: {},
        body: JSON.stringify({ statusCode: 404, error: "Not Found", message: "Route GET:/workspace-catalog/projects/p1/workspaces not found" }),
      }),
    });

    const unavailableError = await unavailable.list("p1").catch((error: unknown) => error);
    const quiescingError = await quiescing.list("p1").catch((error: unknown) => error);
    const invalidError = await invalid.list("p1").catch((error: unknown) => error);
    const missingWorkspaceError = await missingWorkspace.resolve("p1", "missing").catch((error: unknown) => error);
    const oldDaemonError = await oldDaemon.list("p1").catch((error: unknown) => error);

    expect(unavailableError).toBeInstanceOf(WorkspaceCatalogUnavailableError);
    expect(unavailableError).toHaveProperty("message", "Session daemon workspace authority unavailable: connect ECONNREFUSED");
    expect(workspaceCatalogHttpStatus(unavailableError, 400)).toBe(503);
    expect(quiescingError).toBeInstanceOf(WorkspaceCatalogRequestError);
    expect(quiescingError).toHaveProperty("message", "Session daemon workspace authority returned HTTP 503: Session daemon is shutting down");
    expect(workspaceCatalogHttpStatus(quiescingError, 400)).toBe(503);
    expect(invalidError).toBeInstanceOf(WorkspaceCatalogProtocolError);
    expect(workspaceCatalogHttpStatus(invalidError, 400)).toBe(502);
    expect(missingWorkspaceError).toBeInstanceOf(WorkspaceCatalogRequestError);
    expect(missingWorkspaceError).toHaveProperty("message", "Workspace not found");
    expect(workspaceCatalogHttpStatus(missingWorkspaceError, 400)).toBe(400);
    expect(oldDaemonError).toBeInstanceOf(WorkspaceCatalogProtocolError);
    expect(oldDaemonError).toHaveProperty(
      "message",
      "Session daemon does not support workspace authority operations; restart or upgrade the session daemon",
    );
    expect(workspaceCatalogHttpStatus(oldDaemonError, 404)).toBe(502);
  });
});

function providerResolution(workspaces: unknown[]) {
  return {
    status: "provider",
    projectId: "project a",
    ownerPluginId: "replacement",
    workspaces,
    diagnostics: [{
      code: "probe-failed",
      message: "Passing provider probe failed",
      tier: "primary",
      pluginId: "passing-provider",
    }],
  };
}

function jsonResponse(value: unknown) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}
