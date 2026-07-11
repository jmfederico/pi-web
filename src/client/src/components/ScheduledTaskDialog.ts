import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api, type Project, type ScheduledTask, type ScheduledTaskCreateRequest, type ScheduledTaskSessionMode, type Workspace } from "../api";

type SchedulePreset = "day" | "weekday" | "hour" | "custom";

function presetFromCron(cron: string): SchedulePreset {
  if (/^\d+ \d+ \* \* \*$/.test(cron)) return "day";
  if (/^\d+ \d+ \* \* 1-5$/.test(cron)) return "weekday";
  if (/^0 \* \* \* \*$/.test(cron)) return "hour";
  return "custom";
}

function timeOfDayFromCron(cron: string): string {
  const match = /^(\d+) (\d+) \* \* (\*|1-5)$/.exec(cron);
  if (match === null) return "09:00";
  const [, minute, hour] = match;
  return `${(hour ?? "9").padStart(2, "0")}:${(minute ?? "0").padStart(2, "0")}`;
}

function cronFromPreset(preset: SchedulePreset, timeOfDay: string, customCron: string): string {
  if (preset === "hour") return "0 * * * *";
  if (preset === "custom") return customCron;
  const [hourText, minuteText] = timeOfDay.split(":");
  const hour = String(Number(hourText ?? "9"));
  const minute = String(Number(minuteText ?? "0"));
  return preset === "weekday" ? `${minute} ${hour} * * 1-5` : `${minute} ${hour} * * *`;
}

/**
 * Create/edit modal for a scheduled task, modeled on ProjectDialog's
 * backdrop/section/header/body/footer shape. Opened from within a workspace's
 * "Scheduled tasks" sidebar section, so "where it runs" defaults to that
 * workspace's context rather than starting from a blank picker.
 */
