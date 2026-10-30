import type { SubsessionStatus } from "./spawnSubsessionTool.js";

export const SUBSESSION_COMPLETION_ENTRY_TYPE = "pi-web.subsession.completed";
export const SUBSESSION_RECEIPT_ENTRY_TYPE = "pi-web.subsession.received";
export const SUBSESSION_NOTIFICATION_CUSTOM_TYPE = "subsession.completion";

/** Immutable result of one child run, not the child's mutable current status. */
export interface SubsessionCompletion {
  completionId: string;
  sessionId: string;
  cwd: string;
  status: Exclude<SubsessionStatus, "working" | "unknown">;
  finalText: string;
  messageCount: number;
  errorDetail?: string;
}

/** One owner for delivery through tools, run boundaries, and idle-parent wakes. */
export class SubsessionCompletionInbox {
  private readonly completions = new Map<string, SubsessionCompletion>();
  private readonly received = new Set<string>();
  private readonly claimed = new Set<string>();

  record(completion: SubsessionCompletion): void {
    this.completions.set(completion.completionId, completion);
  }

  latest(sessionId: string): SubsessionCompletion | undefined {
    let latest: SubsessionCompletion | undefined;
    for (const completion of this.completions.values()) {
      if (completion.sessionId === sessionId) latest = completion;
    }
    return latest;
  }

  pending(): SubsessionCompletion[] {
    return [...this.completions.values()].filter(({ completionId }) => !this.received.has(completionId) && !this.claimed.has(completionId));
  }

  claim(): SubsessionCompletion[] {
    const pending = this.pending();
    for (const { completionId } of pending) this.claimed.add(completionId);
    return pending;
  }

  receive(completionIds: readonly string[]): void {
    for (const id of completionIds) {
      this.received.add(id);
      this.claimed.delete(id);
    }
  }

  hasReceived(completionId: string): boolean {
    return this.received.has(completionId);
  }

  release(completionIds: readonly string[]): void {
    for (const id of completionIds) this.claimed.delete(id);
  }

  releaseClaims(): void {
    this.claimed.clear();
  }

  forgetChild(sessionId: string): void {
    for (const [id, completion] of this.completions) {
      if (completion.sessionId !== sessionId) continue;
      this.completions.delete(id);
      this.received.delete(id);
      this.claimed.delete(id);
    }
  }

  /** Receipts follow the active parent branch; rewinding before a receipt restores unread results. */
  restoreReceipts(entries: readonly unknown[], releaseClaims = true): void {
    this.received.clear();
    if (releaseClaims) this.claimed.clear();
    const toolResults = new Map<string, number>();
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry) || entry["type"] !== "message" || !isRecord(entry["message"])) continue;
      const message = entry["message"];
      if (message["role"] === "toolResult" && message["isError"] !== true && typeof message["toolCallId"] === "string") {
        toolResults.set(message["toolCallId"], index);
        const nested = message["nestedCalls"];
        if (isRecord(nested) && Array.isArray(nested["calls"])) {
          for (const call of nested["calls"]) {
            if (isRecord(call) && call["status"] === "ok" && typeof call["id"] === "string") toolResults.set(call["id"], index);
          }
        }
      }
    }
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry)) continue;
      if (entry["type"] === "custom" && entry["customType"] === SUBSESSION_RECEIPT_ENTRY_TYPE) {
        const data = entry["data"];
        // A tool receipt only counts after its successful result was committed.
        // A crash, failed result write, or rewind between them must not lose an answer.
        if (isRecord(data) && typeof data["toolCallId"] === "string" && (toolResults.get(data["toolCallId"]) ?? -1) <= index) continue;
        this.receive(completionReceiptIds(data));
      } else if (entry["type"] === "custom_message" && entry["customType"] === SUBSESSION_NOTIFICATION_CUSTOM_TYPE) {
        this.receive(completionReceiptIds(entry["details"]));
      }
    }
  }
}

export function completionReceiptIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["completionIds"])) return [];
  return value["completionIds"].filter((id): id is string => typeof id === "string");
}

export function persistedSubsessionCompletions(entries: readonly unknown[]): SubsessionCompletion[] {
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== SUBSESSION_COMPLETION_ENTRY_TYPE) return [];
    const data = entry["data"];
    if (!isRecord(data) || typeof data["completionId"] !== "string" || typeof data["sessionId"] !== "string"
      || typeof data["cwd"] !== "string" || (data["status"] !== "idle" && data["status"] !== "error")
      || typeof data["finalText"] !== "string" || typeof data["messageCount"] !== "number"
      || !Number.isSafeInteger(data["messageCount"]) || data["messageCount"] < 0) return [];
    return [{
      completionId: data["completionId"], sessionId: data["sessionId"], cwd: data["cwd"], status: data["status"],
      finalText: data["finalText"], messageCount: data["messageCount"],
      ...(typeof data["errorDetail"] === "string" ? { errorDetail: data["errorDetail"] } : {}),
    }];
  });
}

/** Delivery reports runtime facts, not whether the child's task succeeded. */
export type SubsessionLifecycleNotice = Pick<SubsessionCompletion, "completionId" | "sessionId" | "status">;

export function subsessionLifecycleNotice({ completionId, sessionId, status }: SubsessionCompletion): SubsessionLifecycleNotice {
  return { completionId, sessionId, status };
}

export function renderSubsessionCompletion({ sessionId, status }: SubsessionLifecycleNotice): string {
  return status === "idle" ? `Subsession ${sessionId} is now idle.` : `Subsession ${sessionId} stopped with error.`;
}

export function renderSubsessionCompletions(completions: readonly SubsessionLifecycleNotice[], workingIds: readonly string[]): string {
  const next = workingIds.length === 0
    ? "No other tracked subsessions are working."
    : `Still working: ${workingIds.join(", ")}. Continue working, or call yield_to_subsessions alone and last at the next join point. Further lifecycle notices arrive automatically; do not poll.`;
  return `${completions.map(renderSubsessionCompletion).join("\n\n")}\n\n${next}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
