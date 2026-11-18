// @vitest-environment happy-dom
import { installNativeDialogFake } from "../nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, expect, it, vi } from "vitest";
import { NavigationDialog } from "./NavigationDialog";
import type { ModalSurface } from "../ModalSurface";
import { deepActiveElement } from "../modalLayerRegistry";
import { orderedNavigationTabs } from "../../navigationPreferences";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("focuses search, supports button navigation and traps Tab, then restores focus on Escape", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const dialog = new NavigationDialog();
  dialog.tabs = [{ id: "chat", label: "Chat" }, { id: "tools:files", label: "Files" }];
  dialog.selectedTab = "tools:files";
  dialog.onClose = () => { dialog.remove(); };
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  document.body.append(dialog);
  await dialog.updateComplete;
  const surface = dialog.shadowRoot?.querySelector<ModalSurface>("modal-surface");
  if (surface == null) throw new Error("Expected shared modal surface");
  await surface.updateComplete;
  expect(surface.shadowRoot?.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Navigation");
  const input = dialog.shadowRoot?.querySelector("input");
  expect(deepActiveElement(document)).toBe(input);
  dialog.shadowRoot?.querySelector<HTMLButtonElement>('.destination-button[aria-pressed="true"]')?.focus();
  const key = (value: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, composed: true, cancelable: true });
    deepActiveElement(document)?.dispatchEvent(event);
    return event;
  };
  expect(key("ArrowUp").defaultPrevented).toBe(true);
  expect(deepActiveElement(document)?.textContent).toBe("Chat");
  key("End");
  expect(deepActiveElement(document)?.textContent).toBe("Files");
  key("Home");
  expect(deepActiveElement(document)?.textContent).toBe("Chat");
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  input?.focus();
  expect(key("Tab", true).defaultPrevented).toBe(true);
  expect(deepActiveElement(document)?.textContent).toBe("Collapsed");
  expect(key("Tab").defaultPrevented).toBe(true);
  expect(deepActiveElement(document)).toBe(input);
  const composingEscape = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, composed: true, cancelable: true });
  input?.dispatchEvent(composingEscape);
  expect(composingEscape.defaultPrevented).toBe(false);
  expect(dialog.isConnected).toBe(true);
  expect(key("Escape").defaultPrevented).toBe(true);
  expect(dialog.isConnected).toBe(false);
  expect(deepActiveElement(document)).toBe(opener);
});

it("filters destinations and navigates results from search without changing pins", async () => {
  const dialog = new NavigationDialog();
  dialog.tabs = [{ id: "chat", label: "Chat" }, { id: "tools:files", label: "Files" }, { id: "tools:find", label: "Find" }];
  dialog.onSelect = vi.fn();
  dialog.onClose = vi.fn();
  dialog.onPreferencesChange = vi.fn();
  document.body.append(dialog);
  await dialog.updateComplete;
  const input = dialog.shadowRoot?.querySelector("input");
  if (input == null) throw new Error("Expected navigation search input");
  const search = async (query: string) => {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await dialog.updateComplete;
  };
  const key = async (key: string) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
    await dialog.updateComplete;
  };
  const selected = () => dialog.shadowRoot?.querySelector('.destination-button.selected')?.textContent;
  const announcement = () => dialog.shadowRoot?.querySelector('[role="status"]')?.textContent;
  await search(" FI ");
  expect(dialog.shadowRoot?.querySelectorAll(".destination-button")).toHaveLength(2);
  expect(selected()).toBe("Files");
  expect(input.getAttribute("aria-describedby")).toBe("navigation-selection");
  expect(announcement()).toBe("Files, 1 of 2");
  await key("ArrowUp");
  expect(selected()).toBe("Find");
  expect(announcement()).toBe("Find, 2 of 2");
  expect(dialog.shadowRoot?.querySelector('[aria-current]')).toBeNull();
  await key("ArrowDown");
  expect(selected()).toBe("Files");
  await key("End");
  expect(selected()).toBe("Find");
  await key("Home");
  expect(selected()).toBe("Files");
  const composingEnter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, composed: true, cancelable: true });
  input.dispatchEvent(composingEnter);
  expect(composingEnter.defaultPrevented).toBe(false);
  expect(dialog.onSelect).not.toHaveBeenCalled();
  await key("Enter");
  expect(dialog.onSelect).toHaveBeenCalledWith("tools:files");
  expect(dialog.onClose).toHaveBeenCalledOnce();
  expect(dialog.onPreferencesChange).not.toHaveBeenCalled();
  await search("missing");
  expect(dialog.shadowRoot?.textContent).toContain("No destinations found.");
  expect(announcement()).toBe("No destinations found.");
  await key("ArrowDown");
  await key("Enter");
  expect(dialog.onSelect).toHaveBeenCalledOnce();
  await search("");
  expect(selected()).toBe("Chat");
});

