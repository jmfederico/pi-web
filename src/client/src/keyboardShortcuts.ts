import type { AppAction } from "./actions";

export const shortcutSequenceTimeoutMs = 1200;

const modifierOrder = ["mod", "alt", "shift"] as const;
type ShortcutModifier = typeof modifierOrder[number];

export type ShortcutPreferenceConfig = Record<string, string | null>;
export type ShortcutBindingSource = "default" | "custom";

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  target: EventTarget | null;
}

export type ShortcutParseResult =
  | { ok: true; shortcut: string; tokens: string[] }
  | { ok: false; message: string };

export interface ShortcutBindingSummary {
  action: AppAction;
  shortcut: string;
  source: ShortcutBindingSource;
}

export interface ShortcutBindingResolution extends ShortcutBindingSummary {
  tokens: string[];
  key: string;
  order: number;
  active: boolean;
  shadows: ShortcutBindingSummary[];
  shadowedBy?: ShortcutBindingSummary;
}

interface ShortcutBinding extends ShortcutBindingSummary {
  tokens: string[];
  key: string;
  order: number;
}

export class KeyboardShortcutDispatcher {
  private pendingTokens: string[] = [];
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;

  handle(event: ShortcutKeyEvent, actions: AppAction[], options: { shortcuts?: ShortcutPreferenceConfig } = {}): boolean {
    const token = shortcutTokenFromEvent(event);
    if (token === undefined) return false;

    const shortcuts = resolveShortcutBindings(actions, options.shortcuts, { enabledOnly: true })
      .filter((binding) => binding.active)
      .map((binding) => ({ action: binding.action, tokens: binding.tokens }));

    if (this.pendingTokens.length > 0) {
      const handledPending = this.handleSequence([...this.pendingTokens, token], shortcuts);
      if (handledPending) return true;
      this.clearPending();
      if (!isShortcutSequenceStarter(token)) return false;
    } else if (!isShortcutSequenceStarter(token)) return false;

    return this.handleSequence([token], shortcuts);
  }

  reset(): void {
    this.clearPending();
  }

  private handleSequence(sequence: string[], shortcuts: { action: AppAction; tokens: string[] }[]): boolean {
    const exact = shortcuts.find((entry) => sameTokens(entry.tokens, sequence));
    if (exact !== undefined) {
      this.clearPending();
      void exact.action.run();
      return true;
    }

    const hasPrefix = shortcuts.some((entry) => startsWithTokens(entry.tokens, sequence));
    if (hasPrefix) {
      this.setPending(sequence);
      return true;
    }

    return false;
  }

  private setPending(tokens: string[]): void {
    this.clearPending();
    this.pendingTokens = tokens;
    this.pendingTimer = globalThis.setTimeout(() => {
      this.pendingTokens = [];
      this.pendingTimer = undefined;
    }, shortcutSequenceTimeoutMs);
  }

