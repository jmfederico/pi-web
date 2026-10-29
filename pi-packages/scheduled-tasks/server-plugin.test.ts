import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JsonValue, PiWebHostPiSessionRunCompletion, PiWebHostPiSessionsV1, ServerPluginActivationContextV5,
} from "@jmfederico/pi-web/server-plugin-api";
import { activateTasks } from "./server-plugin.js";
import { TaskStore } from "./store.js";
import type { Execution } from "./domain.js";

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const project = { id: "project", name: "Project", path: "/workspace" };
const workspace = { id: "workspace", projectId: project.id, label: "Main", path: project.path, isMain: true };
const definition = {
  name: "Daily review", projectId: project.id, workspaceId: workspace.id, prompt: "Review the project.",
  schedule: { kind: "once", at: "2030-01-01T00:00:05Z" }, contextPaths: ["notes/context.md"],
};
async function fixture(options: { root?: string; timezone?: string; startTime?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "scheduled-plugin-"));
  if (options.root === undefined) roots.push(root);
  let now = options.startTime ?? "2030-01-01T00:00:00.000Z";
  const lifetime = new AbortController();
  const signal = new AbortController().signal;
  const resolve = vi.fn(() => Promise.resolve({ project, workspace }));
  const run = vi.fn<PiWebHostPiSessionsV1["run"]>(() => Promise.resolve({ sessionId: "normal-conversation", completion: Promise.resolve({ status: "completed" }) }));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const context: ServerPluginActivationContextV5 = {
    apiVersion: 5, pluginId: "scheduled-tasks", packageRoot: "/package", dataDirectory: root,
    settings: options.timezone === undefined ? {} : { defaultTimezone: options.timezone },
    signal, lifetimeSignal: lifetime.signal, logger,
    execFile: () => Promise.reject(new Error("Unexpected command")),
  };
  const activation = activateTasks(context, () => now);
  activation.start({ signal, capabilities: {
    resolve(capability) {
      return capability.parse(capability.id === "workspaces"
        ? { version: 1, resolve }
        : { version: 1, run, create: () => Promise.reject(new Error("Unused")) });
    },
  } });
  let closed = false;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    await activation.dispose();
  };
  cleanups.push(dispose);
  return {
    root, run, resolve, lifetime, dispose, logger,
    setNow: (value: string) => { now = value; },
    request: (operation: string, input: JsonValue = {}) => activation.peer.request({ scope: { kind: "machine" }, operation, input, signal }),
    create: async () => {
      await activation.peer.request({ scope: { kind: "machine" }, operation: "create", input: definition, signal });
      const db = TaskStore.open(join(root, "tasks.sqlite"));
      try { const task = db.listTasks()[0]; if (task === undefined) throw new Error("Missing task"); return task; }
      finally { db.close(); }
    },
  };
}

