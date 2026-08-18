import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PendingExtensionDialog, SessionUiEvent } from "../../shared/apiTypes.js";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import { PendingExtensionDialogStore, PendingExtensionDialogValidationError } from "./pendingExtensionDialogStore.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const ACTIVE_SESSION_ID = "session-1";

/**
 * Service over a clocked store with sequential dialog ids, so dialogs are named
 * `dialog-1`, `dialog-2`, … and timestamps are fixed. The daemon default
 * timeout is `0` (wait forever) unless a test says otherwise, so parked waits
 * arm no real timers.
 */
function dialogService(options: { extensionDialogsTimeoutMs?: number } = {}) {
  const store = new PendingExtensionDialogStore({
    now: () => new Date("2026-02-01T10:00:00.000Z"),
    createDialogId: (() => {
      let next = 0;
      return () => { next += 1; return `dialog-${next.toString()}`; };
    })(),
  });
  const fake = fakeRuntime(ACTIVE_SESSION_ID);
  const events = new CapturingSessionEventHub();
  const service = new PiSessionService(events, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([sessionRecord(ACTIVE_SESSION_ID)]),
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: runtimeCreator(fake.runtime),
    pendingExtensionDialogStore: store,
    extensionDialogsTimeoutMs: options.extensionDialogsTimeoutMs ?? 0,
    heartbeatIntervalMs: 60_000,
  });
  return { service, store, events, fake };
}

/** Start the session and return the UI context its extensions were bound with. */
async function boundUiContext(service: PiSessionService, fake: ReturnType<typeof fakeRuntime>): Promise<ExtensionUIContext> {
  await service.status(sessionRef(ACTIVE_SESSION_ID));
  const bindings = fake.calls.bindExtensions.at(-1);
  if (bindings?.uiContext === undefined) throw new Error("session extensions were not bound");
  return bindings.uiContext;
}

function dialogEvents(events: CapturingSessionEventHub): { sessionId: string; event: SessionUiEvent }[] {
  return events.sessionEvents.filter(({ event }) => event.type === "dialog.opened" || event.type === "dialog.closed");
}

/** Observe a parked wait without hanging the test when it never settles. */
async function settledValue(promise: Promise<boolean | string | undefined>): Promise<{ settled: true; value: boolean | string | undefined } | { settled: false }> {
  return await Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    Promise.resolve({ settled: false as const }),
  ]);
}

function openDialog(events: CapturingSessionEventHub): PendingExtensionDialog {
  const opened = dialogEvents(events).find(({ event }) => event.type === "dialog.opened");
  if (opened?.event.type !== "dialog.opened") throw new Error("no dialog.opened event published");
  return opened.event.dialog;
}

describe("PiSessionService extension dialog UI context", () => {
  it("opens a confirm dialog for the extension and parks its answer", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);

    const parked = ui.confirm("Proceed?", "Really proceed?");

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([{
      dialogId: "dialog-1",
      kind: "confirm",
      title: "Proceed?",
      message: "Really proceed?",
      askedAt: "2026-02-01T10:00:00.000Z",
      runScoped: false,
    }]);
    expect(dialogEvents(events)).toEqual([
      { sessionId: ACTIVE_SESSION_ID, event: { type: "dialog.opened", dialog: openDialog(events) } },
    ]);
    await expect(settledValue(parked)).resolves.toEqual({ settled: false });
    await service.dispose();
  });

  it("marks a dialog opened while a run is in flight as run-scoped", async () => {
    const { service, store, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    fake.session.isStreaming = true;

    void ui.confirm("Run consent", "Allow this tool call?");

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([expect.objectContaining({ runScoped: true })]);
    await service.dispose();
  });

  it("opens select and input dialogs with their kind-shaped fields", async () => {
    const { service, store, fake } = dialogService();
    const ui = await boundUiContext(service, fake);

    void ui.select("Pick a database", ["pg", "sqlite"]);
    void ui.input("Branch name?", "feature/…");

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([
      expect.objectContaining({ dialogId: "dialog-1", kind: "select", title: "Pick a database", options: ["pg", "sqlite"] }),
      expect.objectContaining({ dialogId: "dialog-2", kind: "input", title: "Branch name?", placeholder: "feature/…" }),
    ]);
    await service.dispose();
  });

  it("rejects a malformed dialog without opening anything", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);

    await expect(ui.select("Pick one", [])).rejects.toThrow(PendingExtensionDialogValidationError);

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events)).toEqual([]);
    await service.dispose();
  });

  it("dismisses a dialog whose signal is already aborted without opening it", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const controller = new AbortController();
    controller.abort();

    await expect(ui.confirm("Proceed?", "Really?", { signal: controller.signal })).resolves.toBe(false);

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events)).toEqual([]);
    await service.dispose();
  });

  it("keeps delegating non-dialog UI methods to the base context", async () => {
    const { service, fake } = dialogService();
    const ui = await boundUiContext(service, fake);

    await expect(ui.editor("title")).resolves.toBeUndefined();
    await service.dispose();
  });
});

