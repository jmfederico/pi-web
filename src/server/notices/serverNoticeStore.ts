import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue, ServerNotice, ServerNoticeSeverity, ServerNoticeSnapshot } from "../../shared/apiTypes.js";

export interface ServerNoticeInput {
  severity: ServerNoticeSeverity;
  message: string;
  source?: string;
  context?: JsonObject;
}

export interface ServerNoticeStoreOptions {
  daemonInstanceId?: string;
  now?: () => Date;
  createNoticeId?: () => string;
}

export interface ServerNoticeRecordResult {
  notice: ServerNotice;
  snapshot: ServerNoticeSnapshot;
}

export interface ServerNoticeDismissResult {
  snapshot: ServerNoticeSnapshot;
  dismissed: boolean;
}

/**
 * Current server-owned application notices for one session-daemon instance.
 *
 * The store intentionally has no deduplication or history: every record call
 * is one event occurrence, and dismissal removes only the requested id.
 */
export class ServerNoticeStore {
  readonly daemonInstanceId: string;
  private readonly now: () => Date;
  private readonly createNoticeId: () => string;
  private readonly notices = new Map<string, ServerNotice>();
  private revision = 0;

  constructor(options: ServerNoticeStoreOptions = {}) {
    this.daemonInstanceId = options.daemonInstanceId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.createNoticeId = options.createNoticeId ?? randomUUID;
  }

  record(input: ServerNoticeInput): ServerNoticeRecordResult {
    requireSeverity(input.severity);
    if (input.message.trim() === "") throw new Error("Notice message must not be empty");

    const notice: ServerNotice = Object.freeze({
      id: `${this.daemonInstanceId}:${this.createNoticeId()}`,
      severity: input.severity,
      message: input.message,
      createdAt: this.now().toISOString(),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.context === undefined ? {} : { context: copyJsonObject(input.context) }),
    });
    this.notices.set(notice.id, notice);
    this.revision = incrementSafe(this.revision, "Notice revision exhausted");
    return { notice, snapshot: this.snapshot() };
  }

  snapshot(): ServerNoticeSnapshot {
    return {
      daemonInstanceId: this.daemonInstanceId,
      revision: this.revision,
      // Newest notices are presented first, while the map remains the simple
      // insertion-ordered ownership structure for exact-id deletion.
      notices: [...this.notices.values()].reverse().map(copyNotice),
    };
  }

  dismiss(daemonInstanceId: string, noticeId: string): ServerNoticeDismissResult {
    if (daemonInstanceId !== this.daemonInstanceId || !this.notices.delete(noticeId)) {
      return { snapshot: this.snapshot(), dismissed: false };
    }
    this.revision = incrementSafe(this.revision, "Notice revision exhausted");
    return { snapshot: this.snapshot(), dismissed: true };
  }
}

function requireSeverity(value: unknown): asserts value is ServerNoticeSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error("Invalid notice severity");
}

function copyNotice(notice: ServerNotice): ServerNotice {
  return {
    ...notice,
    ...(notice.context === undefined ? {} : { context: copyJsonObject(notice.context) }),
  };
}

function copyJsonObject(value: JsonObject): JsonObject {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copyJsonValue(item)]),
  ));
}

function copyJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(copyJsonValue));
  if (isJsonObject(value)) return copyJsonObject(value);
  return value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function incrementSafe(value: number, message: string): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) throw new Error(message);
  return next;
}
