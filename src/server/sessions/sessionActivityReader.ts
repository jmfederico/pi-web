import { randomUUID } from "node:crypto";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import type { PiWebHostPiSessionConnection } from "../../server-plugin-api.js";
import {
  activityArray, activityRecord, parseActivityTasks, parseActivityGoal, parseActivityFleet,
  type ActivityRead, type ActivityGoal, type ActivityTask, type ActivityFleet,
} from "../../shared/sessionActivity.js";

export type ActivityRunner = Partial<Pick<ExtensionRunner, "getAllRegisteredTools" | "createToolContext">>;

/** Fixed read operations from audited providers; never an arbitrary tool-execution API. */
export async function readActivityTool(runner: ActivityRunner, name: "todo" | "get_goal", signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const tool = runner.getAllRegisteredTools?.().find((candidate) => candidate.definition.name === name);
  const owner = name === "todo" ? /\/@juicesharp\/rpiv-todo\/index\.(?:ts|js)$/ : /\/pi-goal-x\/extensions\/goal\.(?:ts|js)$/;
  if (tool === undefined || !owner.test(tool.sourceInfo.path.replaceAll("\\", "/")) || runner.createToolContext === undefined) {
    throw new Error("Supported activity reader is not installed");
  }
  // These providers' read operations reconcile their own caches, but do not
  // start work. Calling their readers directly adds no synthetic chat/tool turn.
  const id = `pi-web-activity-${randomUUID()}`;
  const result = await tool.definition.execute(id, name === "todo" ? { action: "list", includeDeleted: true } : {}, signal, undefined, runner.createToolContext(id, signal));
  return result.details;
}

export function projectLiveTodos(details: unknown): ActivityTask[] {
  const tasks = activityArray(activityRecord(details)["tasks"]);
  const rows: unknown[] = [];
  for (const entry of tasks) {
    const task = activityRecord(entry);
    if (task["status"] === "deleted") continue;
    const id = task["id"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error("Invalid todo identity");
    rows.push({ id: String(id), title: task["subject"], status: task["status"], depth: 0 });
  }
  return parseActivityTasks(rows);
}

export function projectLiveGoal(details: unknown): ActivityGoal | null {
  const result = activityRecord(details);
  if (result["version"] !== 3) throw new Error("Unsupported goal state version");
  if (result["goal"] === null) return null;
  const goal = activityRecord(result["goal"]);
  const list = goal["taskList"] === undefined ? [] : activityArray(activityRecord(goal["taskList"])["tasks"]);
  const queue = list.map((task) => ({ task, depth: 0 }));
  const tasks: unknown[] = [];
  while (queue.length > 0) {
    if (tasks.length + queue.length > 512) throw new Error("Goal task limit exceeded");
    const next = queue.shift();
    if (next === undefined) break;
    if (next.depth > 8) throw new Error("Goal task depth exceeded");
    const task = activityRecord(next.task);
    const state = task["status"];
    if (state !== "pending" && state !== "complete" && state !== "skipped") throw new Error("Invalid goal task state");
    tasks.push({ id: task["id"], title: task["title"], depth: next.depth,
      status: state === "complete" ? "completed" : state === "pending" && goal["status"] === "active" && task["id"] === goal["currentTaskId"] ? "in_progress" : state });
    if (task["subtasks"] !== undefined) queue.unshift(...activityArray(task["subtasks"]).map((child) => ({ task: child, depth: next.depth + 1 })));
  }
  return parseActivityGoal({ id: goal["id"], objective: goal["objective"], status: goal["status"], tasks });
}

export async function readActivitySource<T>(read: () => Promise<T>, signal: AbortSignal, reason: string): Promise<ActivityRead<T>> {
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const expired = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(new Error("Activity sample expired")); };
      signal.addEventListener("abort", abort, { once: true });
    });
    return { state: "ready", value: await Promise.race([read(), expired]) };
  } catch {
    return { state: "unavailable", reason };
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

export async function readLiveFleet(connection: PiWebHostPiSessionConnection, signal: AbortSignal): Promise<ActivityFleet> {
  const requestId = randomUUID();
  let unsubscribe: (() => void) | undefined;
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await new Promise<ActivityFleet>((resolve, reject) => {
      abort = () => { reject(new Error("Fleet reader disconnected")); };
      signal.addEventListener("abort", abort, { once: true });
      connection.signal.addEventListener("abort", abort, { once: true });
      unsubscribe = connection.on(`subagents:rpc:v1:reply:${requestId}`, (payload) => {
        try {
          const reply = activityRecord(payload);
          if (reply["version"] !== 1 || reply["requestId"] !== requestId) return;
          if (reply["success"] !== true) throw new Error("Fleet status unavailable");
          const fleet = activityRecord(activityRecord(reply["data"])["fleet"]);
          if (fleet["version"] !== 1) throw new Error("Unsupported fleet version");
          resolve(parseActivityFleet(fleet));
        } catch (error) { reject(error instanceof Error ? error : new Error("Invalid fleet reply")); }
      });
      connection.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {} });
    });
  } finally {
    unsubscribe?.();
    if (abort !== undefined) {
      signal.removeEventListener("abort", abort);
      connection.signal.removeEventListener("abort", abort);
    }
    connection.close();
  }
}
