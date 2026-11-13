import { describe, expect, it } from "vitest";
import { createSessionStateData, latestSessionStateEntries, parseSessionStateEntry, readSessionState, SESSION_STATE_CUSTOM_TYPE, SESSION_STATE_MAX_BYTES, SESSION_STATE_RESET_CUSTOM_TYPE } from "./sessionState.js";
import { PI_WEB_HOST_SESSION_STATE_CAPABILITY } from "./pluginSessionStateTypes.js";

const entry = (id: string, namespace: string, value: unknown, inherit = true) => ({ type: "custom", id, customType: SESSION_STATE_CUSTOM_TYPE, data: { version: 1, namespace, value, inherit } });

describe("private native session state", () => {
  it("reads latest append order, ignores unrelated entries and separates namespaces", () => {
    const entries = [entry("a", "first", 1), entry("b", "other", 2), entry("c", "first", null, false),
      { type: "custom", customType: "unrelated", data: undefined }, { type: "message" }];
    expect(readSessionState(entries, "first")).toEqual({ revision: "c", value: null });
    expect(readSessionState(entries, "other")).toEqual({ revision: "b", value: 2 });
    expect(readSessionState(entries, "absent")).toEqual({ revision: "" });
    expect(latestSessionStateEntries(entries).find(({ namespace }) => namespace === "first")?.inherit).toBe(false);
    expect(parseSessionStateEntry({ ...entries[0], type: "message" })).toBeUndefined();
  });

  it("honors fork resets so copied history cannot revive private or opted-out values", () => {
    const entries = [entry("a", "private", 1, false), entry("b", "public", "old"),
      { type: "custom", id: "reset", customType: SESSION_STATE_RESET_CUSTOM_TYPE, data: { version: 1 } }, entry("c", "public", "current")];
    expect(readSessionState(entries, "private")).toEqual({ revision: "" });
    expect(readSessionState(entries, "public")).toEqual({ revision: "c", value: "current" });
  });

  it("rejects invalid namespaces, non-JSON, cycles, depth and byte overflow, and detaches values", () => {
    expect(() => createSessionStateData("", null, false)).toThrow();
    expect(() => createSessionStateData("a b", null, false)).toThrow();
    expect(() => createSessionStateData("example", "x".repeat(SESSION_STATE_MAX_BYTES), false)).toThrow("byte limit");
    expect(() => createSessionStateData("example", NaN, false)).toThrow();
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    expect(() => parseSessionStateEntry(entry("a", "example", cycle))).toThrow();
    let deep: unknown = null;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => parseSessionStateEntry(entry("a", "example", deep))).toThrow();
    const value = { x: [1] };
    const data = createSessionStateData("example", value, true);
    value.x.push(2);
    expect(data.value).toEqual({ x: [1] });
  });

  it.each([
    { version: 2, namespace: "grants", value: [], inherit: false },
    { version: 1, namespace: "", value: [], inherit: false },
    { version: 1, namespace: "grants", value: undefined, inherit: false },
    { version: 1, namespace: "grants", value: [], inherit: "false" },
    null,
  ])("rejects malformed newer state rather than reviving previous grants or inheritance: %j", (data) => {
    const malformed = { type: "custom", id: "bad", customType: SESSION_STATE_CUSTOM_TYPE, data };
    const entries = [entry("old", "grants", ["enabled"], true), malformed];
    expect(() => parseSessionStateEntry(malformed)).toThrow();
    expect(() => readSessionState(entries, "grants")).toThrow();
    expect(() => latestSessionStateEntries(entries)).toThrow();
  });

  it.each([null, {}, { version: 2 }])("rejects malformed reset data rather than reviving previous state: %j", (data) => {
    const entries = [entry("old", "grants", ["enabled"], true),
      { type: "custom", id: "reset", customType: SESSION_STATE_RESET_CUSTOM_TYPE, data }];
    expect(() => readSessionState(entries, "grants")).toThrow("reset");
    expect(() => latestSessionStateEntries(entries)).toThrow("reset");
  });

  it.each([SESSION_STATE_CUSTOM_TYPE, SESSION_STATE_RESET_CUSTOM_TYPE])("rejects recognized entries without a native revision: %s", (customType) => {
    const malformed = { ...entry("", "grants", [], false), customType };
    expect(() => latestSessionStateEntries([entry("old", "grants", ["enabled"]), malformed])).toThrow();
  });

  it("validates public capability selection and output, with detached write admission", async () => {
    const selection = { projectId: "p", workspaceId: "w", sessionId: "s" };
    const cap = PI_WEB_HOST_SESSION_STATE_CAPABILITY.parse({ version: 1, read: () => ({ revision: "" }), write: () => ({ revision: "broken" }) });
    await expect(cap.read({ ...selection, sessionId: "" }, "example")).rejects.toThrow();
    await expect(cap.write(selection, "example", { value: true, inherit: false, revision: "" })).rejects.toThrow();
    expect(await cap.read(selection, "example")).toEqual({ revision: "" });
  });
});