it("offers unpinned destinations and closes after navigating without modifying pins", async () => {
  const dialog = new NavigationDialog();
  dialog.tabs = [{ id: "chat", label: "Chat" }, { id: "tools:files", label: "Files" }];
  dialog.preferences = { pinnedIds: ["chat", "missing:tool"], mobileCollapsed: true };
  dialog.selectedTab = "tools:files";
  dialog.onSelect = vi.fn();
  dialog.onClose = vi.fn();
  dialog.onPreferencesChange = vi.fn();
  document.body.append(dialog);
  await dialog.updateComplete;
  const pin = dialog.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Pin Files"]');
  expect(pin?.getAttribute("aria-pressed")).toBe("false");
  expect(pin?.querySelector("svg")).not.toBeNull();
  const files = dialog.shadowRoot?.querySelector<HTMLButtonElement>('.destination-button[aria-pressed="true"]');
  expect(files?.textContent).toBe("Files");
  files?.click();
  expect(dialog.onSelect).toHaveBeenCalledWith("tools:files");
  expect(dialog.onClose).toHaveBeenCalledOnce();
  expect(dialog.onPreferencesChange).not.toHaveBeenCalled();
});

it("moves destinations without navigating or changing pins, and keeps keyboard focus on the moved item", async () => {
  const dialog = new NavigationDialog();
  dialog.tabs = [{ id: "chat", label: "Chat" }, { id: "tools:files", label: "Files" }, { id: "tools:find", label: "Find" }];
  dialog.pinUniverse = ["navigation", "chat", "tools:files", "tools:find"];
  dialog.preferences = { pinnedIds: ["chat"], mobileCollapsed: false };
  dialog.selectedTab = "chat";
  dialog.onSelect = vi.fn();
  dialog.onClose = vi.fn();
  dialog.onPreferencesChange = (preferences) => { dialog.preferences = preferences; };
  document.body.append(dialog);
  await dialog.updateComplete;
  const button = (name: string) => {
    const target = [...dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []].find((element) => element.getAttribute("aria-label") === name);
    if (target === undefined) throw new Error(`Missing button ${name}`);
    return target;
  };
  button("Move Files up").focus();
  button("Move Files up").click();
  await dialog.updateComplete;
  expect(dialog.preferences).toEqual({ pinnedIds: ["chat"], mobileCollapsed: false, orderedIds: ["navigation", "tools:files", "chat", "tools:find"] });
  expect([...dialog.shadowRoot?.querySelectorAll(".destination-button") ?? []].map((element) => element.textContent)).toEqual(["Files", "Chat", "Find"]);
  expect(deepActiveElement(document)).toBe(button("Reorder Files"));
  expect(button("Move Files up").disabled).toBe(true);
  button("Reorder Files").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true, cancelable: true }));
  await dialog.updateComplete;
  expect(dialog.preferences.orderedIds).toEqual(["navigation", "chat", "tools:files", "tools:find"]);
  expect(deepActiveElement(document)).toBe(button("Reorder Files"));
  expect(dialog.shadowRoot?.querySelector('.destination-button[aria-current="page"]')?.textContent).toBe("Chat");
  expect(dialog.onSelect).not.toHaveBeenCalled();
  expect(dialog.onClose).not.toHaveBeenCalled();
  const input = dialog.shadowRoot?.querySelector("input");
  if (input == null) throw new Error("Missing search");
  input.value = "Fi";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await dialog.updateComplete;
  expect(button("Move Files down").disabled).toBe(true);
  expect(button("Reorder Files").disabled).toBe(true);
  const before = dialog.preferences;
  button("Reorder Files").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true, cancelable: true }));
  button("Move Files down").click();
  expect(dialog.preferences).toBe(before);
});