describe("PiSessionService.answerDialog", () => {
  it("resolves the extension's parked wait with the user's answer", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const parked = ui.confirm("Proceed?", "Really?");

    const response = await service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1", true);

    await expect(parked).resolves.toBe(true);
    expect(response.result).toBe("closed");
    expect(response.outcome).toEqual({
      dialogId: "dialog-1",
      reason: "answered",
      answer: true,
      askedAt: "2026-02-01T10:00:00.000Z",
      closedAt: "2026-02-01T10:00:00.000Z",
    });
    expect(response.sessionStatus.pendingDialogs).toBeUndefined();
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events).map(({ event }) => event)).toEqual([
      { type: "dialog.opened", dialog: openDialog(events) },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "answered", answer: true },
    ]);
    await service.dispose();
  });

  it("routes answers by dialog id when several dialogs are open", async () => {
    const { service, store, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const select = ui.select("Pick a database", ["pg", "sqlite"]);
    const input = ui.input("Branch name?");

    await service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-2", "feature/dialogs");

    await expect(input).resolves.toBe("feature/dialogs");
    await expect(settledValue(select)).resolves.toEqual({ settled: false });
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([expect.objectContaining({ dialogId: "dialog-1" })]);
    await service.dispose();
  });

  it("reports a stale dialog id without settling the parked wait", async () => {
    const { service, store, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const parked = ui.confirm("Proceed?", "Really?");

    const response = await service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-gone", true);

    expect(response.result).toBe("stale");
    expect(response).not.toHaveProperty("outcome");
    expect(response.sessionStatus.pendingDialogs).toEqual([expect.objectContaining({ dialogId: "dialog-1" })]);
    await expect(settledValue(parked)).resolves.toEqual({ settled: false });
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toHaveLength(1);
    await service.dispose();
  });

  it("rejects an answer that does not fit the dialog kind and leaves the dialog open", async () => {
    const { service, store, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const parked = ui.confirm("Proceed?", "Really?");

    await expect(service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1", "yes")).rejects.toThrow(PendingExtensionDialogValidationError);

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toHaveLength(1);
    await expect(settledValue(parked)).resolves.toEqual({ settled: false });
    await service.dispose();
  });
});

describe("PiSessionService.cancelDialog", () => {
  it("settles a browser cancel with the dialog kind's cancel value", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const confirm = ui.confirm("Proceed?", "Really?");
    const select = ui.select("Pick a database", ["pg", "sqlite"]);

    const response = await service.cancelDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1");
    await service.cancelDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-2");

    expect(response.outcome).toMatchObject({ dialogId: "dialog-1", reason: "cancelled" });
    await expect(confirm).resolves.toBe(false);
    await expect(select).resolves.toBeUndefined();
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events).map(({ event }) => event)).toMatchObject([
      { type: "dialog.opened", dialog: { dialogId: "dialog-1" } },
      { type: "dialog.opened", dialog: { dialogId: "dialog-2" } },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "cancelled" },
      { type: "dialog.closed", dialogId: "dialog-2", reason: "cancelled" },
    ]);
    await service.dispose();
  });

  it("reports a stale cancel of a dialog that is already gone", async () => {
    const { service, fake } = dialogService();
    await boundUiContext(service, fake);

    const response = await service.cancelDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-gone");

    expect(response.result).toBe("stale");
    await service.dispose();
  });
});

