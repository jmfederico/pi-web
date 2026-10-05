export const SUBAGENT_ASYNC_WIDGET_KEY = "subagent-async";
export const SUBAGENT_ASYNC_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_RUNS = 20;
const MAX_CHILDREN_PER_NODE = 8;
const MAX_DEPTH = 3;
const MAX_TOTAL_NODES = 512;
const MAX_STRING_LENGTH = 160;
const MAX_HOST_REASON_LENGTH = 64;
const MAX_WIDGET_LINES = 64;
const MAX_DATE_VALUE = 8_640_000_000_000_000;

export type FleetNodeKind = "subagent" | "workflow" | "step" | "host-step";
export type FleetNodeState = "queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";

const NODE_KINDS: ReadonlySet<string> = new Set(["subagent", "workflow", "step", "host-step"]);
const NODE_STATES: ReadonlySet<string> = new Set(["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"]);

export interface FleetActivity {
  state?: string;
  currentTool?: string;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  turnCount?: number;
  toolCount?: number;
}

export type FleetHostStepVerdict = "pass" | "fail" | "inconclusive";

export interface FleetHostStepMetadata {
  stale?: boolean;
  verdict?: FleetHostStepVerdict;
  reasonCode?: string;
}

export interface FleetNode {
  id: string;
  kind: FleetNodeKind;
  label: string;
  state: FleetNodeState;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: FleetActivity;
  hostStep?: FleetHostStepMetadata;
  children: FleetNode[];
}

export interface FleetSnapshot {
  generatedAt: number;
  runs: FleetNode[];
  omitted: {
    runs: number;
    children: number;
    byteLimitExceeded: boolean;
  };
}

export type FleetParseResult =
  | { status: "ready"; snapshot: FleetSnapshot }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

export function parseSubagentFleet(widgets: Record<string, string[]> | undefined): FleetParseResult {
  if (!isRecord(widgets)) return unavailable();

  const widgetLines: unknown = widgets[SUBAGENT_ASYNC_WIDGET_KEY];
  if (widgetLines === undefined) return unavailable();
  if (!Array.isArray(widgetLines) || widgetLines.length > MAX_WIDGET_LINES) return malformed();

  let payload: string | undefined;
  for (const line of widgetLines) {
    if (typeof line !== "string") return malformed();
    if (!line.startsWith(SUBAGENT_ASYNC_WIDGET_PREFIX)) continue;
    if (payload !== undefined) return malformed();
    payload = line.slice(SUBAGENT_ASYNC_WIDGET_PREFIX.length);
  }
  if (payload === undefined) return unavailable();
  if (payload.length > MAX_SNAPSHOT_BYTES || new TextEncoder().encode(payload).byteLength > MAX_SNAPSHOT_BYTES) {
    return malformed("The async status snapshot exceeds the supported size limit.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return malformed();
  }

  try {
    return { status: "ready", snapshot: parseSnapshot(decoded) };
  } catch (error) {
    return malformed(error instanceof SnapshotParseError ? error.message : undefined);
  }
}

function parseSnapshot(value: unknown): FleetSnapshot {
  if (!isRecord(value)) throw new SnapshotParseError("The async status snapshot is malformed.");
  if (value["kind"] !== SNAPSHOT_KIND) throw new SnapshotParseError("Unsupported async status snapshot kind.");
  if (value["version"] !== SNAPSHOT_VERSION) throw new SnapshotParseError("Unsupported async status snapshot version.");

  validateCaps(value["caps"]);
  const generatedAt = requiredTimestamp(value["generatedAt"]);
  const omitted = parseOmitted(value["omitted"]);
  if (!Array.isArray(value["runs"]) || value["runs"].length > MAX_RUNS) {
    throw new SnapshotParseError("The async status snapshot exceeds the supported run limit.");
  }

  const budget = { count: 0 };
  const runs = parseSiblingNodes(value["runs"], 0, budget, MAX_RUNS);
  return { generatedAt, runs, omitted };
}

function validateCaps(value: unknown): void {
  if (!isRecord(value)) throw new SnapshotParseError("The async status snapshot is malformed.");
  for (const key of ["maxRuns", "maxChildrenPerNode", "maxDepth", "maxStringLength", "maxSerializedBytes"] as const) {
    if (!isCount(value[key])) throw new SnapshotParseError("The async status snapshot is malformed.");
  }
}

function parseOmitted(value: unknown): FleetSnapshot["omitted"] {
  if (!isRecord(value) || !isCount(value["runs"]) || !isCount(value["children"]) || typeof value["byteLimitExceeded"] !== "boolean") {
    throw new SnapshotParseError("The async status snapshot is malformed.");
  }
  return {
    runs: value["runs"],
    children: value["children"],
    byteLimitExceeded: value["byteLimitExceeded"],
  };
}

function parseSiblingNodes(values: unknown[], depth: number, budget: { count: number }, maxCount = MAX_CHILDREN_PER_NODE): FleetNode[] {
  if (values.length > maxCount) {
    throw new SnapshotParseError("The async status snapshot exceeds the supported child limit.");
  }
  const nodes = values.map((value) => parseNode(value, depth, budget));
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new SnapshotParseError("The async status snapshot has duplicate node identifiers.");
    ids.add(node.id);
  }
  return nodes;
}

