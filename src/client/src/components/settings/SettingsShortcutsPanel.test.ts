import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateResult } from "lit";
import type { AppAction } from "../../actions";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { SettingsShortcutsPanel } from "./SettingsShortcutsPanel";
import type { SettingsNotice } from "./SettingsPanelFrame";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings-shortcuts-panel layout", () => {
  it("renders header, ordered notices, and shortcut settings through the shared frame", () => {
    const panel = new SettingsShortcutsPanel();
    panel.configResponse = configResponse({ shortcuts: {} });
    panel.error = "Failed to load shortcut settings.";
    panel.savedMessage = "Shortcut settings saved.";

    const template = panel.render();
    const rendered = flattenTemplateContent(template);

    expect(rendered).toContain("<settings-panel-frame");
    expect(frameNotices(template).map((notice) => notice.type)).toEqual(["error", "success"]);
    expectTextOrder(rendered, [
      "Keyboard shortcuts",
      "Edit app shortcuts by action.",
      "<code>mod+k</code>",
      "Reload",
      "Failed to load shortcut settings.",
      "Shortcut settings saved.",
      "Chat composer",
      "Config file",
      "No actions registered.",
    ]);
  });

  it("keeps the prompt-enter card before the loading shortcuts state", () => {
    const panel = new SettingsShortcutsPanel();
    panel.loading = true;

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, ["Keyboard shortcuts", "Chat composer", "Loading shortcuts…"]);
    expect(rendered).not.toContain("Config file");
  });
});

describe("settings-shortcuts-panel shortcut row actions", () => {
  it("saves edited shortcuts, disables them with None, and resets overrides", () => {
    vi.stubGlobal("HTMLInputElement", FakeHTMLInputElement);
    const onSave = vi.fn<SaveHandler>();
    const savePanel = panelWithShortcuts({ shortcuts: { "core:other": "mod+o" } }, onSave);

    findTemplateEventHandler<Event>(savePanel.render(), "@input=")(
      new EventWithTarget("input", new FakeHTMLInputElement(" control + shift + p ")),
    );

    expectTextOrder(flattenTemplateContent(savePanel.render()), ["Open palette", "Ctrl+Shift+P", "Custom · Unsaved"]);

    findTemplateEventHandler<Event>(savePanel.render(), ">Save</button>")(new Event("click"));

    const nonePanel = panelWithShortcuts({ shortcuts: { "core:open-palette": "mod+shift+p", "core:other": "mod+o" } }, onSave);
    findTemplateEventHandler<Event>(nonePanel.render(), ">None</button>")(new Event("click"));

    const resetPanel = panelWithShortcuts({ shortcuts: { "core:open-palette": null, "core:other": "mod+o" } }, onSave);
    findTemplateEventHandler<Event>(resetPanel.render(), ">Reset</button>")(new Event("click"));

    expect(onSave.mock.calls).toEqual([
      [{ shortcuts: { "core:other": "mod+o", "core:open-palette": "mod+shift+p" } }],
      [{ shortcuts: { "core:open-palette": null, "core:other": "mod+o" } }],
      [{ shortcuts: { "core:other": "mod+o" } }],
    ]);
  });
});

function frameNotices(template: TemplateResult): readonly SettingsNotice[] {
  const notices = collectTemplateValues(template).find(isSettingsNoticeArray);
  if (notices === undefined) throw new Error("Expected settings-panel-frame notices to be rendered");
  return notices;
}

function flattenTemplateContent(template: TemplateResult): string {
  const chunks: string[] = [];
  visitTemplate(template);
  return chunks.join("");

  function visitTemplate(current: TemplateResult): void {
    const strings = templateStrings(current);
    const values = templateValues(current);
    for (let index = 0; index < values.length; index += 1) {
      const staticChunk = strings[index];
      if (staticChunk !== undefined) chunks.push(staticChunk);
      visitValue(values[index]);
    }
    const finalChunk = strings[values.length];
    if (finalChunk !== undefined) chunks.push(finalChunk);
  }

  function visitValue(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visitValue(item);
      return;
    }
    if (isSettingsNotice(value)) {
      visitValue(value.title);
      visitValue(value.content);
      return;
    }
    if (isTemplateResult(value)) {
      visitTemplate(value);
      return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      chunks.push(String(value));
    }
  }
}

