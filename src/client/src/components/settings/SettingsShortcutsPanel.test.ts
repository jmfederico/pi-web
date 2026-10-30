// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppAction } from "../../actions";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE } from "../../composerShortcuts";
import { shortcutSequenceTimeoutMs } from "../../keyboardShortcuts";
import { SettingsShortcutsPanel } from "./SettingsShortcutsPanel";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("settings-shortcuts-panel layout", () => {
  it("renders the shared frame, ordered notices, and composer actions without registered app actions", async () => {
    const panel = new SettingsShortcutsPanel();
    panel.configResponse = configResponse({ shortcuts: {} });
    panel.error = "Failed to load shortcut settings.";
    panel.savedMessage = "Shortcut settings saved.";
    panel.onReload = vi.fn();
    await mount(panel);

    const frame = frameRoot(panel);
    expect(frame.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
    expect(frame.querySelector(".description")?.textContent).toContain("Type or record a shortcut, then save each action.");
    expect(frame.querySelector("code")?.textContent).toBe("mod");
    expect([...frame.querySelectorAll(".notice")].map((notice) => ({
      role: notice.getAttribute("role"),
      text: notice.textContent.trim(),
    }))).toEqual([
      { role: "alert", text: "Failed to load shortcut settings." },
      { role: "status", text: "Shortcut settings saved." },
    ]);
    button(frame, "Refresh shortcuts").click();
    expect(panel.onReload).toHaveBeenCalledOnce();
    expect(panel.renderRoot.querySelector(".config-path-card")?.textContent).toContain("/tmp/pi-web/config.json");
    expect([...panel.renderRoot.querySelectorAll("h3")].map((heading) => heading.textContent)).toContain("Chat composer");
    expect(row(panel, COMPOSER_SEND_DESKTOP).textContent).toContain("Send message — desktop");
    expect(row(panel, COMPOSER_SEND_MOBILE).textContent).toContain("Send message — touch or narrow screen");
    expect(panel.renderRoot.textContent).toContain("Touch or narrow screen applies when the primary pointer is coarse or the viewport is at most 760px wide. Desktop applies otherwise.");
    expect(panel.renderRoot.querySelectorAll("article")).toHaveLength(2);
    expect(panel.renderRoot.querySelector('input[type="radio"]')).toBeNull();
    expect(panel.renderRoot.textContent).not.toContain("No actions registered.");
  });

  it("renders the loading state without the old prompt-enter card", async () => {
    const panel = new SettingsShortcutsPanel();
    panel.loading = true;
    await mount(panel);

    expect(frameRoot(panel).querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
    expect(button(frameRoot(panel), "Refresh shortcuts").disabled).toBe(true);
    expect(panel.renderRoot.querySelector(".loading-card")?.textContent).toBe("Loading shortcuts…");
    expect(panel.renderRoot.querySelector(".config-path-card")).toBeNull();
    expect(panel.renderRoot.querySelector(".prompt-enter-card")).toBeNull();
  });
});

describe("settings-shortcuts-panel send behavior", () => {
  it("defaults to steer and saves either behavior without dropping other config", async () => {
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({ shortcuts: { "core:other": "mod+o" } }, onSave);
    const select = panel.renderRoot.querySelector<HTMLSelectElement>('select[aria-label="Send while agent is running"]');
    if (select === null) throw new Error("Missing send behavior setting");
    expect(select.value).toBe("steer");
    select.value = "followUp";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onSave).toHaveBeenLastCalledWith({ defaultStreamingBehavior: "followUp" });
    panel.configResponse = configResponse({ defaultStreamingBehavior: "followUp" });
    await settle(panel);
    expect(select.value).toBe("followUp");
    select.value = "steer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onSave).toHaveBeenLastCalledWith({ defaultStreamingBehavior: "steer" });
  });
});

describe("settings-shortcuts-panel shortcut row actions", () => {
  it("saves edited shortcuts, disables them with None, and resets overrides", async () => {
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({ shortcuts: { "core:other": "mod+o" } }, onSave);
    await editShortcut(panel, "core:open-palette", " control + shift + p ");

    expect(row(panel, "core:open-palette").querySelector(".shortcut-status")?.textContent).toContain("Ctrl+Shift+P");
    expect(row(panel, "core:open-palette").textContent).toContain("Custom · Unsaved");
    await clickRow(panel, "core:open-palette", "Save");
    expect(onSave).toHaveBeenLastCalledWith({ shortcuts: { "core:other": "mod+o", "core:open-palette": "mod+shift+p" } });

    panel.configResponse = configResponse({ shortcuts: { "core:open-palette": "mod+shift+p", "core:other": "mod+o" } });
    await settle(panel);
    await clickRow(panel, "core:open-palette", "Disable shortcut");
    expect(onSave).toHaveBeenLastCalledWith({ shortcuts: { "core:open-palette": null, "core:other": "mod+o" } });

    panel.configResponse = configResponse({ shortcuts: { "core:open-palette": null, "core:other": "mod+o" } });
    await settle(panel);
    expect(row(panel, "core:open-palette").textContent).toContain("Disabled");
    await clickRow(panel, "core:open-palette", "Restore default");
    expect(onSave).toHaveBeenLastCalledWith({ shortcuts: { "core:other": "mod+o" } });
    expect(onSave).toHaveBeenCalledTimes(3);
  });

  it.each(["Save", "Disable shortcut", "Restore default"] as const)("migrates former action ids when using %s", async (operation) => {
    const onSave = vi.fn<SaveHandler>();
    const action = shortcutAction({ id: "git:view.git", shortcutAliases: ["core:view.git"], shortcut: "mod+3" });
    const panel = await panelWithShortcuts({ shortcuts: { "core:view.git": "mod+8", "core:other": "mod+o" } }, onSave, action);

    expect(input(panel, action.id).value).toBe("mod+8");
    expect(row(panel, action.id).querySelector(".shortcut-status")?.textContent).toContain("Ctrl+8");
    expect(row(panel, action.id).textContent).toContain("Custom");
    if (operation === "Save") await editShortcut(panel, action.id, "mod+9");
    await clickRow(panel, action.id, operation);

    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      shortcuts: {
        "core:other": "mod+o",
        ...(operation === "Restore default" ? {} : { "git:view.git": operation === "Disable shortcut" ? null : "mod+9" }),
      },
    });
  });
});

