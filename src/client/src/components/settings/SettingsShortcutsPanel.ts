import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { AppAction } from "../../actions";
import type { PiWebConfigResponse, PiWebConfigValues, PiWebShortcutConfig } from "../../api";
import { formatShortcut, parseShortcutInput, resolveShortcutBindings, shortcutPreferenceForAction, shortcutSequenceTimeoutMs, shortcutTokenFromEvent, type ShortcutBindingResolution } from "../../keyboardShortcuts";
import { composerShortcutActions, isComposerShortcut } from "../../composerShortcuts";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiFormStyles } from "../ui/formStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";

const RECORD_SHORTCUT_LISTENER_OPTIONS = { capture: true } as const;

function renderShortcutsDescription(): TemplateResult {
  return html`Type or record a shortcut, then save each action. <code>mod</code> means ⌘ on Mac or Ctrl elsewhere. Try <code>mod+k</code> or a sequence like <code>g p</code>.`;
}

@customElement("settings-shortcuts-panel")
export class SettingsShortcutsPanel extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

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
  @state() private recording: RecordingState | undefined;
  private pendingSaves = new Map<string, { action: AppAction; preference: string | null | undefined; draft: string | undefined }>();
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
    const tokens = [...recording.tokens, token];
    this.localError = "";
    this.drafts = { ...this.drafts, [recording.actionId]: tokens.join(" ") };
    this.recording = { actionId: recording.actionId, tokens };
    if (isComposerShortcut(recording.actionId)) this.stopRecording();
    else this.armRecordingTimer();
  };

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (this.configResponse === undefined || this.loading || this.saving) this.stopRecording();
    if (changed.has("configResponse") && this.configResponse !== undefined) {
      for (const [actionId, pending] of this.pendingSaves) {
        if (shortcutPreferenceForAction(pending.action, this.configResponse.config.shortcuts) !== pending.preference) continue;
        if (this.drafts[actionId] === pending.draft) {
          this.drafts = Object.fromEntries(Object.entries(this.drafts).filter(([id]) => id !== actionId));
        }
        this.pendingSaves.delete(actionId);
      }
    }
  }

  override disconnectedCallback(): void {
    this.stopRecording();
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    const groups = shortcutGroups([...composerShortcutActions(), ...this.actions]);
    const shortcutResolutions = this.shortcutResolutions();
    return html`
      <settings-panel-frame
        heading="Keyboard shortcuts"
        .description=${renderShortcutsDescription()}
        actionLabel="Refresh shortcuts"
        .actionDisabled=${this.loading || this.saving}
        .notices=${this.panelNotices()}
        .onAction=${this.onReload}
      >
        ${this.configResponse === undefined && this.loading ? html`<div class="loading-card ui-settings-path">Loading shortcuts…</div>` : html`
          ${this.configResponse === undefined ? html`<div class="loading-card ui-settings-path" role="status">Shortcut settings are unavailable. Refresh shortcuts to try again.</div>` : null}
          <details class="config-path-card ui-settings-path">
            <summary>Shortcut details</summary>
            <p>Unmodified app shortcuts work outside editable fields. Composer send shortcuts accept one key combination and take priority inside the editor. Unassigned Enter and Shift+Enter insert newlines.</p>
            <p>Touch or narrow screen applies when the primary pointer is coarse or the viewport is at most 760px wide. Desktop applies otherwise.</p>
            <p>Custom app shortcuts take priority over defaults. Ties use action id order. Shorter shortcuts block longer sequences with the same prefix.</p>
            <span>Config file</span>
            <code>${this.configResponse?.path ?? "Unknown"}</code>
            <small>Shortcut overrides are saved under <code>shortcuts</code>. A value of <code>null</code> disables the action shortcut.</small>
          </details>
          <section class="shortcut-group ui-settings-section">
            <div class="ui-settings-heading"><h3>Send behavior</h3></div>
            <label class="shortcut-input-label ui-form-field">
              <span>Send while agent is running</span>
              <select class="ui-select" aria-label="Send while agent is running" .value=${live(this.configResponse?.config.defaultStreamingBehavior ?? "steer")} ?disabled=${this.loading || this.saving || this.configResponse === undefined} @change=${(event: Event) => { void this.saveSendBehavior(event); }}>
                <option value="steer">Steer (default)</option>
                <option value="followUp">Follow-up</option>
              </select>
            </label>
            <p>Keyboard shortcut only. Steer sends before the next model call; follow-up waits for the response to finish.</p>
          </section>
          ${groups.length === 0 ? html`<div class="loading-card ui-settings-path">No actions registered.</div>` : groups.map((group) => html`
            <section class="shortcut-group ui-settings-section">
              <div class="ui-settings-heading"><h3>${group.name}</h3></div>
              <div class="shortcut-list ui-settings-list">
                ${group.actions.map((action) => this.renderShortcutRow(action, shortcutResolutions.get(action.id)))}
              </div>
            </section>
          `)}
        `}
      </settings-panel-frame>
    `;
  }

  private async saveSendBehavior(event: Event): Promise<void> {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : undefined;
    if (this.configResponse === undefined || (value !== "steer" && value !== "followUp")) return;
    await this.onSave?.({ ...this.configResponse.config, defaultStreamingBehavior: value });
  }

  private panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    const error = this.localError || this.error;
    if (error !== "") notices.push({ type: "error", content: error });
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    return notices;
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
    const controlsDisabled = this.loading || this.saving || this.configResponse === undefined;
    return html`
      <article class=${`ui-settings-row ${shortcutRowClass(resolution)}`}>
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
          <label class="shortcut-input-label ui-form-field">
            <span>Shortcut</span>
            <input
              class="shortcut-input ui-input"
              data-action-id=${action.id}
              aria-label=${`Shortcut for ${action.title}`}
              aria-describedby=${recordingHint !== "" ? `recording-${action.id}` : nothing}
              .value=${inputText}
              placeholder=${action.shortcut ?? "mod+k"}
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              ?disabled=${controlsDisabled}
              @input=${(event: Event) => { this.updateDraft(action.id, inputValue(event)); }}
            >
          </label>
          ${recordingHint !== "" ? html`<small class="recording-hint" id=${`recording-${action.id}`} role="status">${recordingHint}</small>` : null}
          <div class="shortcut-actions ui-settings-actions">
            <button class="primary ui-button ui-button--action ui-button--primary" aria-label=${`Save shortcut for ${action.title}`} ?disabled=${controlsDisabled || !hasDraft || inputText.trim() === ""} @click=${() => { void this.saveShortcut(action); }}>Save</button>
            <button class="ui-button ui-button--action" aria-label=${`${this.recording?.actionId === action.id ? "Cancel recording" : "Record shortcut"} for ${action.title}`} ?disabled=${controlsDisabled} @click=${() => { void this.toggleRecording(action.id); }}>${this.recording?.actionId === action.id ? "Cancel recording" : "Record"}</button>
            <button class="ui-button ui-button--action" aria-label=${`Disable shortcut for ${action.title}`} ?disabled=${controlsDisabled || configured === null} @click=${() => { void this.setShortcutNone(action); }}>Disable shortcut</button>
            <button class="ui-button ui-button--action" aria-label=${`Restore default shortcut for ${action.title}`} ?disabled=${controlsDisabled || !hasConfiguredShortcut} @click=${() => { void this.resetShortcut(action); }}>Restore default</button>
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
    if (recording.tokens.length === 0) return "Recording shortcut: press a key combination or sequence. Press Esc to stop.";
    return `Recording shortcut: ${formatShortcut(recording.tokens.join(" "))}. Press another key to add a sequence, or wait to finish.`;
  }

  private updateDraft(actionId: string, value: string): void {
    this.drafts = { ...this.drafts, [actionId]: value };
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
    if (isComposerShortcut(action.id) && parsed.tokens.length !== 1) {
      this.localError = "Composer send shortcuts must be a single key combination, not a sequence.";
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
    if (this.configResponse === undefined || this.onSave === undefined) return;
    const config: PiWebConfigValues = { ...this.configResponse.config };
    const currentShortcuts = config.shortcuts ?? {};
    const migratedShortcuts = withoutShortcutPreferences(currentShortcuts, [action.id, ...(action.shortcutAliases ?? [])]);
    const shortcuts = shortcut === undefined ? migratedShortcuts : { ...migratedShortcuts, [action.id]: shortcut };
    if (Object.keys(shortcuts).length === 0) {
      delete config.shortcuts;
    } else {
      config.shortcuts = shortcuts;
    }
    const pending = { action, preference: shortcut, draft: this.drafts[action.id] };
    this.pendingSaves.set(action.id, pending);
    try {
      // A resolved callback is not acknowledgement: the owner may catch save errors.
      // Clear the draft only when the returned config contains this preference.
      await this.onSave(config);
      this.requestUpdate();
    } catch (error) {
      if (this.pendingSaves.get(action.id) === pending) this.pendingSaves.delete(action.id);
      this.localError = `Could not save shortcut. ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private shortcutResolutions(): Map<string, ShortcutBindingResolution> {
    const shortcuts = this.previewShortcutConfig();
    // Desktop/mobile composer bindings are mutually exclusive and do not disable app bindings.
    const resolutions = [
      ...resolveShortcutBindings(this.actions, shortcuts, { enabledOnly: true }),
      ...composerShortcutActions().flatMap((action) => resolveShortcutBindings([action], shortcuts)),
    ];
    return new Map(resolutions.map((resolution) => [resolution.action.id, resolution]));
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

  static override styles = [uiButtonStyles, uiFormStyles, uiSettingsStyles, css`
    :host { display: block; }
    h3, p { margin: 0; }
    p { color: var(--pi-muted); line-height: 1.45; }
    .config-path-card span { color: var(--pi-muted); font-size: 12px; font-weight: 600; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); overflow-wrap: anywhere; }
    .shortcut-group { margin: 0; }
    .shortcut-group:has(.shortcut-list) { padding: 0; gap: 0; }
    .shortcut-group:has(.shortcut-list) > .ui-settings-heading { padding: 16px; background: var(--pi-surface); }
    .shortcut-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 48%); align-items: start; }
    .shortcut-row.shadowed { background: color-mix(in srgb, var(--pi-warning) 5%, var(--pi-surface)); }
    .shortcut-row.shadowing { background: color-mix(in srgb, var(--pi-accent) 5%, var(--pi-surface)); }
    .shortcut-row:last-child { border-bottom: 0; }
    .shortcut-main { min-width: 0; display: grid; gap: 4px; }
    .shortcut-main strong, .shortcut-main small { overflow-wrap: anywhere; }
    .shortcut-main small { color: var(--pi-muted); }
    .shortcut-id { font-family: var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .shortcut-editor { min-width: 0; display: grid; gap: 8px; }
    .shortcut-status { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .shortcut-status small { color: var(--pi-muted); font-size: 11px; }
    .shortcut-status small.custom { color: var(--pi-accent); }
    .shortcut-status small.disabled { color: var(--pi-warning); }
    .shortcut-status small.conflict.shadowing { color: var(--pi-accent); }
    .shortcut-status small.conflict.shadowed { color: var(--pi-warning); }
    .shortcut-input { --ui-input-font-family: var(--pi-control-monospace-font-family, var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); }
    kbd { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); padding: 3px 7px; font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); white-space: nowrap; }
    .unassigned { color: var(--pi-muted); font-size: 12px; }
    .recording-hint { color: var(--pi-accent); font-size: 12px; }

    @media (max-width: 760px) {
      .shortcut-row { grid-template-columns: minmax(0, 1fr); align-items: start; }
      .shortcut-status, .shortcut-actions { justify-content: flex-start; }
    }
  `];
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
  if (!resolution.active) return `Conflict: inactive; used by ${resolution.shadowedBy?.action.title ?? "another action"}`;
  const shadowedCount = resolution.shadows.length;
  if (shadowedCount === 0) return undefined;
  const shadowedNames = resolution.shadows.slice(0, 2).map((binding) => binding.action.title).join(", ");
  const suffix = shadowedCount > 2 ? `, +${String(shadowedCount - 2)} more` : "";
  return `Conflict: takes priority over ${String(shadowedCount)} ${shadowedCount === 1 ? "action" : "actions"}: ${shadowedNames}${suffix}`;
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
