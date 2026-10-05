import { describe, expect, it } from "vitest";
import { parseSessionActivitySnapshot, parseActivityTasks, parseActivityFleet } from "./sessionActivity.js";

describe("activity snapshot trust boundary", () => {
  it("isolates malformed sources while preserving real memory and explicit unfocused goals", () => {
    const snapshot = parseSessionActivitySnapshot({ version: 1, sessionId: "one", cwd: "/repo", sampledAt: "2026-10-05T00:00:00Z",
      goal: { state: "ready", value: null }, todos: { state: "ready", value: [{ status: "made-up" }] },
      memory: { state: "ready", value: { totalBytes: 1000, availableBytes: 600, availability: "available" } },
    });
    expect(snapshot.todos.state).toBe("unavailable"); expect(snapshot.fleet.state).toBe("unavailable");
    expect(snapshot.goal).toEqual({ state: "ready", value: null });
    expect(snapshot.memory).toEqual({ state: "ready", value: { totalBytes: 1000, availableBytes: 600, availability: "available" } });
  });
  it("rejects oversized identities, duplicate tasks and misleading fleet totals", () => {
    expect(() => parseSessionActivitySnapshot({ version: 1, sessionId: "a".repeat(129), cwd: "/repo", sampledAt: "2026-10-05T00:00:00Z" })).toThrow();
    const task = { id: "1", title: "Task", status: "pending", depth: 0 };
    expect(() => parseActivityTasks([task, task])).toThrow("Duplicate");
    expect(() => parseActivityTasks(Array(513).fill(task))).toThrow();
    expect(() => parseActivityFleet({ entries: [], totalActive: 2, omitted: 0 })).toThrow();
  });
});
