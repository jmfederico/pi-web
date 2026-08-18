import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppAction } from "../../actions";
import type { PiWebConfigResponse, PiWebConfigValues, PiWebShortcutConfig } from "../../api";
import { formatShortcut, isShortcutSequenceStarter, parseShortcutInput, resolveShortcutBindings, shortcutPreferenceForAction, shortcutSequenceTimeoutMs, shortcutTokenFromEvent, type ShortcutBindingResolution } from "../../keyboardShortcuts";
import { readPromptEnterPreference, writePromptEnterPreference, type PromptEnterPreference } from "../../promptEnterBehavior";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";

const RECORD_SHORTCUT_LISTENER_OPTIONS = { capture: true } as const;

const PROMPT_ENTER_OPTIONS: readonly { value: PromptEnterPreference; label: string; description: string }[] = [
  {
    value: "auto",
    label: "Auto/default",
    description: "Desktop-like Enter sends; mobile, coarse pointer, or narrow screens insert a new line.",
  },
  {
    value: "send",
    label: "Enter sends message",
    description: "Enter sends the chat message; Shift+Enter adds a new line when supported.",
  },
  {
    value: "newline",
    label: "Enter inserts new line",
    description: "Enter adds a line break; Shift+Enter sends the chat message when supported.",
  },
];

function renderShortcutsDescription(): TemplateResult {
  return html`Edit app shortcuts by action. Type a shortcut such as <code>mod+k</code> or <code>mod+g p</code>, record one from the keyboard, disable it with None, or reset it to the default. When shortcuts conflict, custom shortcuts win before defaults; ties are resolved by action id, and shorter shortcuts shadow longer sequences with the same prefix.`;
}

@customElement("settings-shortcuts-panel")
export class SettingsShortcutsPanel extends LitElement {
  @property({ attribute: false }) actions: AppAction[] = [];
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;
  @state() private drafts: Record<string, string> = {};
  @state() private localError = "";
  @state() private promptEnterPreference: PromptEnterPreference = readPromptEnterPreference();
  @state() private recording: RecordingState | undefined;
  private recordingTimer: number | undefined;
  private recordingListenerActive = false;

  private readonly onRecordKeyDown = (event: KeyboardEvent): void => {
    const recording = this.recording;
    if (recording === undefined) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      this.stopRecording();
      return;
    }

    const token = shortcutTokenFromEvent(event);
    if (token === undefined) {
      this.localError = "Press a letter, number, punctuation, function, or navigation key. Press Esc to cancel recording.";
      return;
    }
    if (recording.tokens.length === 0 && !isShortcutSequenceStarter(token)) {
      this.localError = "Start shortcuts with Ctrl/⌘ or Alt so normal typing is not captured.";
      return;
    }

