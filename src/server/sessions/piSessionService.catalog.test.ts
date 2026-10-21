import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService, projectSessionActivitySubsessions } from "./piSessionService.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, testModelRuntime } from "./piSessionService.testSupport.js";
import { SessionUnreadStore } from "./sessionUnreadStore.js";

describe("read-only session catalog", () => {
  it("inspects cold and archived session activity without creating a Pi runtime", async () => {
    const parent = sessionRecord("cold");
    const gateway = sessionGateway([parent, sessionRecord("archived")]);
    const open = vi.spyOn(gateway, "open");
    const readMessagePage = vi.fn((path: string) => Promise.resolve({ messages: [], start: 0, total: path.includes("archive") ? 7 : 4 }));
    gateway.readMessagePage = readMessagePage;
    const archiveStore = {
      ...emptyArchiveStore(),
      list: () => Promise.resolve([{
        sessionId: "archived", cwd: "/workspace", archivedAt: "2026-10-17T12:00:00.000Z",
        originalPath: "/sessions/archived.jsonl", archivePath: "/archive/archived.jsonl",
      }]),
      get: (id: string) => Promise.resolve(id === "archived" ? {
        sessionId: "archived", cwd: "/workspace", archivedAt: "2026-10-17T12:00:00.000Z",
        originalPath: "/sessions/archived.jsonl", archivePath: "/archive/archived.jsonl",
      } : undefined),
    };
    const createRuntime = vi.fn(runtimeCreator(fakeRuntime().runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway,
      archiveStore, createAgentRuntime: createRuntime,
    });
    try {
      await expect(service.inspectSessionActivity("/workspace", "cold")).resolves.toMatchObject({
        session: { id: "cold", runtime: "not-hosted" }, lifecycle: "active", runtimeLoaded: false, activity: "unknown",
        status: { messageCount: 4, pendingMessageCount: null, queueState: { available: false }, telemetry: { available: false } },
        relatedExecutions: { supportedKinds: ["subsession"], unsupportedKinds: ["background-agent", "terminal", "process"] },
      });
      await expect(service.inspectSessionActivity("/workspace", "archived")).resolves.toMatchObject({
        session: { id: "archived", archived: true }, lifecycle: "archived", runtimeLoaded: false, activity: "unknown",
        status: { messageCount: 7, isStreaming: null, telemetry: { available: false } },
      });
      expect(readMessagePage).toHaveBeenCalledWith("/sessions/cold.jsonl", { limit: 1, maxMessages: 500, maxBytes: 8 * 1024 * 1024 }, undefined);
      expect(readMessagePage).toHaveBeenCalledWith("/archive/archived.jsonl", { limit: 1, maxMessages: 500, maxBytes: 8 * 1024 * 1024 }, undefined);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("reads current runtime activity without opening another runtime", async () => {
    const fake = fakeRuntime("live", { isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 2 });
    const createRuntime = vi.fn(runtimeCreator(fake.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(), createAgentRuntime: createRuntime,
    });
    try {
      await service.start("/workspace");
      const snapshot = await service.inspectSessionActivity("/workspace", "live");
      expect(snapshot).toMatchObject({
        session: { id: "live", runtime: "busy" }, lifecycle: "active", runtimeLoaded: true, activity: "working",
        status: { isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 2, queueState: { available: true }, telemetry: { available: true } },
      });
      expect(createRuntime).toHaveBeenCalledTimes(1);
      expect(service.activeCount()).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  it("classifies a queued prompt as waiting while the runtime is not executing", async () => {
    const fake = fakeRuntime("queued", { isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 1 });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime),
    });
    try {
      await service.start("/workspace");
      await expect(service.inspectSessionActivity("/workspace", "queued")).resolves.toMatchObject({
        activity: "waiting", status: { isStreaming: false, pendingMessageCount: 1 },
      });
    } finally {
      await service.dispose();
    }
  });

  it("does not persist unread exclusions when inspecting an unhydrated persisted relation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-session-activity-readonly-"));
    const parentFile = join(root, "parent.jsonl");
    const childFile = join(root, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", id: "parent", cwd: "/workspace" })}\n`);
    await writeFile(childFile, `${JSON.stringify({ type: "session", id: "child", cwd: "/workspace", parentSession: parentFile })}\n`);
    const parentLink = { type: "custom", customType: "pi-web.subsession.link", data: {
      version: 1, spawnedBySessionId: "parent", spawnedSessionId: "child", spawnedSessionFile: childFile, cwd: "/workspace",
    } };
    const gateway = sessionGateway([{ ...sessionRecord("parent"), path: parentFile }]);
    gateway.open = vi.fn(() => { throw new Error("cold inspection must not open a Pi session manager"); });
    gateway.readEntries = vi.fn(() => Promise.resolve([parentLink]));
    gateway.readMessagePage = vi.fn(() => Promise.resolve({ messages: [], start: 0, total: 0 }));
    const events = new CapturingSessionEventHub();
    const unreadStore = new SessionUnreadStore();
    const excludeSession = vi.spyOn(unreadStore, "excludeSession");
    const service = new PiSessionService(events, {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway,
      archiveStore: emptyArchiveStore(), unreadStore,
    });
    try {
      await expect(service.inspectSessionActivity("/workspace", "parent")).resolves.toMatchObject({
        relatedExecutions: { totalCount: 1, executions: [{ sessionId: "child", status: "idle" }] },
      });
      expect(excludeSession).not.toHaveBeenCalled();
      expect(events.globalEvents).toEqual([]);
      expect(events.sessionEvents).toEqual([]);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aggregates working subsessions beyond the bounded activity projection", () => {
    const children = Array.from({ length: 101 }, (_, index) => ({
      sessionId: `child-${String(index)}`, cwd: "/workspace", status: index === 100 ? "working" as const : "idle" as const,
    }));
    expect(projectSessionActivitySubsessions("parent", "/workspace", children)).toMatchObject({
      totalCount: 101, workingCount: 1, truncated: true,
    });
    expect(projectSessionActivitySubsessions("parent", "/workspace", children).executions).toHaveLength(100);
  });

  it("keeps archived parent counts consistent with a working child", () => {
    expect(projectSessionActivitySubsessions("parent", "/workspace", [
      { sessionId: "working-child", cwd: "/workspace", status: "working" },
    ])).toMatchObject({
      totalCount: 1, workingCount: 1,
      executions: [{ sessionId: "working-child", status: "working", canStop: true }],
    });
  });

  it("does not infer a workspace for empty or relative child paths", () => {
    const cwd = process.cwd();
    expect(projectSessionActivitySubsessions("parent", cwd, [
      { sessionId: "unknown", cwd: "", status: "working" },
      { sessionId: "relative", cwd: ".", status: "idle" },
    ])).toMatchObject({ totalCount: 0, workingCount: 0, executions: [], truncated: true });
  });

  it("does not rewrite a legacy parent transcript during cold activity inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-session-activity-transcript-readonly-"));
    const sessions = join(root, "sessions");
    const parentFile = join(sessions, "parent.jsonl");
    const childFile = join(sessions, "child.jsonl");
    await mkdir(sessions, { recursive: true });
    const parentText = [
      JSON.stringify({ type: "session", version: 1, id: "parent", timestamp: "2026-10-17T12:00:00.000Z", cwd: "/workspace" }),
      JSON.stringify({ type: "custom", customType: "pi-web.subsession.link", data: {
        version: 1, spawnedBySessionId: "parent", spawnedSessionId: "child", spawnedSessionFile: childFile, cwd: "/workspace",
      } }),
    ].join("\n") + "\n";
    await writeFile(parentFile, parentText);
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 1, id: "child", timestamp: "2026-10-17T12:00:00.000Z", cwd: "/workspace", parentSession: parentFile })}\n`);
    const gateway = createPiSessionManagerGateway({
      agentDir: join(root, "agent"), env: { PI_CODING_AGENT_SESSION_DIR: sessions },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: join(root, "agent"), modelRuntime: testModelRuntime, sessionManager: gateway,
      archiveStore: emptyArchiveStore(),
    });
    try {
      const before = createHash("sha256").update(await readFile(parentFile)).digest("hex");
      await expect(service.inspectSessionActivity("/workspace", "parent")).resolves.toMatchObject({
        relatedExecutions: { totalCount: 1, executions: [{ sessionId: "child", status: "idle" }] },
      });
      const after = createHash("sha256").update(await readFile(parentFile)).digest("hex");
      expect(after).toBe(before);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects same-workspace parent IDs and archive timestamps without exposing session paths", async () => {
    const parent = sessionRecord("parent");
    const child = { ...sessionRecord("child"), parentSessionPath: parent.path };
    const outsideParent = { ...sessionRecord("outside-child"), parentSessionPath: "/other-workspace/parent.jsonl" };
    const gateway = sessionGateway([parent, child, outsideParent]);
    const archiveStore = {
      ...emptyArchiveStore(),
      list: () => Promise.resolve([{
        sessionId: "parent", cwd: "/workspace", archivedAt: "2026-10-17T12:00:00.000Z",
        originalPath: parent.path,
      }]),
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway,
      archiveStore, createAgentRuntime: vi.fn(runtimeCreator(fakeRuntime().runtime)),
    });
    try {
      const rows = await service.listCatalogSessions("/workspace");
      expect(rows.find(({ id }) => id === "parent")).toMatchObject({ archived: true, archivedAt: "2026-10-17T12:00:00.000Z" });
      expect(rows.find(({ id }) => id === "child")).toMatchObject({ parentSessionId: "parent" });
      expect(rows.find(({ id }) => id === "outside-child")).not.toHaveProperty("parentSessionId");
      expect(JSON.stringify(rows)).not.toContain("/sessions/");
      expect(JSON.stringify(rows)).not.toContain("parentSessionPath");
    } finally {
      await service.dispose();
    }
  });

  it("lists cold conversations without opening a runtime or leaking transcript/file fields", async () => {
    const gateway = sessionGateway([{ ...sessionRecord("cold"), firstMessage: "private text" }]);
    const open = vi.spyOn(gateway, "open");
    const createRuntime = vi.fn(runtimeCreator(fakeRuntime().runtime));
    const events = new CapturingSessionEventHub();
    const service = new PiSessionService(events, { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: createRuntime });
    try {
      expect(await service.listCatalogSessions("/workspace")).toEqual([
        { id: "cold", cwd: "/workspace", archived: false, runtime: "not-hosted" },
      ]);
      expect(open).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("reads paged cold history without opening a runtime and preserves turn boundaries", async () => {
    const entries = [
      { type: "message", id: "u1", message: { role: "user", content: "first" } },
      { type: "message", id: "a1", message: { role: "assistant", content: "answer" } },
      { type: "message", id: "u2", message: { role: "user", content: "second" } },
    ];
    const gateway = sessionGateway([sessionRecord("cold")]);
    const readEntries = vi.fn(() => Promise.resolve(entries));
    gateway.readEntries = readEntries;
    const open = vi.spyOn(gateway, "open");
    const createRuntime = vi.fn(runtimeCreator(fakeRuntime().runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway,
      archiveStore: emptyArchiveStore(), createAgentRuntime: createRuntime,
    });
    try {
      await expect(service.inspectionMessages({ id: "cold", cwd: "/workspace" }, { before: 2, limit: 1 })).resolves.toEqual({
        messages: [
          { role: "user", content: "first", entryId: "u1" },
          { role: "assistant", content: "answer", entryId: "a1" },
        ],
        start: 0,
        total: 3,
      });
      expect(readEntries).toHaveBeenCalledWith("/sessions/cold.jsonl");
      expect(open).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("uses the streaming page reader for cold history when the gateway provides it", async () => {
    const gateway = sessionGateway([sessionRecord("cold")]);
    const page = { messages: [{ role: "user", content: "latest", entryId: "user-1" }], start: 4, total: 5 };
    const readMessagePage = vi.fn(() => Promise.resolve(page));
    const readEntries = vi.fn(() => Promise.resolve([]));
    gateway.readMessagePage = readMessagePage;
    gateway.readEntries = readEntries;
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway,
      archiveStore: emptyArchiveStore(), createAgentRuntime: vi.fn(runtimeCreator(fakeRuntime().runtime)),
    });
    try {
      await expect(service.inspectionMessages({ id: "cold", cwd: "/workspace" })).resolves.toEqual(page);
      expect(readMessagePage).toHaveBeenCalledWith("/sessions/cold.jsonl", { limit: 100, maxMessages: 500, maxBytes: 8 * 1024 * 1024 }, undefined);
      expect(readEntries).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
    }
  });

  it("applies the bounded response budget to already-hosted session history", async () => {
    const fake = fakeRuntime("live");
    fake.session.sessionManager.getBranch = () => [{
      type: "message", id: "large-user", message: { role: "user", content: "x".repeat(9 * 1024 * 1024) },
    }];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime),
    });
    try {
      await service.start("/workspace");
      await expect(service.inspectionMessages({ id: "live", cwd: "/workspace" }, { limit: 1 })).rejects.toThrow("exceeds 8388608 bytes");
    } finally {
      await service.dispose();
    }
  });

  it("uses a bounded default page for hosted inspection without affecting browser paging", async () => {
    const fake = fakeRuntime("live");
    fake.session.sessionManager.getBranch = () => Array.from({ length: 501 }, (_, index) => ({
      type: "message", id: `user-${String(index)}`, ...(index === 0 ? {} : { parentId: `user-${String(index - 1)}` }),
      message: { role: "user", content: `message ${String(index)}` },
    }));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime),
    });
    try {
      await service.start("/workspace");
      const result = await service.inspectionMessages({ id: "live", cwd: "/workspace" });
      expect(result).toMatchObject({ start: 401, total: 501 });
      expect(result.messages).toHaveLength(100);
    } finally {
      await service.dispose();
    }
  });

  it("reports already-hosted idle/busy sessions, without assigning runtime state to a cloned file", async () => {
    const fake = fakeRuntime("live");
    const gateway = sessionGateway([]);
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime) });
    try {
      await service.start("/workspace");
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("idle");
      fake.session.isStreaming = true;
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("busy");
      fake.session.isStreaming = false;
      gateway.list = () => Promise.resolve([sessionRecord("live")]);
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("not-hosted");
    } finally {
      await service.dispose();
    }
  });

  it("rejects cancelled reads before touching storage", async () => {
    const gateway = sessionGateway([]);
    const list = vi.spyOn(gateway, "list");
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore() });
    try {
      await expect(service.listCatalogSessions("/workspace", AbortSignal.abort())).rejects.toThrow();
      expect(list).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
    }
  });
});
