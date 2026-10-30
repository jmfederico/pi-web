import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiSessionServiceDependencies } from "./piSessionService.js";
import {
  CapturingSessionEventHub, fakeRuntime, fakeSessionManager, sessionGateway,
  sessionRecord, testModelRuntime, type RuntimeCreator,
} from "./piSessionService.testSupport.js";

const CWD = "/workspace";
const PARENT = "parent-1";
const CHILD = "child-1";
const services = new Set<PiSessionService>();
const tempDirs: string[] = [];
type RuntimeFixture = ReturnType<typeof fakeRuntime>;
type ArchiveStore = NonNullable<PiSessionServiceDependencies["archiveStore"]>;
type ArchiveRecord = Awaited<ReturnType<ArchiveStore["archive"]>>;

function journalRuntime(id: string, file = `/sessions/${id}.jsonl`, cwd = CWD) {
  const entries: unknown[] = [];
  const appendCustomEntry = vi.fn((customType: string, data?: unknown) => {
    entries.push({ type: "custom", customType, data });
    return `entry-${String(entries.length)}`;
  });
  const manager = fakeSessionManager(cwd, {
    getSessionId: () => id,
    getSessionFile: () => file,
    getEntries: () => entries,
    getBranch: () => entries,
    appendCustomEntry,
  });
  return { ...fakeRuntime(id, { sessionFile: file, sessionManager: manager }), entries, appendCustomEntry };
}

function fixture(runtimes: RuntimeFixture[], deps: Partial<PiSessionServiceDependencies> = {}, spawnTargetsEnabled = true) {
  const events = new CapturingSessionEventHub();
  const archived = new Map<string, ArchiveRecord>();
  const archive = vi.fn<ArchiveStore["archive"]>((input) => {
    const record = { ...input, archivedAt: "2026-01-01T00:00:00.000Z" };
    archived.set(input.sessionId, record);
    return Promise.resolve(record);
  });
  const restore = vi.fn<ArchiveStore["restore"]>(() => Promise.resolve());
  const archiveStore: ArchiveStore = {
    list: () => Promise.resolve([...archived.values()]),
    get: (id) => Promise.resolve(archived.get(id)),
    isArchived: (id) => Promise.resolve(archived.has(id)),
    archive,
    restore,
  };
  let index = 0;
  const createAgentRuntime = vi.fn<RuntimeCreator>(() => {
    const runtime = runtimes[index++];
    if (runtime === undefined) throw new Error("Unexpected runtime creation");
    return Promise.resolve(runtime.runtime);
  });
  const gateway = sessionGateway([]);
  const listAll = vi.fn(() => gateway.listAll());
  const open = vi.fn((file: string) => {
    const runtime = runtimes.find((candidate) => candidate.session.sessionFile === file);
    if (runtime === undefined) throw new Error(`Unexpected session file: ${file}`);
    return runtime.session.sessionManager;
  });
  const resolveSpawnTarget = vi.fn((_cwd: string, targetCwd?: string) => Promise.resolve({ allowed: true as const, cwd: targetCwd ?? CWD }));
  const service = new PiSessionService(events, {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    createAgentRuntime,
    sessionManager: { ...gateway, listAll, open },
    archiveStore,
    ...(spawnTargetsEnabled ? { spawnTargets: { resolveSpawnTarget } } : {}),
    subsessionsEnabled: true,
    heartbeatIntervalMs: 60_000,
    ...deps,
  });
  services.add(service);
  return { service, events, archived, archive, restore, createAgentRuntime, listAll, open, resolveSpawnTarget };
}

async function trackedFixture() {
  const parent = journalRuntime(PARENT);
  // Keep completion notifications from starting unrelated parent turns.
  parent.session.isStreaming = true;
  const child = journalRuntime(CHILD);
  const unrelated = journalRuntime("unrelated-1");
  const grandchild = journalRuntime("grandchild-1");
  const context = fixture([parent, child, unrelated, grandchild]);
  await context.service.start(CWD);
  await context.service.spawnSubsession({
    spawningCwd: CWD, parentSessionId: PARENT, parentSessionFile: parent.session.sessionFile, prompt: "initial task",
  });
  await vi.advanceTimersByTimeAsync(0);
  return { ...context, parent, child, unrelated, grandchild };
}