    const tokens = [...recording.tokens, token];
    this.localError = "";
    this.drafts = { [recording.actionId]: tokens.join(" ") };
    this.recording = { actionId: recording.actionId, tokens };
    this.armRecordingTimer();
  };

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("configResponse") && this.configResponse !== undefined) {
      this.drafts = {};
      this.localError = "";
      this.stopRecording();
    }
  }

  override disconnectedCallback(): void {
    this.stopRecording();
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    const groups = shortcutGroups(this.actions);
    const shortcutResolutions = this.shortcutResolutions();
    return html`
      <settings-panel-frame
        heading="Keyboard shortcuts"
        .description=${renderShortcutsDescription()}
        actionLabel="Reload"
        .actionDisabled=${this.loading}
        .notices=${this.panelNotices()}
        .onAction=${this.onReload}
      >
        ${this.renderPromptEnterPreferenceCard()}
        ${this.configResponse === undefined && this.loading ? html`<div class="loading-card">Loading shortcuts…</div>` : html`
          <div class="config-path-card">
            <span>Config file</span>
            <code>${this.configResponse?.path ?? "Unknown"}</code>
            <small>Shortcut overrides are saved under <code>shortcuts</code>. A value of <code>null</code> disables the action shortcut.</small>
          </div>
          ${groups.length === 0 ? html`<div class="loading-card">No actions registered.</div>` : groups.map((group) => html`
            <section class="shortcut-group">
              <h3>${group.name}</h3>
              <div class="shortcut-list">
                ${group.actions.map((action) => this.renderShortcutRow(action, shortcutResolutions.get(action.id)))}
              </div>
            </section>
          `)}
        `}
      </settings-panel-frame>
    `;
  }

  private panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    const error = this.localError || this.error;
    if (error !== "") notices.push({ type: "error", content: error });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    return notices;
  }

  private renderPromptEnterPreferenceCard(): TemplateResult {
    return html`
      <section class="prompt-enter-card" aria-labelledby="prompt-enter-preference-title">
        <div class="prompt-enter-copy">
          <span class="card-eyebrow">Chat composer</span>
          <h3 id="prompt-enter-preference-title">Enter key behavior</h3>
          <p>Choose what Enter does in this browser. Shift+Enter does the opposite when supported; automatic touch-keyboard capitalization is ignored to avoid accidental sends.</p>
        </div>
        <div class="prompt-enter-options" role="radiogroup" aria-label="Enter and Shift Enter behavior in the chat composer">
          ${PROMPT_ENTER_OPTIONS.map((option) => html`
            <label class="prompt-enter-option">
              <input
                type="radio"
                name="prompt-enter-preference"
                .value=${option.value}
                .checked=${this.promptEnterPreference === option.value}
                @change=${() => { this.updatePromptEnterPreference(option.value); }}
              >
              <span>
                <strong>${option.label}</strong>
                <small>${option.description}</small>
              </span>
            </label>
          `)}
        </div>
      </section>
    `;
  }

  private updatePromptEnterPreference(preference: PromptEnterPreference): void {
    this.promptEnterPreference = preference;
    writePromptEnterPreference(preference);
  }

  private renderShortcutRow(action: AppAction, resolution: ShortcutBindingResolution | undefined): TemplateResult {
    const shortcuts = this.configResponse?.config.shortcuts;
    const configured = shortcutPreferenceForAction(action, shortcuts);
    const state = shortcutState(action, shortcuts);
    const inputText = this.shortcutInputText(action);
    const parsedInput = inputText.trim() === "" ? undefined : parseShortcutInput(inputText);
    const previewShortcut = parsedInput?.ok === true ? parsedInput.shortcut : effectiveShortcut(action, shortcuts);
    const hasConfiguredShortcut = configured !== undefined;
    const hasDraft = this.drafts[action.id] !== undefined;
    const displayState = hasDraft && inputText.trim() !== "" ? "custom" : state;
    const recordingHint = this.recordingHint(action.id);
    const conflictLabel = shortcutConflictLabel(resolution);
    return html`
      <article class=${shortcutRowClass(resolution)}>
        <div class="shortcut-main">
          <strong>${action.title}</strong>
          ${action.description !== undefined && action.description !== "" ? html`<small>${action.description}</small>` : null}
          <small class="shortcut-id">${action.id}</small>
          <small>${action.shortcut !== undefined && action.shortcut !== "" ? html`Default: <kbd>${formatShortcut(action.shortcut)}</kbd>` : "No default shortcut"}</small>
        </div>
        <div class="shortcut-editor">
          <div class="shortcut-status">
            ${previewShortcut !== undefined && previewShortcut !== "" ? html`<kbd>${formatShortcut(previewShortcut)}</kbd>` : html`<span class="unassigned">${state === "disabled" ? "Disabled" : "Unassigned"}</span>`}
            <small class=${displayState}>${shortcutStateLabel(displayState)}${hasDraft ? " · Unsaved" : ""}</small>
            ${conflictLabel === undefined ? null : html`<small class=${shortcutConflictClass(resolution)}>${conflictLabel}</small>`}
          </div>
          <label class="shortcut-input-label">
            <span>Shortcut</span>
            <input
              class="shortcut-input"
              data-action-id=${action.id}
              .value=${inputText}
              placeholder=${action.shortcut ?? "mod+k"}
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              ?disabled=${this.saving}
              @input=${(event: Event) => { this.updateDraft(action.id, inputValue(event)); }}
            >
          </label>
          ${recordingHint !== "" ? html`<small class="recording-hint">${recordingHint}</small>` : null}
          <div class="shortcut-actions">
            <button class="primary" ?disabled=${this.loading || this.saving || !hasDraft || inputText.trim() === ""} @click=${() => { void this.saveShortcut(action); }}>Save</button>
            <button ?disabled=${this.loading || this.saving} @click=${() => { void this.toggleRecording(action.id); }}>${this.recording?.actionId === action.id ? "Cancel recording" : "Record"}</button>
            <button ?disabled=${this.loading || this.saving || configured === null} @click=${() => { void this.setShortcutNone(action); }}>None</button>
            <button ?disabled=${this.loading || this.saving || !hasConfiguredShortcut} @click=${() => { void this.resetShortcut(action); }}>Reset</button>
          </div>
        </div>
      </article>
    `;
  }

  private shortcutInputText(action: AppAction): string {
    const draft = this.drafts[action.id];
    if (draft !== undefined) return draft;
    const configured = shortcutPreferenceForAction(action, this.configResponse?.config.shortcuts);
    if (configured === null) return "";
    return configured ?? action.shortcut ?? "";
  }

  private recordingHint(actionId: string): string {
    const recording = this.recording;
    if (recording?.actionId !== actionId) return "";
    if (recording.tokens.length === 0) return "Recording: press Ctrl/⌘ or Alt with a key. Press Esc to cancel.";
    return `Recording: ${formatShortcut(recording.tokens.join(" "))}. Press another key to add a sequence, or wait to finish.`;
  }

  private updateDraft(actionId: string, value: string): void {
    this.drafts = { [actionId]: value };
    this.localError = "";
  }

  private async saveShortcut(action: AppAction): Promise<void> {
    this.stopRecording();
    const input = this.shortcutInputText(action).trim();
    const parsed = parseShortcutInput(input);
    if (!parsed.ok) {
      this.localError = parsed.message;
      return;
    }
    this.localError = "";
    await this.saveShortcutPreference(action, parsed.shortcut);
  }

  private async setShortcutNone(action: AppAction): Promise<void> {
    this.stopRecording();
    this.localError = "";
    await this.saveShortcutPreference(action, null);
  }

  private async resetShortcut(action: AppAction): Promise<void> {
    this.stopRecording();
    this.localError = "";
    await this.saveShortcutPreference(action, undefined);
  }

  private async saveShortcutPreference(action: AppAction, shortcut: string | null | undefined): Promise<void> {
    const config: PiWebConfigValues = { ...(this.configResponse?.config ?? {}) };
    const currentShortcuts = config.shortcuts ?? {};
    const migratedShortcuts = withoutShortcutPreferences(currentShortcuts, [action.id, ...(action.shortcutAliases ?? [])]);
    const shortcuts = shortcut === undefined ? migratedShortcuts : { ...migratedShortcuts, [action.id]: shortcut };
    if (Object.keys(shortcuts).length === 0) {
      delete config.shortcuts;
    } else {
      config.shortcuts = shortcuts;
    }
    await this.onSave?.(config);
  }

  private shortcutResolutions(): Map<string, ShortcutBindingResolution> {
    return new Map(resolveShortcutBindings(this.actions, this.previewShortcutConfig(), { enabledOnly: true }).map((resolution) => [resolution.action.id, resolution]));
  }

  private previewShortcutConfig(): PiWebShortcutConfig | undefined {
    const shortcuts = { ...(this.configResponse?.config.shortcuts ?? {}) };
    for (const [actionId, draft] of Object.entries(this.drafts)) {
      const trimmedDraft = draft.trim();
      if (trimmedDraft === "") continue;
      const parsed = parseShortcutInput(trimmedDraft);
      if (parsed.ok) shortcuts[actionId] = parsed.shortcut;
    }
    return Object.keys(shortcuts).length === 0 ? undefined : shortcuts;
  }

  private async toggleRecording(actionId: string): Promise<void> {
    if (this.recording?.actionId === actionId) {
      this.stopRecording();
      return;
    }
    this.stopRecording();
    this.localError = "";
    this.recording = { actionId, tokens: [] };
    this.ensureRecordingListener();
    await this.updateComplete;
    this.focusShortcutInput(actionId);
  }

  private focusShortcutInput(actionId: string): void {
    for (const input of this.renderRoot.querySelectorAll<HTMLInputElement>(".shortcut-input")) {
      if (input.dataset["actionId"] === actionId) {
        input.focus();
        input.select();
        return;
      }
    }
  }

  private armRecordingTimer(): void {
    this.clearRecordingTimer();
    this.recordingTimer = window.setTimeout(() => {
      this.recordingTimer = undefined;
      this.stopRecording();
    }, shortcutSequenceTimeoutMs);
  }

  private stopRecording(): void {
    this.clearRecordingTimer();
    this.removeRecordingListener();
    this.recording = undefined;
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer === undefined) return;
    window.clearTimeout(this.recordingTimer);
    this.recordingTimer = undefined;
  }

  private ensureRecordingListener(): void {
    if (this.recordingListenerActive) return;
    window.addEventListener("keydown", this.onRecordKeyDown, RECORD_SHORTCUT_LISTENER_OPTIONS);
    this.recordingListenerActive = true;
  }

  private removeRecordingListener(): void {
    if (!this.recordingListenerActive) return;
    window.removeEventListener("keydown", this.onRecordKeyDown, RECORD_SHORTCUT_LISTENER_OPTIONS);
    this.recordingListenerActive = false;
  }

  static override styles = css`
    :host { display: block; }
    h3, p { margin: 0; }
    h3 { font-size: 13px; line-height: 1.3; }
    p { color: var(--pi-muted); line-height: 1.45; }
    button, input { font: inherit; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    button:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
    .primary { border-color: var(--pi-accent); background: var(--pi-selection-bg); color: var(--pi-text-bright); }
    .loading-card, .config-path-card, .prompt-enter-card { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .loading-card, .config-path-card { color: var(--pi-muted); }
    .config-path-card { display: grid; gap: 5px; }
    .config-path-card span, .card-eyebrow { color: var(--pi-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .prompt-enter-card { display: grid; grid-template-columns: minmax(0, .85fr) minmax(260px, 1fr); gap: 12px; align-items: start; }
    .prompt-enter-copy { display: grid; gap: 5px; min-width: 0; }
    .prompt-enter-copy p, .prompt-enter-option small { font-size: 12px; }
    .prompt-enter-options { display: grid; gap: 7px; }
    .prompt-enter-option { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: start; color: var(--pi-text); }
    .prompt-enter-option input { box-sizing: border-box; width: 14px; min-width: 14px; height: 14px; margin: 3px 0 0; padding: 0; border: 0; background: transparent; accent-color: var(--pi-accent); font-family: inherit; }
    .prompt-enter-option input:focus { border-color: transparent; box-shadow: none; outline: 2px solid var(--pi-accent-border); outline-offset: 2px; }
    .prompt-enter-option span { display: grid; gap: 2px; }
    .prompt-enter-option small { color: var(--pi-muted); line-height: 1.35; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .shortcut-group { margin: 0; }
    .shortcut-group h3 { margin: 0 0 8px; color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
    .shortcut-list { border: 1px solid var(--pi-border); border-radius: 10px; overflow: hidden; }
    .shortcut-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 48%); gap: 14px; align-items: start; padding: 12px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
    .shortcut-row.shadowed { background: color-mix(in srgb, var(--pi-warning) 5%, var(--pi-surface)); }
    .shortcut-row.shadowing { background: color-mix(in srgb, var(--pi-accent) 5%, var(--pi-surface)); }
    .shortcut-row:last-child { border-bottom: 0; }
    .shortcut-main { min-width: 0; display: grid; gap: 4px; }
    .shortcut-main strong, .shortcut-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .shortcut-main small { color: var(--pi-muted); }
    .shortcut-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .shortcut-editor { min-width: 0; display: grid; gap: 8px; }
    .shortcut-status { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .shortcut-status small { color: var(--pi-muted); font-size: 11px; }
    .shortcut-status small.custom { color: var(--pi-accent); }
    .shortcut-status small.disabled { color: var(--pi-warning); }
    .shortcut-status small.conflict { border: 1px solid currentColor; border-radius: 999px; padding: 2px 7px; }
    .shortcut-status small.conflict.shadowing { color: var(--pi-accent); }
    .shortcut-status small.conflict.shadowed { color: var(--pi-warning); }
    .shortcut-input-label { min-width: 0; display: grid; gap: 5px; }
    .shortcut-input-label span { color: var(--pi-muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    input { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 9px; outline: none; font: var(--pi-control-font-size, 16px) var(--pi-control-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    input:focus { border-color: var(--pi-accent); box-shadow: 0 0 0 1px var(--pi-accent-border); }
    .shortcut-actions { display: flex; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
    kbd { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); padding: 3px 7px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
    .unassigned { color: var(--pi-muted); font-size: 12px; }
    .recording-hint { color: var(--pi-accent); font-size: 12px; }

    @media (max-width: 760px) {
      .prompt-enter-card { grid-template-columns: minmax(0, 1fr); }
      .shortcut-row { grid-template-columns: minmax(0, 1fr); align-items: start; }
      .shortcut-status, .shortcut-actions { justify-content: flex-start; }
    }
  `;
}

