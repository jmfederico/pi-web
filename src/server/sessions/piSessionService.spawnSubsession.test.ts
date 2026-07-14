import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import type { SpawnTargetDecision } from "./spawnTargetResolver.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModel, type RuntimeCreator } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

describe("PiSessionService", () => {
  describe("spawnSubsession", () => {
    function subsessionService(decision: SpawnTargetDecision, heartbeatIntervalMs = 60_000, childIds = ["child-1"]) {
      const parent = fakeRuntime("parent-1", { sessionFile: "/tmp/parent-1.jsonl" });
      const children = childIds.map((childId) => fakeRuntime(childId, {
        sessionFile: `/tmp/${childId}.jsonl`,
        sessionManager: fakeSessionManager("/workspace-feature"),
      }));
      const child = children[0];
      if (child === undefined) throw new Error("At least one child fixture is required");
      const created = [parent.runtime, ...children.map(({ runtime }) => runtime)];
      let index = 0;
      const createAgentRuntime: RuntimeCreator = async () => {
        await Promise.resolve();
        const runtime = created[Math.min(index, created.length - 1)] ?? child.runtime;
        index += 1;
        return runtime;
      };
      const archived = new Map<string, { sessionId: string; cwd: string; archivedAt: string }>();
      const archiveStore = {
        list: () => Promise.resolve([...archived.values()]),
        get: (sessionId: string) => Promise.resolve(archived.get(sessionId)),
        archive: (input: { sessionId: string; cwd: string }) => {
          const record = { sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-01T00:00:00.000Z" };
          archived.set(input.sessionId, record);
          return Promise.resolve(record);
        },
        restore: (sessionId: string) => { archived.delete(sessionId); return Promise.resolve(); },
        isArchived: (sessionId: string) => Promise.resolve(archived.has(sessionId)),
      };
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime,
        sessionManager: sessionGateway([]),
        archiveStore,
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve(decision) },
        heartbeatIntervalMs,
      });
      return { parent, child, children, service };
    }

    it("records the parent, delivers the prompt, and lists the tracked child", async () => {
      const { child, service } = subsessionService({ allowed: true, cwd: "/workspace-feature" });
      await service.start("/workspace"); // bring the parent online so it can be notified

      const result = await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "do the slice", cwd: "/workspace-feature" });

      expect(result).toEqual({ sessionId: "child-1", cwd: "/workspace-feature" });
      expect(child.calls.prompt).toEqual([{ text: "do the slice", options: undefined }]);
      await expect(service.listSubsessions("parent-1")).resolves.toEqual([
        { sessionId: "child-1", cwd: "/workspace-feature", status: "idle" },
      ]);
      await service.dispose();
    });

    it("uses the parent model and disables delegation before creating the tracked child runtime", async () => {
      const parent = fakeRuntime("parent-1", { sessionFile: "/tmp/parent-1.jsonl" });
      const child = fakeRuntime("child-1", { sessionFile: "/tmp/child-1.jsonl", sessionManager: fakeSessionManager("/workspace-feature") });
      const model = testModel();
      const initialModels: PiAgentSession["model"][] = [];
      const delegationCapabilities: boolean[] = [];
      const runtimes = [parent.runtime, child.runtime];
      let index = 0;
      const createAgentRuntime: RuntimeCreator = async (_createRuntime, options) => {
        await Promise.resolve();
        initialModels.push(options.initialModel);
        delegationCapabilities.push(options.delegationToolsEnabled);
        const runtime = runtimes[index] ?? child.runtime;
        index += 1;
        return runtime;
      };
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime,
        sessionManager: sessionGateway([]),
        archiveStore: emptyArchiveStore(),
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
        heartbeatIntervalMs: 60_000,
      });

      await service.start("/workspace");
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "do the slice", cwd: "/workspace-feature", model });

      expect(initialModels).toEqual([undefined, model]);
      expect(delegationCapabilities).toEqual([true, false]);
      await service.dispose();
    });

    it("persists tracked child links in the parent and child sessions", async () => {
      const parentPersisted: { customType: string; data?: unknown }[] = [];
      const childPersisted: { customType: string; data?: unknown }[] = [];
      const parent = fakeRuntime("parent-1", {
        sessionFile: "/tmp/parent-1.jsonl",
        sessionManager: fakeSessionManager("/workspace", {
          appendCustomEntry: (customType, data) => {
            parentPersisted.push({ customType, data });
            return "parent-entry-1";
          },
        }),
      });
      const child = fakeRuntime("child-1", {
        sessionFile: "/tmp/child-1.jsonl",
        sessionManager: fakeSessionManager("/workspace-feature", {
          appendCustomEntry: (customType, data) => {
            childPersisted.push({ customType, data });
            return "child-entry-1";
          },
        }),
      });
      const runtimes = [parent.runtime, child.runtime];
      let index = 0;
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime: () => {
          const runtime = runtimes[index] ?? child.runtime;
          index += 1;
          return Promise.resolve(runtime);
        },
        sessionManager: sessionGateway([]),
        archiveStore: emptyArchiveStore(),
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
        heartbeatIntervalMs: 60_000,
      });

      await service.start("/workspace");
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "do the slice", cwd: "/workspace-feature" });

      expect(parentPersisted).toEqual([
        {
          customType: "pi-web.subsession.link",
          data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: "/tmp/child-1.jsonl", cwd: "/workspace-feature" },
        },
      ]);
      expect(childPersisted).toEqual([
        {
          customType: "pi-web.subsession.spawned",
          data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" },
        },
      ]);
      await service.dispose();
    });

    it("hydrates persisted child links after a service restart so the parent can inspect them", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-"));
      const parentFile = join(tempDir, "parent.jsonl");
      const childFile = join(tempDir, "child.jsonl");
      await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");

      try {
        const childManager = fakeSessionManager("/workspace-feature", {
          getBranch: () => [{ type: "message", message: { role: "assistant", content: "finished" } }],
        });
        const parent = fakeRuntime("parent-1", {
          sessionFile: parentFile,
          sessionManager: fakeSessionManager("/workspace", {
            getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" } }],
          }),
        });
        const child = fakeRuntime("child-1", { sessionFile: childFile, sessionManager: childManager });
        const runtimes = [parent.runtime, child.runtime];
        let index = 0;
        const open = vi.fn(() => childManager);
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime: () => {
            const runtime = runtimes[index] ?? child.runtime;
            index += 1;
            return Promise.resolve(runtime);
          },
          sessionManager: { create: () => parent.session.sessionManager, list: () => Promise.resolve([]), listAll: () => Promise.resolve([]), open },
          archiveStore: emptyArchiveStore(),
          heartbeatIntervalMs: 60_000,
        });

        await service.start("/workspace");

        await expect(service.checkSubsession("parent-1", "child-1")).resolves.toEqual({
          sessionId: "child-1",
          cwd: "/workspace-feature",
          status: "idle",
          finalText: "finished",
          messageCount: 1,
        });
        expect(open).toHaveBeenCalledWith(childFile);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("ignores stale persisted child links when the child no longer records the parent", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-stale-"));
      const parentFile = join(tempDir, "parent.jsonl");
      const childFile = join(tempDir, "child.jsonl");
      await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature" })}\n`, "utf8");

      try {
        const parent = fakeRuntime("parent-1", {
          sessionFile: parentFile,
          sessionManager: fakeSessionManager("/workspace", {
            getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" } }],
          }),
        });
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime: runtimeCreator(parent.runtime),
          sessionManager: { create: () => parent.session.sessionManager, list: () => Promise.resolve([]), listAll: () => Promise.resolve([]), open: () => fakeSessionManager() },
          archiveStore: emptyArchiveStore(),
          heartbeatIntervalMs: 60_000,
        });

        await service.start("/workspace");

        await expect(service.listSubsessions("parent-1")).resolves.toEqual([]);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not hydrate persisted links when the exact child file is unavailable", async () => {
      const parentFile = "/sessions/parent-1.jsonl";
      const parent = fakeRuntime("parent-1", {
        sessionFile: parentFile,
        sessionManager: fakeSessionManager("/workspace", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: "/sessions/child-1.jsonl", cwd: "/workspace-feature" } }],
        }),
      });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime: runtimeCreator(parent.runtime),
        sessionManager: { create: () => parent.session.sessionManager, list: () => Promise.resolve([]), listAll: () => Promise.resolve([]), open: () => fakeSessionManager() },
        archiveStore: emptyArchiveStore(),
        heartbeatIntervalMs: 60_000,
      });

      await service.start("/workspace");

      await expect(service.listSubsessions("parent-1")).resolves.toEqual([]);
      await service.dispose();
    });

    it("does not hydrate parent links without a child file", async () => {
      const parentFile = "/sessions/parent-1.jsonl";
      const parent = fakeRuntime("parent-1", {
        sessionFile: parentFile,
        sessionManager: fakeSessionManager("/workspace", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child", cwd: "/workspace-feature" } }],
        }),
      });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime: runtimeCreator(parent.runtime),
        sessionManager: { create: () => parent.session.sessionManager, list: () => Promise.resolve([]), listAll: () => Promise.resolve([]), open: () => fakeSessionManager() },
        archiveStore: emptyArchiveStore(),
        heartbeatIntervalMs: 60_000,
      });

      await service.start("/workspace");

      await expect(service.listSubsessions("parent-1")).resolves.toEqual([]);
      await service.dispose();
    });

    it("does not invent subsession links from existing child session headers", async () => {
      const parentFile = "/sessions/parent-1.jsonl";
      const childRecord = { ...sessionRecord("child-1", "/workspace-feature"), path: "/sessions/child-1.jsonl", parentSessionPath: parentFile };
      const parent = fakeRuntime("parent-1", {
        sessionFile: parentFile,
        sessionManager: fakeSessionManager("/workspace", { getEntries: () => [] }),
      });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime: runtimeCreator(parent.runtime),
        sessionManager: { create: () => parent.session.sessionManager, list: () => Promise.resolve([]), listAll: () => Promise.resolve([childRecord]), open: () => fakeSessionManager() },
        archiveStore: emptyArchiveStore(),
        heartbeatIntervalMs: 60_000,
      });

      await service.start("/workspace");

      await expect(service.listSubsessions("parent-1")).resolves.toEqual([]);
      await service.dispose();
    });

    it("does not hydrate copied parent links when the opened parent has a different id", async () => {
      const forkedParent = fakeRuntime("parent-fork-1", {
        sessionFile: "/sessions/parent-fork-1.jsonl",
        sessionManager: fakeSessionManager("/workspace", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: "/sessions/child-1.jsonl", cwd: "/workspace-feature" } }],
        }),
      });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime: runtimeCreator(forkedParent.runtime),
        sessionManager: { create: () => forkedParent.session.sessionManager, list: () => Promise.resolve([]), listAll: () => Promise.resolve([]), open: () => fakeSessionManager() },
        archiveStore: emptyArchiveStore(),
        heartbeatIntervalMs: 60_000,
      });

      await service.start("/workspace");

      await expect(service.listSubsessions("parent-fork-1")).resolves.toEqual([]);
      await service.dispose();
    });

    it("relinks a spawned child when the child session is opened after restart", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-open-child-"));
      const parentFile = join(tempDir, "parent.jsonl");
      const childFile = join(tempDir, "child.jsonl");
      await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");

      try {
        const childManager = fakeSessionManager("/workspace-feature", {
          getSessionId: () => "child-1",
          getSessionFile: () => childFile,
          getHeader: () => ({ parentSession: parentFile }),
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } }],
        });
        const parentManager = fakeSessionManager("/workspace", {
          getSessionId: () => "parent-1",
          getSessionFile: () => parentFile,
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" } }],
        });
        const child = fakeRuntime("child-1", { sessionFile: childFile, sessionManager: childManager });
        const parent = fakeRuntime("parent-1", { sessionFile: parentFile, sessionManager: parentManager });
        const runtimes = [child.runtime, parent.runtime];
        const delegationCapabilities: boolean[] = [];
        let index = 0;
        const open = vi.fn((path: string) => path === parentFile ? parentManager : childManager);
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime: (_createRuntime, options) => {
            delegationCapabilities.push(options.delegationToolsEnabled);
            const runtime = runtimes[index] ?? parent.runtime;
            index += 1;
            return Promise.resolve(runtime);
          },
          sessionManager: {
            create: () => childManager,
            list: () => Promise.resolve([{ ...sessionRecord("child-1", "/workspace-feature"), path: childFile, parentSessionPath: parentFile }]),
            listAll: () => Promise.resolve([]),
            open,
          },
          archiveStore: emptyArchiveStore(),
          heartbeatIntervalMs: 60_000,
        });

        await service.status(sessionRef("child-1", "/workspace-feature"));
        child.session.isStreaming = true;
        child.emit({ type: "agent_start" });
        child.session.isStreaming = false;
        child.emit({ type: "agent_end" });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(parent.calls.sendCustomMessage).toHaveLength(1);
        expect(parent.calls.sendCustomMessage[0]?.message.content).toContain("Subsession child-1 stopped working");
        expect(delegationCapabilities).toEqual([false, true]);
        expect(open).toHaveBeenCalledWith(parentFile);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("notifies the validated parent file instead of an active prefix-matched parent id", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-prefix-parent-"));
      const parentFile = join(tempDir, "parent.jsonl");
      const forkParentFile = join(tempDir, "parent-fork.jsonl");
      const childFile = join(tempDir, "child.jsonl");
      await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(forkParentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1-fork", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");

      try {
        const childManager = fakeSessionManager("/workspace-feature", {
          getHeader: () => ({ parentSession: parentFile }),
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } }],
        });
        const parentManager = fakeSessionManager("/workspace", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" } }],
        });
        const forkManager = fakeSessionManager("/workspace");
        const fork = fakeRuntime("parent-1-fork", { sessionFile: forkParentFile, sessionManager: forkManager });
        const child = fakeRuntime("child-1", { sessionFile: childFile, sessionManager: childManager });
        const parent = fakeRuntime("parent-1", { sessionFile: parentFile, sessionManager: parentManager });
        const runtimes = [fork.runtime, child.runtime, parent.runtime];
        let index = 0;
        const open = vi.fn((path: string) => {
          if (path === parentFile) return parentManager;
          if (path === forkParentFile) return forkManager;
          return childManager;
        });
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime: () => {
            const runtime = runtimes[index] ?? parent.runtime;
            index += 1;
            return Promise.resolve(runtime);
          },
          sessionManager: {
            create: () => forkManager,
            list: (cwd: string) => Promise.resolve(cwd === "/workspace"
              ? [{ ...sessionRecord("parent-1-fork", "/workspace"), path: forkParentFile }]
              : [{ ...sessionRecord("child-1", "/workspace-feature"), path: childFile, parentSessionPath: parentFile }]),
            listAll: () => Promise.resolve([]),
            open,
          },
          archiveStore: emptyArchiveStore(),
          heartbeatIntervalMs: 60_000,
        });

        await service.status(sessionRef("parent-1-fork", "/workspace"));
        await service.status(sessionRef("child-1", "/workspace-feature"));
        child.session.isStreaming = true;
        child.emit({ type: "agent_start" });
        child.session.isStreaming = false;
        child.emit({ type: "agent_end" });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(fork.calls.sendCustomMessage).toHaveLength(0);
        expect(parent.calls.sendCustomMessage).toHaveLength(1);
        expect(open).toHaveBeenCalledWith(parentFile);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not relink a copied child with the original session id unless the parent link names the current child file", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-copied-child-"));
      const parentFile = join(tempDir, "parent.jsonl");
      const originalChildFile = join(tempDir, "original-child.jsonl");
      const copiedChildFile = join(tempDir, "copied-child.jsonl");
      await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(originalChildFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");
      await writeFile(copiedChildFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");

      try {
        const childManager = fakeSessionManager("/workspace-feature", {
          getHeader: () => ({ parentSession: parentFile }),
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } }],
        });
        const parentManager = fakeSessionManager("/workspace", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: originalChildFile, cwd: "/workspace-feature" } }],
        });
        const child = fakeRuntime("child-1", { sessionFile: copiedChildFile, sessionManager: childManager });
        const parent = fakeRuntime("parent-1", { sessionFile: parentFile, sessionManager: parentManager });
        const runtimes = [child.runtime, parent.runtime];
        let index = 0;
        const open = vi.fn((path: string) => path === parentFile ? parentManager : childManager);
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime: () => {
            const runtime = runtimes[index] ?? parent.runtime;
            index += 1;
            return Promise.resolve(runtime);
          },
          sessionManager: {
            create: () => childManager,
            list: () => Promise.resolve([{ ...sessionRecord("child-1", "/workspace-feature"), path: copiedChildFile, parentSessionPath: parentFile }]),
            listAll: () => Promise.resolve([]),
            open,
          },
          archiveStore: emptyArchiveStore(),
          heartbeatIntervalMs: 60_000,
        });

        await service.status(sessionRef("child-1", "/workspace-feature"));
        child.session.isStreaming = true;
        child.emit({ type: "agent_start" });
        child.session.isStreaming = false;
        child.emit({ type: "agent_end" });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(parent.calls.sendCustomMessage).toHaveLength(0);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("uses the verified child file instead of an active copied child with the same id", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-active-copy-child-"));
      const parentFile = join(tempDir, "parent.jsonl");
      const originalChildFile = join(tempDir, "original-child.jsonl");
      const copiedChildFile = join(tempDir, "copied-child.jsonl");
      await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(originalChildFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");
      await writeFile(copiedChildFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");

      try {
        const copiedManager = fakeSessionManager("/workspace-feature", {
          getBranch: () => [{ type: "message", message: { role: "assistant", content: "copied child result" } }],
        });
        const originalManager = fakeSessionManager("/workspace-feature", {
          getBranch: () => [{ type: "message", message: { role: "assistant", content: "original child result" } }],
        });
        const parentManager = fakeSessionManager("/workspace", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: originalChildFile, cwd: "/workspace-feature" } }],
        });
        const copiedChild = fakeRuntime("child-1", { sessionFile: copiedChildFile, sessionManager: copiedManager, isStreaming: true });
        const originalChild = fakeRuntime("child-1", { sessionFile: originalChildFile, sessionManager: originalManager });
        const parent = fakeRuntime("parent-1", { sessionFile: parentFile, sessionManager: parentManager });
        const createAgentRuntime: RuntimeCreator = (_createRuntime, options) => {
          if (options.sessionManager === copiedManager) return Promise.resolve(copiedChild.runtime);
          if (options.sessionManager === originalManager) return Promise.resolve(originalChild.runtime);
          if (options.sessionManager === parentManager) return Promise.resolve(parent.runtime);
          throw new Error("unexpected session manager");
        };
        const open = vi.fn((path: string) => {
          if (path === copiedChildFile) return copiedManager;
          if (path === originalChildFile) return originalManager;
          if (path === parentFile) return parentManager;
          throw new Error(`unexpected open path ${path}`);
        });
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime,
          sessionManager: {
            create: () => parentManager,
            list: (cwd: string) => Promise.resolve(cwd === "/workspace-feature" ? [{ ...sessionRecord("child-1", "/workspace-feature"), path: copiedChildFile, parentSessionPath: parentFile }] : []),
            listAll: () => Promise.resolve([]),
            open,
          },
          archiveStore: emptyArchiveStore(),
          heartbeatIntervalMs: 60_000,
        });

        await service.status(sessionRef("child-1", "/workspace-feature"));
        await service.start("/workspace");

        await expect(service.listSubsessions("parent-1", parentFile)).resolves.toEqual([
          { sessionId: "child-1", cwd: "/workspace-feature", status: "idle" },
        ]);

        copiedChild.session.isStreaming = true;
        copiedChild.emit({ type: "agent_start" });
        copiedChild.session.isStreaming = false;
        copiedChild.emit({ type: "agent_end" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(parent.calls.sendCustomMessage).toHaveLength(0);

        await expect(service.checkSubsession("parent-1", "child-1", parentFile)).resolves.toMatchObject({
          sessionId: "child-1",
          cwd: "/workspace-feature",
          status: "idle",
          finalText: "original child result",
          messageCount: 1,
        });
        const read = await service.readSubsession("parent-1", "child-1", { roles: ["assistant"] }, parentFile);
        expect(read.entries[0]?.parts[0]).toMatchObject({ kind: "text", text: "original child result" });
        expect(open).toHaveBeenCalledWith(originalChildFile);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("uses the verified parent file instead of an active copied parent with the same id", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-active-copy-parent-"));
      const parentFile = join(tempDir, "parent.jsonl");
      const copiedParentFile = join(tempDir, "copied-parent.jsonl");
      const childFile = join(tempDir, "child.jsonl");
      await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(copiedParentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");

      try {
        const childManager = fakeSessionManager("/workspace-feature", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } }],
          getBranch: () => [{ type: "message", message: { role: "assistant", content: "child result" } }],
        });
        const parentManager = fakeSessionManager("/workspace", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" } }],
        });
        const copiedParentManager = fakeSessionManager("/workspace", { getEntries: () => [] });
        const child = fakeRuntime("child-1", { sessionFile: childFile, sessionManager: childManager });
        const parent = fakeRuntime("parent-1", { sessionFile: parentFile, sessionManager: parentManager });
        const copiedParent = fakeRuntime("parent-1", { sessionFile: copiedParentFile, sessionManager: copiedParentManager });
        const createAgentRuntime: RuntimeCreator = (_createRuntime, options) => {
          if (options.sessionManager === childManager) return Promise.resolve(child.runtime);
          if (options.sessionManager === parentManager) return Promise.resolve(parent.runtime);
          if (options.sessionManager === copiedParentManager) return Promise.resolve(copiedParent.runtime);
          throw new Error("unexpected session manager");
        };
        const open = vi.fn((path: string) => {
          if (path === childFile) return childManager;
          if (path === parentFile) return parentManager;
          if (path === copiedParentFile) return copiedParentManager;
          throw new Error(`unexpected open path ${path}`);
        });
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime,
          sessionManager: {
            create: () => copiedParentManager,
            list: (cwd: string) => Promise.resolve(cwd === "/workspace"
              ? [{ ...sessionRecord("parent-1", "/workspace"), path: copiedParentFile }]
              : [{ ...sessionRecord("child-1", "/workspace-feature"), path: childFile, parentSessionPath: parentFile }]),
            listAll: () => Promise.resolve([]),
            open,
          },
          archiveStore: emptyArchiveStore(),
          heartbeatIntervalMs: 60_000,
        });

        await service.status(sessionRef("child-1", "/workspace-feature"));
        await service.status(sessionRef("parent-1", "/workspace"));

        await expect(service.listSubsessions("parent-1", copiedParentFile)).resolves.toEqual([]);
        await expect(service.checkSubsession("parent-1", "child-1", copiedParentFile)).rejects.toThrow("not one of your subsessions");
        await expect(service.readSubsession("parent-1", "child-1", {}, copiedParentFile)).rejects.toThrow("not one of your subsessions");

        child.session.isStreaming = true;
        child.emit({ type: "agent_start" });
        child.session.isStreaming = false;
        child.emit({ type: "agent_end" });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(copiedParent.calls.sendCustomMessage).toHaveLength(0);
        expect(parent.calls.sendCustomMessage).toHaveLength(1);
        expect(parent.calls.sendCustomMessage[0]?.message.content).toContain("Subsession child-1 stopped working");
        expect(open).toHaveBeenCalledWith(parentFile);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not relink a child marker when the current child file header no longer records the parent", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-stale-child-header-"));
      const parentFile = join(tempDir, "parent.jsonl");
      const childFile = join(tempDir, "child.jsonl");
      await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature" })}\n`, "utf8");

      try {
        const childManager = fakeSessionManager("/workspace-feature", {
          getHeader: () => ({ parentSession: parentFile }),
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } }],
        });
        const parentManager = fakeSessionManager("/workspace", {
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" } }],
        });
        const child = fakeRuntime("child-1", { sessionFile: childFile, sessionManager: childManager });
        const parent = fakeRuntime("parent-1", { sessionFile: parentFile, sessionManager: parentManager });
        const runtimes = [child.runtime, parent.runtime];
        let index = 0;
        const open = vi.fn((path: string) => path === parentFile ? parentManager : childManager);
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime: () => {
            const runtime = runtimes[index] ?? parent.runtime;
            index += 1;
            return Promise.resolve(runtime);
          },
          sessionManager: {
            create: () => childManager,
            list: () => Promise.resolve([{ ...sessionRecord("child-1", "/workspace-feature"), path: childFile, parentSessionPath: parentFile }]),
            listAll: () => Promise.resolve([]),
            open,
          },
          archiveStore: {
            ...emptyArchiveStore(),
            get: (sessionId) => Promise.resolve(sessionId === "child-1" ? { sessionId: "child-1", cwd: "/workspace-feature", archivedAt: "2026-01-01T00:00:00.000Z", parentSessionPath: parentFile } : undefined),
          },
          heartbeatIntervalMs: 60_000,
        });

        await service.status(sessionRef("child-1", "/workspace-feature"));
        child.session.isStreaming = true;
        child.emit({ type: "agent_start" });
        child.session.isStreaming = false;
        child.emit({ type: "agent_end" });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(parent.calls.sendCustomMessage).toHaveLength(0);
        expect(open).not.toHaveBeenCalledWith(parentFile);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not relink a child marker when the child header points at a different parent id", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-web-subsession-wrong-parent-"));
      const mismatchedParentFile = join(tempDir, "other-parent.jsonl");
      const actualParentFile = join(tempDir, "parent.jsonl");
      const childFile = join(tempDir, "child.jsonl");
      await writeFile(mismatchedParentFile, `${JSON.stringify({ type: "session", version: 3, id: "other-parent", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
      await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: mismatchedParentFile })}\n`, "utf8");

      try {
        const childManager = fakeSessionManager("/workspace-feature", {
          getHeader: () => ({ parentSession: mismatchedParentFile }),
          getEntries: () => [{ type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } }],
        });
        const parent = fakeRuntime("parent-1", { sessionFile: actualParentFile, sessionManager: fakeSessionManager("/workspace") });
        const child = fakeRuntime("child-1", { sessionFile: childFile, sessionManager: childManager });
        const runtimes = [child.runtime, parent.runtime];
        let index = 0;
        const open = vi.fn((path: string) => path === actualParentFile ? parent.session.sessionManager : childManager);
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
          createAgentRuntime: () => {
            const runtime = runtimes[index] ?? parent.runtime;
            index += 1;
            return Promise.resolve(runtime);
          },
          sessionManager: {
            create: () => childManager,
            list: () => Promise.resolve([{ ...sessionRecord("child-1", "/workspace-feature"), path: childFile, parentSessionPath: mismatchedParentFile }]),
            listAll: () => Promise.resolve([{ ...sessionRecord("parent-1", "/workspace"), path: actualParentFile }]),
            open,
          },
          archiveStore: emptyArchiveStore(),
          heartbeatIntervalMs: 60_000,
        });

        await service.status(sessionRef("child-1", "/workspace-feature"));
        child.session.isStreaming = true;
        child.emit({ type: "agent_start" });
        child.session.isStreaming = false;
        child.emit({ type: "agent_end" });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(parent.calls.sendCustomMessage).toHaveLength(0);
        expect(open).not.toHaveBeenCalledWith(actualParentFile);
        await service.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not relink copied child markers when the opened child has a different id", async () => {
      const parentFile = "/sessions/parent-1.jsonl";
      const childFile = "/sessions/child-fork-1.jsonl";
      const childManager = fakeSessionManager("/workspace-feature", {
        getHeader: () => ({ parentSession: parentFile }),
        getEntries: () => [{ type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } }],
      });
      const child = fakeRuntime("child-fork-1", { sessionFile: childFile, sessionManager: childManager });
      const open = vi.fn(() => childManager);
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime: runtimeCreator(child.runtime),
        sessionManager: {
          create: () => childManager,
          list: () => Promise.resolve([{ ...sessionRecord("child-fork-1", "/workspace-feature"), path: childFile, parentSessionPath: parentFile }]),
          listAll: () => Promise.resolve([]),
          open,
        },
        archiveStore: emptyArchiveStore(),
        heartbeatIntervalMs: 60_000,
      });

      await service.status(sessionRef("child-fork-1", "/workspace-feature"));
      child.session.isStreaming = true;
      child.emit({ type: "agent_start" });
      child.session.isStreaming = false;
      child.emit({ type: "agent_end" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(open).not.toHaveBeenCalledWith(parentFile);
      await expect(service.listSubsessions("parent-1")).resolves.toEqual([]);
      await service.dispose();
    });

    it("notifies the parent once when the tracked child stops working", async () => {
      const { parent, child, service } = subsessionService({ allowed: true, cwd: "/workspace-feature" });
      await service.start("/workspace");
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "go", cwd: "/workspace-feature" });
      parent.calls.prompt.length = 0; // ignore the spawn prompt to the child; focus on the parent notification

      child.session.isStreaming = true;
      child.emit({ type: "agent_start" }); // arm the notification
      child.session.isStreaming = false;
      child.emit({ type: "agent_end" }); // fire once
      child.emit({ type: "turn_end" }); // must not re-notify
      await new Promise((resolve) => setTimeout(resolve, 20)); // the parent notification is delivered via the async custom-message path

      expect(parent.calls.sendCustomMessage).toHaveLength(1);
      expect(parent.calls.sendCustomMessage[0]?.message.content).toContain("Subsession child-1 stopped working");
      expect(parent.calls.sendCustomMessage[0]?.message.customType).toBe("subsession.completion");
      expect(parent.calls.sendCustomMessage[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      expect(parent.calls.prompt).toHaveLength(0); // not a user-authored message
      await service.dispose();
    });

    it("reports other working children in each completion notice", async () => {
      const { parent, children, service } = subsessionService(
        { allowed: true, cwd: "/workspace-feature" },
        60_000,
        ["child-1", "child-2"],
      );
      const [first, second] = children;
      if (first === undefined || second === undefined) throw new Error("Expected two child fixtures");
      await service.start("/workspace");
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "first", cwd: "/workspace-feature" });
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "second", cwd: "/workspace-feature" });

      first.session.isStreaming = true;
      first.emit({ type: "agent_start" });
      second.session.isStreaming = true;
      second.emit({ type: "agent_start" });

      first.session.isStreaming = false;
      first.emit({ type: "agent_end" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(parent.calls.sendCustomMessage[0]?.message.content).toBe(
        "Subsession child-1 stopped working (idle).\nStill working: child-2. Continue working, or call yield_to_subsessions alone and last at the next join point. Further completion notices arrive automatically; do not poll.\n\n--- SUBSESSION OUTPUT: child-1 ---\n(no output)",
      );

      second.session.isStreaming = false;
      second.emit({ type: "agent_end" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(parent.calls.sendCustomMessage[1]?.message.content).toBe(
        "Subsession child-2 stopped working (idle).\nNo other tracked subsessions are working.\n\n--- SUBSESSION OUTPUT: child-2 ---\n(no output)",
      );
      await service.dispose();
    });

    it("notifies via the heartbeat when the child settles without a further event", async () => {
      const { parent, child, service } = subsessionService({ allowed: true, cwd: "/workspace-feature" }, 10);
      await service.start("/workspace");
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "go", cwd: "/workspace-feature" });
      parent.calls.prompt.length = 0;

      // The child works, then settles silently: agent_end arrives while it still
      // reports active work, so the event-driven latch does not fire here.
      child.session.isStreaming = true;
      child.emit({ type: "agent_start" });
      child.emit({ type: "agent_end" });
      expect(parent.calls.sendCustomMessage).toHaveLength(0);

      // Once the session settles, the periodic heartbeat re-check notifies.
      child.session.isStreaming = false;
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(parent.calls.sendCustomMessage).toHaveLength(1);
      expect(parent.calls.sendCustomMessage[0]?.message.content).toContain("Subsession child-1 stopped working");
      await service.dispose();
    });

    it("does not notify the parent when a tracked child is archived", async () => {
      const { parent, child, service } = subsessionService({ allowed: true, cwd: "/workspace-feature" });
      await service.start("/workspace");
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "go", cwd: "/workspace-feature" });
      // Arm the notification, as a real working child would.
      child.session.isStreaming = true;
      child.emit({ type: "agent_start" });
      child.session.isStreaming = false;
      parent.calls.sendCustomMessage.length = 0;

      await service.archive("child-1");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(parent.calls.sendCustomMessage).toHaveLength(0);
      await service.dispose();
    });

    it("reports a missing tracked child file as unknown in the subsession list", async () => {
      const { service } = subsessionService({ allowed: true, cwd: "/workspace-feature" });
      await service.start("/workspace");
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "go", cwd: "/workspace-feature" });

      await service.archive("child-1");

      await expect(service.listSubsessions("parent-1")).resolves.toEqual([
        { sessionId: "child-1", cwd: "/workspace-feature", status: "unknown" },
      ]);
      await service.dispose();
    });

    it("check_subsession and read_subsession refuse sessions that are not the caller's children", async () => {
      const { service } = subsessionService({ allowed: true, cwd: "/workspace-feature" });
      await service.start("/workspace");
      await service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "go", cwd: "/workspace-feature" });

      await expect(service.checkSubsession("someone-else", "child-1")).rejects.toThrow("not one of your subsessions");
      await expect(service.readSubsession("someone-else", "child-1", {})).rejects.toThrow("not one of your subsessions");
      await service.dispose();
    });

    it("is disabled when no spawn target resolver is configured", async () => {
      const fake = fakeRuntime("nope");
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([]),
        heartbeatIntervalMs: 60_000,
      });
      await expect(service.spawnSubsession({ spawningCwd: "/workspace", parentSessionId: "p", parentSessionFile: undefined, prompt: "go", cwd: undefined }))
        .rejects.toThrow("Spawning sessions is disabled");
      await service.dispose();
    });
  });
});
