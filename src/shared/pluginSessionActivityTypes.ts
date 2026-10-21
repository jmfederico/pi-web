import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginCatalogReadOptions, PluginSessionSelection, PluginSessionSnapshot } from "./pluginCatalogTypes.js";

export interface PluginSessionActivityExecution {
  readonly id: string;
  readonly kind: "subsession";
  readonly parentSessionId: string;
  readonly sessionId: string;
  readonly status: "working" | "idle" | "failed" | "unknown";
  readonly canStop: boolean;
  readonly canOpenSession: true;
}

export interface PluginSessionActivityV1Snapshot {
  readonly session: PluginSessionSnapshot;
  readonly lifecycle: "starting" | "active" | "archived";
  readonly runtimeLoaded: boolean;
  readonly activity: "working" | "waiting" | "idle" | "unknown";
  readonly status: {
    readonly persisted: boolean | null;
    readonly isStreaming: boolean | null;
    readonly isCompacting: boolean | null;
    readonly isBashRunning: boolean | null;
    readonly pendingMessageCount: number | null;
    readonly messageCount: number | null;
    readonly queueState: {
      readonly available: boolean;
      readonly reason?: "runtime_not_loaded";
      readonly steeringCount?: number;
      readonly followUpCount?: number;
      readonly compactionFollowUpCount?: number;
    };
    readonly telemetry: {
      readonly available: boolean;
      readonly reason?: "runtime_not_loaded";
      readonly tokens?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly total: number };
      readonly cost?: number;
      readonly contextUsage?: { readonly tokens: number | null; readonly contextWindow: number; readonly percent: number | null };
    };
  };
  readonly relatedExecutions: {
    readonly supportedKinds: readonly ["subsession"];
    readonly unsupportedKinds: readonly ["background-agent", "terminal", "process"];
    readonly truncated: boolean;
    readonly executions: readonly PluginSessionActivityExecution[];
    readonly workingCount: number;
    readonly totalCount: number;
  };
}