describe("PiSessionService extension dialog timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-cancels an unanswered dialog when the daemon default timeout elapses", async () => {
    vi.useFakeTimers();
    const { service, store, events, fake } = dialogService({ extensionDialogsTimeoutMs: 300_000 });
    const ui = await boundUiContext(service, fake);
    const parked = ui.confirm("Proceed?", "Really?");

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([
      expect.objectContaining({ timeoutAt: "2026-02-01T10:05:00.000Z" }),
    ]);
    await vi.advanceTimersByTimeAsync(300_000);

    await expect(parked).resolves.toBe(false);
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events).map(({ event }) => event)).toEqual([
      { type: "dialog.opened", dialog: openDialog(events) },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "timeout" },
    ]);
    await service.dispose();
  });

  it("honors the extension's own sooner timeout over the daemon default", async () => {
    vi.useFakeTimers();
    const { service, store, fake } = dialogService({ extensionDialogsTimeoutMs: 300_000 });
    const ui = await boundUiContext(service, fake);
    const parked = ui.input("Branch name?", undefined, { timeout: 1_000 });

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([
      expect.objectContaining({ timeoutAt: "2026-02-01T10:00:01.000Z" }),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(parked).resolves.toBeUndefined();
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    await service.dispose();
  });

  it("waits forever on a zero daemon default unless the extension set a timeout", async () => {
    vi.useFakeTimers();
    const { service, store, fake } = dialogService({ extensionDialogsTimeoutMs: 0 });
    const ui = await boundUiContext(service, fake);
    const parked = ui.confirm("Proceed?", "Really?");

    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toHaveLength(1);
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)[0]).not.toHaveProperty("timeoutAt");
    await vi.advanceTimersByTimeAsync(60_000_000);

    await expect(settledValue(parked)).resolves.toEqual({ settled: false });
    await service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1", true);
    await expect(parked).resolves.toBe(true);
    await service.dispose();
  });
});

describe("PiSessionService extension dialog signal", () => {
  it("dismisses the dialog with the cancel value when the extension aborts its signal", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const controller = new AbortController();
    const parked = ui.select("Pick a database", ["pg", "sqlite"], { signal: controller.signal });

    controller.abort();

    await expect(parked).resolves.toBeUndefined();
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events).map(({ event }) => event)).toEqual([
      { type: "dialog.opened", dialog: openDialog(events) },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "cancelled" },
    ]);
    await service.dispose();
  });
});

describe("PiSessionService extension dialog run end and teardown", () => {
  it("settles run-scoped dialogs as aborted on agent_end but leaves idle dialogs open", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    fake.session.isStreaming = true;
    const consent = ui.confirm("Run consent", "Allow this tool call?");
    fake.session.isStreaming = false;
    const idle = ui.input("Session note?");

    fake.emit({ type: "agent_end" });

    await expect(consent).resolves.toBe(false);
    await expect(settledValue(idle)).resolves.toEqual({ settled: false });
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([expect.objectContaining({ dialogId: "dialog-2" })]);
    expect(dialogEvents(events).map(({ event }) => event)).toMatchObject([
      { type: "dialog.opened", dialog: { dialogId: "dialog-1" } },
      { type: "dialog.opened", dialog: { dialogId: "dialog-2" } },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "aborted" },
    ]);
    await service.dispose();
  });

  it("settles every dialog as session-ended when the session closes", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    fake.session.isStreaming = true;
    const consent = ui.confirm("Run consent", "Allow this tool call?");
    fake.session.isStreaming = false;
    const idle = ui.input("Session note?");

    await service.stop(sessionRef(ACTIVE_SESSION_ID));

    await expect(consent).resolves.toBe(false);
    await expect(idle).resolves.toBeUndefined();
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events).map(({ event }) => event)).toMatchObject([
      { type: "dialog.opened", dialog: { dialogId: "dialog-1" } },
      { type: "dialog.opened", dialog: { dialogId: "dialog-2" } },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "session-ended" },
      { type: "dialog.closed", dialogId: "dialog-2", reason: "session-ended" },
    ]);
    await service.dispose();
  });

  it("settles every dialog as session-ended when the daemon disposes the session", async () => {
    const { service, store, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const parked = ui.confirm("Proceed?", "Really?");

    await service.dispose();

    await expect(parked).resolves.toBe(false);
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
  });

  it("settles the old runtime's dialogs as session-ended when the runtime is replaced", async () => {
    const { service, store, events, fake } = dialogService();
    const rebinds: ((session: PiAgentSession) => Promise<void>)[] = [];
    fake.runtime.setRebindSession = (fn) => {
      if (fn !== undefined) rebinds.push(fn);
    };
    const ui = await boundUiContext(service, fake);
    const parked = ui.confirm("Proceed?", "Really?");
    const replacement = fakeRuntime(ACTIVE_SESSION_ID);
    const rebind = rebinds[0];
    if (rebind === undefined) throw new Error("runtime replacement was not armed");

    await rebind(replacement.session);

    await expect(parked).resolves.toBe(false);
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events).map(({ event }) => event)).toEqual([
      { type: "dialog.opened", dialog: openDialog(events) },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "session-ended" },
    ]);
    // The replacement runtime is bound with a fresh UI context of its own.
    expect(replacement.calls.bindExtensions).toHaveLength(1);
    await service.dispose();
  });
});