const controls = ["stopSubsession", "resumeSubsession", "archiveSubsession"] as const;
type Control = typeof controls[number];
function control(service: PiSessionService, action: Control, parentId: string, childId: string, parentFile?: string) {
  return action === "resumeSubsession"
    ? service.resumeSubsession(parentId, childId, "continue", parentFile)
    : service[action](parentId, childId, parentFile);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  try {
    await Promise.all([...services].map((service) => service.dispose()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  } finally {
    services.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("PiSessionService direct-child lifecycle control", () => {
  it("aborts without disposing, then resumes the same linked conversation with literal prompt text", async () => {
    const { service, parent, child, createAgentRuntime } = await trackedFixture();
    const parentLinks = [...parent.entries];
    const childMarkers = [...child.entries];
    child.entries.push({ type: "message", message: { role: "assistant", content: "work already done" } });
    child.session.isStreaming = true;
    child.session.pendingMessageCount = 1;
    const abort = child.session.abort.bind(child.session);
    child.session.abort = async () => {
      await abort();
      child.session.isStreaming = false;
      child.session.pendingMessageCount = 0;
    };

    await expect(service.stopSubsession(PARENT, CHILD, parent.session.sessionFile)).resolves.toEqual({ sessionId: CHILD, cwd: CWD, status: "idle" });
    expect(child.calls.abort).toBe(1);
    expect(child.calls.clearQueue).toBe(1);
    expect(child.calls.dispose).toBe(0);
    expect(service.activeCount()).toBe(2);
    await expect(service.listSubsessions(PARENT)).resolves.toEqual([{ sessionId: CHILD, cwd: CWD, status: "idle" }]);

    await expect(service.resumeSubsession(PARENT, CHILD, "/literal-template keep going", parent.session.sessionFile)).resolves.toEqual({ sessionId: CHILD, cwd: CWD, status: "working" });
    expect(child.calls.prompt.at(-1)).toEqual({ text: "/literal-template keep going", options: { expandPromptTemplates: false } });
    expect(createAgentRuntime).toHaveBeenCalledTimes(2);
    expect(child.entries).toContainEqual({ type: "message", message: { role: "assistant", content: "work already done" } });
    expect(parent.entries).toEqual(parentLinks);
    expect(child.entries.slice(0, childMarkers.length)).toEqual(childMarkers);
    expect(child.calls.dispose).toBe(0);
  });

  it("can resume an idle child with an omitted continuation prompt", async () => {
    const { service, child } = await trackedFixture();
    await expect(service.resumeSubsession(PARENT, CHILD)).resolves.toMatchObject({ sessionId: CHILD, status: "working" });
    expect(child.calls.prompt.at(-1)?.options).toEqual({ expandPromptTemplates: false });
    expect(child.calls.prompt.at(-1)?.text.trim()).toBeTruthy();
  });

  it.each(["streaming", "compacting", "bash", "queued"] as const)("rejects resume while the child has %s work", async (activity) => {
    const { service, child } = await trackedFixture();
    if (activity === "streaming") child.session.isStreaming = true;
    if (activity === "compacting") child.session.isCompacting = true;
    if (activity === "bash") child.session.isBashRunning = true;
    if (activity === "queued") child.session.pendingMessageCount = 1;
    await expect(service.resumeSubsession(PARENT, CHILD, "must not submit")).rejects.toThrow(/working|activity/i);
    expect(child.calls.prompt).toHaveLength(1);
    expect(child.calls.abort).toBe(0);
  });

  it.each(controls)("%s rejects unrelated sessions, grandchildren, and a copied parent file", async (action) => {
    const { service, parent, child, unrelated, grandchild, archive } = await trackedFixture();
    await service.start(CWD);
    await service.spawnSubsession({ spawningCwd: CWD, parentSessionId: CHILD, parentSessionFile: child.session.sessionFile, prompt: "nested task" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(control(service, action, PARENT, unrelated.session.sessionId)).rejects.toThrow(/not one of your subsessions/i);
    await expect(control(service, action, PARENT, grandchild.session.sessionId)).rejects.toThrow(/not one of your subsessions/i);
    await expect(control(service, action, CHILD, PARENT)).rejects.toThrow(/not one of your subsessions/i);
    await expect(control(service, action, PARENT, CHILD, "/sessions/copied-parent.jsonl")).rejects.toThrow(/not one of your subsessions/i);
    expect(child.calls.prompt).toHaveLength(1);
    expect(child.calls.abort).toBe(0);
    expect(child.calls.dispose).toBe(0);
    expect(unrelated.calls.prompt).toHaveLength(0);
    expect(unrelated.calls.abort).toBe(0);
    expect(grandchild.calls.prompt).toHaveLength(1);
    expect(grandchild.calls.abort).toBe(0);
    expect(grandchild.calls.dispose).toBe(0);
    expect(parent.calls.abort).toBe(0);
    expect(archive).not.toHaveBeenCalled();
  });

  it("requires idle before archive, then uses the ordinary archive path after stop without erasing links", async () => {
    const { service, parent, child, archive, archived } = await trackedFixture();
    const parentLinks = [...parent.entries];
    const childMarkers = [...child.entries];
    child.session.isStreaming = true;
    await expect(service.archiveSubsession(PARENT, CHILD)).rejects.toThrow(/stop.*activity.*archiv/i);
    expect(archive).not.toHaveBeenCalled();
    expect(child.calls.abort).toBe(0);
    expect(child.calls.dispose).toBe(0);

    const abort = child.session.abort.bind(child.session);
    child.session.abort = async () => { await abort(); child.session.isStreaming = false; };
    await service.stopSubsession(PARENT, CHILD);
    await service.archiveSubsession(PARENT, CHILD, parent.session.sessionFile);

    expect(archive).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ sessionId: CHILD, cwd: CWD, path: child.session.sessionFile }));
    expect(archived.has(CHILD)).toBe(true);
    expect(child.calls.dispose).toBe(1);
    expect(service.activeCount()).toBe(1);
    expect(parent.entries).toEqual(parentLinks);
    expect(child.entries).toEqual(childMarkers);
  });

  it("rejects resume of an archived child without restoring or prompting it", async () => {
    const { service, child, archived, restore } = await trackedFixture();
    archived.set(CHILD, { sessionId: CHILD, cwd: CWD, archivedAt: "2026-01-01T00:00:00.000Z" });
    await expect(service.resumeSubsession(PARENT, CHILD, "must not run")).rejects.toThrow(/archived.*read.only/i);
    expect(child.calls.prompt).toHaveLength(1);
    expect(restore).not.toHaveBeenCalled();
  });

  it.each(controls)("%s rejects an unverified persisted link before opening or mutating its target", async (action) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-agent-control-stale-"));
    tempDirs.push(dir);
    const parentFile = join(dir, "parent.jsonl");
    const childFile = join(dir, "child.jsonl");
    // A parent-side claim is not authority when the child header lacks its backlink.
    await writeFile(childFile, JSON.stringify({ type: "session", version: 3, id: CHILD, cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
    const parent = journalRuntime(PARENT, parentFile);
    parent.entries.push({ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: PARENT, spawnedSessionId: CHILD, spawnedSessionFile: childFile, cwd: CWD } });
    const { service, open, createAgentRuntime, archive } = fixture([parent]);
    await service.start(CWD);
    await expect(control(service, action, PARENT, CHILD, parentFile)).rejects.toThrow(/not one of your subsessions/i);
    expect(open).not.toHaveBeenCalledWith(childFile);
    expect(createAgentRuntime).toHaveBeenCalledOnce();
    expect(archive).not.toHaveBeenCalled();
  });

  it("recovers a verified child after restart and controls that conversation rather than spawning a replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-agent-control-recover-"));
    tempDirs.push(dir);
    const parentFile = join(dir, "parent.jsonl");
    const childFile = join(dir, "child.jsonl");
    await writeFile(childFile, JSON.stringify({ type: "session", version: 3, id: CHILD, cwd: CWD, parentSession: parentFile, timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
    const parent = journalRuntime(PARENT, parentFile);
    parent.session.isStreaming = true;
    parent.entries.push({ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: PARENT, spawnedSessionId: CHILD, spawnedSessionFile: childFile, cwd: CWD } });
    const child = journalRuntime(CHILD, childFile);
    const { service, open, createAgentRuntime } = fixture([parent, child]);
    await service.start(CWD);
    await service.stopSubsession(PARENT, CHILD, parentFile);
    await service.resumeSubsession(PARENT, CHILD, "continue recovered work", parentFile);
    expect(open).toHaveBeenCalledWith(childFile);
    expect(child.calls.abort).toBe(1);
    expect(child.calls.prompt).toEqual([{ text: "continue recovered work", options: { expandPromptTemplates: false } }]);
    expect(createAgentRuntime).toHaveBeenCalledTimes(2);
    expect(child.calls.dispose).toBe(0);
    await expect(service.listSubsessions(PARENT, parentFile)).resolves.toMatchObject([{ sessionId: CHILD }]);
  });
});

describe("PiSessionService same-project session messaging", () => {
  const message = "  Please investigate this independently.\n\nKeep this body unchanged.  \n";
  const send = (service: PiSessionService, target = CHILD, sender = PARENT) => service.sendSessionMessage({ sendingCwd: CWD, sendingSessionId: sender, sessionId: target, message });

  it.each([false, true])("blocks messaging when disabled, with explicit resolver=%s", async (explicitResolver) => {
    const target = journalRuntime(CHILD);
    const resolveMessageTarget = vi.fn(() => Promise.resolve({ allowed: true as const, cwd: CWD }));
    const { service, createAgentRuntime, listAll, resolveSpawnTarget } = fixture([target], {
      sessionMessagesEnabled: false,
      ...(explicitResolver ? { messageTargets: { resolveSpawnTarget: resolveMessageTarget } } : {}),
    });
    await expect(send(service)).rejects.toThrow("Session messaging is unavailable");
    expect(createAgentRuntime).not.toHaveBeenCalled();
    expect(listAll).not.toHaveBeenCalled();
    expect(resolveMessageTarget).not.toHaveBeenCalled();
    expect(resolveSpawnTarget).not.toHaveBeenCalled();
    expect(target.calls.sendCustomMessage).toEqual([]);
  });

  it("delivers attributed custom follow-ups to children, parents, and unrelated sessions without granting authority", async () => {
    const { service, parent, child, unrelated, listAll } = await trackedFixture();
    await service.start(CWD);
    await expect(send(service)).resolves.toEqual({ sessionId: CHILD, delivery: "started" });
    await expect(send(service, PARENT, CHILD)).resolves.toEqual({ sessionId: PARENT, delivery: "queued" });
    await expect(send(service, unrelated.session.sessionId)).resolves.toEqual({ sessionId: unrelated.session.sessionId, delivery: "started" });
    await vi.advanceTimersByTimeAsync(0);
    for (const recipient of [parent, child, unrelated]) {
      const sendingSessionId = recipient === parent ? CHILD : PARENT;
      expect(recipient.calls.sendCustomMessage).toEqual([{
        message: {
          customType: "session.message",
          content: `Message from session ${sendingSessionId}:\n\n${message}`,
          display: true,
          details: { sendingSessionId },
        },
        options: { triggerTurn: true, deliverAs: "followUp" },
      }]);
    }
    expect(listAll).not.toHaveBeenCalled();
    expect(unrelated.entries).toEqual([]);
    await expect(service.listSubsessions(PARENT)).resolves.toEqual([{ sessionId: CHILD, cwd: CWD, status: "idle" }]);
    await expect(service.listSubsessions(unrelated.session.sessionId)).resolves.toEqual([]);
    await expect(service.checkSubsession(PARENT, unrelated.session.sessionId)).rejects.toThrow(/not one of your subsessions/i);
    await expect(service.readSubsession(PARENT, unrelated.session.sessionId, {})).rejects.toThrow(/not one of your subsessions/i);
    await expect(service.stopSubsession(PARENT, unrelated.session.sessionId)).rejects.toThrow(/not one of your subsessions/i);
  });

  it("queues a follow-up for an already streaming recipient", async () => {
    const target = journalRuntime(CHILD);
    target.session.isStreaming = true;
    const { service } = fixture([target]);
    await service.start(CWD);
    await expect(send(service)).resolves.toEqual({ sessionId: CHILD, delivery: "queued" });
    expect(target.calls.sendCustomMessage[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(target.calls.abort).toBe(0);
  });

  it("allows a message to wake a stopped child without a persistent paused gate", async () => {
    const { service, child } = await trackedFixture();
    child.session.isStreaming = true;
    const abort = child.session.abort.bind(child.session);
    child.session.abort = async () => { await abort(); child.session.isStreaming = false; };
    await service.stopSubsession(PARENT, CHILD);
    await expect(send(service)).resolves.toEqual({ sessionId: CHILD, delivery: "started" });
    expect(child.calls.sendCustomMessage).toHaveLength(1);
    expect(child.calls.dispose).toBe(0);
  });

  it.each(["compaction", "bash"] as const)("accepts a queued message during %s without waiting for idle", async (activity) => {
    const target = journalRuntime(CHILD);
    target.session.isCompacting = activity === "compaction";
    target.session.isBashRunning = activity === "bash";
    let releaseIdle: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const waitForIdle = vi.spyOn(target.session, "waitForIdle").mockReturnValue(idle);
    const { service } = fixture([target]);
    await service.start(CWD);
    const accepted = vi.fn();
    const result = send(service);
    void result.then(accepted);
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(accepted).toHaveBeenCalledWith({ sessionId: CHILD, delivery: "queued" });
      expect(waitForIdle).toHaveBeenCalledOnce();
      expect(target.calls.sendCustomMessage).toHaveLength(0);
    } finally {
      target.session.isCompacting = false;
      target.session.isBashRunning = false;
      releaseIdle?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(result).resolves.toEqual({ sessionId: CHILD, delivery: "queued" });
    expect(target.calls.sendCustomMessage).toEqual([{
      message: {
        customType: "session.message",
        content: `Message from session ${PARENT}:\n\n${message}`,
        display: true,
        details: { sendingSessionId: PARENT },
      },
      options: { triggerTurn: true, deliverAs: "followUp" },
    }]);
  });

  it("does not deliver deferred work into a recipient runtime that was closed", async () => {
    const target = journalRuntime(CHILD);
    target.session.isCompacting = true;
    let releaseIdle: () => void = () => { throw new Error("Idle gate is not initialized"); };
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    vi.spyOn(target.session, "waitForIdle").mockReturnValue(idle);
    const info = vi.fn();
    const { service } = fixture([target], { logger: { info } });
    await service.start(CWD);
    await expect(send(service)).resolves.toMatchObject({ delivery: "queued" });
    await service.stop({ id: CHILD, cwd: CWD });
    releaseIdle();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.calls.sendCustomMessage).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ sessionId: CHILD }), "session message delivery failed");
    expect(service.activeCount()).toBe(0);
  });

  it("discovers an inactive target with listAll, validates its cwd, and opens the existing conversation", async () => {
    const targetCwd = "/workspace-feature";
    const target = journalRuntime(CHILD, "/sessions/existing-child.jsonl", targetCwd);
    const record = { ...sessionRecord(CHILD, targetCwd), path: target.session.sessionFile ?? "" };
    const gateway = sessionGateway([record]);
    const listAll = vi.fn(() => gateway.listAll());
    const open = vi.fn(() => target.session.sessionManager);
    const resolveSpawnTarget = vi.fn(() => Promise.resolve({ allowed: true as const, cwd: targetCwd }));
    const { service, createAgentRuntime } = fixture([target], {
      sessionManager: { ...gateway, listAll, open },
      messageTargets: { resolveSpawnTarget },
    });
    await expect(send(service)).resolves.toEqual({ sessionId: CHILD, delivery: "started" });
    expect(listAll).toHaveBeenCalledOnce();
    expect(resolveSpawnTarget).toHaveBeenCalledWith(CWD, targetCwd);
    expect(open).toHaveBeenCalledWith(record.path);
    expect(createAgentRuntime).toHaveBeenCalledOnce();
    expect(target.calls.prompt).toHaveLength(0);
    expect(target.calls.sendCustomMessage[0]?.message).toEqual({
      customType: "session.message",
      content: `Message from session ${PARENT}:\n\n${message}`,
      display: true,
      details: { sendingSessionId: PARENT },
    });
    await expect(service.listSubsessions(PARENT)).resolves.toEqual([]);
  });

  it("rejects nonexistent exact ids instead of accepting a prefix match", async () => {
    const target = journalRuntime("child-1-longer");
    const gateway = sessionGateway([sessionRecord("child-1-longer")]);
    const open = vi.fn(() => target.session.sessionManager);
    const { service, createAgentRuntime, resolveSpawnTarget } = fixture([target], { sessionManager: { ...gateway, open } });
    await service.start(CWD);
    await expect(send(service)).rejects.toThrow(/not found/i);
    expect(createAgentRuntime).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(resolveSpawnTarget).not.toHaveBeenCalled();
    expect(target.calls.sendCustomMessage).toHaveLength(0);
  });

  it("rejects a cross-project persisted target before opening it, using messaging policy rather than spawn policy", async () => {
    const target = journalRuntime(CHILD, "/sessions/other-project.jsonl", "/other-project");
    const gateway = sessionGateway([{ ...sessionRecord(CHILD, "/other-project"), path: target.session.sessionFile ?? "" }]);
    const open = vi.fn(() => target.session.sessionManager);
    const resolveSpawnTarget = vi.fn(() => Promise.resolve({ allowed: false as const, reason: "out-of-project" as const, allowedCwds: [CWD] }));
    const { service, createAgentRuntime, resolveSpawnTarget: spawnResolver } = fixture([target], {
      sessionManager: { ...gateway, open },
      messageTargets: { resolveSpawnTarget },
    });
    await expect(send(service)).rejects.toThrow(/same.*project/i);
    expect(resolveSpawnTarget).toHaveBeenCalledWith(CWD, "/other-project");
    expect(spawnResolver).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(createAgentRuntime).not.toHaveBeenCalled();
    expect(target.calls.sendCustomMessage).toHaveLength(0);
  });

  it("does not bypass project authorization for an already active target", async () => {
    const target = journalRuntime(CHILD, "/sessions/other-project.jsonl", "/other-project");
    const { service, listAll } = fixture([target], {
      messageTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: false, reason: "out-of-project", allowedCwds: [CWD] }) },
    });
    await service.start("/other-project");
    await expect(send(service)).rejects.toThrow(/same.*project/i);
    expect(listAll).not.toHaveBeenCalled();
    expect(target.calls.sendCustomMessage).toHaveLength(0);
  });

  it("supports a messaging resolver independently of spawn availability", async () => {
    const target = journalRuntime(CHILD);
    const { service } = fixture([target], {
      messageTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: CWD }) },
    }, false);
    await service.start(CWD);
    await expect(send(service)).resolves.toEqual({ sessionId: CHILD, delivery: "started" });
    expect(target.calls.sendCustomMessage).toHaveLength(1);
  });

  it("rejects archived targets before opening, without restoring or delivering", async () => {
    const target = journalRuntime(CHILD);
    const gateway = sessionGateway([sessionRecord(CHILD)]);
    const open = vi.fn(() => target.session.sessionManager);
    const { service, archived, restore, createAgentRuntime } = fixture([target], { sessionManager: { ...gateway, open } });
    archived.set(CHILD, { sessionId: CHILD, cwd: CWD, archivedAt: "2026-01-01T00:00:00.000Z" });
    await expect(send(service)).rejects.toThrow(/archived.*read.only/i);
    expect(open).not.toHaveBeenCalled();
    expect(createAgentRuntime).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(target.calls.sendCustomMessage).toHaveLength(0);
  });

  it("returns acceptance without waiting for the recipient's full turn and publishes later delivery failures", async () => {
    const target = journalRuntime(CHILD);
    let rejectTurn: ((error: Error) => void) | undefined;
    const turn = new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
    const sendCustomMessage = vi.spyOn(target.session, "sendCustomMessage").mockReturnValue(turn);
    const { service, events } = fixture([target]);
    await service.start(CWD);
    const result = send(service);
    const accepted = vi.fn();
    void result.then(accepted);
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(sendCustomMessage).toHaveBeenCalledOnce();
      expect(accepted).toHaveBeenCalledWith({ sessionId: CHILD, delivery: "started" });
      expect(events.sessionEvents).not.toContainEqual({ sessionId: CHILD, event: { type: "session.error", message: "recipient turn failed" } });
    } finally {
      rejectTurn?.(new Error("recipient turn failed"));
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(result).resolves.toEqual({ sessionId: CHILD, delivery: "started" });
    expect(events.sessionEvents).toContainEqual({ sessionId: CHILD, event: { type: "session.error", message: "recipient turn failed" } });
  });
});