it.each(["", "a"])("keeps the highlighted destination after resetting the whole order during search %j", async (query) => {
  const dialog = new NavigationDialog();
  const defaults = [{ id: "chat", label: "Chat" }, { id: "tools:files", label: "Files" }, { id: "tools:find", label: "Find" }] as const;
  dialog.preferences = { pinnedIds: ["chat"], mobileCollapsed: true, orderedIds: ["tools:files", "chat", "tools:find"] };
  dialog.tabs = orderedNavigationTabs(defaults, dialog.preferences.orderedIds);
  dialog.selectedTab = "chat";
  dialog.onSelect = vi.fn();
  // Like the app, the owner publishes preferences together with ordered tabs.
  dialog.onPreferencesChange = (preferences) => {
    queueMicrotask(() => {
      dialog.preferences = preferences;
      dialog.tabs = orderedNavigationTabs(defaults, preferences.orderedIds);
    });
  };
  document.body.append(dialog);
  await dialog.updateComplete;
  const input = dialog.shadowRoot?.querySelector("input");
  if (input == null) throw new Error("Missing search");
  if (query !== "") {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await dialog.updateComplete;
  }
  expect(dialog.shadowRoot?.querySelector(".destination-button.selected")?.textContent).toBe("Chat");
  const reset = [...dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>("footer button") ?? []].find((button) => button.textContent === "Reset order");
  if (reset === undefined) throw new Error("Missing reset button");
  expect(reset.disabled).toBe(false);
  reset.click();
  await dialog.updateComplete;
  await dialog.updateComplete;
  expect(dialog.preferences).toEqual({ pinnedIds: ["chat"], mobileCollapsed: true });
  expect(dialog.shadowRoot?.querySelector(".destination-button.selected")?.textContent).toBe("Chat");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
  expect(dialog.onSelect).toHaveBeenCalledWith("chat");
});

it("toggles icon pins and mobile layout independently, resets tabs, and uses shared Escape handling", async () => {
  const dialog = new NavigationDialog();
  dialog.tabs = [{ id: "chat", label: "Chat" }, { id: "tools:files", label: "Files" }];
  dialog.preferences = { pinnedIds: ["chat", "missing:tool"], mobileCollapsed: true };
  dialog.onPreferencesChange = (preferences) => { dialog.preferences = preferences; };
  dialog.onClose = vi.fn();
  document.body.append(dialog);
  await dialog.updateComplete;
  dialog.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Pin Files"]')?.click();
  await dialog.updateComplete;
  expect(dialog.preferences).toEqual({ pinnedIds: ["chat", "missing:tool", "tools:files"], mobileCollapsed: true });
  expect(dialog.shadowRoot?.querySelector('button[aria-label="Pin Files"]')?.getAttribute("aria-pressed")).toBe("true");
  const modes = [...dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>('.mobile-navigation button') ?? []];
  expect(modes.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
  modes[0]?.click();
  await dialog.updateComplete;
  expect(dialog.preferences).toEqual({ pinnedIds: ["chat", "missing:tool", "tools:files"], mobileCollapsed: false });
  expect(modes.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  modes[1]?.click();
  await dialog.updateComplete;
  dialog.shadowRoot?.querySelector<HTMLButtonElement>("footer button")?.click();
  await dialog.updateComplete;
  expect(dialog.preferences).toEqual({ pinnedIds: [], mobileCollapsed: true });
  expect([...dialog.shadowRoot?.querySelectorAll(".pin-button") ?? []].every((button) => button.getAttribute("aria-pressed") === "true")).toBe(true);
  expect(dialog.shadowRoot?.querySelector('input[type="checkbox"]')).toBeNull();
  const surface = dialog.shadowRoot?.querySelector<ModalSurface>("modal-surface");
  if (surface == null) throw new Error("Expected shared modal surface");
  await surface.updateComplete;
  deepActiveElement(document)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  expect(dialog.onClose).toHaveBeenCalledOnce();
});
