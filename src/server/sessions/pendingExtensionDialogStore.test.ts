import { describe, expect, it } from "vitest";
import {
  EXTENSION_DIALOG_INPUT_MAX_LENGTH,
  EXTENSION_DIALOG_OPTION_LIMIT,
  type ExtensionDialogAnswer,
} from "../../shared/apiTypes.js";
import {
  PendingExtensionDialogStore,
  PendingExtensionDialogValidationError,
  type ExtensionDialogCancelReason,
} from "./pendingExtensionDialogStore.js";

const sessionId = "session-1";

function testStore(createDialogId?: () => string) {
  let dialogCount = 0;
  let tick = 0;
  return new PendingExtensionDialogStore({
    createDialogId: createDialogId ?? (() => `dialog-${(++dialogCount).toString()}`),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}

describe("PendingExtensionDialogStore open", () => {
  it("normalizes a confirm dialog and reports it among the session's pending dialogs", () => {
    const store = testStore();

    const dialog = store.open({
      sessionId,
      kind: "confirm",
      title: "Deploy to production?",
      message: "This will restart the service.",
      timeoutMs: 300_000,
      runScoped: true,
    });

    expect(dialog).toEqual({
      dialogId: "dialog-1",
      kind: "confirm",
      title: "Deploy to production?",
      message: "This will restart the service.",
      askedAt: "2026-01-01T00:00:00.000Z",
      timeoutAt: "2026-01-01T00:05:00.000Z",
      runScoped: true,
    });
    expect(store.pendingDialogs(sessionId)).toEqual([dialog]);
    expect(store.pendingDialogs("other-session")).toEqual([]);
  });

  it("keeps several dialogs of one session open, oldest first, without superseding", () => {
    const store = testStore();

    const confirm = store.open({ sessionId, kind: "confirm", title: "Proceed?", runScoped: true });
    const select = store.open({ sessionId, kind: "select", title: "Pick a branch", options: ["main", "dev"], runScoped: false });
    const input = store.open({ sessionId, kind: "input", title: "Commit name", placeholder: "feat: …", runScoped: false });

    expect(store.pendingDialogs(sessionId)).toEqual([confirm, select, input]);
    expect(select).toEqual({
      dialogId: "dialog-2",
      kind: "select",
      title: "Pick a branch",
      options: ["main", "dev"],
      askedAt: "2026-01-01T00:00:01.000Z",
      runScoped: false,
    });
    expect(input).toEqual({
      dialogId: "dialog-3",
      kind: "input",
      title: "Commit name",
      placeholder: "feat: …",
      askedAt: "2026-01-01T00:00:02.000Z",
      runScoped: false,
    });
  });

  it("keeps each session's dialogs separate", () => {
    const store = testStore();
    store.open({ sessionId, kind: "confirm", title: "One?", runScoped: false });
    store.open({ sessionId: "session-2", kind: "confirm", title: "Two?", runScoped: false });
    store.open({ sessionId: "session-2", kind: "confirm", title: "Three?", runScoped: false });

    expect(store.pendingDialogs(sessionId).map((dialog) => dialog.title)).toEqual(["One?"]);
    expect(store.pendingDialogs("session-2").map((dialog) => dialog.title)).toEqual(["Two?", "Three?"]);
  });

  it("omits timeoutAt when no timeout applies and drops blank cosmetic fields", () => {
    const store = testStore();

    const dialog = store.open({ sessionId, kind: "confirm", title: "Sure?", message: "   ", runScoped: false });

    expect(dialog).toEqual({
      dialogId: "dialog-1",
      kind: "confirm",
      title: "Sure?",
      askedAt: "2026-01-01T00:00:00.000Z",
      runScoped: false,
    });
    expect(dialog).not.toHaveProperty("timeoutAt");
    expect(dialog).not.toHaveProperty("message");
  });

  it("drops fields that do not belong to the dialog's kind", () => {
    const store = testStore();

    const select = store.open({
      sessionId,
      kind: "select",
      title: "Pick",
      options: ["a"],
      message: "not a confirm field",
      placeholder: "not an input field",
      runScoped: false,
    });
    const input = store.open({
      sessionId,
      kind: "input",
      title: "Type",
      options: ["a"],
      runScoped: false,
    });

    expect(select).not.toHaveProperty("message");
    expect(select).not.toHaveProperty("placeholder");
    expect(input).not.toHaveProperty("options");
    expect(input).not.toHaveProperty("placeholder");
  });

  it("rejects dialogs the user could not meaningfully answer", () => {
    const store = testStore();
    const open = (overrides: Record<string, unknown>) => () =>
      store.open({ sessionId, kind: "confirm", title: "Ok?", runScoped: false, ...overrides });

    expect(open({ title: "  " })).toThrow(/dialog title must not be empty/);
    expect(open({ kind: "widget" })).toThrow(/Unknown dialog kind widget/);
    expect(open({ kind: "select", options: undefined })).toThrow(/at least one option/);
    expect(open({ kind: "select", options: [] })).toThrow(/at least one option/);
    expect(open({ kind: "select", options: ["a", "a"] })).toThrow(/Duplicate select option a/);
    expect(open({ kind: "select", options: ["  "] })).toThrow(/select option must not be empty/);
    expect(open({
      kind: "select",
      options: Array.from({ length: EXTENSION_DIALOG_OPTION_LIMIT + 1 }, (_, index) => `v${index.toString()}`),
    })).toThrow(/more than 24 options/);
    expect(open({ timeoutMs: 0 })).toThrow(PendingExtensionDialogValidationError);
    expect(open({ timeoutMs: -5 })).toThrow(PendingExtensionDialogValidationError);
    expect(open({ timeoutMs: Number.NaN })).toThrow(PendingExtensionDialogValidationError);
    expect(store.pendingDialogs(sessionId)).toEqual([]);
  });

  it("rejects an open whose id collides with a still-open dialog", () => {
    const store = testStore(() => "dialog-x");
    store.open({ sessionId, kind: "confirm", title: "First?", runScoped: false });

    expect(() => store.open({ sessionId, kind: "confirm", title: "Second?", runScoped: false }))
      .toThrow(/already open/);
    expect(store.pendingDialogs(sessionId).map((dialog) => dialog.title)).toEqual(["First?"]);
  });
});

describe("PendingExtensionDialogStore answer", () => {
  it("closes a confirm dialog with the user's boolean answer", () => {
    const store = testStore();
    store.open({ sessionId, kind: "confirm", title: "Proceed?", runScoped: true });

    const result = store.answer(sessionId, "dialog-1", true);

    expect(result).toEqual({
      status: "closed",
      outcome: {
        dialogId: "dialog-1",
        reason: "answered",
        answer: true,
        askedAt: "2026-01-01T00:00:00.000Z",
        closedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    expect(store.pendingDialogs(sessionId)).toEqual([]);
  });

  it("closes a select dialog with the chosen option and an input dialog with the typed text", () => {
    const store = testStore();
    store.open({ sessionId, kind: "select", title: "Pick", options: ["main", "dev"], runScoped: false });
    store.open({ sessionId, kind: "input", title: "Name", runScoped: false });

    const selected = store.answer(sessionId, "dialog-1", "dev");
    const typed = store.answer(sessionId, "dialog-2", "feat: dialogs");

    expect(selected).toMatchObject({ status: "closed", outcome: { reason: "answered", answer: "dev" } });
    expect(typed).toMatchObject({ status: "closed", outcome: { reason: "answered", answer: "feat: dialogs" } });
  });

  it("accepts an empty string as an input answer, distinct from cancelling", () => {
    const store = testStore();
    store.open({ sessionId, kind: "input", title: "Name", runScoped: false });

    const result = store.answer(sessionId, "dialog-1", "");

    expect(result).toMatchObject({ status: "closed", outcome: { reason: "answered", answer: "" } });
  });

  it("rejects answers that do not fit the dialog's kind and keeps the dialog open", () => {
    const store = testStore();
    store.open({ sessionId, kind: "confirm", title: "Sure?", runScoped: false });
    store.open({ sessionId, kind: "select", title: "Pick", options: ["a", "b"], runScoped: false });
    store.open({ sessionId, kind: "input", title: "Type", runScoped: false });
    const answer = (dialogId: string, value: ExtensionDialogAnswer) => () => store.answer(sessionId, dialogId, value);

    expect(answer("dialog-1", "yes")).toThrow(/expects a boolean answer/);
    expect(answer("dialog-2", true)).toThrow(/has no option true/);
    expect(answer("dialog-2", "c")).toThrow(/has no option c/);
    expect(answer("dialog-3", false)).toThrow(/expects a text answer/);
    expect(answer("dialog-3", "x".repeat(EXTENSION_DIALOG_INPUT_MAX_LENGTH + 1))).toThrow(/exceeds its length limit/);
    expect(store.pendingDialogs(sessionId).map((dialog) => dialog.dialogId)).toEqual(["dialog-1", "dialog-2", "dialog-3"]);
  });

  it("treats an answer for a dialog that is no longer open as stale", () => {
    const store = testStore();
    store.open({ sessionId, kind: "confirm", title: "Sure?", runScoped: false });

    expect(store.answer(sessionId, "dialog-other", true)).toEqual({ status: "stale" });
    expect(store.answer("session-2", "dialog-1", true)).toEqual({ status: "stale" });

    store.answer(sessionId, "dialog-1", false);
    expect(store.answer(sessionId, "dialog-1", true)).toEqual({ status: "stale" });
  });
});

describe("PendingExtensionDialogStore cancel", () => {
  it("closes a dialog without an answer for every cancel reason", () => {
    const store = testStore();
    const reasons: ExtensionDialogCancelReason[] = ["cancelled", "timeout", "aborted", "session-ended"];

    for (const reason of reasons) {
      const dialog = store.open({ sessionId, kind: "confirm", title: `${reason}?`, runScoped: false });
      const result = store.cancel(sessionId, dialog.dialogId, reason);
      if (result.status !== "closed") throw new Error("expected the dialog to close");
      const { closedAt, ...outcome } = result.outcome;
      expect(closedAt).toEqual(expect.any(String));
      expect(outcome).toEqual({ dialogId: dialog.dialogId, reason, askedAt: dialog.askedAt });
      expect(result.outcome).not.toHaveProperty("answer");
    }
    expect(store.pendingDialogs(sessionId)).toEqual([]);
  });

  it("closes only the named dialog and keeps the rest in order", () => {
    const store = testStore();
    store.open({ sessionId, kind: "confirm", title: "One?", runScoped: false });
    store.open({ sessionId, kind: "confirm", title: "Two?", runScoped: false });
    store.open({ sessionId, kind: "confirm", title: "Three?", runScoped: false });

    store.cancel(sessionId, "dialog-2", "cancelled");
    expect(store.pendingDialogs(sessionId).map((dialog) => dialog.dialogId)).toEqual(["dialog-1", "dialog-3"]);

    store.answer(sessionId, "dialog-1", true);
    expect(store.pendingDialogs(sessionId).map((dialog) => dialog.dialogId)).toEqual(["dialog-3"]);
  });

  it("records the close time, not the open time, as closedAt", () => {
    const store = testStore();
    store.open({ sessionId, kind: "confirm", title: "Sure?", runScoped: false });

    const result = store.cancel(sessionId, "dialog-1", "timeout");

    expect(result).toMatchObject({
      status: "closed",
      outcome: { askedAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-01T00:00:01.000Z" },
    });
  });

  it("treats a cancel for a dialog that is no longer open as stale", () => {
    const store = testStore();
    store.open({ sessionId, kind: "confirm", title: "Sure?", runScoped: false });

    expect(store.cancel(sessionId, "dialog-other", "cancelled")).toEqual({ status: "stale" });
    expect(store.cancel("session-2", "dialog-1", "cancelled")).toEqual({ status: "stale" });

    store.cancel(sessionId, "dialog-1", "aborted");
    expect(store.cancel(sessionId, "dialog-1", "cancelled")).toEqual({ status: "stale" });
  });
});
