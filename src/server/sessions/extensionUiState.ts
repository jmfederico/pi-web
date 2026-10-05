import type { SessionExtensionUi } from "../../shared/apiTypes.js";

// Keep these limits aligned with the client parser; 33,000 characters preserves a 32 KiB RPC JSON widget and its marker.
const MAX_STATUS_KEYS = 32;
const MAX_WIDGET_KEYS = 16;
const MAX_KEY_LENGTH = 128;
const MAX_STATUS_LENGTH = 512;
const MAX_WIDGET_LINES = 32;
const MAX_WIDGET_LINE_LENGTH = 33_000;
const MAX_WIDGET_LENGTH = 40_000;
const MAX_WIDGET_TOTAL_LENGTH = 65_536;
const PRIVATE_WIDGET_KEY = "subagent-inspect";

function isSafeKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEY_LENGTH) return false;
  if (value === "prototype" || Object.prototype.hasOwnProperty.call(Object.prototype, value)) return false;
  return !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line: unknown) => typeof line === "string");
}

function widgetLength(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length, 0);
}

export class ExtensionUiState {
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, string[]>();
  private widgetCharacters = 0;
  private disposed = false;
  private workingMessage: string | undefined;

  setWorkingMessage(value: unknown): boolean {
    if (this.disposed || (value !== undefined && typeof value !== "string")) return false;
    const bounded = value?.slice(0, MAX_STATUS_LENGTH).trim();
    const next = bounded === "" ? undefined : bounded;
    if (next === this.workingMessage) return false;
    this.workingMessage = next;
    return true;
  }

  setStatus(key: unknown, value: unknown): boolean {
    if (this.disposed || !isSafeKey(key)) return false;
    if (value === undefined) return this.statuses.delete(key);
    if (typeof value !== "string") return false;
    const boundedValue = value.slice(0, MAX_STATUS_LENGTH);
    const current = this.statuses.get(key);
    if (current === boundedValue) return false;
    if (current === undefined && this.statuses.size >= MAX_STATUS_KEYS) return false;
    this.statuses.set(key, boundedValue);
    return true;
  }

  setWidget(key: unknown, value: unknown): boolean {
    if (this.disposed || !isSafeKey(key) || key === PRIVATE_WIDGET_KEY) return false;
    if (value === undefined) {
      const current = this.widgets.get(key);
      if (current === undefined) return false;
      this.widgets.delete(key);
      this.widgetCharacters -= widgetLength(current);
      return true;
    }
    if (!isStringArray(value)) return false;
    if (value.length > MAX_WIDGET_LINES || value.some((line) => line.length > MAX_WIDGET_LINE_LENGTH)) return false;
    const boundedLines = [...value];
    const nextLength = widgetLength(boundedLines);
    if (nextLength > MAX_WIDGET_LENGTH) return false;
    const current = this.widgets.get(key);
    if (current?.length === boundedLines.length
      && current.every((line, index) => line === boundedLines[index])) return false;
    if (current === undefined && this.widgets.size >= MAX_WIDGET_KEYS) return false;
    const retainedLength = this.widgetCharacters - (current === undefined ? 0 : widgetLength(current));
    if (retainedLength + nextLength > MAX_WIDGET_TOTAL_LENGTH) return false;
    this.widgets.set(key, boundedLines);
    this.widgetCharacters = retainedLength + nextLength;
    return true;
  }

  snapshot(): SessionExtensionUi | undefined {
    if (this.disposed || (this.statuses.size === 0 && this.widgets.size === 0 && this.workingMessage === undefined)) return undefined;
    const statuses: Record<string, string> = {};
    const widgets: Record<string, string[]> = {};
    for (const [key, value] of this.statuses) statuses[key] = value;
    for (const [key, lines] of this.widgets) widgets[key] = [...lines];
    return { statuses, widgets, ...(this.workingMessage === undefined ? {} : { workingMessage: this.workingMessage }) };
  }

  dispose(): void {
    this.disposed = true;
    this.statuses.clear();
    this.widgets.clear();
    this.widgetCharacters = 0;
    this.workingMessage = undefined;
  }
}