describe("PiSessionService extension dialog abort request", () => {
  it("settles a parked run-scoped dialog as aborted when an abort is requested", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    fake.session.isStreaming = true;
    const consent = ui.confirm("Run consent", "Allow this tool call?");

    await service.abort(sessionRef(ACTIVE_SESSION_ID));

    await expect(consent).resolves.toBe(false);
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events).map(({ event }) => event)).toEqual([
      { type: "dialog.opened", dialog: openDialog(events) },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "aborted" },
    ]);
    const statuses = events.sessionEvents.flatMap(({ event }) => (event.type === "status.update" ? [event.status] : []));
    expect(statuses.at(-1)?.pendingDialogs).toBeUndefined();
    expect(fake.calls.abort).toBe(1);
    await service.dispose();
  });

  it("settles the dialog before the runtime abort completes, so a parked handler cannot deadlock it", async () => {
    const { service, store, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    fake.session.isStreaming = true;
    // Model pi's agent loop parked behind the dialog handler: the runtime
    // abort can only finish once the handler (and so the dialog) has ended.
    const healthyAbort: typeof fake.session.abort = () => Promise.resolve();
    let releaseAbort: (() => void) | undefined;
    fake.session.abort = () =>
      new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
    const consent = ui.confirm("Run consent", "Allow this tool call?");

    const aborting = service.abort(sessionRef(ACTIVE_SESSION_ID));

    await expect(consent).resolves.toBe(false);
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    if (releaseAbort === undefined) throw new Error("runtime abort was not requested");
    releaseAbort();
    await aborting;
    fake.session.abort = healthyAbort;
    await service.dispose();
  });

  it("settles the dialog even when the runtime abort itself fails", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    fake.session.isStreaming = true;
    const healthyAbort: typeof fake.session.abort = () => Promise.resolve();
    fake.session.abort = () => Promise.reject(new Error("abort blew up"));
    const consent = ui.confirm("Run consent", "Allow this tool call?");

    await expect(service.abort(sessionRef(ACTIVE_SESSION_ID))).rejects.toThrow("abort blew up");

    await expect(consent).resolves.toBe(false);
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    expect(dialogEvents(events).map(({ event }) => event)).toEqual([
      { type: "dialog.opened", dialog: openDialog(events) },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "aborted" },
    ]);
    fake.session.abort = healthyAbort;
    await service.dispose();
  });

  it("leaves idle-opened dialogs parked across an abort request", async () => {
    const { service, store, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    const idle = ui.input("Session note?");

    await service.abort(sessionRef(ACTIVE_SESSION_ID));

    await expect(settledValue(idle)).resolves.toEqual({ settled: false });
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([expect.objectContaining({ dialogId: "dialog-1" })]);
    expect(dialogEvents(events).map(({ event }) => event)).toEqual([
      { type: "dialog.opened", dialog: openDialog(events) },
    ]);
    await service.dispose();
  });

  it("does not close the dialog a second time when agent_end arrives after the abort", async () => {
    const { service, events, fake } = dialogService();
    const ui = await boundUiContext(service, fake);
    fake.session.isStreaming = true;
    const consent = ui.confirm("Run consent", "Allow this tool call?");

    await service.abort(sessionRef(ACTIVE_SESSION_ID));
    fake.emit({ type: "agent_end" });

    await expect(consent).resolves.toBe(false);
    expect(dialogEvents(events).map(({ event }) => event)).toEqual([
      { type: "dialog.opened", dialog: openDialog(events) },
      { type: "dialog.closed", dialogId: "dialog-1", reason: "aborted" },
    ]);
    await service.dispose();
  });
});

describe("PiSessionService extension dialog status projection", () => {
  it("reports open dialogs oldest first so a reloading browser rehydrates them", async () => {
    const { service, fake } = dialogService();
    const ui = await boundUiContext(service, fake);

    const before = await service.status(sessionRef(ACTIVE_SESSION_ID));
    void ui.confirm("Proceed?", "Really?");
    void ui.input("Branch name?");
    const during = await service.status(sessionRef(ACTIVE_SESSION_ID));
    await service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1", true);
    const after = await service.status(sessionRef(ACTIVE_SESSION_ID));

    expect(before.pendingDialogs).toBeUndefined();
    expect(during.pendingDialogs?.map((dialog) => dialog.dialogId)).toEqual(["dialog-1", "dialog-2"]);
    expect(after.pendingDialogs?.map((dialog) => dialog.dialogId)).toEqual(["dialog-2"]);
    await service.dispose();
  });
});

