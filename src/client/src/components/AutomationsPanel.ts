import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  AutomationDefinition,
  AutomationDraft,
  AutomationModelPolicy,
  AutomationModelsResponse,
  AutomationRun,
  AutomationRunStatus,
  AutomationThinkingPolicy,
  AutomationTrigger,
  UpdateAutomationRequest,
} from "../api";
import { automationsApi } from "../api";
import type { WorkspacePanelContext } from "../plugins/types";
import { formatCost, formatTokenCount } from "../utils/format";

const ACTIVE_STATUSES: readonly AutomationRunStatus[] = ["queued", "starting", "running", "cancelling"];
const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

interface AutomationFormState {
  name: string;
  description: string;
  prompt: string;
  triggerType: AutomationTrigger["type"];
  schedule: string;
  timeZone: string;
  modelKey: string;
  thinkingLevel: string;
  timeoutMinutes: string;
}

interface AutomationAggregate {
  automationId: string;
  name: string;
  runs: number;
  tokens?: number;
  unknownTokens: number;
  costMicros?: number;
  unknownCost: number;
}

@customElement("automations-panel")
export class AutomationsPanel extends LitElement {
  @property({ attribute: false }) context?: WorkspacePanelContext;

  @state() private definitions: AutomationDefinition[] = [];
  @state() private runs: AutomationRun[] = [];
  @state() private modelOptions: AutomationModelsResponse | undefined;
  @state() private loading = true;
  @state() private error = "";
  @state() private showForm = false;
  @state() private editingId: string | undefined;
  @state() private editingRevision: number | undefined;
  @state() private busyIds = new Set<string>();
  @state() private form: AutomationFormState = emptyForm();

