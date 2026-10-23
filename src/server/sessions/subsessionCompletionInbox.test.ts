import { describe, expect, it } from "vitest";
import {
  completionReceiptIds,
  persistedSubsessionCompletions,
  renderSubsessionCompletions,
  SUBSESSION_COMPLETION_ENTRY_TYPE,
  SUBSESSION_NOTIFICATION_CUSTOM_TYPE,
  SUBSESSION_RECEIPT_ENTRY_TYPE,
  SubsessionCompletionInbox,
  type SubsessionCompletion,
} from "./subsessionCompletionInbox.js";

function completion(overrides: Partial<SubsessionCompletion> = {}): SubsessionCompletion {
  return {
    completionId: "child-1:run-1",
    sessionId: "child-1",
    cwd: "/workspace",
    status: "idle",
    finalText: "all done",
    messageCount: 3,
    ...overrides,
  };
}

function completionEntry(data: unknown) {
  return { type: "custom", customType: SUBSESSION_COMPLETION_ENTRY_TYPE, data };
}

function receiptEntry(completionIds: readonly string[]) {
  return { type: "custom", customType: SUBSESSION_RECEIPT_ENTRY_TYPE, data: { completionIds } };
}

describe("SubsessionCompletionInbox", () => {
  it("keeps pending and latest inspection non-acknowledging", () => {
    const inbox = new SubsessionCompletionInbox();
    const result = completion();

    expect(inbox.pending()).toEqual([]);
    expect(inbox.latest(result.sessionId)).toBeUndefined();
    inbox.record(result);

    expect(inbox.pending()).toEqual([result]);
    expect(inbox.latest(result.sessionId)).toEqual(result);
    expect(inbox.latest("other-child")).toBeUndefined();
    expect(inbox.pending()).toEqual([result]);
  });

  it("claims unread results once and allows later arrivals to be claimed separately", () => {
    const inbox = new SubsessionCompletionInbox();
    const first = completion();
    const second = completion({ completionId: "child-2:run-1", sessionId: "child-2" });
    inbox.record(first);

    expect(inbox.claim()).toEqual([first]);
    expect(inbox.pending()).toEqual([]);
    expect(inbox.claim()).toEqual([]);

    inbox.record(second);
    expect(inbox.pending()).toEqual([second]);
    expect(inbox.claim()).toEqual([second]);
    expect(inbox.claim()).toEqual([]);

    inbox.releaseClaims();
    expect(inbox.pending()).toEqual([first, second]);
    expect(inbox.claim()).toEqual([first, second]);
  });

  it("acknowledges only the named completion and retries unreceived claims", () => {
    const inbox = new SubsessionCompletionInbox();
    const first = completion();
    const second = completion({ completionId: "child-2:run-1", sessionId: "child-2" });
    inbox.record(first);
    inbox.record(second);
    inbox.claim();

    inbox.receive([first.completionId]);
    inbox.receive([first.completionId]);
    expect(inbox.pending()).toEqual([]);

    inbox.releaseClaims();
    expect(inbox.pending()).toEqual([second]);
    expect(inbox.claim()).toEqual([second]);
    inbox.receive([second.completionId]);
    inbox.releaseClaims();
    expect(inbox.claim()).toEqual([]);
  });

  it("retains the latest result for explicit retrieval after direct acknowledgment without replay", () => {
    const inbox = new SubsessionCompletionInbox();
    const result = completion();
    inbox.record(result);

    // A completed check can acknowledge the result without an automatic-delivery claim.
    inbox.receive([result.completionId]);
    expect(inbox.latest(result.sessionId)).toEqual(result);
    expect(inbox.pending()).toEqual([]);
    inbox.record(result);
    inbox.releaseClaims();
    expect(inbox.pending()).toEqual([]);
    expect(inbox.claim()).toEqual([]);
  });

  it("keeps later runs of one child distinct from a claimed or received earlier run", () => {
    const inbox = new SubsessionCompletionInbox();
    const first = completion();
    const later = completion({
      completionId: "child-1:run-2",
      status: "error",
      finalText: "second run output",
      messageCount: 7,
      errorDetail: "second run failed",
    });
    inbox.record(first);
    const firstDelivery = inbox.claim();
    inbox.record(later);

    expect(firstDelivery).toEqual([first]);
    expect(inbox.latest(first.sessionId)).toEqual(later);
    expect(inbox.pending()).toEqual([later]);
    inbox.receive([first.completionId]);
    inbox.releaseClaims();
    expect(inbox.claim()).toEqual([later]);
    inbox.receive([later.completionId]);
    expect(inbox.pending()).toEqual([]);
    expect(inbox.latest(first.sessionId)).toEqual(later);

    const newest = completion({ completionId: "child-1:run-3", finalText: "third run output" });
    inbox.record(newest);
    expect(inbox.pending()).toEqual([newest]);
    expect(inbox.latest(first.sessionId)).toEqual(newest);
  });

  it("honors restored receipts even when completed results are loaded afterward", () => {
    const inbox = new SubsessionCompletionInbox();
    const result = completion();
    inbox.restoreReceipts([receiptEntry([result.completionId])]);
    inbox.record(result);

    expect(inbox.claim()).toEqual([]);
    expect(inbox.latest(result.sessionId)).toEqual(result);
  });

  it("restores receipts from the active parent branch and clears abandoned claims", () => {
    const inbox = new SubsessionCompletionInbox();
    const first = completion();
    const second = completion({ completionId: "child-1:run-2", finalText: "later answer" });
    const third = completion({ completionId: "child-2:run-1", sessionId: "child-2" });
    inbox.record(first);
    inbox.record(second);
    inbox.record(third);
    inbox.receive([third.completionId]);
    inbox.claim();
    const explicitReceipt = receiptEntry([first.completionId]);
    const automaticReceipt = {
      type: "custom_message",
      customType: SUBSESSION_NOTIFICATION_CUSTOM_TYPE,
      details: { completionIds: [second.completionId] },
    };

    inbox.restoreReceipts([explicitReceipt, automaticReceipt]);
    expect(inbox.pending()).toEqual([third]);
    expect(inbox.latest(first.sessionId)).toEqual(second);

    // Rewinding before the automatic notice makes only its receipt disappear.
    inbox.restoreReceipts([explicitReceipt]);
    expect(inbox.pending()).toEqual([second, third]);
    inbox.restoreReceipts([]);
    expect(inbox.pending()).toEqual([first, second, third]);
  });

  it.each(["missing", "failed", "preceding", "committed"])("restores a tool-bound receipt only with its successful committed result (%s)", (state) => {
    const inbox = new SubsessionCompletionInbox();
    const result = completion();
    inbox.record(result);
    const receipt = { ...receiptEntry([result.completionId]), data: { completionIds: [result.completionId], toolCallId: "check-1" } };
    const toolResult = { type: "message", message: { role: "toolResult", toolCallId: "check-1", isError: state === "failed" } };
    const entries = state === "missing" ? [receipt] : state === "preceding" ? [toolResult, receipt] : [receipt, toolResult];
    inbox.restoreReceipts(entries);
    expect(inbox.pending()).toEqual(state === "committed" ? [] : [result]);
  });

  it.each(["ok", "error", "unfinished"])("restores a nested inspection receipt through its enclosing result (%s)", (status) => {
    const inbox = new SubsessionCompletionInbox();
    const result = completion();
    inbox.record(result);
    inbox.restoreReceipts([
      { ...receiptEntry([result.completionId]), data: { completionIds: [result.completionId], toolCallId: "script/0" } },
      { type: "message", message: { role: "toolResult", toolCallId: "script", isError: false, nestedCalls: { calls: [{ id: "script/0", status }] } } },
    ]);
    expect(inbox.pending()).toEqual(status === "ok" ? [] : [result]);
  });

  it("can reconcile receipt intents without releasing in-flight delivery claims", () => {
    const inbox = new SubsessionCompletionInbox();
    const result = completion();
    inbox.record(result);
    inbox.claim();
    inbox.restoreReceipts([], false);
    expect(inbox.pending()).toEqual([]);
    inbox.restoreReceipts([]);
    expect(inbox.pending()).toEqual([result]);
  });

  it("releases only the specified claim and discards a removed child's results", () => {
    const inbox = new SubsessionCompletionInbox();
    const first = completion();
    const other = completion({ completionId: "other-run", sessionId: "child-2" });
    inbox.record(first);
    inbox.record(other);
    inbox.claim();
    inbox.release([first.completionId]);
    expect(inbox.pending()).toEqual([first]);
    inbox.forgetChild(first.sessionId);
    inbox.releaseClaims();
    expect(inbox.pending()).toEqual([other]);
    expect(inbox.latest(first.sessionId)).toBeUndefined();
  });

  it("ignores unrelated, legacy, and malformed branch entries instead of inventing receipts", () => {
    const inbox = new SubsessionCompletionInbox();
    const result = completion();
    inbox.record(result);
    const ids = { completionIds: [result.completionId] };

    inbox.restoreReceipts([
      null,
      [],
      completionEntry(ids),
      { type: "custom", customType: SUBSESSION_NOTIFICATION_CUSTOM_TYPE, data: ids },
      { type: "custom_message", customType: SUBSESSION_RECEIPT_ENTRY_TYPE, details: ids },
      { type: "message", details: ids },
      { type: "custom", customType: SUBSESSION_RECEIPT_ENTRY_TYPE, data: { completionIds: result.completionId } },
      { type: "custom_message", customType: SUBSESSION_NOTIFICATION_CUSTOM_TYPE, details: { sessionId: result.sessionId } },
    ]);

    expect(inbox.pending()).toEqual([result]);
  });
});