@customElement("scheduled-task-dialog")
export class ScheduledTaskDialog extends LitElement {
  @property({ attribute: false }) task?: ScheduledTask;
  @property() defaultProjectId = "";
  @property() defaultProjectName = "";
  @property() defaultWorkspaceId?: string;
  @property() defaultWorkspaceLabel = "main";
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) onSave?: (input: ScheduledTaskCreateRequest) => void;
  @property({ attribute: false }) onCancel?: () => void;

  @state() private name = "";
  @state() private prompt = "";
  @state() private projectId = "";
  @state() private projectName = "";
  @state() private workspaceId: string | undefined = undefined;
  @state() private workspaceLabel = "main";
  @state() private showWherePicker = false;
  @state() private pickerWorkspaces: Workspace[] = [];
  @state() private preset: SchedulePreset = "day";
  @state() private timeOfDay = "09:00";
  @state() private timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  @state() private customCron = "0 9 * * *";
  @state() private sessionMode: ScheduledTaskSessionMode = "new";
  @state() private notifyOnComplete = false;
  @state() private enabled = true;

  override connectedCallback(): void {
    super.connectedCallback();
    const task = this.task;
    this.name = task?.name ?? "";
    this.prompt = task?.prompt ?? "";
    this.projectId = task?.projectId ?? this.defaultProjectId;
    this.projectName = this.defaultProjectName;
    this.workspaceId = task?.workspaceId ?? this.defaultWorkspaceId;
    this.workspaceLabel = this.defaultWorkspaceLabel;
    const cron = task?.schedule.cron ?? "0 9 * * *";
    this.preset = presetFromCron(cron);
    this.timeOfDay = timeOfDayFromCron(cron);
    this.customCron = cron;
    this.timezone = task?.schedule.timezone ?? this.timezone;
    this.sessionMode = task?.sessionMode ?? "new";
    this.notifyOnComplete = task?.notifyOnComplete ?? false;
    this.enabled = task?.enabled ?? true;
  }

  private get cron(): string {
    return cronFromPreset(this.preset, this.timeOfDay, this.customCron);
  }

  private get canSave(): boolean {
    return this.name.trim() !== "" && this.prompt.trim() !== "" && this.projectId !== "" && this.cron.trim() !== "";
  }

  private async onProjectPicked(projectId: string): Promise<void> {
    this.projectId = projectId;
    this.workspaceId = undefined;
    this.pickerWorkspaces = await api.workspaces(projectId);
    const main = this.pickerWorkspaces.find((workspace) => workspace.isMain);
    if (main !== undefined) this.workspaceId = main.id;
  }

  private submit(): void {
    if (!this.canSave) return;
    const input: ScheduledTaskCreateRequest = {
      name: this.name.trim(),
      projectId: this.projectId,
      prompt: this.prompt.trim(),
      schedule: { cron: this.cron, timezone: this.timezone },
      sessionMode: this.sessionMode,
      notifyOnComplete: this.notifyOnComplete,
      enabled: this.enabled,
      ...(this.workspaceId === undefined ? {} : { workspaceId: this.workspaceId }),
    };
    this.onSave?.(input);
  }

  override render() {
    const editing = this.task !== undefined;
    return html`
      <div class="backdrop" @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.onCancel?.(); }}>
        <section @click=${(event: Event) => { event.stopPropagation(); }}>
          <header>
            <strong>${editing ? "Edit scheduled task" : "New scheduled task"}</strong>
            <button @click=${() => { this.onCancel?.(); }} aria-label="Close">×</button>
          </header>
          <div class="body">
            ${this.renderWhereItRuns()}
            <label class="field">
              <span class="field-heading">Name</span>
              <input type="text" .value=${this.name} @input=${(event: InputEvent) => { this.name = inputValue(event); }} placeholder="Nightly dependency audit">
            </label>
            <label class="field">
              <span class="field-heading">Prompt</span>
              <textarea .value=${this.prompt} @input=${(event: InputEvent) => { this.prompt = inputValue(event); }} placeholder="What should the agent do each time this runs?"></textarea>
              <span class="hint">Sent exactly like this, as the first message of the run — same as typing it yourself.</span>
            </label>
            ${this.renderSchedule()}
            ${this.renderSessionMode()}
            <label class="check">
              <input type="checkbox" .checked=${this.notifyOnComplete} @change=${(event: Event) => { this.notifyOnComplete = checkboxValue(event); }}>
              Notify me when a run finishes
            </label>
            <label class="check">
              <input type="checkbox" .checked=${this.enabled} @change=${(event: Event) => { this.enabled = checkboxValue(event); }}>
              Enabled
            </label>
          </div>
          <footer>
            <button @click=${() => { this.onCancel?.(); }}>Cancel</button>
            <button class="primary" ?disabled=${!this.canSave} @click=${() => { this.submit(); }}>${editing ? "Save changes" : "Create task"}</button>
          </footer>
        </section>
      </div>
    `;
  }

  private renderWhereItRuns() {
    if (!this.showWherePicker) {
      return html`
        <div class="field">
          <span class="field-heading">Where it runs</span>
          <div class="where-context">
            <span class="path"><strong>${this.projectName}</strong><span class="sep">·</span>${this.workspaceLabel}</span>
            <button class="link" @click=${() => { this.showWherePicker = true; }}>Change</button>
          </div>
        </div>
      `;
    }
    return html`
      <div class="field">
        <span class="field-heading">Where it runs</span>
        <div class="two-col">
          <select .value=${this.projectId} @change=${(event: Event) => { void this.onProjectPicked(selectValue(event)); }}>
            ${this.projects.map((project) => html`<option value=${project.id} ?selected=${project.id === this.projectId}>${project.name}</option>`)}
          </select>
          <select .value=${this.workspaceId ?? ""} @change=${(event: Event) => { this.workspaceId = selectValue(event); }}>
            ${this.pickerWorkspaces.map((workspace) => html`<option value=${workspace.id} ?selected=${workspace.id === this.workspaceId}>${workspace.label}${workspace.isMain ? " · main" : ""}</option>`)}
          </select>
        </div>
      </div>
    `;
  }

  private renderSchedule() {
    return html`
      <div class="field">
        <span class="field-heading">Schedule</span>
        <div class="chip-row">
          ${(["day", "weekday", "hour", "custom"] as const).map((preset) => html`
            <button class="chip ${this.preset === preset ? "selected" : ""}" @click=${() => { this.preset = preset; }}>${presetLabel(preset)}</button>
          `)}
        </div>
        ${this.preset === "custom" ? html`
          <div class="schedule-detail">
            <input class="cron-input" type="text" .value=${this.customCron} @input=${(event: InputEvent) => { this.customCron = inputValue(event); }}>
            ${this.renderTimezonePicker()}
          </div>
        ` : this.preset === "hour" ? null : html`
          <div class="schedule-detail">
            <input type="time" .value=${this.timeOfDay} @input=${(event: InputEvent) => { this.timeOfDay = inputValue(event); }}>
            ${this.renderTimezonePicker()}
          </div>
        `}
      </div>
    `;
  }

  private renderTimezonePicker() {
    return html`<input class="timezone-input" type="text" .value=${this.timezone} @input=${(event: InputEvent) => { this.timezone = inputValue(event); }} title="IANA timezone, e.g. Asia/Jakarta">`;
  }

  private renderSessionMode() {
    return html`
      <div class="field">
        <span class="field-heading">When it runs</span>
        <label class="radio">
          <input type="radio" name="session-mode" .checked=${this.sessionMode === "new"} @change=${() => { this.sessionMode = "new"; }}>
          <span class="radio-copy">
            <span class="title">Start a new session each run</span>
            <span class="desc">Fresh context every time — best for self-contained jobs.</span>
          </span>
        </label>
        <label class="radio disabled">
          <input type="radio" name="session-mode" disabled>
          <span class="radio-copy">
            <span class="title">Continue the most recent session <span class="badge">Coming soon</span></span>
            <span class="desc">Keep adding to the same running session — for tasks that build on prior context.</span>
          </span>
        </label>
      </div>
    `;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 30; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .backdrop { display: grid; place-items: start center; width: 100%; height: 100%; padding-top: min(6vh, 56px); box-sizing: border-box; background: var(--pi-overlay); }
    section { width: min(640px, calc(100vw - 40px)); max-height: min(680px, calc(100vh - 40px)); display: flex; flex-direction: column; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); overflow: hidden; }
    header, footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--pi-border); }
    footer { border-top: 1px solid var(--pi-border); border-bottom: 0; justify-content: end; }
    .body { display: grid; gap: 16px; padding: 14px; min-height: 0; overflow: auto; }
    .field { display: grid; gap: 7px; }
    .field-heading { color: var(--pi-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    input[type="text"], input[type="time"], input:not([type]), select, textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 9px; font: var(--pi-control-font-size, 14px) var(--pi-control-font-family, system-ui, sans-serif); }
    textarea { min-height: 84px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
    .cron-input, .timezone-input { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .hint { color: var(--pi-muted); font-size: 12.5px; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .where-context { display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-surface); padding: 9px 10px; }
    .where-context .sep { color: var(--pi-muted); margin: 0 5px; }
    .link { border: 0; background: transparent; color: var(--pi-accent); padding: 0; cursor: pointer; font-size: 12.5px; }
    .link:hover { text-decoration: underline; }
    .chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-muted); padding: 6px 13px; font-size: 12.5px; cursor: pointer; }
    .chip.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); color: var(--pi-text); }
    .schedule-detail { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .schedule-detail input { width: auto; }
    .radio { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; }
    .radio.disabled { opacity: .6; }
    .radio input { width: auto; margin-top: 3px; }
    .radio-copy { display: grid; gap: 2px; }
    .radio-copy .title { display: flex; align-items: center; gap: 8px; }
    .radio-copy .desc { color: var(--pi-muted); font-size: 12.5px; }
    .badge { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); background: var(--pi-warning-surface); padding: 1px 7px; font-size: 10.5px; text-transform: uppercase; }
    .check { display: flex; align-items: center; gap: 8px; }
    .check input { width: auto; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    header button { border: 0; background: transparent; color: var(--pi-muted); font-size: 22px; padding: 0 8px; }
    .primary { border-color: var(--pi-accent); background: var(--pi-selection-bg); color: var(--pi-text-bright); }
    button:disabled { opacity: .5; cursor: not-allowed; }
  `;
}

function presetLabel(preset: SchedulePreset): string {
  switch (preset) {
    case "day": return "Every day";
    case "weekday": return "Every weekday";
    case "hour": return "Every hour";
    case "custom": return "Custom";
  }
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ? event.target.value : "";
}

function selectValue(event: Event): string {
  return event.target instanceof HTMLSelectElement ? event.target.value : "";
}

function checkboxValue(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false;
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduled-task-dialog": ScheduledTaskDialog;
  }
}
