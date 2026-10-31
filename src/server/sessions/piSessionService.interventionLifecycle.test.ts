import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { PiSessionService, type PiSessionServiceDependencies } from "./piSessionService.js";
import { SESSION_INTERVENTION_CUSTOM_TYPE } from "./sessionIntervention.js";
import {
  CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator,
  sessionGateway, sessionRecord, sessionRef, testModelRuntime,
} from "./piSessionService.testSupport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function lifecycleFixture(options: { child?: boolean; archived?: boolean; failArchive?: boolean; required?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-intervention-lifecycle-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const required = options.required ?? true;
  const root = { ...sessionRecord("root"), path: join(dir, "root.jsonl"), interventionRequired: required };
  const child = { ...sessionRecord("child"), path: join(dir, "child.jsonl"), parentSessionPath: root.path, interventionRequired: true };
  const records = options.child === true ? [root, child] : [root];
  for (const record of records) await writeFile(record.path, "persisted session\n");
  const entries = [{ type: "custom", customType: SESSION_INTERVENTION_CUSTOM_TYPE, data: { version: 1, required } }];
  const manager = fakeSessionManager("/workspace", {
    getSessionId: () => root.id, getSessionFile: () => root.path,
    getEntries: () => entries, getBranch: () => entries,
  });
  const fake = fakeRuntime(root.id, { sessionFile: root.path, sessionManager: manager });
  const activity = new WorkspaceActivityService();
  const archivedIds = new Set(options.archived === true ? [root.id] : []);
  const archivedRecord = (id: string) => ({
    sessionId: id, cwd: "/workspace", archivedAt: "2026-01-03T00:00:00.000Z",
    originalPath: join(dir, `${id}.jsonl`),
  });
  const archiveStore: NonNullable<PiSessionServiceDependencies["archiveStore"]> = {
    list: () => Promise.resolve([...archivedIds].map(archivedRecord)),
    get: (id) => Promise.resolve(archivedIds.has(id) ? archivedRecord(id) : undefined),
    isArchived: (id) => Promise.resolve(archivedIds.has(id)),
    archive: (input) => {
      if (options.failArchive === true) return Promise.reject(new Error("archive write failed"));
      archivedIds.add(input.sessionId);
      return Promise.resolve(archivedRecord(input.sessionId));
    },
    restore: (id) => { archivedIds.delete(id); return Promise.resolve(); },
  };
  const gateway = sessionGateway(records);
  gateway.list = () => Promise.resolve(records.filter((record) => !archivedIds.has(record.id)));
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: dir, modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore,
    workspaceActivity: activity, createAgentRuntime: runtimeCreator(fake.runtime), heartbeatIntervalMs: 60_000,
  });
  cleanups.push(() => service.dispose());
  return { service, activity, fake, root, child };
}

describe("session intervention lifecycle projection", () => {
  it("preserves persisted intervention when stopping a hosted runtime while clearing work", async () => {
    const { service, activity, fake } = await lifecycleFixture();
    await service.status(sessionRef("root"));
    fake.session.isStreaming = true;
    fake.emit({ type: "message_start", message: { role: "assistant" } });
    expect(activity.snapshot().sessions).toEqual([{ sessionId: "root", cwd: "/workspace" }]);

    await service.stop(sessionRef("root"));

    expect(service.activeCount()).toBe(0);
    expect(activity.snapshot().sessions).toEqual([]);
    expect(activity.snapshot().interventionSessions).toEqual([{ sessionId: "root", cwd: "/workspace" }]);
  });

  it("clears runtime-only dialog intervention when stopping without a durable request", async () => {
    const { service, activity, fake } = await lifecycleFixture({ required: false });
    await service.status(sessionRef("root"));
    const ui = fake.calls.bindExtensions.at(-1)?.uiContext;
    if (ui === undefined) throw new Error("session extensions were not bound");
    const answer = ui.confirm("Proceed?", "Allow the action?");
    expect(activity.snapshot().interventionSessions).toEqual([{ sessionId: "root", cwd: "/workspace" }]);

    await service.stop(sessionRef("root"));

    await expect(answer).resolves.toBe(false);
    expect(activity.snapshot().interventionSessions).toEqual([]);
  });

  it("removes a hosted intervention only after single-session archive succeeds", async () => {
    const { service, activity } = await lifecycleFixture();
    await service.restoreInterventionState();
    await service.archive(sessionRef("root"));
    expect(activity.snapshot().interventionSessions).toEqual([]);
  });

  it("preserves intervention if archive persistence fails after closing the runtime", async () => {
    const { service, activity } = await lifecycleFixture({ failArchive: true });
    await service.restoreInterventionState();
    await expect(service.archive(sessionRef("root"))).rejects.toThrow("archive write failed");
    expect(service.activeCount()).toBe(0);
    expect(activity.snapshot().interventionSessions).toEqual([{ sessionId: "root", cwd: "/workspace" }]);
  });

  it("removes cold descendants as well as the hosted root after tree archive", async () => {
    const { service, activity } = await lifecycleFixture({ child: true });
    await service.restoreInterventionState();
    expect(activity.snapshot().interventionSessions).toHaveLength(2);
    const result = await service.archiveTree(sessionRef("root"));
    expect(result.sessionIds).toEqual(["root", "child"]);
    expect(activity.snapshot().interventionSessions).toEqual([]);
  });

  it("immediately restores a cold session's durable intervention without opening its runtime", async () => {
    const { service, activity } = await lifecycleFixture({ archived: true });
    await service.restoreInterventionState();
    expect(activity.snapshot().interventionSessions).toEqual([]);

    await service.restore(sessionRef("root"));

    expect(service.activeCount()).toBe(0);
    expect(activity.snapshot().interventionSessions).toEqual([{ sessionId: "root", cwd: "/workspace" }]);
  });
});
