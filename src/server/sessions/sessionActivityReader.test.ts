import { describe, expect, it, vi } from "vitest";
import { Type } from "pi-web-typebox";
import type { ExtensionRunner, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiWebHostPiSessionConnection } from "../../server-plugin-api.js";
import { projectLiveGoal, projectLiveTodos, readActivitySource, readActivityTool, readLiveFleet } from "./sessionActivityReader.js";
import { activityRecord } from "../../shared/sessionActivity.js";

describe("live session activity adapters", () => {
  it("reads actual todo results, not codemode argument prose, and excludes deleted tasks", () => {
    expect(projectLiveTodos({ tasks: [{ id: 1, subject: "Current work", status: "in_progress" }, { id: 2, subject: "Old", status: "deleted" }] })).toEqual([
      { id: "1", title: "Current work", status: "in_progress", depth: 0 },
    ]);
    expect(() => projectLiveTodos({ calls: [{ name: "todo", args: { action: "create" } }] })).toThrow();
  });

  it("projects focused goals and nested tasks even when the goal footer status is absent", () => {
    expect(projectLiveGoal({ version: 3, goal: { id: "g", objective: "Build", status: "active", currentTaskId: "nested", taskList: {
      tasks: [{ id: "root", title: "Parent", status: "pending", subtasks: [{ id: "nested", title: "Implement", status: "pending" }, { id: "done", title: "Done", status: "complete" }] }],
    } } })).toEqual({ id: "g", objective: "Build", status: "active", tasks: [
      { id: "root", title: "Parent", status: "pending", depth: 0 },
      { id: "nested", title: "Implement", status: "in_progress", depth: 1 },
      { id: "done", title: "Done", status: "completed", depth: 1 },
    ] });
    expect(projectLiveGoal({ version: 3, goal: null })).toBeNull();
    expect(() => projectLiveGoal({ version: 4, goal: null })).toThrow();
  });

  it("only calls fixed read operations from supported provider paths", async () => {
    const execute = vi.fn<ToolDefinition["execute"]>().mockResolvedValue({ content: [], details: { tasks: [] } });
    const createToolContext = vi.fn<ExtensionRunner["createToolContext"]>();
    const definition = { name: "todo", label: "Todo", description: "Tasks", parameters: Type.Object({}), execute };
    const sourceInfo = { path: "/packages/@juicesharp/rpiv-todo/index.ts", source: "npm:@juicesharp/rpiv-todo", scope: "user" as const, origin: "top-level" as const };
    const runner = { getAllRegisteredTools: () => [{ definition, sourceInfo }], createToolContext };
    const signal = new AbortController().signal;
    await expect(readActivityTool(runner, "todo", signal)).resolves.toEqual({ tasks: [] });
    expect(execute.mock.calls[0]?.[1]).toEqual({ action: "list", includeDeleted: true });
    expect(createToolContext).toHaveBeenCalledWith(expect.stringMatching(/^pi-web-activity-/), signal);
    sourceInfo.path = "/unrelated/project/todo.ts";
    await expect(readActivityTool(runner, "todo", signal)).rejects.toThrow("not installed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses only the read-only RPC and cleans up listeners and the connection", async () => {
    const owner = new AbortController();
    let handler: ((value: unknown) => void | Promise<void>) | undefined;
    const unsubscribe = vi.fn();
    const close = vi.fn();
    const emit = vi.fn((_channel: string, payload: unknown) => {
      const request = activityRecord(payload);
      expect(request["method"]).toBe("status");
      void handler?.({ version: 1, requestId: request["requestId"], success: true, data: { fleet: {
        version: 1, totalActive: 1, omitted: 0, entries: [{ key: "opaque", agent: "worker", model: "model", goal: "Task" }],
      } } });
    });
    const connection: PiWebHostPiSessionConnection = { signal: owner.signal, on: (_channel, callback) => { handler = callback; return unsubscribe; }, emit, close };
    expect((await readLiveFleet(connection, owner.signal)).totalActive).toBe(1);
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0]?.[0]).toBe("subagents:rpc:v1:request");
  });

  it("bounds a nonresponding source and does not serialize provider errors", async () => {
    const owner = new AbortController();
    const pending = readActivitySource(() => new Promise<never>(() => { /* Deliberately unresponsive provider. */ }), owner.signal, "Source unavailable");
    owner.abort();
    await expect(pending).resolves.toEqual({ state: "unavailable", reason: "Source unavailable" });
    await expect(readActivitySource(() => Promise.reject(new Error("private provider detail")), new AbortController().signal, "Source unavailable")).resolves.toEqual({ state: "unavailable", reason: "Source unavailable" });
  });
});