describe("settings-shortcuts-panel draft preservation", () => {
  it("preserves multiple drafts through recording, one-row save acknowledgement, and refresh", async () => {
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({ shortcuts: {} }, onSave);
    await editShortcut(panel, COMPOSER_SEND_DESKTOP, "mod+enter");
    await editShortcut(panel, "core:open-palette", "mod+p");
    await clickRow(panel, COMPOSER_SEND_MOBILE, "Record");
    pressKey("Enter", { shiftKey: true });
    await settle(panel);
    expect(input(panel, COMPOSER_SEND_DESKTOP).value).toBe("mod+enter");
    expect(input(panel, "core:open-palette").value).toBe("mod+p");
    await clickRow(panel, "core:open-palette", "Save");
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ shortcuts: { "core:open-palette": "mod+p" } });
    expect(row(panel, "core:open-palette").textContent).toContain("Unsaved");
    panel.configResponse = configResponse(onSave.mock.lastCall?.[0] ?? {});
    await settle(panel);
    expect(row(panel, "core:open-palette").textContent).not.toContain("Unsaved");
    expect(button(row(panel, "core:open-palette"), "Save").disabled).toBe(true);
    expect(input(panel, COMPOSER_SEND_DESKTOP).value).toBe("mod+enter");
    expect(input(panel, COMPOSER_SEND_MOBILE).value).toBe("shift+enter");

    panel.onReload = vi.fn(() => {
      panel.configResponse = configResponse({ shortcuts: { "core:open-palette": "mod+o" } });
    });
    await settle(panel);
    button(frameRoot(panel), "Refresh shortcuts").click();
    await settle(panel);
    expect(panel.onReload).toHaveBeenCalledOnce();
    expect(input(panel, "core:open-palette").value).toBe("mod+o");
    for (const actionId of [COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE]) {
      expect(row(panel, actionId).textContent).toContain("Unsaved");
      expect(button(row(panel, actionId), "Save").disabled).toBe(false);
    }
    expect(input(panel, COMPOSER_SEND_DESKTOP).value).toBe("mod+enter");
    expect(input(panel, COMPOSER_SEND_MOBILE).value).toBe("shift+enter");
  });

  it("retains failed saves when the owner handles the error or the callback rejects", async () => {
    const panel = await panelWithShortcuts({}, vi.fn(() => { panel.error = "Save failed. Try again."; }));
    await editShortcut(panel, "core:open-palette", "mod+p");
    await editShortcut(panel, COMPOSER_SEND_DESKTOP, "mod+enter");
    await clickRow(panel, "core:open-palette", "Save");
    panel.configResponse = configResponse({ shortcuts: { "core:open-palette": "mod+o" } });
    await settle(panel);
    expect(input(panel, "core:open-palette").value).toBe("mod+p");
    expect(row(panel, "core:open-palette").textContent).toContain("Unsaved");
    expect(frameRoot(panel).querySelector('[role="alert"]')?.textContent).toContain("Save failed");
    panel.onSave = vi.fn().mockRejectedValue(new Error("Connection lost"));
    await clickRow(panel, "core:open-palette", "Save");
    expect(frameRoot(panel).querySelector('[role="alert"]')?.textContent).toContain("Could not save shortcut. Connection lost");
    expect(input(panel, "core:open-palette").value).toBe("mod+p");
    expect(input(panel, COMPOSER_SEND_DESKTOP).value).toBe("mod+enter");
  });

  it.each(["Disable shortcut", "Restore default"])("clears only the acknowledged row draft after %s", async (operation) => {
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({ shortcuts: { "core:open-palette": "mod+o" } }, onSave);
    await editShortcut(panel, "core:open-palette", "mod+p");
    await editShortcut(panel, COMPOSER_SEND_DESKTOP, "mod+enter");
    await clickRow(panel, "core:open-palette", operation);
    panel.configResponse = configResponse(onSave.mock.lastCall?.[0] ?? {});
    await settle(panel);
    expect(input(panel, "core:open-palette").value).toBe(operation === "Disable shortcut" ? "" : "mod+k");
    expect(row(panel, "core:open-palette").textContent).not.toContain("Unsaved");
    expect(input(panel, COMPOSER_SEND_DESKTOP).value).toBe("mod+enter");
  });

  it("does not erase a newer draft when an earlier save is acknowledged", async () => {
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({}, onSave);
    await editShortcut(panel, "core:open-palette", "mod+p");
    await clickRow(panel, "core:open-palette", "Save");
    await editShortcut(panel, "core:open-palette", "mod+o");
    panel.configResponse = configResponse(onSave.mock.lastCall?.[0] ?? {});
    await settle(panel);
    expect(input(panel, "core:open-palette").value).toBe("mod+o");
    expect(row(panel, "core:open-palette").textContent).toContain("Unsaved");
  });
});

