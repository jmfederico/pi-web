import { describe, expect, it } from "vitest";
import { ExtensionUiState } from "./extensionUiState.js";

describe("ExtensionUiState", () => {
  it("ignores invalid working messages and clears empty or disposed messages", () => {
    const state = new ExtensionUiState();
    state.setWorkingMessage("Loading");
    for (const invalid of [null, {}, 42]) expect(state.setWorkingMessage(invalid)).toBe(false);
    expect(state.snapshot()?.workingMessage).toBe("Loading");
    expect(state.setWorkingMessage("")).toBe(true);
    expect(state.snapshot()).toBeUndefined();
    state.setWorkingMessage("Loading again");
    state.dispose();
    expect(state.setWorkingMessage("Late message")).toBe(false);
    expect(state.snapshot()).toBeUndefined();
  });

  it("stores and removes bounded status and string-array widget values", () => {
    const state = new ExtensionUiState();

    expect(state.snapshot()).toBeUndefined();
    expect(state.setStatus("worker", "working")).toBe(true);
    expect(state.setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:", "payload"])).toBe(true);
    expect(state.snapshot()).toEqual({
      statuses: { worker: "working" },
      widgets: { "subagent-async": ["PI_SUBAGENT_ASYNC_JSON:", "payload"] },
    });

    expect(state.setStatus("worker", undefined)).toBe(true);
    expect(state.setWidget("subagent-async", undefined)).toBe(true);
    expect(state.snapshot()).toBeUndefined();
  });

  it("rejects prototype-sensitive keys and private inspect widgets", () => {
    const state = new ExtensionUiState();

    for (const key of ["__proto__", "constructor", "prototype", "toString"]) {
      expect(state.setStatus(key, "unsafe")).toBe(false);
      expect(state.setWidget(key, ["unsafe"])).toBe(false);
    }
    expect(state.setWidget("subagent-inspect", ["PI_SUBAGENT_INSPECT_JSON: private"])).toBe(false);
    expect(state.snapshot()).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "unsafe")).toBe(false);
  });

  it("bounds keys, map sizes, status text, widget lines, and widget line text", () => {
    const state = new ExtensionUiState();

    expect(state.setStatus("k".repeat(129), "ignored")).toBe(false);
    expect(state.setWidget("bad-lines", ["ok", 1])).toBe(false);
    expect(state.setStatus("long", "x".repeat(600))).toBe(true);
    expect(state.setWidget("long", ["y".repeat(30_000), "z".repeat(200)])).toBe(true);
    expect(state.setWidget("too-long", ["y".repeat(40_001)])).toBe(false);
    expect(state.setWidget("too-many-lines", Array.from({ length: 33 }, () => "line"))).toBe(false);
    expect(state.setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:" + "x".repeat(32_768)])).toBe(true);
    for (let index = 0; index < 40; index += 1) {
      state.setStatus("status-" + String(index), "value");
      state.setWidget("widget-" + String(index), ["line"]);
    }

    const snapshot = state.snapshot();
    expect(snapshot?.statuses["long"]).toHaveLength(512);
    expect(Object.keys(snapshot?.statuses ?? {}).length).toBeLessThanOrEqual(32);
    expect(snapshot?.widgets["long"]?.[0]).toHaveLength(30_000);
    expect(snapshot?.widgets["subagent-async"]?.[0]).toBe("PI_SUBAGENT_ASYNC_JSON:" + "x".repeat(32_768));
    expect(Object.keys(snapshot?.widgets ?? {}).length).toBeLessThanOrEqual(16);
  });

  it("returns detached snapshots and rejects mutations after disposal", () => {
    const state = new ExtensionUiState();
    state.setStatus("worker", "working");
    const snapshot = state.snapshot();
    if (snapshot === undefined) throw new Error("expected status snapshot");
    snapshot.statuses["worker"] = "changed by caller";

    expect(state.snapshot()?.statuses["worker"]).toBe("working");
    state.dispose();
    expect(state.snapshot()).toBeUndefined();
    expect(state.setStatus("late", "stale")).toBe(false);
    expect(state.setWidget("late", ["stale"])).toBe(false);
  });
});
