import { afterEach, describe, expect, it, vi } from "vitest";
import { isNavigationPinned, loadNavigationPreferences, moveNavigationTab, orderedNavigationTabs, pinnedNavigationTabs, saveNavigationPreferences, toggleNavigationPin } from "./navigationPreferences";

const tabs = [{ id: "navigation" }, { id: "chat" }, { id: "plugin:files" }];

afterEach(() => { vi.unstubAllGlobals(); });

describe("navigation preferences", () => {
  it("shows all tabs for empty pins and explicit all pins, in destination order", () => {
    expect(pinnedNavigationTabs(tabs, [])).toEqual(tabs);
    expect(pinnedNavigationTabs(tabs, ["plugin:files", "chat", "navigation"])).toEqual(tabs);
    expect(pinnedNavigationTabs(tabs, ["plugin:files"])).toEqual([tabs[2]]);
  });

  it("materializes implicit all pins on unpin and treats removing the last pin as all", () => {
    expect(toggleNavigationPin("chat", [], tabs.map((tab) => tab.id))).toEqual(["navigation", "plugin:files"]);
    const pins = toggleNavigationPin("chat", ["chat"], []);
    expect(pins).toEqual([]);
    expect(isNavigationPinned("plugin:files", pins)).toBe(true);
  });

  it("retains unavailable plugins through filtering and pin management", () => {
    const pins = ["missing:tool"];
    expect(pinnedNavigationTabs(tabs, pins)).toEqual([]);
    expect(toggleNavigationPin("chat", pins, ["chat"])).toEqual(["missing:tool", "chat"]);
    expect(pinnedNavigationTabs([{ id: "missing:tool" }], pins)).toEqual([{ id: "missing:tool" }]);
    expect(pins).toEqual(["missing:tool"]);
  });

  it("applies remembered order before unseen defaults without mutating tabs or duplicating IDs", () => {
    const order = ["missing:tool", "plugin:files", "plugin:files", "navigation"];
    expect(orderedNavigationTabs(tabs)).toEqual(tabs);
    expect(orderedNavigationTabs(tabs, order)).toEqual([tabs[2], tabs[0], tabs[1]]);
    expect(orderedNavigationTabs([...tabs, { id: "missing:tool" }, { id: "new:tool" }], order).map((tab) => tab.id))
      .toEqual(["missing:tool", "plugin:files", "navigation", "chat", "new:tool"]);
    expect(tabs.map((tab) => tab.id)).toEqual(["navigation", "chat", "plugin:files"]);
    expect(order).toEqual(["missing:tool", "plugin:files", "plugin:files", "navigation"]);
  });

  it("materializes the full universe for the first move in either direction", () => {
    const available = tabs.map((tab) => tab.id);
    expect(moveNavigationTab("plugin:files", "chat", "before", undefined, available)).toEqual(["navigation", "plugin:files", "chat"]);
    expect(moveNavigationTab("navigation", "plugin:files", "after", [], available)).toEqual(["chat", "plugin:files", "navigation"]);
    expect(available).toEqual(["navigation", "chat", "plugin:files"]);
  });

  it("preserves unavailable and hidden destinations while moving visible neighbors", () => {
    const order = ["missing:tool", "chat", "navigation", "plugin:files"];
    const available = [...tabs.map((tab) => tab.id), "new:tool"];
    expect(moveNavigationTab("plugin:files", "chat", "before", order, available))
      .toEqual(["missing:tool", "plugin:files", "chat", "navigation", "new:tool"]);
    expect(moveNavigationTab("chat", "plugin:files", "after", order, available))
      .toEqual(["missing:tool", "navigation", "plugin:files", "chat", "new:tool"]);
    expect(order).toEqual(["missing:tool", "chat", "navigation", "plugin:files"]);
  });

  it.each([
    ["chat", "chat"], ["unknown", "chat"], ["chat", "unknown"],
  ])("ignores invalid moves (%s, %s) without losing the known universe", (id, neighborId) => {
    expect(moveNavigationTab(id, neighborId, "before", ["chat", "chat", "missing:tool"], tabs.map((tab) => tab.id)))
      .toEqual(["chat", "missing:tool", "navigation", "plugin:files"]);
  });

  it("round-trips order independently from pins and mobile collapse", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const preferences = { pinnedIds: ["chat"], orderedIds: ["missing:tool", "plugin:files", "chat"], mobileCollapsed: true };
    expect(saveNavigationPreferences(preferences, storage)).toBe(true);
    expect(loadNavigationPreferences(storage)).toEqual(preferences);
    const changed = { ...preferences, pinnedIds: [], mobileCollapsed: false };
    saveNavigationPreferences(changed, storage);
    expect(loadNavigationPreferences(storage)).toEqual(changed);
  });

  it.each([
    { orderedIds: ["chat", 5, "chat", "", null, "missing:tool"], expected: ["chat", "missing:tool"] },
    { orderedIds: "chat", expected: [] },
    { orderedIds: null, expected: [] },
  ])("sanitizes order only when present: $orderedIds", ({ orderedIds, expected }) => {
    expect(loadNavigationPreferences({ getItem: () => JSON.stringify({ orderedIds }) }))
      .toEqual({ pinnedIds: [], orderedIds: expected, mobileCollapsed: false });
  });

  it("round-trips pins independently from mobile collapse", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const preferences = { pinnedIds: ["missing:tool"], mobileCollapsed: true };
    saveNavigationPreferences(preferences, storage);
    expect(loadNavigationPreferences(storage)).toEqual(preferences);
    saveNavigationPreferences({ ...preferences, mobileCollapsed: false }, storage);
    expect(loadNavigationPreferences(storage)).toEqual({ ...preferences, mobileCollapsed: false });
  });

  it("reports unavailable browser storage as an unsuccessful save", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(saveNavigationPreferences({ pinnedIds: [], mobileCollapsed: true })).toBe(false);
  });

  it("defaults safely for malformed or unavailable storage and validates stored values", () => {
    const storage = (raw: string) => ({ getItem: () => raw });
    expect(loadNavigationPreferences(storage("{"))).toEqual({ pinnedIds: [], mobileCollapsed: false });
    expect(loadNavigationPreferences(storage('{"pinnedIds":["chat",5,"chat",""],"mobileCollapsed":"true"}'))).toEqual({ pinnedIds: ["chat"], mobileCollapsed: false });
    const blocked = { getItem: () => { throw new Error("Blocked"); }, setItem: () => { throw new Error("Blocked"); } };
    expect(loadNavigationPreferences(blocked)).toEqual({ pinnedIds: [], mobileCollapsed: false });
    expect(saveNavigationPreferences({ pinnedIds: [], mobileCollapsed: true }, blocked)).toBe(false);
  });
});