function collectTemplateValues(template: TemplateResult): unknown[] {
  const values: unknown[] = [];
  visit(template);
  return values;

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isTemplateResult(current)) return;
    for (const value of templateValues(current)) {
      values.push(value);
      visit(value);
    }
  }
}

function expectTextOrder(content: string, labels: readonly string[]): void {
  let previousIndex = -1;
  for (const label of labels) {
    const currentIndex = content.indexOf(label, previousIndex + 1);
    if (currentIndex === -1) throw new Error(`Expected rendered content to include ${label}`);
    expect(currentIndex).toBeGreaterThan(previousIndex);
    previousIndex = currentIndex;
  }
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isSettingsNotice(value: unknown): value is SettingsNotice {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string" && Reflect.has(value, "content");
}

function isSettingsNoticeArray(value: unknown): value is readonly SettingsNotice[] {
  return Array.isArray(value) && value.every(isSettingsNotice);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

type SaveHandler = (config: PiWebConfigValues) => void | Promise<void>;
type TemplateEventHandler<E extends Event> = (event: E) => void;

function panelWithShortcuts(config: PiWebConfigValues, onSave: SaveHandler): SettingsShortcutsPanel {
  const panel = new SettingsShortcutsPanel();
  panel.actions = [shortcutAction()];
  panel.configResponse = configResponse(config);
  panel.onSave = onSave;
  return panel;
}

function shortcutAction(): AppAction {
  return {
    id: "core:open-palette",
    title: "Open palette",
    description: "Open the command palette.",
    shortcut: "mod+k",
    group: "Navigation",
    run: vi.fn(),
  };
}

function findTemplateEventHandler<E extends Event>(template: TemplateResult, marker: string): TemplateEventHandler<E> {
  const handler = findOptionalTemplateEventHandler<E>(template, marker);
  if (handler === undefined) throw new Error(`Expected template event handler near ${marker}`);
  return handler;
}

function findOptionalTemplateEventHandler<E extends Event>(template: TemplateResult, marker: string): TemplateEventHandler<E> | undefined {
  return findInTemplate(template);

  function findInTemplate(current: TemplateResult): TemplateEventHandler<E> | undefined {
    const strings = templateStrings(current);
    const values = templateValues(current);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (isTemplateEventHandler<E>(value) && templateEventHandlerMatches(strings, index, marker)) return value;
      const nestedHandler = findInValue(value);
      if (nestedHandler !== undefined) return nestedHandler;
    }
    return undefined;
  }

  function findInValue(value: unknown): TemplateEventHandler<E> | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nestedHandler = findInValue(item);
        if (nestedHandler !== undefined) return nestedHandler;
      }
      return undefined;
    }
    if (isTemplateResult(value)) return findInTemplate(value);
    return undefined;
  }
}

function templateEventHandlerMatches(strings: readonly string[], valueIndex: number, marker: string): boolean {
  return (strings[valueIndex] ?? "").includes(marker) || (strings[valueIndex + 1] ?? "").includes(marker);
}

function isTemplateEventHandler<E extends Event>(value: unknown): value is TemplateEventHandler<E> {
  return typeof value === "function";
}

class FakeHTMLInputElement extends EventTarget {
  constructor(readonly value: string) {
    super();
  }
}

class EventWithTarget extends Event {
  constructor(type: string, private readonly eventTarget: EventTarget) {
    super(type);
  }

  override get target(): EventTarget {
    return this.eventTarget;
  }
}

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}