function parseNode(value: unknown, depth: number, budget: { count: number }): FleetNode {
  if (depth > MAX_DEPTH || ++budget.count > MAX_TOTAL_NODES) {
    throw new SnapshotParseError("The async status snapshot exceeds the supported hierarchy limit.");
  }
  if (!isRecord(value) || !isFleetNodeKind(value["kind"]) || !isFleetNodeState(value["state"])) {
    throw new SnapshotParseError("The async status snapshot contains an unsupported node.");
  }

  const id = requiredText(value["id"], true);
  const label = requiredText(value["label"], false);
  const activity = parseActivity(value["activity"]);
  const hostStep = parseHostStepMetadata(value["hostStep"]);
  const childrenValue = value["children"];
  if (childrenValue !== undefined && !Array.isArray(childrenValue)) {
    throw new SnapshotParseError("The async status snapshot is malformed.");
  }
  const children = childrenValue === undefined ? [] : parseSiblingNodes(childrenValue, depth + 1, budget);

  return {
    id,
    kind: value["kind"],
    label,
    state: value["state"],
    ...(value["startedAt"] !== undefined ? { startedAt: requiredTimestamp(value["startedAt"]) } : {}),
    ...(value["updatedAt"] !== undefined ? { updatedAt: requiredTimestamp(value["updatedAt"]) } : {}),
    ...(value["endedAt"] !== undefined ? { endedAt: requiredTimestamp(value["endedAt"]) } : {}),
    ...(activity ? { activity } : {}),
    ...(hostStep ? { hostStep } : {}),
    children,
  };
}

function parseActivity(value: unknown): FleetActivity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SnapshotParseError("The async status snapshot is malformed.");
  return {
    ...(value["state"] !== undefined ? { state: optionalText(value["state"]) } : {}),
    ...(value["currentTool"] !== undefined ? { currentTool: optionalText(value["currentTool"]) } : {}),
    ...(value["lastActivityAt"] !== undefined ? { lastActivityAt: requiredTimestamp(value["lastActivityAt"]) } : {}),
    ...(value["currentToolStartedAt"] !== undefined ? { currentToolStartedAt: requiredTimestamp(value["currentToolStartedAt"]) } : {}),
    ...(value["turnCount"] !== undefined ? { turnCount: requiredCount(value["turnCount"]) } : {}),
    ...(value["toolCount"] !== undefined ? { toolCount: requiredCount(value["toolCount"]) } : {}),
  };
}

function parseHostStepMetadata(value: unknown): FleetHostStepMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SnapshotParseError("The async status snapshot is malformed.");

  const stale = value["stale"];
  const verdict = value["verdict"];
  const rawReasonCode = value["reasonCode"];
  if (stale !== undefined && typeof stale !== "boolean") {
    throw new SnapshotParseError("The async status snapshot contains invalid host-step freshness metadata.");
  }
  if (verdict !== undefined && !isFleetHostStepVerdict(verdict)) {
    throw new SnapshotParseError("The async status snapshot contains an unsupported host-step verdict.");
  }

  let reasonCode: string | undefined;
  if (rawReasonCode !== undefined) {
    if (typeof rawReasonCode !== "string") throw new SnapshotParseError("The async status snapshot contains invalid host-step reason metadata.");
    reasonCode = cleanText(rawReasonCode);
    if (!reasonCode || reasonCode.length > MAX_HOST_REASON_LENGTH) {
      throw new SnapshotParseError("The async status snapshot contains invalid host-step reason metadata.");
    }
  }

  return {
    ...(stale !== undefined ? { stale } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  };
}

function requiredText(value: unknown, isIdentity: boolean): string {
  if (typeof value !== "string") throw new SnapshotParseError("The async status snapshot is malformed.");
  const text = cleanText(value);
  if (!text || (isIdentity && text.length > MAX_STRING_LENGTH)) {
    throw new SnapshotParseError("The async status snapshot is malformed.");
  }
  return isIdentity ? text : text.slice(0, MAX_STRING_LENGTH);
}

function optionalText(value: unknown): string {
  if (typeof value !== "string") throw new SnapshotParseError("The async status snapshot is malformed.");
  return cleanText(value).slice(0, MAX_STRING_LENGTH);
}

function cleanText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
}

function requiredTimestamp(value: unknown): number {
  if (!isCount(value) || value > MAX_DATE_VALUE) throw new SnapshotParseError("The async status snapshot is malformed.");
  return value;
}

function requiredCount(value: unknown): number {
  if (!isCount(value)) throw new SnapshotParseError("The async status snapshot is malformed.");
  return value;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFleetNodeKind(value: unknown): value is FleetNodeKind {
  return typeof value === "string" && NODE_KINDS.has(value);
}

function isFleetNodeState(value: unknown): value is FleetNodeState {
  return typeof value === "string" && NODE_STATES.has(value);
}

function isFleetHostStepVerdict(value: unknown): value is FleetHostStepVerdict {
  return value === "pass" || value === "fail" || value === "inconclusive";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): FleetParseResult {
  return { status: "unavailable", message: "No structured async status snapshot is available." };
}

function malformed(message = "The async status snapshot is malformed or exceeds supported limits."): FleetParseResult {
  return { status: "error", message };
}

class SnapshotParseError extends Error {}