describe("completionReceiptIds", () => {
  it("extracts only string completion ids from an untyped receipt", () => {
    expect(completionReceiptIds({ completionIds: ["child-1:run-1", 1, null, {}, "child-2:run-1"] }))
      .toEqual(["child-1:run-1", "child-2:run-1"]);
    for (const value of [undefined, null, [], "receipt", {}, { completionIds: "child-1:run-1" }]) {
      expect(completionReceiptIds(value)).toEqual([]);
    }
  });
});

describe("persistedSubsessionCompletions", () => {
  it("recovers separate completed runs and applies parent receipts without losing explicit retrieval", () => {
    const first = completion({ finalText: "", messageCount: 0 });
    const later = completion({ completionId: "child-1:run-2", status: "error", errorDetail: "provider failed" });
    const recovered = persistedSubsessionCompletions([completionEntry(first), completionEntry(later)]);
    expect(recovered).toEqual([first, later]);

    const inbox = new SubsessionCompletionInbox();
    for (const result of recovered) inbox.record(result);
    inbox.restoreReceipts([receiptEntry([first.completionId])]);
    expect(inbox.pending()).toEqual([later]);
    expect(inbox.latest(first.sessionId)).toEqual(later);
  });

  it("ignores malformed records and entries that are not persisted completions", () => {
    const valid = completion();
    const entry = completionEntry(valid);
    expect(persistedSubsessionCompletions([
      undefined,
      null,
      [],
      1,
      {},
      { ...entry, type: "custom_message" },
      { ...entry, customType: SUBSESSION_RECEIPT_ENTRY_TYPE },
      completionEntry(null),
      completionEntry([]),
      entry,
    ])).toEqual([valid]);
  });

  it.each([
    { field: "completionId", invalid: 1 },
    { field: "sessionId", invalid: null },
    { field: "cwd", invalid: [] },
    { field: "status", invalid: "working" },
    { field: "status", invalid: "unknown" },
    { field: "status", invalid: "finished" },
    { field: "finalText", invalid: {} },
    { field: "messageCount", invalid: "3" },
    { field: "messageCount", invalid: -1 },
    { field: "messageCount", invalid: 1.5 },
    { field: "messageCount", invalid: Number.POSITIVE_INFINITY },
  ])("rejects a missing or invalid $field ($invalid)", ({ field, invalid }) => {
    const data: Record<string, unknown> = { ...completion() };
    data[field] = undefined;
    expect(persistedSubsessionCompletions([completionEntry(data)])).toEqual([]);

    data[field] = invalid;
    expect(persistedSubsessionCompletions([completionEntry(data)])).toEqual([]);
  });

  it("keeps only completion fields and ignores a non-string optional error detail", () => {
    const valid = completion();
    expect(persistedSubsessionCompletions([
      completionEntry({ ...valid, errorDetail: { message: "not a string" }, unrelated: true }),
    ])).toEqual([valid]);
  });
});