  private clearPending(): void {
    this.pendingTokens = [];
    if (this.pendingTimer !== undefined) {
      globalThis.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }
}

export function resolveShortcutBindings(actions: AppAction[], shortcuts?: ShortcutPreferenceConfig, options: { enabledOnly?: boolean } = {}): ShortcutBindingResolution[] {
  const bindings = actions.flatMap((action, order) => {
    if (options.enabledOnly === true && action.enabled === false) return [];
    const binding = shortcutBindingForAction(action, shortcuts, order);
    return binding === undefined ? [] : [binding];
  });
  const bindingsByKey = new Map<string, ShortcutBinding[]>();
  for (const binding of bindings) {
    bindingsByKey.set(binding.key, [...(bindingsByKey.get(binding.key) ?? []), binding]);
  }

  const exactWinnersByKey = new Map<string, ShortcutBinding>();
  for (const conflictSet of bindingsByKey.values()) {
    const winner = [...conflictSet].sort(compareShortcutBindings)[0];
    if (winner !== undefined) exactWinnersByKey.set(winner.key, winner);
  }

  const exactWinners = [...exactWinnersByKey.values()].sort(compareShortcutPrefixCandidates);
  const shadowsByWinner = new Map<ShortcutBinding, ShortcutBinding[]>();
  const winnerByBinding = new Map<ShortcutBinding, ShortcutBinding>();
  for (const binding of bindings) {
    const exactWinner = exactWinnersByKey.get(binding.key);
    if (exactWinner === undefined) continue;
    const winner = prefixWinnerFor(exactWinner, exactWinners) ?? exactWinner;
    winnerByBinding.set(binding, winner);
    if (binding !== winner) shadowsByWinner.set(winner, [...(shadowsByWinner.get(winner) ?? []), binding]);
  }

  return bindings.map((binding) => {
    const winner = winnerByBinding.get(binding);
    const active = winner === binding;
    const shadowedBy = winner === undefined || active ? undefined : shortcutBindingSummary(winner);
    const shadows = active ? [...(shadowsByWinner.get(binding) ?? [])].sort(compareShortcutBindings).map(shortcutBindingSummary) : [];
    return {
      ...binding,
      active,
      shadows,
      ...(shadowedBy === undefined ? {} : { shadowedBy }),
    };
  }).sort((left, right) => left.order - right.order);
}

export function parseShortcutInput(shortcut: string): ShortcutParseResult {
  return parseShortcut(shortcut, { requireFirstChordActivator: true });
}

export function normalizeShortcut(shortcut: string): string[] {
  const parsed = parseShortcut(shortcut, { requireFirstChordActivator: false });
  return parsed.ok ? parsed.tokens : [];
}

export function formatShortcut(shortcut: string): string {
  return normalizeShortcut(shortcut)
    .map((token) => token
      .split("+")
      .map(formatShortcutPart)
      .join("+"))
    .join(" ");
}

export function shortcutTokenFromEvent(event: ShortcutKeyEvent): string | undefined {
  if (event.isComposing) return undefined;
  const key = normalizeKey(event.key);
  if (key === undefined) return undefined;
  const modifiers: string[] = [];
  if (event.metaKey || event.ctrlKey) modifiers.push("mod");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  modifiers.push(key);
  return modifiers.join("+");
}

export function isShortcutSequenceStarter(token: string): boolean {
  return token.split("+").includes("mod") || token.split("+").includes("alt");
}

function shortcutBindingForAction(action: AppAction, shortcuts: ShortcutPreferenceConfig | undefined, order: number): ShortcutBinding | undefined {
  const configured = shortcutPreferenceForAction(action, shortcuts);
  if (configured === null) return undefined;
  const shortcut = configured ?? action.shortcut;
  if (shortcut === undefined || shortcut === "") return undefined;
  const tokens = normalizeShortcut(shortcut);
  const firstToken = tokens[0];
  if (firstToken === undefined || !isShortcutSequenceStarter(firstToken)) return undefined;
  return {
    action,
    shortcut: tokens.join(" "),
    source: configured === undefined ? "default" : "custom",
    tokens,
    key: shortcutBindingKey(tokens),
    order,
  };
}

export function shortcutPreferenceForAction(action: Pick<AppAction, "id" | "shortcutAliases">, shortcuts: ShortcutPreferenceConfig | undefined): string | null | undefined {
  if (shortcuts === undefined) return undefined;
  for (const actionId of [action.id, ...(action.shortcutAliases ?? [])]) {
    if (Object.hasOwn(shortcuts, actionId)) return shortcuts[actionId];
  }
  return undefined;
}

function shortcutBindingKey(tokens: string[]): string {
  return tokens.join("\u0000");
}

function shortcutBindingSummary(binding: ShortcutBinding): ShortcutBindingSummary {
  return { action: binding.action, shortcut: binding.shortcut, source: binding.source };
}

function compareShortcutBindings(left: ShortcutBinding, right: ShortcutBinding): number {
  return shortcutSourceRank(left.source) - shortcutSourceRank(right.source)
    || compareStrings(left.action.id, right.action.id)
    || compareStrings(left.action.title, right.action.title)
    || left.order - right.order;
}

function compareShortcutPrefixCandidates(left: ShortcutBinding, right: ShortcutBinding): number {
  return left.tokens.length - right.tokens.length || compareShortcutBindings(left, right);
}

function prefixWinnerFor(binding: ShortcutBinding, exactWinners: ShortcutBinding[]): ShortcutBinding | undefined {
  return exactWinners.find((candidate) => candidate !== binding && candidate.tokens.length < binding.tokens.length && startsWithTokens(binding.tokens, candidate.tokens));
}

function shortcutSourceRank(source: ShortcutBindingSource): number {
  switch (source) {
    case "custom": return 0;
    case "default": return 1;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseShortcut(shortcut: string, options: { requireFirstChordActivator: boolean }): ShortcutParseResult {
  const cleaned = shortcut.trim().toLowerCase().replace(/\s*\+\s*/gu, "+");
  if (cleaned === "") return { ok: false, message: "Enter a shortcut, choose None, or reset to the default." };

  const tokens: string[] = [];
  const chordInputs = cleaned.split(/\s+/u).filter((token) => token !== "");
  for (const [index, chordInput] of chordInputs.entries()) {
    const parsed = parseShortcutChord(chordInput);
    if (!parsed.ok) return parsed;
    if (index === 0 && options.requireFirstChordActivator && !isShortcutSequenceStarter(parsed.token)) {
      return { ok: false, message: "Shortcuts must start with Ctrl/⌘ or Alt so normal typing is not captured." };
    }
    tokens.push(parsed.token);
  }

  return { ok: true, shortcut: tokens.join(" "), tokens };
}

type ShortcutChordParseResult =
  | { ok: true; token: string }
  | { ok: false; message: string };

function parseShortcutChord(chord: string): ShortcutChordParseResult {
  const parts = chord.split("+").filter((part) => part !== "");
  if (parts.length === 0) return { ok: false, message: "Shortcut chords must include a key." };

  const modifiers = new Set<ShortcutModifier>();
  let key: string | undefined;
  for (const part of parts) {
    const modifier = modifierAlias(part);
    if (modifier !== undefined) {
      if (modifiers.has(modifier)) return { ok: false, message: `Shortcut has duplicate ${formatShortcutPart(modifier)} modifiers.` };
      modifiers.add(modifier);
      continue;
    }

    const normalizedKey = normalizeShortcutKeyName(part);
    if (normalizedKey === undefined) return { ok: false, message: `Unsupported shortcut key: ${part}` };
    if (key !== undefined) return { ok: false, message: "Each shortcut chord can include only one non-modifier key." };
    key = normalizedKey;
  }

  if (key === undefined) return { ok: false, message: "Shortcut chords must include a key." };

  const orderedModifiers = modifierOrder.filter((modifier) => modifiers.has(modifier));
  return { ok: true, token: [...orderedModifiers, key].join("+") };
}

function modifierAlias(part: string): ShortcutModifier | undefined {
  switch (part) {
    case "mod":
    case "meta":
    case "cmd":
    case "command":
    case "ctrl":
    case "control":
    case "primary":
      return "mod";
    case "alt":
    case "option":
    case "opt":
      return "alt";
    case "shift":
      return "shift";
    default:
      return undefined;
  }
}

function normalizeShortcutKeyName(key: string): string | undefined {
  const alias = keyAlias(key);
  if (alias !== undefined) return alias;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/u.test(key)) return key;
  if (key.length === 1) return key;
  return undefined;
}

function normalizeKey(key: string): string | undefined {
  if (key === " ") return "space";
  const normalized = key.toLowerCase();
  return normalizeShortcutKeyName(normalized);
}

function keyAlias(key: string): string | undefined {
  switch (key) {
    case " ":
    case "spacebar":
    case "space":
      return "space";
    case "esc":
    case "escape":
      return "escape";
    case "return":
    case "enter":
      return "enter";
    case "del":
    case "delete":
      return "delete";
    case "backspace":
      return "backspace";
    case "tab":
      return "tab";
    case "up":
    case "arrowup":
      return "arrowup";
    case "down":
    case "arrowdown":
      return "arrowdown";
    case "left":
    case "arrowleft":
      return "arrowleft";
    case "right":
    case "arrowright":
      return "arrowright";
    case "pageup":
    case "pagedown":
    case "home":
    case "end":
      return key;
    case "+":
    case "plus":
      return "plus";
    case "period":
    case "dot":
      return ".";
    case "comma":
      return ",";
    case "slash":
      return "/";
    case "backslash":
      return "\\";
    case "minus":
      return "-";
    default:
      return undefined;
  }
}

function formatShortcutPart(part: string): string {
  if (part === "mod") return isMac() ? "⌘" : "Ctrl";
  if (part === "shift") return "Shift";
  if (part === "alt") return isMac() ? "⌥" : "Alt";
  if (part === "enter") return "Enter";
  if (part === "escape") return "Esc";
  if (part === "space") return "Space";
  if (part === "tab") return "Tab";
  if (part === "backspace") return "Backspace";
  if (part === "delete") return "Delete";
  if (part === "arrowup") return "↑";
  if (part === "arrowdown") return "↓";
  if (part === "arrowleft") return "←";
  if (part === "arrowright") return "→";
  if (part === "pageup") return "PageUp";
  if (part === "pagedown") return "PageDown";
  if (part === "home") return "Home";
  if (part === "end") return "End";
  if (part === "plus") return "+";
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/u.test(part)) return part.toUpperCase();
  return part.length === 1 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

function sameTokens(left: string[], right: string[]): boolean {
  return left.length === right.length && startsWithTokens(left, right);
}

function startsWithTokens(tokens: string[], prefix: string[]): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("mac");
}