describe("PiSessionService session_start dialog startup reachability", () => {
  /**
   * A `session_start` dialog parks session construction before the session
   * ever becomes active: the bind below models the issue's probe by awaiting
   * a confirm inside extension binding. The dialog must stay reachable —
   * statusable and answerable — in that window, or startup could never be
   * unblocked from the browser.
   */
  function startupDialogService() {
    const harness = dialogService();
    const confirmAnswers: (boolean | string | undefined)[] = [];
    harness.fake.session.bindExtensions = (bindings) => {
      harness.fake.calls.bindExtensions.push(bindings);
      if (bindings.uiContext === undefined) return Promise.resolve();
      return bindings.uiContext.confirm("Proceed at startup?", "Really?").then((answer) => {
        confirmAnswers.push(answer);
      });
    };
    return { ...harness, confirmAnswers };
  }

  async function parkOnStartupDialog(store: PendingExtensionDialogStore): Promise<void> {
    await vi.waitFor(() => {
      expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toHaveLength(1);
    });
  }

  it("serves status for a session still parked on a session_start dialog", async () => {
    const { service, store } = startupDialogService();
    const started = service.start("/workspace");
    await parkOnStartupDialog(store);

    const status = await service.status(sessionRef(ACTIVE_SESSION_ID));

    expect(status.pendingDialogs).toEqual([
      expect.objectContaining({ dialogId: "dialog-1", kind: "confirm", title: "Proceed at startup?", runScoped: false }),
    ]);
    await service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1", true);
    await started;
    await service.dispose();
  });

  it("answers a session_start dialog mid-startup so creation can finish", async () => {
    const { service, store, confirmAnswers } = startupDialogService();
    const started = service.start("/workspace");
    await parkOnStartupDialog(store);

    const response = await service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1", true);

    expect(response.result).toBe("closed");
    expect(response.outcome).toMatchObject({ dialogId: "dialog-1", reason: "answered", answer: true });
    expect(response.sessionStatus.pendingDialogs ?? []).toEqual([]);
    const created = await started;
    expect(created.id).toBe(ACTIVE_SESSION_ID);
    expect(confirmAnswers).toEqual([true]);
    expect(store.pendingDialogs(ACTIVE_SESSION_ID)).toEqual([]);
    // Readiness handed the session to the active path: a repeat answer races
    // lost against the already-closed dialog instead of erroring.
    const repeat = await service.answerDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1", true);
    expect(repeat.result).toBe("stale");
    await service.dispose();
  });

  it("cancels a session_start dialog mid-startup with the kind's cancel value", async () => {
    const { service, store, confirmAnswers } = startupDialogService();
    const started = service.start("/workspace");
    await parkOnStartupDialog(store);

    const response = await service.cancelDialog(sessionRef(ACTIVE_SESSION_ID), "dialog-1");

    expect(response.result).toBe("closed");
    expect(response.outcome).toMatchObject({ dialogId: "dialog-1", reason: "cancelled" });
    await started;
    expect(confirmAnswers).toEqual([false]);
    await service.dispose();
  });

  it("dispose settles a startup-parked dialog instead of blocking behind its timeout", async () => {
    const { service, store, events, confirmAnswers } = startupDialogService();
    // The open flow registers in pendingSessionOpens, which dispose awaits:
    // without settling the dialog first, disposal would ride its timeout.
    const opening = service.messages(sessionRef(ACTIVE_SESSION_ID));
    await parkOnStartupDialog(store);

    await service.dispose();

    expect(confirmAnswers).toEqual([false]);
    const closedEvents = dialogEvents(events).filter(({ event }) => event.type === "dialog.closed");
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]?.event).toMatchObject({ dialogId: "dialog-1", reason: "session-ended" });
    // The released open completed inside dispose's awaited window; the late
    // messages read neither hangs nor rejects the test run.
    await Promise.allSettled([opening]);
  });

  it("closing a session whose open is parked on a session_start dialog settles the dialog first", async () => {
    const { service, store, events, confirmAnswers } = startupDialogService();
    const opening = service.messages(sessionRef(ACTIVE_SESSION_ID));
    await parkOnStartupDialog(store);

    await service.stop(sessionRef(ACTIVE_SESSION_ID));

    expect(confirmAnswers).toEqual([false]);
    const closedEvents = dialogEvents(events).filter(({ event }) => event.type === "dialog.closed");
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]?.event).toMatchObject({ dialogId: "dialog-1", reason: "session-ended" });
    await Promise.allSettled([opening]);
    await service.dispose();
  });
});
