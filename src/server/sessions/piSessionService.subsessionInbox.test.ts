import { SessionManager } from "../../piSdk.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";
import type { SubsessionReadQuery } from "./spawnSubsessionTool.js";
import { completionReceiptIds, persistedSubsessionCompletions, SUBSESSION_COMPLETION_ENTRY_TYPE, SUBSESSION_NOTIFICATION_CUSTOM_TYPE, SUBSESSION_RECEIPT_ENTRY_TYPE, type SubsessionCompletion } from "./subsessionCompletionInbox.js";

const CWD = "/workspace";
const PARENT_ID = "parent-1";
const PARENT_FILE = "/sessions/inbox-parent-1.jsonl";
const HEARTBEAT_MS = 10;
const services = new Set<PiSessionService>();
const tempDirs: string[] = [];
type DeliveryDraft = NonNullable<Awaited<ReturnType<PiSessionService["prepareSubsessionDelivery"]>>>;

function journal(sessionId: string, sessionFile: string) {
  const entries: unknown[] = [];
  const appendCustomEntry = vi.fn((customType: string, data?: unknown) => {
    const id = `entry-${String(entries.length)}`;
    entries.push({ type: "custom", id, customType, data });
    return id;
  });
  const manager = fakeSessionManager(CWD, {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getEntries: () => entries,
    getBranch: () => entries,
    appendCustomEntry,
  });
  return { entries, appendCustomEntry, manager };
}

async function inboxService(childIds = ["child-1"]) {
  const parentJournal = journal(PARENT_ID, PARENT_FILE);
  // Completion must happen while the parent is busy: otherwise automatic
  // delivery legitimately consumes the answer before the inspecting tool runs.
  // fakeRuntime's successful send promise models completed SDK delivery;
  // boundary-draft persistence and receipt events are emitted explicitly below.
  const parent = { ...fakeRuntime(PARENT_ID, { sessionFile: PARENT_FILE, sessionManager: parentJournal.manager, isStreaming: true }), journal: parentJournal };
  const send = parent.session.sendCustomMessage.bind(parent.session);
  parent.session.sendCustomMessage = async (message, options) => {
    await send(message, options);
    parentJournal.entries.push({ type: "custom_message", ...message });
  };
  const children = childIds.map((id) => {
    const childJournal = journal(id, `/sessions/inbox-${id}.jsonl`);
    return { ...fakeRuntime(id, { sessionFile: childJournal.manager.getSessionFile(), sessionManager: childJournal.manager }), journal: childJournal };
  });
  const child = children[0];
  if (child === undefined) throw new Error("Expected at least one child");
  const runtimes = [parent.runtime, ...children.map((fixture) => fixture.runtime)];
  let index = 0;
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    createAgentRuntime: () => {
      const runtime = runtimes[index++];
      if (runtime === undefined) throw new Error("Unexpected runtime creation");
      return Promise.resolve(runtime);
    },
    sessionManager: sessionGateway([]),
    archiveStore: emptyArchiveStore(),
    spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: CWD }) },
    subsessionsEnabled: true,
    heartbeatIntervalMs: HEARTBEAT_MS,
  });
  services.add(service);
  await service.start(CWD);
  for (const id of childIds) {
    await service.spawnSubsession({ spawningCwd: CWD, parentSessionId: PARENT_ID, parentSessionFile: PARENT_FILE, prompt: `work for ${id}` });
  }
  // The fake prompt resolves without running an agent. Flush its host mutation
  // receipt before explicitly emitting the real child run below.
  await vi.advanceTimersByTimeAsync(0);
  return { service, parent, child, children };
}

type ParentFixture = Awaited<ReturnType<typeof inboxService>>["parent"];
type ChildFixture = Awaited<ReturnType<typeof inboxService>>["child"];

function startChildRun(child: ChildFixture): void {
  child.session.isStreaming = true;
  child.emit({ type: "agent_start" });
}

function finishChildRun(child: ChildFixture, content: string | unknown[] = "final answer", emitEnd = true): void {
  child.journal.entries.push({ type: "message", message: { role: "assistant", content } });
  child.session.isStreaming = false;
  if (emitEnd) child.emit({ type: "agent_end" });
}

async function settleParent(parent: ParentFixture): Promise<void> {
  parent.session.isStreaming = false;
  parent.emit({ type: "agent_settled" });
  // Drain the zero-delay wake and several heartbeats, never runAllTimers on the
  // service's recurring interval. This also catches delayed completion replay.
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
}