describe("settings-shortcuts-panel accessibility", () => {
  it("names row controls by action and describes recording and conflicts clearly", async () => {
    const panel = await panelWithShortcuts({}, vi.fn());
    const actionId = "core:open-palette";
    expect(input(panel, actionId).getAttribute("aria-label")).toBe("Shortcut for Open palette");
    for (const [text, name] of [
      ["Save", "Save shortcut for Open palette"],
      ["Record", "Record shortcut for Open palette"],
      ["Disable shortcut", "Disable shortcut for Open palette"],
      ["Restore default", "Restore default shortcut for Open palette"],
    ] as const) expect(button(row(panel, actionId), text).getAttribute("aria-label")).toBe(name);
    expect(frameRoot(panel).querySelector(".description")?.textContent).toContain("⌘ on Mac or Ctrl elsewhere");
    const details = panel.renderRoot.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Shortcut details");
    expect(details?.textContent).toContain("Shorter shortcuts block longer sequences");
    await clickRow(panel, actionId, "Record");
    const hint = row(panel, actionId).querySelector(".recording-hint");
    expect(hint?.getAttribute("role")).toBe("status");
    expect(hint?.id).toBe(input(panel, actionId).getAttribute("aria-describedby"));
    expect(hint?.textContent).toContain("Recording shortcut: press a key combination or sequence");
    expect(button(row(panel, actionId), "Cancel recording").getAttribute("aria-label")).toBe("Cancel recording for Open palette");
    await clickRow(panel, actionId, "Cancel recording");
    panel.actions = [shortcutAction(), shortcutAction({ id: "core:other", title: "Other action", shortcut: "mod+p" })];
    await settle(panel);
    await editShortcut(panel, actionId, "mod+p");
    expect(row(panel, actionId).querySelector(".conflict")?.textContent).toContain("Conflict: takes priority over 1 action: Other action");
    expect(row(panel, "core:other").querySelector(".conflict")?.textContent).toContain("Conflict: inactive; used by Open palette");
  });

  it("disables editing when config is unavailable while allowing refresh", async () => {
    const panel = new SettingsShortcutsPanel();
    panel.onSave = vi.fn();
    panel.onReload = vi.fn();
    await mount(panel);
    expect(panel.renderRoot.textContent).toContain("Shortcut settings are unavailable. Refresh shortcuts to try again.");
    for (const control of panel.renderRoot.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select")) {
      expect(control.disabled).toBe(true);
      if (control instanceof HTMLButtonElement) control.click();
    }
    expect(panel.onSave).not.toHaveBeenCalled();
    expect(button(frameRoot(panel), "Refresh shortcuts").disabled).toBe(false);
    button(frameRoot(panel), "Refresh shortcuts").click();
    expect(panel.onReload).toHaveBeenCalledOnce();
    panel.configResponse = configResponse({});
    panel.loading = true;
    await settle(panel);
    expect(input(panel, COMPOSER_SEND_DESKTOP).disabled).toBe(true);
  });
});

