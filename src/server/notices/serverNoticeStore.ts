import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue, ServerNotice, ServerNoticeScope, ServerNoticeSeverity, ServerNoticeSnapshot } from "../../shared/apiTypes.js";
import {
  isPluginServerNoticeSource,
  parseServerNoticeScope,
  SERVER_PLUGIN_NOTICE_GLOBAL_LIMIT,
  SERVER_PLUGIN_NOTICE_PER_SOURCE_LIMIT,
} from "../../shared/serverNoticeContract.js";

export interface ServerNoticeInput {
  severity: ServerNoticeSeverity;
  message: string;
  source?: string;
  scope?: ServerNoticeScope;
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
 * Plugin-attributed occurrences have per-source and global retention bounds;
 * core-owned sources are never eligible for overflow eviction.
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
    if (typeof input.message !== "string" || input.message.trim() === "") {
      throw new Error("Notice message must not be empty");
    }
    if (input.source !== undefined && (typeof input.source !== "string" || input.source.trim() === "")) {
      throw new Error("Notice source must not be empty");
    }

    // Prepare the complete immutable record, revision, and eviction set before
    // changing the store so any validation/generation failure is atomic.
    const scope = input.scope === undefined ? undefined : parseServerNoticeScope(input.scope, "Notice scope");
    const context = input.context === undefined ? undefined : copyJsonObject(input.context);
    const id = `${this.daemonInstanceId}:${this.createNoticeId()}`;
    if (this.notices.has(id)) throw new Error(`Notice id already exists: ${id}`);
    const nextRevision = incrementSafe(this.revision, "Notice revision exhausted");
    const notice: ServerNotice = Object.freeze({
      id,
      severity: input.severity,
      message: input.message,
      createdAt: this.now().toISOString(),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(scope === undefined ? {} : { scope }),
      ...(context === undefined ? {} : { context }),
    });
    const evictions = isPluginServerNoticeSource(notice.source)
      ? this.pluginEvictions(notice.source)
      : [];

    for (const noticeId of evictions) this.notices.delete(noticeId);
    this.notices.set(notice.id, notice);
    this.revision = nextRevision;
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

  private pluginEvictions(source: `plugin:${string}`): string[] {
    const pluginNotices = [...this.notices.values()]
      .filter((notice) => isPluginServerNoticeSource(notice.source));
    const sameSource = pluginNotices.filter((notice) => notice.source === source);
    const evictions = new Set<string>();

    const sourceOverflow = Math.max(0, sameSource.length + 1 - SERVER_PLUGIN_NOTICE_PER_SOURCE_LIMIT);
    for (const notice of sameSource.slice(0, sourceOverflow)) evictions.add(notice.id);

    const remainingPluginCount = pluginNotices.length - evictions.size;
    const globalOverflow = Math.max(0, remainingPluginCount + 1 - SERVER_PLUGIN_NOTICE_GLOBAL_LIMIT);
    for (const notice of pluginNotices) {
      if (evictions.has(notice.id)) continue;
      if (evictions.size >= sourceOverflow + globalOverflow) break;
      evictions.add(notice.id);
    }
    return [...evictions];
  }
}

function requireSeverity(value: unknown): asserts value is ServerNoticeSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error("Invalid notice severity");
}

function copyNotice(notice: ServerNotice): ServerNotice {
  return {
    ...notice,
    ...(notice.scope === undefined ? {} : { scope: { ...notice.scope } }),
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