describe("scheduled task daemon integration", () => {
  it("dispatches without browser activity, links the conversation, and requires explicit outcome reports", async () => {
    vi.useFakeTimers();
    const f = await fixture({ timezone: "Europe/Madrid" });
    const task = await f.create();
    expect(task.timezone).toBe("Europe/Madrid");
    f.setNow("2030-01-01T00:00:05.000Z");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id, workspaceId: workspace.id }));
    expect(f.run.mock.calls[0]?.[0].prompt).toContain("notes/context.md");
    const db = TaskStore.open(join(f.root, "tasks.sqlite"));
    let execution: Execution | undefined;
    try { execution = db.executions()[0]; } finally { db.close(); }
    if (execution === undefined) throw new Error("Missing execution");
    expect(execution).toMatchObject({ status: "dispatched", sessionId: "normal-conversation", task: { revision: 1 } });
    expect(f.run.mock.calls[0]?.[0].prompt).toContain(execution.id);
    await expect(f.request("report", { executionId: execution.id, outcome: "completed", summary: "Reviewed." })).resolves.toMatchObject({ status: "completed" });
    await expect(f.request("report", { executionId: execution.id, outcome: "errored", summary: "Correction: check failed." })).resolves.toMatchObject({
      status: "errored", reports: [{ outcome: "completed", summary: "Reviewed." }, { outcome: "errored", summary: "Correction: check failed." }],
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it("asks for missing timezone, validates current targets, and rejects stale/invalid writes", async () => {
    const f = await fixture();
    await expect(f.request("create", definition)).rejects.toThrow("Ask the user");
    await expect(f.request("create", { ...definition, timezone: "UTC", surprise: true })).rejects.toThrow("Unexpected");
    await expect(f.request("create", { ...definition, timezone: "UTC", contextPaths: ["../escape"] })).rejects.toThrow("workspace-relative");
    f.resolve.mockRejectedValueOnce(new Error("Workspace no longer registered"));
    await expect(f.request("create", { ...definition, timezone: "UTC" })).rejects.toThrow("no longer registered");
    await f.request("create", { ...definition, timezone: "UTC" });
    const db = TaskStore.open(join(f.root, "tasks.sqlite"));
    const task = db.listTasks()[0]; db.close();
    if (task === undefined) throw new Error("Missing task");
    await expect(f.request("pause", { taskId: task.id, revision: 2, paused: true })).rejects.toThrow("revision conflict");
    await expect(f.request("update", { taskId: task.id, revision: 1, definition: { ...definition, timezone: "Asia/Tokyo", prompt: "New instructions" } })).resolves.toMatchObject({ revision: 2, timezone: "Asia/Tokyo" });
    await expect(f.request("inspect", { taskId: task.id })).resolves.toMatchObject({ revision: 2, prompt: "New instructions" });
    await expect(f.request("pause", { taskId: task.id, revision: 2, paused: true })).resolves.toMatchObject({ paused: true });
    await expect(f.request("pause", { taskId: task.id, revision: 3, paused: false })).resolves.toMatchObject({ paused: false });
    await expect(f.request("archive", { taskId: task.id, revision: 4 })).resolves.toMatchObject({ archived: true });
    await expect(f.request("dispatch", { taskId: task.id })).rejects.toThrow("Archived");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("distinguishes pre-dispatch validation failure from uncertain host admission and never retries", async () => {
    vi.useFakeTimers();
    const f = await fixture({ timezone: "UTC" });
    const task = await f.create();
    f.resolve.mockRejectedValueOnce(new Error("Removed workspace"));
    await expect(f.request("dispatch", { taskId: task.id })).resolves.toMatchObject({ status: "failed", dispatchError: "Removed workspace" });
    expect(f.run).not.toHaveBeenCalled();
    f.run.mockRejectedValueOnce(new Error("Disconnected during admission"));
    await expect(f.request("dispatch", { taskId: task.id })).resolves.toMatchObject({ status: "uncertain", sessionId: null });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each(["failed", "cancelled", "rejected"])("does not infer an execution outcome from initial turn %s", async (status) => {
    const f = await fixture({ timezone: "UTC" });
    const task = await f.create();
    const completion: Promise<PiWebHostPiSessionRunCompletion> = status === "rejected" ? Promise.reject(new Error("provider unavailable"))
      : Promise.resolve(status === "failed" ? { status, error: "provider unavailable" } : { status: "cancelled" });
    void completion.catch(() => undefined);
    f.run.mockResolvedValueOnce({ sessionId: "normal-conversation", completion });
    await expect(f.request("dispatch", { taskId: task.id })).resolves.toMatchObject({ status: "dispatched", reports: [] });
    await expect(f.request("overview")).resolves.toMatchObject({ tasks: [{ latestExecution: { status: "dispatched" } }] });
  });

  it("pages compact execution history while retaining full dispatch context separately", async () => {
    const f = await fixture({ timezone: "UTC" });
    const task = await f.create();
    for (let index = 0; index < 3; index += 1) await f.request("dispatch", { taskId: task.id });
    const db = TaskStore.open(join(f.root, "tasks.sqlite"));
    const executions = db.executions(); db.close();
    await expect(f.request("history", { taskId: task.id, limit: 2 })).resolves.toMatchObject({
      executions: [{ id: executions[0]?.id }, { id: executions[1]?.id }], nextOffset: 2,
    });
    await expect(f.request("history", { taskId: task.id, limit: 2, offset: 2 })).resolves.toMatchObject({
      executions: [{ id: executions[2]?.id }], nextOffset: null,
    });
    const page = JSON.stringify(await f.request("history", { taskId: task.id }));
    expect(page).not.toContain(definition.prompt);
    await expect(f.request("execution", { executionId: executions[0]?.id ?? "" })).resolves.toMatchObject({ task: { prompt: definition.prompt } });
    await expect(f.request("history", { limit: 51 })).rejects.toThrow("limit");
    await expect(f.request("history", { offset: -1 })).rejects.toThrow("offset");
  });

  it("quiesces on disable, drains admitted launches before closing SQLite, and preserves records on restart", async () => {
    vi.useFakeTimers();
    const f = await fixture({ timezone: "UTC" });
    const task = await f.create();
    let admit: ((value: Awaited<ReturnType<PiWebHostPiSessionsV1["run"]>>) => void) | undefined;
    f.run.mockImplementationOnce(() => new Promise((resolve) => { admit = resolve; }));
    const dispatch = f.request("dispatch", { taskId: task.id });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = f.dispose();
    await expect(f.request("overview")).rejects.toThrow();
    f.setNow("2030-01-01T00:00:10.000Z");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.run).toHaveBeenCalledOnce();
    if (admit === undefined) throw new Error("Dispatch not admitted");
    admit({ sessionId: "survives-disable", completion: new Promise(() => undefined) });
    await expect(dispatch).resolves.toMatchObject({ sessionId: "survives-disable", status: "dispatched" });
    await stopping;
    const restarted = await fixture({ root: f.root, timezone: "UTC", startTime: "2030-01-01T00:00:10.000Z" });
    // Manual execution did not consume the scheduled one-off. The overdue one-off runs once after restart.
    await vi.advanceTimersByTimeAsync(0);
    expect(restarted.run).toHaveBeenCalledOnce();
    await expect(restarted.request("history", { taskId: task.id })).resolves.toMatchObject({
      executions: [expect.objectContaining({ trigger: "scheduled" }), expect.objectContaining({ sessionId: "survives-disable" })],
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(restarted.run).toHaveBeenCalledOnce();
  });
});