describe("settings-shortcuts-panel composer shortcuts", () => {
  it("saves desktop and mobile independently even when both share an app shortcut", async () => {
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({ shortcuts: {} }, onSave);
    for (const actionId of [COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE]) {
      const otherId = actionId === COMPOSER_SEND_DESKTOP ? COMPOSER_SEND_MOBILE : COMPOSER_SEND_DESKTOP;
      const otherBinding = input(panel, otherId).value;
      await editShortcut(panel, actionId, "mod+k");
      expect(input(panel, otherId).value).toBe(otherBinding);
      expect(panel.renderRoot.querySelector(".conflict")).toBeNull();
      await clickRow(panel, actionId, "Save");
      const savedConfig = onSave.mock.lastCall?.[0];
      expect(savedConfig).toEqual({ shortcuts: {
        ...(actionId === COMPOSER_SEND_MOBILE ? { [COMPOSER_SEND_DESKTOP]: "mod+k" } : {}),
        [actionId]: "mod+k",
      } });
      panel.configResponse = configResponse(savedConfig ?? {});
      await settle(panel);
    }
    for (const actionId of [COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE, "core:open-palette"]) {
      expect(input(panel, actionId).value).toBe("mod+k");
    }
    expect(panel.renderRoot.querySelector(".conflict")).toBeNull();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it.each([COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE])("rejects a multi-key sequence for %s on save", async (actionId) => {
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({ shortcuts: {} }, onSave);
    await editShortcut(panel, actionId, "g p");
    await clickRow(panel, actionId, "Save");

    expect(onSave).not.toHaveBeenCalled();
    expect(frameRoot(panel).querySelector('[role="alert"]')?.textContent).toContain(
      "Composer send shortcuts must be a single key combination, not a sequence.",
    );
    expect(input(panel, actionId).value).toBe("g p");
  });

  it.each([COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE])("records one combination and stops immediately for %s", async (actionId) => {
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({ shortcuts: {} }, onSave);
    await clickRow(panel, actionId, "Record");
    expect(panel.shadowRoot?.activeElement).toBe(input(panel, actionId));
    pressKey("Enter", { shiftKey: true });
    await settle(panel);

    expect(input(panel, actionId).value).toBe("shift+enter");
    expect(row(panel, actionId).querySelector(".recording-hint")).toBeNull();
    expect(button(row(panel, actionId), "Record")).toBeDefined();
    pressKey("p");
    await settle(panel);
    expect(input(panel, actionId).value).toBe("shift+enter");
    expect(onSave).not.toHaveBeenCalled();
    await clickRow(panel, actionId, "Save");
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ shortcuts: { [actionId]: "shift+enter" } });
  });

  it("records an unmodified global g p sequence and finishes after the sequence timeout", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn<SaveHandler>();
    const panel = await panelWithShortcuts({ shortcuts: {} }, onSave);
    await clickRow(panel, "core:open-palette", "Record");
    pressKey("g");
    await settle(panel);
    expect(input(panel, "core:open-palette").value).toBe("g");
    pressKey("p");
    await settle(panel);
    expect(input(panel, "core:open-palette").value).toBe("g p");
    expect(button(row(panel, "core:open-palette"), "Cancel recording")).toBeDefined();

    await vi.advanceTimersByTimeAsync(shortcutSequenceTimeoutMs);
    await settle(panel);
    expect(row(panel, "core:open-palette").querySelector(".recording-hint")).toBeNull();
    expect(button(row(panel, "core:open-palette"), "Record")).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
    await clickRow(panel, "core:open-palette", "Save");
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ shortcuts: { "core:open-palette": "g p" } });
  });
});