interface RecordingState {
  actionId: string;
  tokens: string[];
}

type ShortcutState = "default" | "custom" | "disabled" | "unassigned";

function shortcutRowClass(resolution: ShortcutBindingResolution | undefined): string {
  if (resolution?.active === false) return "shortcut-row shadowed";
  if (resolution?.active === true && resolution.shadows.length > 0) return "shortcut-row shadowing";
  return "shortcut-row";
}

function shortcutConflictClass(resolution: ShortcutBindingResolution | undefined): string {
  return resolution?.active === false ? "conflict shadowed" : "conflict shadowing";
}

function shortcutConflictLabel(resolution: ShortcutBindingResolution | undefined): string | undefined {
  if (resolution === undefined) return undefined;
  if (!resolution.active) return `Shadowed by ${resolution.shadowedBy?.action.title ?? "another action"}`;
  const shadowedCount = resolution.shadows.length;
  if (shadowedCount === 0) return undefined;
  const shadowedNames = resolution.shadows.slice(0, 2).map((binding) => binding.action.title).join(", ");
  const suffix = shadowedCount > 2 ? `, +${String(shadowedCount - 2)} more` : "";
  return `Shadows ${String(shadowedCount)} ${shadowedCount === 1 ? "action" : "actions"}: ${shadowedNames}${suffix}`;
}