  private targetKey = "";
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshGeneration = 0;
  private connected = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.connected = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    void (this.currentTargetKey() === this.targetKey ? this.refresh() : this.refreshForCurrentTarget());
  }

  override disconnectedCallback(): void {
    this.connected = false;
    this.refreshGeneration += 1;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    super.disconnectedCallback();
  }

  protected override updated(): void {
    const key = this.currentTargetKey();
    if (key !== "" && key !== this.targetKey) void this.refreshForCurrentTarget();
  }

  override render(): TemplateResult {
    const context = this.context;
    if (context === undefined) return html`<p class="empty">Select a workspace to manage automations.</p>`;
    const terminalRuns = this.runs.filter((run) => !ACTIVE_STATUSES.includes(run.status));
    const durations = terminalRuns.map(runDurationMs).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
    const knownUsages = terminalRuns.flatMap((run) => {
      const usage = knownAutomationUsage(run);
      return usage === undefined ? [] : [usage];
    });
    const usagesWithCost = knownUsages.filter((usage) => usage.estimatedCostMicros !== undefined);
    const totalTokens = knownUsages.reduce((sum, usage) => sum + usage.tokens.total, 0);
    const knownCostMicros = usagesWithCost.reduce((sum, usage) => sum + (usage.estimatedCostMicros ?? 0), 0);
    const attention = terminalRuns.filter((run) => run.status === "failed" || run.status === "timed_out" || run.status === "unknown").length;

    return html`
      <section class="panel" aria-label="Workspace automations">
        <header class="toolbar">
          <div>
            <h2>Automations</h2>
            <p>Fresh Pi sessions scheduled and supervised by this machine.</p>
          </div>
          <div class="toolbar-actions">
            <button @click=${() => void this.refresh()} ?disabled=${this.loading}>Refresh</button>
            <button class="primary" @click=${this.openCreateForm}>${this.showForm && this.editingId === undefined ? "Close" : "New automation"}</button>
          </div>
        </header>

        ${this.error === "" ? nothing : html`<div class="error" role="alert">${this.error}</div>`}
        ${this.showForm ? this.renderForm() : nothing}

        <section class="kpis" aria-label="Automation summary">
          ${kpi("Runs", String(terminalRuns.length), `${String(this.runs.filter((run) => ACTIVE_STATUSES.includes(run.status)).length)} active`)}
          ${kpi("Needs attention", String(attention), "failed, timed out, or unknown")}
          ${kpi("Median / p95", `${formatDuration(percentile(durations, 0.5))} / ${formatDuration(percentile(durations, 0.95))}`, "execution duration")}
          ${kpi("Root tokens", knownUsages.length === 0 ? "Unknown" : formatTokenCount(totalTokens), `${String(knownUsages.length)}/${String(terminalRuns.length)} runs reported · direct session usage`)}
          ${kpi("Estimated spend", usagesWithCost.length === 0 ? "Unknown" : formatCost(knownCostMicros / 1_000_000), `${String(usagesWithCost.length)}/${String(terminalRuns.length)} runs estimated`)}
        </section>

        ${this.renderSwimlane()}
        ${this.renderUsageOverview()}

        <section class="section">
          <div class="section-heading"><h3>Automation jobs</h3><span>${String(this.definitions.length)}</span></div>
          ${this.loading && this.definitions.length === 0 ? html`<p class="empty">Loading automations…</p>` : this.definitions.length === 0 ? html`<p class="empty">No automations yet. Create a disabled draft, run it once, then enable its schedule.</p>` : html`
            <div class="definition-grid">${this.definitions.map((definition) => this.renderDefinition(definition))}</div>
          `}
        </section>

        ${this.renderRunHistory()}
      </section>
    `;
  }

  private renderForm(): TemplateResult {
    const form = this.form;
    const editing = this.editingId !== undefined;
    const modelAvailable = form.modelKey === "default" || this.modelOptions?.models.some((model) => modelKey(model.provider, model.id) === form.modelKey) === true;
    const unavailableModel = modelAvailable || form.modelKey === "" ? undefined : modelLabel(modelFromKey(form.modelKey));
    return html`
      <form class="editor" @submit=${this.submitForm}>
        <div class="editor-heading">
          <div><strong>${editing ? "Edit automation" : "New automation"}</strong><small>${editing ? "Changes disable the schedule until this revision is tested." : "New jobs are saved disabled."}</small></div>
          <button type="button" aria-label="Close automation editor" @click=${this.closeForm}>×</button>
        </div>
        <label>Name<input .value=${form.name} @input=${this.updateField("name")} required maxlength="120" /></label>
        <label>Description<input .value=${form.description} @input=${this.updateField("description")} maxlength="500" /></label>
        <label class="wide">Prompt<textarea .value=${form.prompt} @input=${this.updateField("prompt")} required rows="5"></textarea></label>
        <label>Trigger
          <select .value=${form.triggerType} @change=${this.updateField("triggerType")}>
            <option value="manual">Manual only</option>
            <option value="once">One shot</option>
            <option value="interval">Interval</option>
            <option value="cron">Cron</option>
          </select>
        </label>
        ${this.renderScheduleField(form)}
        <label>Model
          <select .value=${form.modelKey} @change=${this.changeModelField}>
            ${unavailableModel === undefined ? nothing : html`<option value=${form.modelKey}>Unavailable: ${unavailableModel}</option>`}
            ${this.modelOptions?.models.map((model) => {
              const key = modelKey(model.provider, model.id);
              return html`<option value=${key}>${model.name ?? model.id ?? "Unknown model"} · ${model.provider ?? "unknown"}</option>`;
            })}
            <option value="default">Follow machine default</option>
          </select>
        </label>
        <label>Thinking
          <select .value=${form.thinkingLevel} @change=${this.updateField("thinkingLevel")}>
            <option value="default">Model default</option>
            ${this.thinkingLevelOptions(form).map((level) => html`<option value=${level}>${level}</option>`)}
          </select>
        </label>
        <label>Timeout (minutes)<input type="number" min="1" max="1440" step="1" .value=${form.timeoutMinutes} @input=${this.updateField("timeoutMinutes")} required /></label>
        <div class="form-actions wide">
          <button type="button" @click=${this.closeForm}>Cancel</button>
          <button class="primary" type="submit">${editing ? "Save and require retest" : "Save disabled draft"}</button>
        </div>
      </form>
    `;
  }

  private renderScheduleField(form: AutomationFormState): TemplateResult | typeof nothing {
    if (form.triggerType === "manual") return nothing;
    if (form.triggerType === "once") return html`<label>Run at<input type="datetime-local" .value=${form.schedule} @input=${this.updateField("schedule")} required /></label>`;
    if (form.triggerType === "interval") return html`<label>Every (minutes)<input type="number" min="1" step="1" .value=${form.schedule} @input=${this.updateField("schedule")} required /></label>`;
    return html`
      <label>Cron expression<input .value=${form.schedule} @input=${this.updateField("schedule")} placeholder="0 0 9 * * 1-5" required /></label>
      <label>Timezone<input .value=${form.timeZone} @input=${this.updateField("timeZone")} placeholder="Europe/Amsterdam" required /></label>
    `;
  }

  private renderDefinition(definition: AutomationDefinition): TemplateResult {
    const latest = this.runs.find((run) => run.automationId === definition.id);
    const tested = definition.testedRevision === definition.revision;
    const latestUsage = latest === undefined ? undefined : knownAutomationUsage(latest);
    const active = this.runs.find((run) => run.automationId === definition.id && ACTIVE_STATUSES.includes(run.status));
    return html`
      <article class="definition ${definition.enabled ? "enabled" : "paused"}">
        <div class="definition-title">
          <span class="status-dot" aria-label=${definition.enabled ? "enabled" : "paused"}></span>
          <div><strong>${definition.name}</strong><small>${describeTrigger(definition.trigger)}</small></div>
          <span class="revision">r${String(definition.revision)}</span>
        </div>
        ${definition.description === undefined ? nothing : html`<p>${definition.description}</p>`}
        <div class="badges">
          <span>${modelLabel(definition.model)}</span>
          <span>thinking ${thinkingLabel(definition.thinking)}</span>
          <span>${formatDuration(definition.timeoutMs)} timeout</span>
          <span class=${tested ? "tested" : "untested"}>${tested ? "tested" : "retest required"}</span>
        </div>
        <dl>
          <div><dt>Next</dt><dd>${definition.nextRunAt === undefined ? "—" : formatDateTime(definition.nextRunAt)}</dd></div>
          <div><dt>Last</dt><dd>${latest === undefined ? "never" : `${latest.status} · ${formatDuration(runDurationMs(latest))}`}</dd></div>
          <div><dt>Usage</dt><dd>${latestUsage === undefined ? "unavailable" : `${formatTokenCount(latestUsage.tokens.total)} · ${latestUsage.estimatedCostMicros === undefined ? "cost unknown" : `est. ${formatCost(latestUsage.estimatedCostMicros / 1_000_000)}`}`}</dd></div>
        </dl>
        <div class="definition-actions">
          <button @click=${() => { this.beginEdit(definition); }}>Edit</button>
          <button class="primary" @click=${() => void this.runNow(definition)} ?disabled=${this.isBusy(definition.id) || active !== undefined}>Run now</button>
          <button @click=${() => void this.toggleEnabled(definition)} ?disabled=${this.isBusy(definition.id) || (!definition.enabled && !tested)} title=${!definition.enabled && !tested ? "Complete a successful manual run of this revision first" : ""}>${definition.enabled ? "Pause" : "Enable"}</button>
          <button class="danger" @click=${() => void this.deleteDefinition(definition)} ?disabled=${this.isBusy(definition.id) || active !== undefined}>Delete</button>
        </div>
      </article>
    `;
  }

  private renderSwimlane(): TemplateResult {
    const plotted = this.runs.filter((run) => run.startedAt !== undefined).slice(0, 80);
    if (plotted.length === 0) return html`<section class="section"><div class="section-heading"><h3>Run timeline</h3></div><p class="empty">Runs will appear here with their elapsed time and outcome.</p></section>`;
    const now = Date.now();
    const starts = plotted.map((run) => Date.parse(run.startedAt ?? "")).filter(Number.isFinite);
    const ends = plotted.map((run) => Date.parse(run.completedAt ?? new Date(now).toISOString())).filter(Number.isFinite);
    const min = Math.min(...starts);
    const max = Math.max(...ends, min + 1);
    const span = Math.max(1, max - min);
    const lanes = [...new Map(plotted.map((run) => [run.automationId, run.automationName])).entries()]
      .map(([automationId, name]) => ({ automationId, name, runs: plotted.filter((run) => run.automationId === automationId) }));
    return html`
      <section class="section">
        <div class="section-heading"><h3>Run timeline</h3><span>${formatDateTime(new Date(min).toISOString())} – ${formatDateTime(new Date(max).toISOString())}</span></div>
        <div class="swimlane" role="img" aria-label="Automation run timeline. A table with the same data follows below.">
          ${lanes.map(({ name, runs }) => html`
            <div class="lane-label" title=${name}>${name}</div>
            <div class="lane-track">
              ${runs.map((run) => {
                const start = Date.parse(run.startedAt ?? "");
                const end = Date.parse(run.completedAt ?? new Date(now).toISOString());
                const left = Math.max(0, ((start - min) / span) * 100);
                const width = Math.max(1, ((Math.max(end, start + 1) - start) / span) * 100);
                return html`<span class="run-bar ${run.status}" style=${`left:${left.toFixed(2)}%;width:${width.toFixed(2)}%`} title=${`${run.status} · ${formatDuration(runDurationMs(run, now))}`}></span>`;
              })}
            </div>
          `)}
        </div>
      </section>
    `;
  }

  private renderUsageOverview(): TemplateResult {
    const aggregates = aggregateRuns(this.runs);
    const maxTokens = Math.max(1, ...aggregates.flatMap((entry) => entry.tokens === undefined ? [] : [entry.tokens]));
    return html`
      <section class="section usage-overview">
        <div class="section-heading"><h3>Usage by automation</h3><span>root sessions · estimated cost</span></div>
        ${aggregates.length === 0 ? html`<p class="empty">Usage is captured when a run settles.</p>` : html`
          <table>
            <caption class="sr-only">Root-session usage totals by automation</caption>
            <thead><tr><th scope="col">Automation</th><th scope="col">Runs</th><th scope="col">Tokens</th><th scope="col">Estimated cost</th></tr></thead>
            <tbody>${aggregates.map((entry) => html`
              <tr>
                <th scope="row">${entry.name}</th><td>${String(entry.runs)}</td>
                <td>${entry.tokens === undefined ? "unknown" : html`<div class="meter"><span style=${`width:${((entry.tokens / maxTokens) * 100).toFixed(1)}%`}></span></div>${formatTokenCount(entry.tokens)}`}${entry.unknownTokens > 0 ? ` · ${String(entry.unknownTokens)} unknown` : ""}</td>
                <td>${entry.costMicros === undefined ? "unknown" : formatCost(entry.costMicros / 1_000_000)}${entry.unknownCost > 0 ? ` · ${String(entry.unknownCost)} unknown` : ""}</td>
              </tr>
            `)}</tbody>
          </table>
        `}
      </section>
    `;
  }

  private renderRunHistory(): TemplateResult {
    return html`
      <section class="section history">
        <div class="section-heading"><h3>Run inbox</h3><span>${String(this.runs.length)} recent runs</span></div>
        ${this.runs.length === 0 ? html`<p class="empty">No runs yet.</p>` : html`
          <div class="table-scroll"><table>
            <caption class="sr-only">Recent automation runs with queue, execution, model, usage, and outcome details</caption>
            <thead><tr><th scope="col">Automation</th><th scope="col">Status</th><th scope="col">Queued</th><th scope="col">Started</th><th scope="col">Completed</th><th scope="col">Duration</th><th scope="col">Model</th><th scope="col">Root tokens</th><th scope="col">Estimated cost</th><th scope="col">Action</th></tr></thead>
            <tbody>${this.runs.map((run) => {
              const usage = knownAutomationUsage(run);
              return html`<tr class=${`run-row ${run.status}`}>
                <th scope="row"><strong>${run.automationName}</strong><small>${run.source} · r${String(run.automationRevision)}</small></th>
                <td><span class=${`status-pill ${run.status}`}>${run.status.replaceAll("_", " ")}</span>${run.reason === undefined ? nothing : html`<small>${run.reason.replaceAll("_", " ")}</small>`}${run.error === undefined ? nothing : html`<small title=${run.error}>${run.error}</small>`}</td>
                <td>${formatDateTime(run.queuedAt)}</td>
                <td>${run.startedAt === undefined ? "Not started" : formatDateTime(run.startedAt)}</td>
                <td>${run.completedAt === undefined ? "—" : formatDateTime(run.completedAt)}</td>
                <td>${formatDuration(runDurationMs(run))}</td>
                <td>${run.actualModel === undefined ? modelLabel(run.configuredModel) : sessionModelLabel(run.actualModel)}${run.actualThinkingLevel === undefined ? "" : ` · ${run.actualThinkingLevel}`}</td>
                <td>${usage === undefined ? "unknown" : html`${formatTokenCount(usage.tokens.total)}<small>${usage.quality.replaceAll("_", " ")} · ${tokenBreakdown(usage.tokens)}</small>`}</td>
                <td>${usage?.estimatedCostMicros === undefined ? "unknown" : `est. ${formatCost(usage.estimatedCostMicros / 1_000_000)}`}</td>
                <td>${ACTIVE_STATUSES.includes(run.status)
                  ? html`<button class="danger" @click=${() => void this.cancelRun(run)} ?disabled=${this.isBusy(run.id) || run.status === "cancelling"}>${run.status === "cancelling" ? "Stopping…" : "Cancel"}</button>`
                  : run.sessionId === undefined ? "—" : html`<a href=${this.sessionHref(run.sessionId)}>Open session</a>`}
                </td>
              </tr>`;
            })}</tbody>
          </table></div>
        `}
      </section>
    `;
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") void this.refresh();
    else {
      this.refreshGeneration += 1;
      if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  };

  private readonly openCreateForm = (): void => {
    if (this.showForm && this.editingId === undefined) {
      this.closeForm();
      return;
    }
    this.editingId = undefined;
    this.editingRevision = undefined;
    this.form = emptyForm(this.preferredModelKey(), this.modelOptions?.defaultTimeoutMs);
    this.showForm = true;
  };

  private readonly closeForm = (): void => {
    this.showForm = false;
    this.editingId = undefined;
    this.editingRevision = undefined;
  };

  private beginEdit(definition: AutomationDefinition): void {
    const edit = snapshotAutomationEdit(definition);
    this.editingId = edit.id;
    this.editingRevision = edit.expectedRevision;
    this.form = edit.form;
    this.showForm = true;
  }

  private updateField(field: keyof AutomationFormState): (event: Event) => void {
    return (event: Event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
      this.form = { ...this.form, [field]: target.value };
    };
  }

  private readonly changeModelField = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) return;
    const modelKeyValue = target.value;
    this.form = { ...this.form, modelKey: modelKeyValue, thinkingLevel: thinkingLevelForModel(modelKeyValue, this.form.thinkingLevel, this.modelOptions) };
  };

  private thinkingLevelOptions(form: AutomationFormState): readonly string[] {
    return thinkingLevelOptions(form.modelKey, form.thinkingLevel, this.modelOptions);
  }

  private readonly submitForm = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const context = this.context;
    if (context === undefined) return;
    const targetKey = this.currentTargetKey();
    try {
      const draft = draftFromForm(this.form, context.workspace.projectId, context.workspace.id, this.modelOptions);
      if (this.editingId === undefined) {
        await automationsApi.create(draft, context.machine.id);
      } else {
        const expectedRevision = this.editingRevision;
        if (expectedRevision === undefined) throw new Error("Automation edit revision is unavailable");
        const update: UpdateAutomationRequest = { ...draft, description: this.form.description, expectedRevision };
        await automationsApi.update(this.editingId, update, context.machine.id);
      }
      if (targetKey !== this.currentTargetKey()) return;
      this.closeForm();
      await this.refresh();
    } catch (error) {
      if (targetKey === this.currentTargetKey()) this.error = errorMessage(error);
    }
  };

  private async runNow(definition: AutomationDefinition): Promise<void> {
    await this.mutate(definition.id, async () => { await automationsApi.runNow(definition.id, this.scope(), this.machineId()); });
  }

  private async toggleEnabled(definition: AutomationDefinition): Promise<void> {
    await this.mutate(definition.id, async () => {
      await automationsApi.update(definition.id, { ...this.scope(), expectedRevision: definition.revision, enabled: !definition.enabled }, this.machineId());
    });
  }

  private async deleteDefinition(definition: AutomationDefinition): Promise<void> {
    if (!confirm(`Delete automation "${definition.name}"? Its run history will be retained.`)) return;
    await this.mutate(definition.id, async () => { await automationsApi.delete(definition.id, this.scope(), this.machineId()); });
  }

  private async cancelRun(run: AutomationRun): Promise<void> {
    if (!confirm(`Cancel the active run of "${run.automationName}"?`)) return;
    await this.mutate(run.id, async () => { await automationsApi.cancel(run.id, this.scope(), this.machineId()); });
  }

  private async mutate(id: string, operation: () => Promise<void>): Promise<void> {
    const targetKey = this.currentTargetKey();
    this.busyIds = new Set(this.busyIds).add(id);
    this.error = "";
    try {
      await operation();
      if (targetKey === this.currentTargetKey()) await this.refresh();
    } catch (error) {
      if (targetKey === this.currentTargetKey()) this.error = errorMessage(error);
    } finally {
      if (targetKey === this.currentTargetKey()) {
        const next = new Set(this.busyIds);
        next.delete(id);
        this.busyIds = next;
      }
    }
  }

  private async refreshForCurrentTarget(): Promise<void> {
    const key = this.currentTargetKey();
    if (key === "" || key === this.targetKey) return;
    this.targetKey = key;
    this.refreshGeneration += 1;
    this.definitions = [];
    this.runs = [];
    this.modelOptions = undefined;
    this.busyIds = new Set();
    this.closeForm();
    this.form = emptyForm();
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const context = this.context;
    if (context === undefined || !this.connected || document.hidden) return;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    const key = this.currentTargetKey();
    const generation = ++this.refreshGeneration;
    this.loading = true;
    try {
      const scope = this.scope();
      const [definitions, runs, modelOptions] = await Promise.all([
        automationsApi.definitions(scope, context.machine.id),
        automationsApi.runs(scope, { limit: 200 }, context.machine.id),
        automationsApi.models(context.machine.id),
      ]);
      if (!this.isCurrentRefresh(generation, key)) return;
      this.definitions = definitions.automations;
      this.runs = runs.runs;
      this.modelOptions = modelOptions;
      if (this.form.modelKey === "") this.form = { ...this.form, modelKey: this.preferredModelKey(), timeoutMinutes: String(modelOptions.defaultTimeoutMs / 60_000) };
      this.error = "";
    } catch (error) {
      if (this.isCurrentRefresh(generation, key)) this.error = errorMessage(error);
    } finally {
      if (this.isCurrentRefresh(generation, key) && this.isDocumentVisible()) {
        this.loading = false;
        const active = this.runs.some((run) => ACTIVE_STATUSES.includes(run.status));
        this.refreshTimer = setTimeout(() => { void this.refresh(); }, active ? 2_000 : 15_000);
      }
    }
  }

  private isCurrentRefresh(generation: number, key: string): boolean {
    return this.connected && generation === this.refreshGeneration && key === this.currentTargetKey();
  }

  private isDocumentVisible(): boolean {
    return !document.hidden;
  }

  private preferredModelKey(): string {
    const current = this.context?.state.status?.model;
    if (current?.provider !== undefined && current.id !== undefined && this.modelOptions?.models.some((model) => model.provider === current.provider && model.id === current.id) === true) {
      return modelKey(current.provider, current.id);
    }
    const fallback = this.modelOptions?.defaultModel ?? this.modelOptions?.models[0];
    return fallback?.provider === undefined || fallback.id === undefined ? "default" : modelKey(fallback.provider, fallback.id);
  }

  private scope(): { projectId: string; workspaceId: string } {
    const workspace = this.context?.workspace;
    if (workspace === undefined) throw new Error("Select a workspace first");
    return { projectId: workspace.projectId, workspaceId: workspace.id };
  }

  private machineId(): string {
    return this.context?.machine.id ?? "local";
  }

  private currentTargetKey(): string {
    const context = this.context;
    return context === undefined ? "" : `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
  }

  private isBusy(id: string): boolean {
    return this.busyIds.has(id);
  }

  private sessionHref(sessionId: string): string {
    const context = this.context;
    if (context === undefined) return "?";
    const params = new URLSearchParams();
    if (context.machine.id !== "local") params.set("machine", context.machine.id);
    params.set("project", context.workspace.projectId);
    params.set("workspace", context.workspace.id);
    params.set("session", sessionId);
    params.set("view", "chat");
    return `?${params.toString()}`;
  }

  static override styles = css`
    :host { display: block; min-height: 100%; color: var(--pi-text); }
    .panel { display: grid; gap: 14px; padding: 14px; }
    h2, h3, p { margin: 0; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    h2 { font-size: 18px; }
    h3 { font-size: 14px; }
    button, input, select, textarea { font: inherit; }
    button { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-surface); color: var(--pi-text); cursor: pointer; padding: 6px 9px; }
    button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    button:disabled { cursor: not-allowed; opacity: .45; }
    button.primary { background: var(--pi-accent); border-color: var(--pi-accent-border); color: var(--pi-text-bright); }
    button.danger { color: var(--pi-danger); }
    a { color: var(--pi-accent); }
    .toolbar, .section-heading, .editor-heading, .definition-title, .definition-actions, .toolbar-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .toolbar p, small, .section-heading span { color: var(--pi-muted); font-size: 11px; }
    .error { padding: 9px 11px; border: 1px solid var(--pi-danger); border-radius: 6px; color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 8%, transparent); }
    .editor { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; border: 1px solid var(--pi-border); border-radius: 8px; padding: 12px; background: var(--pi-surface); }
    .editor-heading, .wide { grid-column: 1 / -1; }
    .editor-heading div { display: grid; gap: 2px; }
    label { display: grid; gap: 4px; color: var(--pi-muted); font-size: 11px; }
    input, select, textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); color: var(--pi-text); padding: 7px 8px; }
    textarea { resize: vertical; }
    .form-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .kpis { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; }
    .kpi, .section, .definition { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); }
    .kpi { display: grid; gap: 4px; padding: 10px; }
    .kpi strong { font-size: 17px; }
    .kpi span { color: var(--pi-muted); font-size: 10px; }
    .section { display: grid; gap: 10px; padding: 11px; }
    .definition-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(285px, 1fr)); gap: 9px; }
    .definition { display: grid; gap: 9px; padding: 10px; }
    .definition-title { justify-content: flex-start; }
    .definition-title div { display: grid; flex: 1; gap: 2px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--pi-muted); }
    .enabled .status-dot { background: var(--pi-success); }
    .revision { color: var(--pi-muted); font-size: 10px; }
    .badges { display: flex; flex-wrap: wrap; gap: 5px; }
    .badges span, .status-pill { border-radius: 999px; background: var(--pi-bg); border: 1px solid var(--pi-border-muted); padding: 2px 6px; font-size: 10px; }
    .badges .tested { color: var(--pi-success); }
    .badges .untested { color: var(--pi-warning, #d99b38); }
    dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 0; }
    dl div { min-width: 0; }
    dt { color: var(--pi-muted); font-size: 9px; text-transform: uppercase; }
    dd { overflow: hidden; margin: 2px 0 0; text-overflow: ellipsis; font-size: 11px; white-space: nowrap; }
    .definition-actions { justify-content: flex-end; }
    .empty { padding: 14px; color: var(--pi-muted); text-align: center; }
    .swimlane { display: grid; grid-template-columns: minmax(90px, 160px) 1fr; gap: 5px 8px; align-items: center; }
    .lane-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .lane-track { position: relative; height: 18px; border-radius: 4px; background: var(--pi-bg); overflow: hidden; }
    .run-bar { position: absolute; top: 3px; height: 12px; min-width: 3px; border-radius: 3px; background: var(--pi-accent); }
    .run-bar.completed { background: var(--pi-success); }
    .run-bar.failed, .run-bar.timed_out, .run-bar.unknown { background: var(--pi-danger); }
    .run-bar.cancelled, .run-bar.skipped { background: var(--pi-muted); }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { padding: 7px; border-bottom: 1px solid var(--pi-border); text-align: left; vertical-align: top; }
    th { color: var(--pi-muted); font-size: 9px; text-transform: uppercase; }
    td small, .run-row th small { display: block; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .table-scroll { overflow-x: auto; }
    .history table { min-width: 1280px; }
    .status-pill.completed { color: var(--pi-success); }
    .status-pill.failed, .status-pill.timed_out, .status-pill.unknown { color: var(--pi-danger); }
    .meter { display: inline-block; width: 72px; height: 5px; margin-right: 6px; border-radius: 999px; background: var(--pi-bg); overflow: hidden; vertical-align: middle; }
    .meter span { display: block; height: 100%; background: var(--pi-accent); }
    @media (max-width: 850px) {
      .kpis { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .editor { grid-template-columns: 1fr; }
      .editor > * { grid-column: 1; }
      .toolbar { align-items: flex-start; }
      .definition-actions { flex-wrap: wrap; }
    }
  `;
}

function kpi(label: string, value: string, detail: string): TemplateResult {
  return html`<article class="kpi"><small>${label}</small><strong>${value}</strong><span>${detail}</span></article>`;
}

function emptyForm(preferredModel = "", defaultTimeoutMs = 60 * 60_000): AutomationFormState {
  return { name: "", description: "", prompt: "", triggerType: "manual", schedule: "", timeZone: DEFAULT_TIME_ZONE, modelKey: preferredModel, thinkingLevel: "default", timeoutMinutes: String(defaultTimeoutMs / 60_000) };
}

export function snapshotAutomationEdit(definition: AutomationDefinition): { id: string; expectedRevision: number; form: AutomationFormState } {
  return { id: definition.id, expectedRevision: definition.revision, form: formFromDefinition(definition) };
}

function formFromDefinition(definition: AutomationDefinition): AutomationFormState {
  const trigger = definition.trigger;
  const schedule = trigger.type === "once" ? toLocalDateTime(trigger.at) : trigger.type === "interval" ? String(trigger.intervalMs / 60_000) : trigger.type === "cron" ? trigger.expression : "";
  return {
    name: definition.name,
    description: definition.description ?? "",
    prompt: definition.prompt,
    triggerType: trigger.type,
    schedule,
    timeZone: trigger.type === "cron" ? trigger.timeZone : DEFAULT_TIME_ZONE,
    modelKey: definition.model.mode === "default" ? "default" : modelKey(definition.model.provider, definition.model.id),
    thinkingLevel: definition.thinking.mode === "default" ? "default" : definition.thinking.level,
    timeoutMinutes: String(definition.timeoutMs / 60_000),
  };
}

/** Thinking levels the model behind `modelKeyValue` supports, or undefined when the concrete model is unknown (e.g. "Follow machine default"). */
export function supportedThinkingLevels(modelKeyValue: string, options?: AutomationModelsResponse): readonly string[] | undefined {
  if (modelKeyValue === "" || modelKeyValue === "default") return undefined;
  return options?.models.find((model) => modelKey(model.provider, model.id) === modelKeyValue)?.thinkingLevels;
}

/**
 * Options for the Thinking dropdown: the selected model's supported levels when
 * known, otherwise the full known set. A pinned level outside the set is still
 * appended so editing a pre-existing automation reflects its saved value without
 * offering unsupported levels as fresh choices for models that filter them out.
 */
export function thinkingLevelOptions(modelKeyValue: string, pinnedLevel: string, options?: AutomationModelsResponse): readonly string[] {
  const base = supportedThinkingLevels(modelKeyValue, options) ?? options?.thinkingLevels ?? [];
  if (pinnedLevel !== "default" && !base.includes(pinnedLevel)) return [...base, pinnedLevel];
  return base;
}

/** Clear a pinned level the selected model cannot honour so the form never submits an unsupported fixed level. */
export function thinkingLevelForModel(modelKeyValue: string, pinnedLevel: string, options?: AutomationModelsResponse): string {
  const supported = supportedThinkingLevels(modelKeyValue, options);
  return pinnedLevel !== "default" && supported !== undefined && !supported.includes(pinnedLevel) ? "default" : pinnedLevel;
}

export function draftFromForm(form: AutomationFormState, projectId: string, workspaceId: string, options?: AutomationModelsResponse): AutomationDraft {
  const timeoutMinutes = Number(form.timeoutMinutes);
  if (!Number.isFinite(timeoutMinutes)) throw new Error("Timeout must be a number of minutes");
  const timeoutMs = Math.round(timeoutMinutes * 60_000);
  if (options !== undefined && (timeoutMs < options.minTimeoutMs || timeoutMs > options.maxTimeoutMs)) throw new Error(`Timeout must be between ${String(options.minTimeoutMs / 60_000)} and ${String(options.maxTimeoutMs / 60_000)} minutes`);
  return {
    projectId,
    workspaceId,
    name: form.name,
    ...(form.description.trim() === "" ? {} : { description: form.description }),
    prompt: form.prompt,
    trigger: triggerFromForm(form),
    model: modelFromKey(form.modelKey, options),
    thinking: form.thinkingLevel === "default" ? { mode: "default" } : { mode: "fixed", level: form.thinkingLevel },
    timeoutMs,
  };
}

function triggerFromForm(form: AutomationFormState): AutomationTrigger {
  if (form.triggerType === "manual") return { type: "manual" };
  if (form.triggerType === "once") {
    const timestamp = new Date(form.schedule);
    if (Number.isNaN(timestamp.getTime())) throw new Error("Choose a valid one-shot time");
    return { type: "once", at: timestamp.toISOString() };
  }
  if (form.triggerType === "interval") return { type: "interval", intervalMs: Math.round(Number(form.schedule) * 60_000) };
  return { type: "cron", expression: form.schedule, timeZone: form.timeZone };
}

function modelFromKey(key: string, options?: AutomationModelsResponse): AutomationModelPolicy {
  if (key === "" || key === "default") return { mode: "default" };
  const matchKey = /^fixed:([^:]+):(.+)$/u.exec(key);
  if (matchKey?.[1] === undefined || matchKey[2] === undefined) throw new Error("Choose a valid model");
  const provider = decodeURIComponent(matchKey[1]);
  const id = decodeURIComponent(matchKey[2]);
  const match = options?.models.find((model) => model.provider === provider && model.id === id);
  return { mode: "fixed", provider, id, ...(match?.name === undefined ? {} : { name: match.name }) };
}

function modelKey(provider: string | undefined, id: string | undefined): string {
  return provider === undefined || id === undefined ? "" : `fixed:${encodeURIComponent(provider)}:${encodeURIComponent(id)}`;
}

function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger.type === "manual") return "manual only";
  if (trigger.type === "once") return `once · ${formatDateTime(trigger.at)}`;
  if (trigger.type === "interval") return `every ${formatDuration(trigger.intervalMs)}`;
  return `${trigger.expression} · ${trigger.timeZone}`;
}

function modelLabel(model: AutomationModelPolicy): string {
  return model.mode === "default" ? "machine default" : `${model.name ?? model.id} · ${model.provider}`;
}

function sessionModelLabel(model: { provider?: string; id?: string; name?: string }): string {
  return `${model.name ?? model.id ?? "unknown"}${model.provider === undefined ? "" : ` · ${model.provider}`}`;
}

function thinkingLabel(thinking: AutomationThinkingPolicy): string {
  return thinking.mode === "default" ? "default" : thinking.level;
}

export function runDurationMs(run: AutomationRun, now = Date.now()): number | undefined {
  if (run.startedAt === undefined) return undefined;
  const start = Date.parse(run.startedAt);
  const end = run.completedAt === undefined ? ACTIVE_STATUSES.includes(run.status) ? now : undefined : Date.parse(run.completedAt);
  return end === undefined || !Number.isFinite(start) || !Number.isFinite(end) ? undefined : Math.max(0, end - start);
}

function percentile(sorted: readonly number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 60_000) return `${String(Math.max(1, Math.round(value / 1000)))}s`;
  if (value < 3_600_000) return `${String(Math.round(value / 60_000))}m`;
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.round((value % 3_600_000) / 60_000);
  return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`;
}

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(timestamp) : value;
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function aggregateRuns(runs: readonly AutomationRun[]): AutomationAggregate[] {
  const aggregates = new Map<string, AutomationAggregate>();
  for (const run of runs) {
    if (ACTIVE_STATUSES.includes(run.status)) continue;
    const entry = aggregates.get(run.automationId) ?? {
      automationId: run.automationId,
      name: run.automationName,
      runs: 0,
      unknownTokens: 0,
      unknownCost: 0,
    };
    entry.runs += 1;
    const usage = knownAutomationUsage(run);
    if (usage === undefined) entry.unknownTokens += 1;
    else entry.tokens = (entry.tokens ?? 0) + usage.tokens.total;
    if (usage?.estimatedCostMicros === undefined) entry.unknownCost += 1;
    else entry.costMicros = (entry.costMicros ?? 0) + usage.estimatedCostMicros;
    aggregates.set(run.automationId, entry);
  }
  return [...aggregates.values()].sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name));
}

export function knownAutomationUsage(run: AutomationRun): NonNullable<AutomationRun["usage"]> | undefined {
  return run.usage?.quality === "unknown" ? undefined : run.usage;
}

function tokenBreakdown(tokens: NonNullable<AutomationRun["usage"]>["tokens"]): string {
  return `input ${formatTokenCount(tokens.input)} · output ${formatTokenCount(tokens.output)} · cache read ${formatTokenCount(tokens.cacheRead)} · cache write ${formatTokenCount(tokens.cacheWrite)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

declare global {
  interface HTMLElementTagNameMap {
    "automations-panel": AutomationsPanel;
  }
}