type SaveHandler = (config: PiWebConfigValues) => void | Promise<void>;

async function settle(panel: SettingsShortcutsPanel): Promise<void> {
  await panel.updateComplete;
  const frame = panel.renderRoot.querySelector("settings-panel-frame");
  if (frame === null) throw new Error("Expected settings panel frame");
  await frame.updateComplete;
}

async function mount(panel: SettingsShortcutsPanel): Promise<void> {
  document.body.append(panel);
  await settle(panel);
}

function frameRoot(panel: SettingsShortcutsPanel): ShadowRoot {
  const root = panel.renderRoot.querySelector("settings-panel-frame")?.shadowRoot;
  if (root == null) throw new Error("Expected settings panel frame shadow root");
  return root;
}

function input(panel: SettingsShortcutsPanel, actionId: string): HTMLInputElement {
  const result = [...panel.renderRoot.querySelectorAll("input")].find((element) => element.dataset["actionId"] === actionId);
  if (result === undefined) throw new Error(`Expected shortcut input for ${actionId}`);
  return result;
}

function row(panel: SettingsShortcutsPanel, actionId: string): HTMLElement {
  const result = input(panel, actionId).closest("article");
  if (result === null) throw new Error(`Expected shortcut row for ${actionId}`);
  return result;
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const result = [...root.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
  if (result === undefined) throw new Error(`Expected button: ${label}`);
  return result;
}

async function clickRow(panel: SettingsShortcutsPanel, actionId: string, label: string): Promise<void> {
  const control = button(row(panel, actionId), label);
  expect(control.disabled).toBe(false);
  control.click();
  await settle(panel);
}

async function editShortcut(panel: SettingsShortcutsPanel, actionId: string, value: string): Promise<void> {
  const control = input(panel, actionId);
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await settle(panel);
}

function pressKey(key: string, modifiers: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
}

async function panelWithShortcuts(config: PiWebConfigValues, onSave: SaveHandler, action = shortcutAction()): Promise<SettingsShortcutsPanel> {
  const panel = new SettingsShortcutsPanel();
  panel.actions = [action];
  panel.configResponse = configResponse(config);
  panel.onSave = onSave;
  await mount(panel);
  return panel;
}

function shortcutAction(patch: Partial<AppAction> = {}): AppAction {
  return {
    id: "core:open-palette",
    title: "Open palette",
    description: "Open the command palette.",
    shortcut: "mod+k",
    group: "Navigation",
    run: vi.fn(),
    ...patch,
  };
}

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false },
  };
}