describe("renderSubsessionCompletions", () => {
  it("returns completed output with a no-other-children status", () => {
    expect(renderSubsessionCompletions([completion()], [])).toBe([
      "Subsession child-1 stopped working (idle).",
      "",
      "--- SUBSESSION OUTPUT: child-1 ---",
      "all done",
      "",
      "No other tracked subsessions are working.",
    ].join("\n"));
  });

  it("identifies errors separately from output and names children still working without polling", () => {
    const failed = completion({ completionId: "child-2:run-1", sessionId: "child-2", status: "error", finalText: "partial answer", errorDetail: "provider failed" });
    expect(renderSubsessionCompletions([completion({ finalText: "" }), failed], ["child-3", "child-4"])).toBe([
      "Subsession child-1 stopped working (idle).",
      "",
      "--- SUBSESSION OUTPUT: child-1 ---",
      "(no output)",
      "",
      "Subsession child-2 stopped working (error).",
      "",
      "Error: provider failed",
      "",
      "--- SUBSESSION OUTPUT: child-2 ---",
      "partial answer",
      "",
      "Still working: child-3, child-4. Continue working, or call yield_to_subsessions alone and last at the next join point. Further unread results arrive automatically; do not poll.",
    ].join("\n"));
  });

  it("applies the 2000-character notice limit to each result, not the whole batch", () => {
    const first = completion({ finalText: "x".repeat(2000) });
    const second = completion({ completionId: "child-2:run-1", sessionId: "child-2", finalText: "y".repeat(2000) });
    const rendered = renderSubsessionCompletions([first, second], []);
    expect(rendered).toContain(`--- SUBSESSION OUTPUT: child-1 ---\n${first.finalText}`);
    expect(rendered).toContain(`--- SUBSESSION OUTPUT: child-2 ---\n${second.finalText}`);
    expect(rendered).not.toContain("was omitted");
  });

  it("omits oversized output entirely, preserves errors, and retains the full result for explicit retrieval", () => {
    const inbox = new SubsessionCompletionInbox();
    const result = completion({ finalText: `ANSWER${"x".repeat(1995)}`, status: "error", errorDetail: "provider failed" });
    inbox.record(result);
    const delivery = inbox.claim();
    const rendered = renderSubsessionCompletions(delivery, []);

    expect(rendered).toContain("Subsession child-1 stopped working (error).");
    expect(rendered).toContain("Error: provider failed");
    expect(rendered).toContain('Output from subsession child-1 was too long for this completion notice and was omitted. Call check_subsession with sessionId "child-1" to retrieve the final output.');
    expect(rendered).not.toContain("--- SUBSESSION OUTPUT:");
    expect(rendered).not.toContain("ANSWER");
    inbox.receive(delivery.map(({ completionId }) => completionId));
    expect(inbox.pending()).toEqual([]);
    expect(inbox.latest(result.sessionId)).toEqual(result);
  });
});