function shortcutGroups(actions: AppAction[]): { name: string; actions: AppAction[] }[] {
  const grouped = new Map<string, AppAction[]>();
  for (const action of [...actions].sort(compareActions)) {
    const group = action.group ?? "Other";
    grouped.set(group, [...(grouped.get(group) ?? []), action]);
  }
  return [...grouped.entries()].map(([name, groupActions]) => ({ name, actions: groupActions }));
}

function compareActions(left: AppAction, right: AppAction): number {
  return (left.group ?? "Other").localeCompare(right.group ?? "Other") || left.title.localeCompare(right.title);
}

function withoutShortcutPreferences(shortcuts: PiWebShortcutConfig, actionIds: readonly string[]): PiWebShortcutConfig {
  const removed = new Set(actionIds);
  return Object.fromEntries(Object.entries(shortcuts).filter(([shortcutActionId]) => !removed.has(shortcutActionId)));
}

function effectiveShortcut(action: AppAction, shortcuts: PiWebShortcutConfig | undefined): string | undefined {
  const configured = shortcutPreferenceForAction(action, shortcuts);
  if (configured === null) return undefined;
  return configured ?? action.shortcut;
}

function shortcutState(action: AppAction, shortcuts: PiWebShortcutConfig | undefined): ShortcutState {
  const configured = shortcutPreferenceForAction(action, shortcuts);
  if (configured === null) return "disabled";
  if (configured !== undefined) return "custom";
  return action.shortcut === undefined || action.shortcut === "" ? "unassigned" : "default";
}

function shortcutStateLabel(state: ShortcutState): string {
  switch (state) {
    case "default": return "Default";
    case "custom": return "Custom";
    case "disabled": return "Disabled";
    case "unassigned": return "No default";
  }
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}
