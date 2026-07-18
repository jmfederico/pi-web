import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

describe("PiSessionService archive and cleanup", () => {
  it("archives a session subtree within the root workspace", async () => {
    const archivedInputs: string[] = [];
    const root = sessionRecord("root");
    const directChild = { ...sessionRecord("direct-child"), path: "/sessions/direct-child.jsonl", parentSessionPath: root.path };
    const archivedChild = { ...sessionRecord("archived-child"), path: "/sessions/archived-child.jsonl", parentSessionPath: root.path };
    const grandchild = { ...sessionRecord("grandchild"), path: "/sessions/grandchild.jsonl", parentSessionPath: archivedChild.path };
    const otherWorkspaceChild = { ...sessionRecord("other-child", "/other"), path: "/sessions/other-child.jsonl", parentSessionPath: root.path };
    const fake = fakeRuntime("root", { sessionFile: root.path });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived-child", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", originalPath: archivedChild.path, archivePath: "/archive/archived-child.jsonl", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z", messageCount: 1, firstMessage: "archived", parentSessionPath: root.path }]),
        get: () => Promise.resolve(undefined),
        archive: (input) => {
          archivedInputs.push(input.sessionId);
          return Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" });
        },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (cwd) => Promise.resolve(cwd === "/workspace" ? [root, directChild, archivedChild, grandchild] : [otherWorkspaceChild]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.archiveTree(sessionRef("root"))).resolves.toEqual({
      archived: true,
      sessionIds: ["root", "direct-child", "grandchild"],
      archivedCount: 3,
      skippedAlreadyArchivedCount: 1,
    });
    expect(archivedInputs).toEqual(["root", "direct-child", "grandchild"]);

    await service.dispose();
  });

  it("permanently deletes archived sessions through the archive store", async () => {
    const deletedSessionIds: string[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: {
        list: () => Promise.resolve([]),
        get: (sessionId) => Promise.resolve(sessionId === "archived" || "archived".startsWith(sessionId)
          ? { sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/archived.jsonl" }
          : undefined),
        archive: () => { throw new Error("archive should not be called for records that already have archive files"); },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
        deleteArchived: (sessionId) => {
          deletedSessionIds.push(sessionId);
          return Promise.resolve();
        },
      },
      sessionManager: sessionGateway([sessionRecord("active")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.deleteArchived("arch")).resolves.toBeUndefined();
    await expect(service.deleteArchived("active")).rejects.toThrow("Archived session not found");

    expect(deletedSessionIds).toEqual(["archived"]);
    await service.dispose();
  });

  it("bulk archives inactive sessions by cwd without opening runtimes", async () => {
    const recordsByCwd = new Map([
      ["/one", [sessionRecord("a", "/one"), sessionRecord("b", "/one")]],
      ["/two", [sessionRecord("c", "/two")]],
    ]);
    const listCalls: string[] = [];
    const open = vi.fn(() => { throw new Error("bulk archive should not open inactive runtimes"); });
    const archiveMany = vi.fn((inputs: readonly { sessionId: string; cwd: string }[]) => Promise.resolve(inputs.map((input) => ({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" }))));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: {
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        archive: (input) => Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" }),
        archiveMany,
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (cwd) => {
          listCalls.push(cwd);
          return Promise.resolve(recordsByCwd.get(cwd) ?? []);
        },
        open,
      },
      heartbeatIntervalMs: 60_000,
    });

    const result = await service.archiveMany([{ id: "a", cwd: "/one" }, { id: "b", cwd: "/one" }, { id: "c", cwd: "/two" }]);

    expect(result).toMatchObject({ archived: true, archivedSessionIds: ["a", "b", "c"], failures: [] });
    expect(listCalls).toEqual(["/one", "/two"]);
    expect(open).not.toHaveBeenCalled();
    expect(archiveMany).toHaveBeenCalledTimes(1);
    expect(archiveMany.mock.calls[0]?.[0].map((input) => input.sessionId)).toEqual(["a", "b", "c"]);
    await service.dispose();
  });

  it("bulk archive reports per-session failures without aborting other archives", async () => {
    const busy = fakeRuntime("busy", { isStreaming: true });
    let createCalls = 0;
    const archiveMany = vi.fn((inputs: readonly { sessionId: string; cwd: string }[]) => Promise.resolve(inputs.map((input) => ({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" }))));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: () => {
        createCalls += 1;
        return Promise.resolve(busy.runtime);
      },
      archiveStore: {
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        archive: (input) => Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" }),
        archiveMany,
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([sessionRecord("busy"), sessionRecord("ok")]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("busy"));
    const result = await service.archiveMany([{ id: "busy", cwd: "/workspace" }, { id: "ok", cwd: "/workspace" }, { id: "missing", cwd: "/workspace" }]);

    expect(createCalls).toBe(1);
    expect(busy.calls.abort).toBe(0);
    expect(archiveMany.mock.calls[0]?.[0].map((input) => input.sessionId)).toEqual(["ok"]);
    expect(result.archivedSessionIds).toEqual(["ok"]);
    expect(result.failures).toEqual([
      { sessionId: "busy", error: "Stop current session activity before archiving" },
      { sessionId: "missing", error: "Session not found" },
    ]);
    await service.dispose();
  });

  it("bulk deletes only archived sessions and skips busy active archived runtimes", async () => {
    const busyRecord = { sessionId: "busy-archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/busy.jsonl" };
    const idleRecord = { sessionId: "idle-archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/idle.jsonl" };
    const busy = fakeRuntime("busy-archived", { isStreaming: true });
    const deleteArchivedMany = vi.fn((sessionIds: readonly string[]) => Promise.resolve([...sessionIds]));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(busy.runtime),
      archiveStore: {
        list: () => Promise.resolve([busyRecord, idleRecord]),
        get: (sessionId) => Promise.resolve(sessionId === "busy-archived" ? busyRecord : undefined),
        archive: () => { throw new Error("archive should not be called for records that already have archive files"); },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
        deleteArchived: () => Promise.resolve(),
        deleteArchivedMany,
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([sessionRecord("unarchived")]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("busy-archived"));
    const result = await service.deleteArchivedMany([{ id: "busy-archived", cwd: "/workspace" }, { id: "idle-archived", cwd: "/workspace" }, { id: "unarchived", cwd: "/workspace" }]);

    expect(busy.calls.abort).toBe(0);
    expect(deleteArchivedMany).toHaveBeenCalledWith(["idle-archived"]);
    expect(result.deletedSessionIds).toEqual(["idle-archived"]);
    expect(result.failures).toEqual([
      { sessionId: "busy-archived", error: "Stop current session activity before deleting archived session" },
      { sessionId: "unarchived", error: "Archived session not found" },
    ]);
    await service.dispose();
  });

  it("bulk delete moves legacy archived records with one workspace scan before deleting", async () => {
    const archiveMany = vi.fn((inputs: readonly { sessionId: string; cwd: string }[]) => Promise.resolve(inputs.map((input) => ({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z", archivePath: `/archive/${input.sessionId}.jsonl` }))));
    const deleteArchivedMany = vi.fn((sessionIds: readonly string[]) => Promise.resolve([...sessionIds]));
    const listCalls: string[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: {
        list: () => Promise.resolve([
          { sessionId: "legacy-a", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z" },
          { sessionId: "legacy-b", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z" },
          { sessionId: "moved", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/moved.jsonl" },
        ]),
        get: () => Promise.resolve(undefined),
        archive: (input) => Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" }),
        archiveMany,
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
        deleteArchived: () => Promise.resolve(),
        deleteArchivedMany,
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (cwd) => {
          listCalls.push(cwd);
          return Promise.resolve([sessionRecord("legacy-a"), sessionRecord("legacy-b"), sessionRecord("unarchived")]);
        },
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const result = await service.deleteArchivedMany([{ id: "legacy-a", cwd: "/workspace" }, { id: "legacy-b", cwd: "/workspace" }, { id: "moved", cwd: "/workspace" }]);

    expect(listCalls).toEqual(["/workspace"]);
    expect(archiveMany.mock.calls[0]?.[0].map((input) => input.sessionId)).toEqual(["legacy-a", "legacy-b"]);
    expect(deleteArchivedMany).toHaveBeenCalledWith(["legacy-a", "legacy-b", "moved"]);
    expect(result.deletedSessionIds).toEqual(["legacy-a", "legacy-b", "moved"]);
    expect(result.failures).toEqual([]);
    await service.dispose();
  });

  it("previews session cleanup without mutating and executes a recomputed plan", async () => {
    const archivedInputs: string[] = [];
    const deletedSessionIds: string[] = [];
    let listAllCalls = 0;
    const archived = { sessionId: "archived-old", cwd: "/old-project", archivedAt: "2026-04-01T00:00:00.000Z", archivePath: "/archive/archived-old.jsonl" };
    const otherArchived = { sessionId: "archived-other", cwd: "/other-project", archivedAt: "2026-04-01T00:00:00.000Z", archivePath: "/archive/archived-other.jsonl" };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      archiveStore: {
        list: () => Promise.resolve([archived, otherArchived]),
        get: () => Promise.resolve(undefined),
        archive: () => Promise.reject(new Error("cleanup should use archiveMany")),
        archiveMany: (inputs) => {
          archivedInputs.push(...inputs.map((input) => input.sessionId));
          return Promise.resolve(inputs.map((input) => ({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-06-25T00:00:00.000Z" })));
        },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
        deleteArchived: () => Promise.reject(new Error("cleanup should use deleteArchivedMany")),
        deleteArchivedMany: (sessionIds) => {
          deletedSessionIds.push(...sessionIds);
          return Promise.resolve([...sessionIds]);
        },
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => {
          listAllCalls += 1;
          return Promise.resolve([
            listAllCalls === 1 ? sessionRecord("preview-only", "/old-project") : sessionRecord("execute-only", "/old-project"),
            listAllCalls === 1 ? sessionRecord("preview-other", "/other-project") : sessionRecord("execute-other", "/other-project"),
          ]);
        },
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const preview = await service.cleanupPreview({ thresholds: { archiveIdleDays: 30, deleteArchivedDays: 30 }, projectCwds: ["/old-project"] });
    expect(preview.totals).toEqual({ archiveCount: 1, deleteCount: 1 });
    expect(preview.projects).toEqual([{ cwd: "/old-project", archiveCount: 1, deleteCount: 1 }]);
    expect(archivedInputs).toEqual([]);
    expect(deletedSessionIds).toEqual([]);

    const result = await service.cleanup({ thresholds: { archiveIdleDays: 30, deleteArchivedDays: 30 }, projectCwds: ["/old-project"] });
    expect(result.archivedSessionIds).toEqual(["execute-only"]);
    expect(result.deletedSessionIds).toEqual(["archived-old"]);
    expect(archivedInputs).toEqual(["execute-only"]);
    expect(deletedSessionIds).toEqual(["archived-old"]);

    await service.dispose();
  });

  it("moves legacy cleanup delete records with one workspace scan before batch deleting", async () => {
    const listCalls: string[] = [];
    const archiveMany = vi.fn((inputs: readonly { sessionId: string; cwd: string }[]) => Promise.resolve(inputs.map((input) => ({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-06-25T00:00:00.000Z", archivePath: `/archive/${input.sessionId}.jsonl` }))));
    const deleteArchivedMany = vi.fn((sessionIds: readonly string[]) => Promise.resolve([...sessionIds]));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      archiveStore: {
        list: () => Promise.resolve([
          { sessionId: "legacy-a", cwd: "/old-project", archivedAt: "2026-04-01T00:00:00.000Z" },
          { sessionId: "legacy-b", cwd: "/old-project", archivedAt: "2026-04-01T00:00:00.000Z" },
        ]),
        get: () => Promise.resolve(undefined),
        archive: () => Promise.reject(new Error("cleanup should use archiveMany")),
        archiveMany,
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
        deleteArchived: () => Promise.reject(new Error("cleanup should use deleteArchivedMany")),
        deleteArchivedMany,
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (cwd) => {
          listCalls.push(cwd);
          return Promise.resolve([sessionRecord("legacy-a", cwd), sessionRecord("legacy-b", cwd)]);
        },
        listAll: () => Promise.resolve([]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const result = await service.cleanup({ thresholds: { deleteArchivedDays: 30 }, projectCwds: ["/old-project"] });

    expect(listCalls).toEqual(["/old-project"]);
    expect(archiveMany).toHaveBeenCalledTimes(1);
    expect(archiveMany.mock.calls[0]?.[0].map((input) => input.sessionId)).toEqual(["legacy-a", "legacy-b"]);
    expect(deleteArchivedMany).toHaveBeenCalledWith(["legacy-a", "legacy-b"]);
    expect(result.deletedSessionIds).toEqual(["legacy-a", "legacy-b"]);

    await service.dispose();
  });

  it("skips busy active sessions during cleanup execution", async () => {
    const fake = fakeRuntime("busy-open", { isStreaming: true, sessionManager: fakeSessionManager("/old-project"), sessionFile: "/sessions/busy-open.jsonl" });
    const archivedInputs: string[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      createAgentRuntime: runtimeCreator(fake.runtime),
      archiveStore: {
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        archive: (input) => {
          archivedInputs.push(input.sessionId);
          return Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-06-25T00:00:00.000Z" });
        },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager("/old-project"),
        list: () => Promise.resolve([sessionRecord("busy-open", "/old-project")]),
        listAll: () => Promise.resolve([sessionRecord("busy-open", "/old-project")]),
        open: () => fakeSessionManager("/old-project"),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.status("busy-open");
    const result = await service.cleanup({ thresholds: { archiveIdleDays: 1 } });

    expect(result.archivedSessionIds).toEqual([]);
    expect(result.skippedBusySessionIds).toEqual(["busy-open"]);
    expect(archivedInputs).toEqual([]);
    expect(fake.calls.abort).toBe(0);

    await service.dispose();
  });

});
