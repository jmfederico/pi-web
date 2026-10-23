import { request } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types.js";
import { registerWorkspaceNotificationRoutes } from "./workspaceNotificationRoutes.js";

const project: Project = { id: "p 1", name: "Repo", path: "/repo", createdAt: "2026-10-10T00:00:00.000Z" };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture(accepted = true) {
  const app = Fastify();
  apps.push(app);
  const requireProject = vi.fn((id: string) => id === project.id
    ? Promise.resolve(project)
    : Promise.reject(new Error("Project not found")));
  const acceptNotification = vi.fn(() => Promise.resolve(accepted));
  const notify = vi.fn();
  registerWorkspaceNotificationRoutes(app, { projects: { requireProject }, workspaces: { acceptNotification }, changes: { notify } });
  return { app, requireProject, acceptNotification, notify };
}

const url = `/workspace-notifications/projects/${encodeURIComponent(project.id)}`;
describe("workspace notification ingress", () => {
  it("publishes only after the current provider accepts the registered scope", async () => {
    const test = fixture();
    const response = await test.app.inject({ method: "POST", url, payload: { pluginId: "git" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(test.acceptNotification).toHaveBeenCalledWith(project, "git", expect.any(AbortSignal));
    expect(test.notify).toHaveBeenCalledExactlyOnceWith(project.id);
  });

  it("does not publish ignored hints, including disabled integration", async () => {
    const test = fixture(false);
    const response = await test.app.inject({ method: "POST", url, payload: { pluginId: "git" } });
    expect(response.json()).toEqual({ accepted: false });
    expect(test.notify).not.toHaveBeenCalled();
  });

  it.each([{}, { pluginId: "../git" }, { pluginId: "git", path: "/unregistered" }])("rejects malformed notification %j before discovery", async (payload) => {
    const test = fixture();
    const response = await test.app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(400);
    expect(test.requireProject).not.toHaveBeenCalled();
    expect(test.notify).not.toHaveBeenCalled();
  });

  it("rejects unknown projects without invoking a provider", async () => {
    const test = fixture();
    const response = await test.app.inject({ method: "POST", url: "/workspace-notifications/projects/missing", payload: { pluginId: "git" } });
    expect(response.statusCode).toBe(404);
    expect(test.acceptNotification).not.toHaveBeenCalled();
  });

  it("cancels provider evaluation on a real client disconnect and never publishes a late acceptance", async () => {
    const app = Fastify();
    apps.push(app);
    let start: ((signal: AbortSignal) => void) | undefined;
    const started = new Promise<AbortSignal>((resolve) => { start = resolve; });
    let finishAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => { finishAbort = resolve; });
    const notify = vi.fn();
    registerWorkspaceNotificationRoutes(app, {
      projects: { requireProject: () => Promise.resolve(project) },
      workspaces: { acceptNotification: (_project, _pluginId, signal) => new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => {
          finishAbort?.();
          resolve(true); // A provider may complete after cancellation; ingress still rejects publication.
        }, { once: true });
        start?.(signal);
      }) },
      changes: { notify },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP test listener");
    const client = request({ host: "127.0.0.1", port: address.port, path: url, method: "POST", headers: { "content-type": "application/json" } });
    client.on("error", () => { /* Expected ECONNRESET from deliberately closing an unfinished request. */ });
    try {
      client.end(JSON.stringify({ pluginId: "git" }));
      const signal = await started;
      client.destroy();
      await aborted;
      await app.close(); // Drain the route's late successful completion before asserting.
      expect(signal.aborted).toBe(true);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      client.destroy();
    }
  });

  it("reports authority failures without publishing a speculative change", async () => {
    const test = fixture();
    test.acceptNotification.mockRejectedValue(new Error("provider unavailable"));
    const response = await test.app.inject({ method: "POST", url, payload: { pluginId: "git" } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "provider unavailable" });
    expect(test.notify).not.toHaveBeenCalled();
  });
});
