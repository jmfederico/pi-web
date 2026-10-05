export type ActivityRead<T> = { state: "ready"; value: T } | { state: "unavailable"; reason: string };
export interface ActivityTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  depth: number;
}
export interface ActivityGoal {
  id: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "budget_limited" | "complete";
  tasks: ActivityTask[];
}
export interface ActivityFleet {
  totalActive: number;
  omitted: number;
  entries: { key: string; agent: string; model: string; goal: string }[];
}
export interface ActivityChild { sessionId: string; cwd: string; status: "working" | "idle" | "error" | "unknown" }
export interface SystemMemory { totalBytes: number; availableBytes: number; availability: "available" | "free" }
export interface SessionActivitySnapshot {
  version: 1;
  sessionId: string;
  cwd: string;
  sampledAt: string;
  todos: ActivityRead<ActivityTask[]>;
  goal: ActivityRead<ActivityGoal | null>;
  fleet: ActivityRead<ActivityFleet>;
  children: ActivityRead<ActivityChild[]>;
  memory: ActivityRead<SystemMemory>;
}

export function activityRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid activity object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function activityText(value: unknown, max = 512): string {
  if (typeof value !== "string") throw new Error("Invalid activity text");
  return value.slice(0, max);
}

function identity(value: unknown, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error("Invalid activity identity");
  return value;
}

export function activityArray(value: unknown, max = 512): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Activity list exceeds display limits or is malformed");
  return value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid activity count");
  return value;
}

function choice<T extends string>(value: unknown, options: readonly T[]): T {
  for (const option of options) if (option === value) return option;
  throw new Error("Invalid activity state");
}

export function parseActivityTasks(value: unknown): ActivityTask[] {
  const ids = new Set<string>();
  return activityArray(value).map((entry) => {
    const row = activityRecord(entry);
    const depth = count(row["depth"]);
    if (depth > 8) throw new Error("Task nesting exceeds display limits");
    const id = identity(row["id"]);
    if (ids.has(id)) throw new Error("Duplicate task identity");
    ids.add(id);
    return { id, title: activityText(row["title"]), depth,
      status: choice(row["status"], ["pending", "in_progress", "completed", "skipped"]) };
  });
}

export function parseActivityGoal(value: unknown): ActivityGoal | null {
  if (value === null) return null;
  const row = activityRecord(value);
  return { id: identity(row["id"]), objective: activityText(row["objective"]),
    status: choice(row["status"], ["active", "paused", "blocked", "budget_limited", "complete"]), tasks: parseActivityTasks(row["tasks"]) };
}

export function parseActivityFleet(value: unknown): ActivityFleet {
  const row = activityRecord(value);
  const entries = activityArray(row["entries"], 128).map((entry) => {
    const item = activityRecord(entry);
    return { key: identity(item["key"]), agent: activityText(item["agent"], 160),
      model: activityText(item["model"] ?? "", 160), goal: activityText(item["goal"] ?? "") };
  });
  const totalActive = count(row["totalActive"]);
  const omitted = count(row["omitted"]);
  if (entries.length + omitted !== totalActive) throw new Error("Invalid fleet totals");
  return { entries, totalActive, omitted };
}

export function parseActivityChildren(value: unknown): ActivityChild[] {
  return activityArray(value).map((entry) => {
    const item = activityRecord(entry);
    return { sessionId: identity(item["sessionId"]), cwd: activityText(item["cwd"], 4096),
      status: choice(item["status"], ["working", "idle", "error", "unknown"]) };
  });
}

export function parseSystemMemory(value: unknown): SystemMemory {
  const row = activityRecord(value);
  const totalBytes = count(row["totalBytes"]);
  const availableBytes = count(row["availableBytes"]);
  if (totalBytes === 0 || availableBytes > totalBytes) throw new Error("Invalid memory sample");
  return { totalBytes, availableBytes, availability: choice(row["availability"], ["available", "free"]) };
}

function readSource<T>(value: unknown, parse: (value: unknown) => T): ActivityRead<T> {
  try {
    const source = activityRecord(value);
    if (source["state"] === "ready") return { state: "ready", value: parse(source["value"]) };
    if (source["state"] === "unavailable") return { state: "unavailable", reason: activityText(source["reason"], 200) };
  } catch { /* A malformed source must not hide the other independent sources. */ }
  return { state: "unavailable", reason: "Invalid activity source response" };
}

export function parseSessionActivitySnapshot(value: unknown): SessionActivitySnapshot {
  const row = activityRecord(value);
  if (row["version"] !== 1) throw new Error("Unsupported activity snapshot version");
  const sampledAt = activityText(row["sampledAt"], 64);
  if (!Number.isFinite(Date.parse(sampledAt))) throw new Error("Invalid activity sample time");
  return { version: 1, sessionId: identity(row["sessionId"]), cwd: identity(row["cwd"], 4096), sampledAt,
    todos: readSource(row["todos"], parseActivityTasks), goal: readSource(row["goal"], parseActivityGoal),
    fleet: readSource(row["fleet"], parseActivityFleet), children: readSource(row["children"], parseActivityChildren),
    memory: readSource(row["memory"], parseSystemMemory) };
}