export interface PluginSessionActivityV1 {
  readonly version: 1;
  readonly inspect: (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => Promise<PluginSessionActivityV1Snapshot>;
}

export const PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY: PluginCapability<PluginSessionActivityV1, 1> = Object.freeze({
  pluginId: "pi-web.host",
  id: "pi-session-activity",
  version: 1,
  parse: snapshotSessionActivity,
});

function snapshotSessionActivity(value: unknown): PluginSessionActivityV1 {
  const row = record(value);
  const inspect = row["inspect"];
  if (row["version"] !== 1 || typeof inspect !== "function") throw invalid();
  return Object.freeze({
    version: 1,
    inspect: async (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => {
      const requested = snapshotSelection(selection);
      const result = snapshotResult(await Reflect.apply(inspect, row, [requested, options]));
      if (result.session.id !== requested.sessionId) throw invalid();
      return result;
    },
  });
}

function snapshotResult(value: unknown): PluginSessionActivityV1Snapshot {
  const row = record(value);
  const session = snapshotSession(row["session"]);
  const lifecycle = row["lifecycle"];
  const activity = row["activity"];
  const runtimeLoaded = boolean(row["runtimeLoaded"]);
  if ((lifecycle !== "starting" && lifecycle !== "active" && lifecycle !== "archived")
    || (activity !== "working" && activity !== "waiting" && activity !== "idle" && activity !== "unknown")) throw invalid();
  const status = record(row["status"]);
  const queue = record(status["queueState"]);
  const telemetry = record(status["telemetry"]);
  const relations = record(row["relatedExecutions"]);
  if (relations["supportedKinds"] === undefined || relations["unsupportedKinds"] === undefined || !Array.isArray(relations["executions"])) throw invalid();
  const executions = relations["executions"].map(snapshotExecution);
  const workingCount = integer(relations["workingCount"]);
  const totalCount = integer(relations["totalCount"]);
  const result: PluginSessionActivityV1Snapshot = Object.freeze({
    session,
    lifecycle,
    runtimeLoaded,
    activity,
    status: Object.freeze({
      persisted: nullableBoolean(status["persisted"]),
      isStreaming: nullableBoolean(status["isStreaming"]),
      isCompacting: nullableBoolean(status["isCompacting"]),
      isBashRunning: nullableBoolean(status["isBashRunning"]),
      pendingMessageCount: nullableInteger(status["pendingMessageCount"]),
      messageCount: nullableInteger(status["messageCount"]),
      queueState: Object.freeze({
        available: boolean(queue["available"]),
        ...(queue["reason"] === undefined ? {} : { reason: queueReason(queue["reason"]) }),
        ...(queue["steeringCount"] === undefined ? {} : { steeringCount: integer(queue["steeringCount"]) }),
        ...(queue["followUpCount"] === undefined ? {} : { followUpCount: integer(queue["followUpCount"]) }),
        ...(queue["compactionFollowUpCount"] === undefined ? {} : { compactionFollowUpCount: integer(queue["compactionFollowUpCount"]) }),
      }),
      telemetry: Object.freeze({
        available: boolean(telemetry["available"]),
        ...(telemetry["reason"] === undefined ? {} : { reason: queueReason(telemetry["reason"]) }),
        ...(telemetry["tokens"] === undefined ? {} : { tokens: snapshotTokens(telemetry["tokens"]) }),
        ...(telemetry["cost"] === undefined ? {} : { cost: finite(telemetry["cost"]) }),
        ...(telemetry["contextUsage"] === undefined ? {} : { contextUsage: snapshotContextUsage(telemetry["contextUsage"]) }),
      }),
    }),
    relatedExecutions: Object.freeze({
      supportedKinds: Object.freeze(["subsession"] as const),
      unsupportedKinds: Object.freeze(["background-agent", "terminal", "process"] as const),
      truncated: boolean(relations["truncated"]),
      executions: Object.freeze(executions),
      workingCount,
      totalCount,
    }),
  });
  const visibleWorkingCount = executions.filter(({ status: state }) => state === "working").length;
  if (workingCount < visibleWorkingCount || workingCount > totalCount || totalCount < executions.length
    || (!result.relatedExecutions.truncated && workingCount !== visibleWorkingCount)) throw invalid();
  if (runtimeLoaded !== (session.runtime !== "not-hosted")) throw invalid();
  return result;
}

function snapshotSession(value: unknown): PluginSessionSnapshot {
  const row = record(value);
  const runtime = row["runtime"];
  if (runtime !== "not-hosted" && runtime !== "idle" && runtime !== "busy") throw invalid();
  if (typeof row["archived"] !== "boolean") throw invalid();
  return Object.freeze({
    id: text(row["id"]), cwd: text(row["cwd"]), archived: row["archived"], runtime,
    ...(row["name"] === undefined ? {} : { name: text(row["name"]) }),
    ...(row["parentSessionId"] === undefined ? {} : { parentSessionId: text(row["parentSessionId"]) }),
    ...(row["archivedAt"] === undefined ? {} : { archivedAt: text(row["archivedAt"]) }),
  });
}
function snapshotExecution(value: unknown): PluginSessionActivityExecution {
  const row = record(value);
  if (row["kind"] !== "subsession") throw invalid();
  const status = row["status"];
  if (status !== "working" && status !== "idle" && status !== "failed" && status !== "unknown") throw invalid();
  const canStop = boolean(row["canStop"]);
  if (canStop !== (status === "working")) throw invalid();
  if (row["canOpenSession"] !== true) throw invalid();
  return Object.freeze({ id: text(row["id"]), kind: "subsession", parentSessionId: text(row["parentSessionId"]), sessionId: text(row["sessionId"]), status, canStop, canOpenSession: true });
}
function snapshotTokens(value: unknown) {
  const row = record(value);
  return Object.freeze({ input: finite(row["input"]), output: finite(row["output"]), cacheRead: finite(row["cacheRead"]), cacheWrite: finite(row["cacheWrite"]), total: finite(row["total"]) });
}
function snapshotContextUsage(value: unknown) {
  const row = record(value);
  return Object.freeze({ tokens: nullableInteger(row["tokens"]), contextWindow: integer(row["contextWindow"]), percent: row["percent"] === null ? null : finite(row["percent"]) });
}
function snapshotSelection(value: unknown): PluginSessionSelection {
  const row = record(value);
  return Object.freeze({ projectId: text(row["projectId"]), workspaceId: text(row["workspaceId"]), sessionId: text(row["sessionId"]) });
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) result[key] = Reflect.get(value, key);
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw invalid();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw invalid(); return value; }
function nullableBoolean(value: unknown): boolean | null { return value === null ? null : boolean(value); }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(); return value; }
function nullableInteger(value: unknown): number | null { return value === null ? null : integer(value); }
function finite(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(); return value; }
function queueReason(value: unknown): "runtime_not_loaded" { if (value !== "runtime_not_loaded") throw invalid(); return value; }
function invalid(): Error { return new Error("Invalid PI WEB host session activity capability v1 data"); }