function receiveCustomMessage(parent: ParentFixture, draft: DeliveryDraft): void {
  // SDK persistence precedes message_end; the service does not append the draft.
  parent.journal.entries.push(draft);
  parent.emit({ type: "message_end", message: { role: "custom", customType: draft.customType, content: draft.content, display: draft.display, details: draft.details } });
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

describe("PiSessionService shared subsession completion inbox", () => {
  it("returns ready answers at the yield/join point without later automatic replay", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);

    // Omitted and explicit parent-file arguments must reach the same inbox.
    const joined = await service.joinSubsessions(PARENT_ID);
    expect(joined.subsessions).toEqual([{ sessionId: "child-1", cwd: CWD, status: "idle" }]);
    expect(joined.completions).toMatchObject([{ sessionId: "child-1", status: "idle", finalText: "final answer", messageCount: 1 }]);
    expect(joined.completions[0]?.completionId).toEqual(expect.any(String));
    const ids = joined.completions.map(({ completionId }) => completionId);
    expect(parent.journal.appendCustomEntry).toHaveBeenCalledWith(SUBSESSION_RECEIPT_ENTRY_TYPE, { completionIds: ids });

    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    await expect(service.prepareSubsessionDelivery(PARENT_ID, PARENT_FILE)).resolves.toBeUndefined();
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });
  });

  it.each(["finalized event", "before finalizing event", "before idle heartbeat"])("check consumes the answer when the child is idle (%s)", async (timing) => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    if (timing === "before idle heartbeat") child.emit({ type: "agent_end" }); // still streaming
    finishChildRun(child, "checked answer", timing === "finalized event");
    // No timer flush here: check itself must finalize an idle, still-armed run.
    await expect(service.checkSubsession(PARENT_ID, "child-1", PARENT_FILE)).resolves.toMatchObject({ status: "idle", finalText: "checked answer", messageCount: 1 });
    const completions = persistedSubsessionCompletions(child.journal.entries);
    expect(completions).toHaveLength(1);
    expect(parent.journal.appendCustomEntry).toHaveBeenCalledWith(SUBSESSION_RECEIPT_ENTRY_TYPE, { completionIds: completions.map(({ completionId }) => completionId) });

    child.emit({ type: "agent_end" }); // a late finalizing event must not re-arm it
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    expect(persistedSubsessionCompletions(child.journal.entries)).toEqual(completions);
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });
  });

  it("a working check consumes nothing, including an unread answer from the child's earlier run", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child, "earlier answer");
    await vi.advanceTimersByTimeAsync(0);
    startChildRun(child);

    await expect(service.checkSubsession(PARENT_ID, "child-1", PARENT_FILE)).resolves.toMatchObject({ status: "working", finalText: "earlier answer" });
    expect(parent.journal.appendCustomEntry.mock.calls.filter(([type]) => type === SUBSESSION_RECEIPT_ENTRY_TYPE)).toEqual([]);
    const joined = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(joined.subsessions).toMatchObject([{ status: "working" }]);
    expect(joined.completions).toMatchObject([{ finalText: "earlier answer" }]);

    finishChildRun(child, "new answer");
    const next = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(next.completions).toMatchObject([{ finalText: "new answer" }]);
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
  });

  it("a transcript read returning the complete final text acknowledges the answer", async () => {
    const { service, parent, child } = await inboxService();
    child.journal.entries.push({ type: "message", message: { role: "assistant", content: "historical answer" } });
    startChildRun(child);
    finishChildRun(child, [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "final answer" }]);

    const read = await service.readSubsession(PARENT_ID, "child-1", { roles: ["assistant"], include: ["text"], limit: 1 }, PARENT_FILE);
    expect(read.entries).toEqual([{ index: 1, role: "assistant", parts: [{ kind: "text", text: "final answer" }] }]);
    expect(parent.journal.appendCustomEntry).toHaveBeenCalledWith(SUBSESSION_RECEIPT_ENTRY_TYPE, { completionIds: persistedSubsessionCompletions(child.journal.entries).map(({ completionId }) => completionId) });
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    await expect(service.prepareSubsessionDelivery(PARENT_ID, PARENT_FILE)).resolves.toBeUndefined();
  });

  it("returns and acknowledges an error-only completion through transcript inspection", async () => {
    const { service, parent, child } = await inboxService();
    child.session.prompt = vi.fn(() => Promise.reject(new Error("No model selected")));
    await service.prompt(sessionRef("child-1"), "try work");
    await vi.advanceTimersByTimeAsync(0);
    await expect(service.readSubsession(PARENT_ID, "child-1", {}, PARENT_FILE)).resolves.toMatchObject({ status: "error", errorDetail: "No model selected", entries: [] });
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
  });

  const nonAcknowledgingReads: { name: string; query: SubsessionReadQuery }[] = [
    { name: "role-filtered", query: { roles: ["user"] } },
    { name: "content-filtered", query: { include: ["thinking"] } },
    { name: "search-filtered", query: { search: "historical answer" } },
    { name: "history-only", query: { before: 2 } },
    { name: "truncated", query: { roles: ["assistant"], limit: 1, maxChars: 4 } },
  ];
  it.each(nonAcknowledgingReads)("a $name transcript read leaves the final answer unread", async ({ name, query }) => {
    const { service, parent, child } = await inboxService();
    child.journal.entries.push(
      { type: "message", message: { role: "user", content: "question" } },
      { type: "message", message: { role: "assistant", content: "historical answer" } },
    );
    startChildRun(child);
    finishChildRun(child, [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "final answer" }]);

    const read = await service.readSubsession(PARENT_ID, "child-1", query, PARENT_FILE);
    expect(read.status).toBe("idle");
    expect(read.entries).not.toHaveLength(0);
    expect(read.entries.flatMap(({ parts }) => parts)).not.toContainEqual({ kind: "text", text: "final answer" });
    if (name === "truncated") expect(read.entries[0]?.parts).toContainEqual({ kind: "text", text: "fina", truncated: { shown: 4, full: 12 } });
    expect(parent.journal.appendCustomEntry.mock.calls.filter(([type]) => type === SUBSESSION_RECEIPT_ENTRY_TYPE)).toEqual([]);
    const joined = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(joined.completions).toMatchObject([{ sessionId: "child-1", finalText: "final answer", messageCount: 3 }]);
  });

  it("joins a partial ready batch while another child works and delivers only the later answer on wake", async () => {
    const { service, parent, children } = await inboxService(["child-1", "child-2"]);
    const [first, second] = children;
    if (first === undefined || second === undefined) throw new Error("Expected two children");
    startChildRun(first);
    startChildRun(second);
    finishChildRun(first, "first child answer");

    const joined = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(joined.subsessions).toEqual([{ sessionId: "child-1", cwd: CWD, status: "idle" }, { sessionId: "child-2", cwd: CWD, status: "working" }]);
    expect(joined.completions).toMatchObject([{ sessionId: "child-1", finalText: "first child answer" }]);
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);

    finishChildRun(second, "second child answer");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
    expect(parent.calls.sendCustomMessage[0]?.message.content).toContain("Subsession child-2 is now idle.");
    expect(JSON.stringify(parent.calls.sendCustomMessage[0]?.message)).not.toContain("second child answer");
    expect(parent.calls.sendCustomMessage[0]?.message.content).not.toContain("first child answer");
    expect(parent.calls.sendCustomMessage[0]?.options).toEqual({ triggerTurn: true });
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });
  });

  it("captures each native settlement before the host prompt receipt unwinds or another run starts", async () => {
    const { service, child } = await inboxService();
    let run = 0;
    child.session.prompt = vi.fn(() => {
      startChildRun(child);
      finishChildRun(child, `answer-${String(++run)}`, false);
      child.emit({ type: "agent_settled" });
      return Promise.resolve();
    });
    await service.prompt(sessionRef("child-1"), "first run");
    await service.prompt(sessionRef("child-1"), "second run");
    const joined = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(joined.completions.map(({ finalText }) => finalText)).toEqual(["answer-1", "answer-2"]);
  });

  it("checking a rewound child acknowledges only the result actually returned", async () => {
    const { service, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child, "first branch answer");
    const firstBranch = [...child.journal.entries];
    startChildRun(child);
    finishChildRun(child, "newer abandoned answer");
    child.session.sessionManager.getBranch = () => firstBranch;
    await expect(service.checkSubsession(PARENT_ID, "child-1", PARENT_FILE)).resolves.toMatchObject({ finalText: "first branch answer" });
    const joined = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(joined.completions).toMatchObject([{ finalText: "newer abandoned answer" }]);
  });

  it("retains both unread runs of one child instead of overwriting the earlier answer", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child, "first run answer");
    startChildRun(child);
    finishChildRun(child, "second run answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);

    const joined = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(joined.completions).toMatchObject([{ sessionId: "child-1", finalText: "first run answer", messageCount: 1 }, { sessionId: "child-1", finalText: "second run answer", messageCount: 2 }]);
    expect(new Set(joined.completions.map(({ completionId }) => completionId)).size).toBe(2);
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
  });

  it("delivers distinct runs independently even when the same child returns identical text", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child, "same answer");
    const first = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(first.completions).toHaveLength(1);
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);

    parent.session.isStreaming = true;
    startChildRun(child);
    finishChildRun(child, "same answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    const runs = persistedSubsessionCompletions(child.journal.entries);
    expect(runs).toMatchObject([{ finalText: "same answer", messageCount: 1 }, { finalText: "same answer", messageCount: 2 }]);
    expect(new Set(runs.map(({ completionId }) => completionId)).size).toBe(2);
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
    expect(completionReceiptIds(parent.calls.sendCustomMessage[0]?.message.details)).toEqual(runs.slice(1).map(({ completionId }) => completionId));
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });
  });

  it("claims a prepared delivery once and commits its custom message_end receipt without duplication", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    const draft = await service.prepareSubsessionDelivery(PARENT_ID, PARENT_FILE);
    if (draft === undefined) throw new Error("Expected a delivery draft");
    expect(draft).toMatchObject({ type: "custom_message", customType: SUBSESSION_NOTIFICATION_CUSTOM_TYPE, display: true });
    expect(draft.content).toContain("Subsession child-1 is now idle.");
    expect(JSON.stringify(draft)).not.toContain("final answer");
    expect(draft.details).toEqual({ sessionId: "child-1", completionIds: completionReceiptIds(draft.details) });
    expect(completionReceiptIds(draft.details)).toEqual(persistedSubsessionCompletions(child.journal.entries).map(({ completionId }) => completionId));
    await expect(service.prepareSubsessionDelivery(PARENT_ID, PARENT_FILE)).resolves.toBeUndefined();
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });

    receiveCustomMessage(parent, draft);
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    await expect(service.prepareSubsessionDelivery(PARENT_ID, PARENT_FILE)).resolves.toBeUndefined();
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });
  });

  it("does not replay a committed boundary draft received through entry_appended instead of message_end", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    const draft = await service.prepareSubsessionDelivery(PARENT_ID, PARENT_FILE);
    if (draft === undefined) throw new Error("Expected a delivery draft");
    // Native boundary entries emit entry_appended, not message_end (also the
    // contract documented by toClientEvent). Settlement must honor that receipt.
    const entry = { ...draft, id: "boundary-receipt", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
    parent.journal.entries.push(entry);
    parent.emit({ type: "entry_appended", entry });
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });
  });

  it("reconciles a failed tool result's provisional receipt before boundary delivery", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    await service.checkSubsession(PARENT_ID, "child-1", PARENT_FILE, "failed-check");
    parent.journal.entries.push({ type: "message", message: { role: "toolResult", toolCallId: "failed-check", isError: true } });
    parent.emit({ type: "turn_end" });
    const draft = await service.prepareSubsessionDelivery(PARENT_ID, PARENT_FILE);
    expect(draft?.content).toContain("Subsession child-1 is now idle.");
    expect(JSON.stringify(draft)).not.toContain("final answer");
  });

  it("releases an uncommitted boundary claim on settlement so the unread answer can wake the parent", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    const draft = await service.prepareSubsessionDelivery(PARENT_ID, PARENT_FILE);
    if (draft === undefined) throw new Error("Expected a delivery draft");
    // No entry was appended and no receipt was emitted for this abandoned draft.
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
    const notice = parent.calls.sendCustomMessage[0]?.message;
    expect(completionReceiptIds(notice?.details)).toEqual(completionReceiptIds(draft.details));
    expect(notice?.content).toContain("Subsession child-1 is now idle.");
    expect(JSON.stringify(notice)).not.toContain("final answer");
    expect(notice?.details).toEqual(draft.details);
    await expect(service.checkSubsession(PARENT_ID, "child-1", PARENT_FILE)).resolves.toMatchObject({ finalText: "final answer" });
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
  });

  it("wakes once when the parent settles before its host prompt mutation receipt unwinds", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    parent.session.prompt = vi.fn(() => {
      parent.session.isStreaming = false;
      // Native settlement precedes the prompt promise and the host finally.
      parent.emit({ type: "agent_settled" });
      return Promise.resolve();
    });

    await service.prompt(sessionRef(PARENT_ID), "continue");
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
    expect(parent.calls.sendCustomMessage[0]?.message.content).toContain("Subsession child-1 is now idle.");
    expect(JSON.stringify(parent.calls.sendCustomMessage[0]?.message)).not.toContain("final answer");
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
  });

  it("delivers unread results after a standalone host shell receipt ends without agent settlement", async () => {
    const { service, parent, child } = await inboxService();
    parent.session.isStreaming = false;
    let finish!: (result: Awaited<ReturnType<typeof parent.session.executeBash>>) => void;
    parent.session.executeBash = vi.fn(() => new Promise<Awaited<ReturnType<typeof parent.session.executeBash>>>((resolve) => { finish = resolve; }));
    await service.shell(sessionRef(PARENT_ID), "!do independent work");
    startChildRun(child);
    finishChildRun(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    finish({ output: "done", exitCode: 0, cancelled: false, truncated: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });
  });

  it("delivers unread results after standalone compaction ends", async () => {
    const { service, parent, child } = await inboxService();
    parent.session.isStreaming = false;
    parent.session.isCompacting = true;
    startChildRun(child);
    finishChildRun(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    parent.session.isCompacting = false;
    parent.emit({ type: "compaction_end" });
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.calls.sendCustomMessage).toHaveLength(1);
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [] });
  });

  it("retains a failed child completion until its snapshot can be recorded", async () => {
    const { service, child } = await inboxService();
    const append = child.journal.appendCustomEntry.getMockImplementation();
    if (append === undefined) throw new Error("Expected a journal writer");
    startChildRun(child);
    child.journal.appendCustomEntry.mockImplementation(() => { throw new Error("child storage failed"); });
    finishChildRun(child);
    await expect(service.checkSubsession(PARENT_ID, "child-1", PARENT_FILE)).rejects.toThrow("Could not record completion");
    child.journal.appendCustomEntry.mockImplementation(append);
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [{ finalText: "final answer" }] });
  });

  it("a failing automatic parent send releases the claim and leaves the answer pending", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    await vi.advanceTimersByTimeAsync(0);
    const send = vi.spyOn(parent.session, "sendCustomMessage").mockRejectedValueOnce(new Error("parent send failed"));
    await settleParent(parent);
    expect(send).toHaveBeenCalledOnce();

    const joined = await service.joinSubsessions(PARENT_ID, PARENT_FILE);
    expect(joined.completions).toEqual(persistedSubsessionCompletions(child.journal.entries));
    expect(joined.completions).toMatchObject([{ finalText: "final answer" }]);
    await settleParent(parent);
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not treat message_end before a failed custom-message write as a durable receipt", async () => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    const send = vi.spyOn(parent.session, "sendCustomMessage").mockImplementation((message) => {
      parent.emit({ type: "message_end", message: { role: "custom", ...message } });
      return Promise.reject(new Error("custom-message storage failed"));
    });
    await settleParent(parent);
    expect(send).toHaveBeenCalledOnce();
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: [{ finalText: "final answer" }] });
  });

  it.each(["join", "check", "read"])("a parent receipt persistence failure in %s leaves the result unread", async (method) => {
    const { service, parent, child } = await inboxService();
    startChildRun(child);
    finishChildRun(child);
    await vi.advanceTimersByTimeAsync(0);
    const completed = persistedSubsessionCompletions(child.journal.entries);
    parent.journal.appendCustomEntry.mockImplementationOnce(() => { throw new Error("receipt storage failed"); });
    const inspect = () => {
      if (method === "join") return service.joinSubsessions(PARENT_ID, PARENT_FILE);
      if (method === "check") return service.checkSubsession(PARENT_ID, "child-1", PARENT_FILE);
      return service.readSubsession(PARENT_ID, "child-1", { roles: ["assistant"], limit: 1 }, PARENT_FILE);
    };

    await expect(inspect()).rejects.toThrow("receipt storage failed");
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
    await expect(service.joinSubsessions(PARENT_ID, PARENT_FILE)).resolves.toMatchObject({ completions: completed });
    expect(completed).toHaveLength(1);
    await settleParent(parent);
    expect(parent.calls.sendCustomMessage).toHaveLength(0);
  });

  it("recovers unread runs from verified files and retains persisted parent receipts after reopening", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-subsession-inbox-"));
    tempDirs.push(dir);
    const parentFile = join(dir, "parent.jsonl");
    const childFile = join(dir, "child.jsonl");
    const first: SubsessionCompletion = { completionId: "persisted-run-1", sessionId: "child-1", cwd: CWD, status: "idle", finalText: "earlier answer", messageCount: 1 };
    const second: SubsessionCompletion = { ...first, completionId: "persisted-run-2", finalText: "recovered answer", messageCount: 2 };
    const timestamp = "2026-01-01T00:00:00.000Z";
    const entry = (id: string, parentId: string | null, fields: object) => ({ id, parentId, timestamp, ...fields });
    await writeFile(parentFile, [
      { type: "session", version: 3, id: PARENT_ID, cwd: CWD, timestamp },
      // A conversational assistant entry makes SDK appends flush to disk, not
      // stay in its pre-conversation buffer. Use the real manager for receipts.
      entry("parent-answer", null, { type: "message", message: { role: "assistant", content: "delegated" } }),
      entry("parent-link", "parent-answer", { type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: PARENT_ID, spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: CWD } }),
      entry("first-receipt", "parent-link", { type: "custom", customType: SUBSESSION_RECEIPT_ENTRY_TYPE, data: { completionIds: [first.completionId] } }),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8");
    await writeFile(childFile, [
      { type: "session", version: 3, id: "child-1", cwd: CWD, timestamp, parentSession: parentFile },
      entry("child-marker", null, { type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: PARENT_ID, spawnedSessionId: "child-1" } }),
      entry("child-answer-1", "child-marker", { type: "message", message: { role: "assistant", content: first.finalText } }),
      entry("child-completion-1", "child-answer-1", { type: "custom", customType: SUBSESSION_COMPLETION_ENTRY_TYPE, data: first }),
      entry("child-answer-2", "child-completion-1", { type: "message", message: { role: "assistant", content: second.finalText } }),
      entry("child-completion-2", "child-answer-2", { type: "custom", customType: SUBSESSION_COMPLETION_ENTRY_TYPE, data: second }),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8");

    const reopen = async () => {
      const parentManager = SessionManager.open(parentFile, dir);
      const childManager = SessionManager.open(childFile, dir);
      const parent = fakeRuntime(PARENT_ID, { sessionFile: parentFile, sessionManager: parentManager, isStreaming: true });
      const child = fakeRuntime("child-1", { sessionFile: childFile, sessionManager: childManager });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: dir,
        modelRuntime: testModelRuntime,
        createAgentRuntime: (_create, options) => {
          if (options.sessionManager === parentManager) return Promise.resolve(parent.runtime);
          if (options.sessionManager === childManager) return Promise.resolve(child.runtime);
          throw new Error("Unexpected recovered manager");
        },
        sessionManager: {
          ...sessionGateway([{ ...sessionRecord(PARENT_ID), path: parentFile }, { ...sessionRecord("child-1"), path: childFile }]),
          open: (path) => {
            if (path === parentFile) return parentManager;
            if (path === childFile) return childManager;
            throw new Error(`Unexpected recovered file ${path}`);
          },
        },
        archiveStore: emptyArchiveStore(),
        heartbeatIntervalMs: HEARTBEAT_MS,
      });
      services.add(service);
      await service.status(sessionRef(PARENT_ID));
      return { service, parent };
    };

    const original = await reopen();
    await expect(original.service.joinSubsessions(PARENT_ID, parentFile)).resolves.toEqual({ subsessions: [{ sessionId: "child-1", cwd: CWD, status: "idle" }], completions: [second] });
    expect(original.parent.calls.sendCustomMessage).toHaveLength(0);
    await original.service.dispose();
    services.delete(original.service);

    const reopened = await reopen();
    await expect(reopened.service.joinSubsessions(PARENT_ID, parentFile)).resolves.toMatchObject({ completions: [] });
    await expect(reopened.service.prepareSubsessionDelivery(PARENT_ID, parentFile)).resolves.toBeUndefined();
    await expect(reopened.service.checkSubsession(PARENT_ID, "child-1", parentFile)).resolves.toMatchObject({ status: "idle", finalText: second.finalText, messageCount: 2 });
    reopened.parent.session.isStreaming = false;
    reopened.parent.emit({ type: "agent_settled" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(reopened.parent.calls.sendCustomMessage).toHaveLength(0);
  });
});
