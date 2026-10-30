import { LocalizationController, localization } from "../localization/browser";
import { sessionCleanupMessages as messages } from "../sessionCleanupMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionCleanupExecuteResponse, SessionCleanupPreviewResponse, SessionCleanupProjectSummary, SessionCleanupRequest } from "../api";
import { canRunSessionCleanup, DEFAULT_SESSION_CLEANUP_DRAFT, selectedSessionCleanupProjectCwds, sessionCleanupPreviewForSelectedProjects, sessionCleanupPreviewHasTargets, validateSessionCleanupDraft, type SessionCleanupDraft } from "../sessionCleanupUi";
import { uiDialogStyles, uiFormStyles } from "./ui/dialogStyles";
import "./ModalSurface";

const summaryIconPaths = {
  info: "M12 8h.01M11 12h1v5M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  archive: "M3 3h18v4H3zM5 7v14h14V7M10 11h4",
  delete: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  check: "M5 12l4 4L19 6",
  warning: "M12 3 2 21h20L12 3zM12 9v5M12 18h.01",
} as const;

@customElement("session-cleanup-dialog")
export class SessionCleanupDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) preview?: SessionCleanupPreviewResponse;
  @property({ attribute: false }) previewRequest?: SessionCleanupRequest;
  @property({ attribute: false }) result?: SessionCleanupExecuteResponse;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) running = false;
  @property({ type: String }) error = "";
  @property({ attribute: false }) errorMessage?: () => string;
  @property({ attribute: false }) onPreview?: (request: SessionCleanupRequest) => void | Promise<void>;
  @property({ attribute: false }) onRun?: (request: SessionCleanupRequest) => void | Promise<void>;
  @property({ attribute: false }) onClose?: () => void;

  @state() private step: "rules" | "review" = "rules";
  @state() private draft: SessionCleanupDraft = { ...DEFAULT_SESSION_CLEANUP_DRAFT };
  @state() private formError: (() => string) | undefined;
  @state() private selectedProjectCwds: string[] | undefined;

  override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has("preview")) {
      this.selectedProjectCwds = this.preview?.projects.map((project) => project.cwd);
      if (this.preview !== undefined) this.step = "review";
    }
  }

  override updated(changedProperties: PropertyValues): void {
    if ((changedProperties.has("step") && changedProperties.get("step") !== undefined)
      || (changedProperties.has("result") && this.result !== undefined)) {
      const heading = this.shadowRoot?.querySelector<HTMLElement>("#step-heading, .result h2");
      heading?.focus();
      const body = this.shadowRoot?.querySelector<HTMLElement>(".body");
      if (body !== null && body !== undefined) body.scrollTop = 0;
    }
  }

  override render(): TemplateResult {
    const reviewing = this.step === "review" && this.preview !== undefined;
    const completed = this.result !== undefined;
    return html`
      <modal-surface .onClose=${() => { this.onClose?.(); }} .label=${messages.t("title")}>
        <header class="ui-dialog-header">
          <h1 class="ui-dialog-title">${messages.t("title")}</h1>
          <button class="ui-button ui-button--icon close-button" title=${messages.t("closeCleanup")} aria-label=${messages.t("closeCleanup")} @click=${() => { this.onClose?.(); }}>×</button>
        </header>
        <div class="body ui-dialog-body ui-form-body" aria-busy=${this.loading || this.running}>
          ${completed ? null : html`
            <h2 id="step-heading" tabindex="-1">${messages.t(reviewing ? "reviewStep" : "rulesStep")}</h2>
            <p class="intro">${messages.t(reviewing ? "reviewIntro" : "intro")}</p>
            ${reviewing && this.preview !== undefined ? this.renderPreview(this.preview) : this.renderForm()}
          `}
          ${this.renderMessage()}
          ${reviewing && !completed ? this.renderActions(true) : null}
        </div>
        <div class="feedback" role="status" aria-atomic="true">
          ${!this.running ? null : html`<p class="running-hint">${messages.t("runningHint")}</p>`}
          ${this.result === undefined ? null : this.renderResult(this.result)}
        </div>
        ${!reviewing || completed ? this.renderActions(false) : null}
      </modal-surface>
    `;
  }

  private renderActions(reviewing: boolean): TemplateResult {
    const selectedPreview = this.selectedPreview();
    const runEnabled = canRunSessionCleanup({ draft: this.draft, preview: selectedPreview, previewRequest: this.previewRequest, loading: this.loading, running: this.running });
    const runTitle = runEnabled ? messages.t("run") : selectedPreview?.projects.length === 0 && this.preview?.projects.length === 0 ? messages.t("noTargetsTitle") : selectedPreview !== undefined && !sessionCleanupPreviewHasTargets(selectedPreview) ? messages.t("selectRequiredTitle") : messages.t("previewRequiredTitle");
    return html`
      <footer class="ui-dialog-footer">
        ${this.result !== undefined ? html`
          <button class="ui-button" @click=${() => { this.onClose?.(); }}>${messages.t("close")}</button>
        ` : reviewing ? html`
          <button class="ui-button" ?disabled=${this.running} @click=${() => { this.backToRules(); }}>${messages.t("back")}</button>
          <button class="ui-button ui-button--primary danger" ?disabled=${!runEnabled} title=${runTitle} @click=${() => { this.runCleanup(); }}>${messages.t(this.running ? "running" : "run")}</button>
        ` : html`
          <button class="ui-button" @click=${() => { this.onClose?.(); }}>${messages.t("cancel")}</button>
          <button class="ui-button ui-button--primary" ?disabled=${this.loading || this.running} @click=${() => { this.previewCleanup(); }}>${messages.t(this.loading ? "previewing" : "preview")}</button>
        `}
      </footer>
    `;
  }

  private renderForm(): TemplateResult {
    const disabled = this.loading || this.running;
    return html`
      <fieldset aria-label=${messages.t("rules")} ?disabled=${disabled}>
        <div class="cleanup-rule">
          <label class="ui-checkbox-field"><input type="checkbox" .checked=${this.draft.archiveIdleEnabled} @change=${(event: Event) => { this.updateDraft({ archiveIdleEnabled: checkedValue(event) }); }}>${messages.t("archiveEnabled")}</label>
          <div class="threshold-field">
            <label for="archive-days">${messages.t("archiveRule")}</label>
            <input id="archive-days" class="ui-input days" aria-label=${messages.t("archiveThreshold")} type="number" min="0" step="1" inputmode="numeric" .value=${this.draft.archiveIdleDays} ?disabled=${disabled || !this.draft.archiveIdleEnabled} @input=${(event: Event) => { this.updateDraft({ archiveIdleDays: inputValue(event) }); }}>
          </div>
        </div>
        <div class="cleanup-rule">
          <label class="ui-checkbox-field"><input type="checkbox" .checked=${this.draft.deleteArchivedEnabled} @change=${(event: Event) => { this.updateDraft({ deleteArchivedEnabled: checkedValue(event) }); }}>${messages.t("deleteEnabled")}</label>
          <div class="threshold-field">
            <label for="delete-days">${messages.t("deleteRule")}</label>
            <input id="delete-days" class="ui-input days" aria-label=${messages.t("deleteThreshold")} type="number" min="0" step="1" inputmode="numeric" .value=${this.draft.deleteArchivedDays} ?disabled=${disabled || !this.draft.deleteArchivedEnabled} @input=${(event: Event) => { this.updateDraft({ deleteArchivedDays: inputValue(event) }); }}>
          </div>
        </div>
        <label class="ui-checkbox-field"><input id="skip-pinned" type="checkbox" .checked=${this.draft.skipPinned} @change=${(event: Event) => { this.updateDraft({ skipPinned: checkedValue(event) }); }}>${messages.t("skipPinned")}</label>
        <p class="hint">${messages.t(this.draft.skipPinned ? "pinnedHint" : "busyHint")}</p>
      </fieldset>
      ${!this.draft.deleteArchivedEnabled ? null : html`<p class="warning">${messages.rich("warning", { strong: (chunks) => html`<strong>${chunks}</strong>` })}</p>`}
    `;
  }

  private renderMessage(): TemplateResult | null {
    const message = this.formError?.() ?? this.errorMessage?.() ?? this.error;
    return message === "" ? null : html`<div class="dialog-error ui-form-error" role="alert">${message}</div>`;
  }

  private renderPreview(preview: SessionCleanupPreviewResponse): TemplateResult {
    const selectedCwds = this.selectedProjectCwdsForPreview();
    const selected = new Set(selectedCwds);
    const selectedPreview = sessionCleanupPreviewForSelectedProjects(preview, selectedCwds);
    return html`
      <section class="preview" aria-label=${messages.t("previewLabel")}>
        <ul class="review-summary" role="list">
          ${this.renderSummaryItem("info", messages.t("summaryEstimates"))}
          ${preview.thresholds.archiveIdleDays === undefined ? null : this.renderSummaryItem("archive", messages.t("archiveSummary", { days: preview.thresholds.archiveIdleDays }))}
          ${preview.thresholds.deleteArchivedDays === undefined ? null : this.renderSummaryItem("delete", messages.t("deleteSummary", { days: preview.thresholds.deleteArchivedDays }), "danger")}
          ${this.draft.skipPinned
            ? this.renderSummaryItem("check", messages.t("summaryPinsProtected"))
            : this.renderSummaryItem("warning", messages.t("summaryPinsIncluded"), "warning")}
          ${this.renderSummaryItem("check", messages.t("summaryBusy"))}
        </ul>
        ${preview.projects.length === 0 ? html`<p class="empty">${messages.t("empty")}</p>` : html`
          ${this.renderSelectionControls(preview, selectedCwds)}
          <div class="table-scroll" tabindex="0" aria-label=${messages.t("tableLabel")}>
            <table>
              <thead>
                <tr><th>${messages.t("cleanupColumn")}</th><th>${messages.t("pathColumn")}</th><th>${messages.t("archiveColumn")}</th><th>${messages.t("deleteColumn")}</th></tr>
              </thead>
              <tbody>
                ${preview.projects.map((project) => this.renderProjectRow(project, selected.has(project.cwd)))}
              </tbody>
              <tfoot>
                <tr><th colspan="2">${messages.t("totals")}</th><td>${localization.number(selectedPreview.totals.archiveCount)}</td><td>${localization.number(selectedPreview.totals.deleteCount)}</td></tr>
              </tfoot>
            </table>
          </div>
        `}
        ${this.renderSkipped(preview)}
      </section>
    `;
  }

  private renderSummaryItem(icon: keyof typeof summaryIconPaths, text: string, tone: "default" | "warning" | "danger" = "default"): TemplateResult {
    return html`<li class=${`summary-${tone}`}>
      <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d=${summaryIconPaths[icon]} /></svg>
      <span>${text}</span>
    </li>`;
  }

  private renderSkipped(response: SessionCleanupPreviewResponse): TemplateResult {
    return html`
      ${response.skippedPinnedSessionIds === undefined || response.skippedPinnedSessionIds.length === 0 ? null : html`<p class="hint">${messages.t("skippedPinned", { count: response.skippedPinnedSessionIds.length })}</p>`}
      ${response.skippedBusySessionIds === undefined || response.skippedBusySessionIds.length === 0 ? null : html`<p class="hint">${messages.t("skipped", { count: response.skippedBusySessionIds.length })}</p>`}
    `;
  }

  private renderSelectionControls(preview: SessionCleanupPreviewResponse, selectedCwds: readonly string[]): TemplateResult {
    const disabled = this.loading || this.running;
    return html`
      <div class="selection-controls" role="group" aria-label=${messages.t("selectionLabel")}>
        <span>${messages.t("selection", { selected: selectedCwds.length, total: preview.projects.length })}</span>
        <button class="ui-button ui-button--compact" ?disabled=${disabled || selectedCwds.length === preview.projects.length} @click=${() => { this.selectAllProjects(); }}>${messages.t("selectAll")}</button>
        <button class="ui-button ui-button--compact" ?disabled=${disabled || selectedCwds.length === 0} @click=${() => { this.deselectAllProjects(); }}>${messages.t("deselectAll")}</button>
      </div>
      ${selectedCwds.length === 0 ? html`<p class="hint" role="status">${messages.t("selectRequired")}</p>` : null}
    `;
  }

  private renderProjectRow(project: SessionCleanupProjectSummary, selected: boolean): TemplateResult {
    return html`
      <tr class=${selected ? "" : "unselected"}>
        <td class="select-cell"><input type="checkbox" aria-label=${messages.t("selectProject", { path: project.cwd })} .checked=${selected} ?disabled=${this.loading || this.running} @change=${(event: Event) => { this.setProjectSelected(project.cwd, checkedValue(event)); }}></td>
        <th title=${project.cwd} dir="auto">${project.cwd}</th>
        <td>${localization.number(project.archiveCount)}</td>
        <td>${localization.number(project.deleteCount)}</td>
      </tr>
    `;
  }

  private renderResult(result: SessionCleanupExecuteResponse): TemplateResult {
    return html`
      <section class="result" aria-label=${messages.t("resultLabel")}>
        <h2 tabindex="-1">${messages.t("complete")}</h2>
        <p>${messages.t("result", { archived: result.archivedSessionIds.length, deleted: result.deletedSessionIds.length })}</p>
        ${this.renderSkipped(result)}
      </section>
    `;
  }

  private updateDraft(patch: Partial<SessionCleanupDraft>): void {
    this.draft = { ...this.draft, ...patch };
    this.formError = undefined;
  }

  private selectedPreview(): SessionCleanupPreviewResponse | undefined {
    return this.preview === undefined ? undefined : sessionCleanupPreviewForSelectedProjects(this.preview, this.selectedProjectCwdsForPreview());
  }

  private selectedProjectCwdsForPreview(): string[] {
    return this.preview === undefined ? [] : selectedSessionCleanupProjectCwds(this.preview, this.selectedProjectCwds);
  }

  private selectAllProjects(): void {
    this.selectedProjectCwds = this.preview?.projects.map((project) => project.cwd) ?? [];
    this.formError = undefined;
  }

  private deselectAllProjects(): void {
    this.selectedProjectCwds = [];
    this.formError = undefined;
  }

  private setProjectSelected(cwd: string, selected: boolean): void {
    const preview = this.preview;
    if (preview === undefined) return;
    const selectedCwds = new Set(this.selectedProjectCwdsForPreview());
    if (selected) selectedCwds.add(cwd);
    else selectedCwds.delete(cwd);
    this.selectedProjectCwds = preview.projects.map((project) => project.cwd).filter((projectCwd) => selectedCwds.has(projectCwd));
    this.formError = undefined;
  }

  private backToRules(): void {
    if (this.running) return;
    this.step = "rules";
    this.formError = undefined;
  }

  private previewCleanup(): void {
    const validation = validateSessionCleanupDraft(this.draft);
    if (!validation.ok) {
      this.formError = () => messages.t(validation.code);
      return;
    }
    this.formError = undefined;
    void this.onPreview?.(validation.request);
  }

  private runCleanup(): void {
    const validation = validateSessionCleanupDraft(this.draft);
    if (!validation.ok) {
      this.formError = () => messages.t(validation.code);
      return;
    }
    const selectedPreview = this.selectedPreview();
    const selectedProjectCwds = this.selectedProjectCwdsForPreview();
    if (!canRunSessionCleanup({ draft: this.draft, preview: selectedPreview, previewRequest: this.previewRequest, loading: this.loading, running: this.running })) {
      const key = selectedPreview !== undefined && !sessionCleanupPreviewHasTargets(selectedPreview) ? "selectRequired" : "previewRequired";
      this.formError = () => messages.t(key);
      return;
    }
    if (selectedPreview === undefined || !confirm(messages.t("confirm", { archive: selectedPreview.totals.archiveCount, delete: selectedPreview.totals.deleteCount }))) return;
    this.formError = undefined;
    void this.onRun?.({ ...validation.request, projectCwds: selectedProjectCwds });
  }

  static override styles = [uiDialogStyles, uiFormStyles, css`
    :host { --ui-dialog-width: 760px; --ui-dialog-max-height: 760px; }
    h2, p { margin: 0; }
    h2 { font-size: 14px; font-weight: 600; }
    p { line-height: 1.5; }
    .intro, .hint, .empty { color: var(--pi-muted); }
    fieldset { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: 12px; }
    .cleanup-rule { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 1fr); align-items: center; gap: 8px 20px; padding-bottom: 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .threshold-field { display: grid; grid-template-columns: minmax(0, 1fr) 80px; align-items: center; gap: 8px; color: var(--pi-muted); }
    input:disabled { opacity: .55; }
    .warning, .result { border-inline-start: 3px solid var(--pi-warning-border); padding: 10px 12px; background: var(--pi-warning-surface); }
    .feedback { flex-shrink: 0; }
    .running-hint { margin: 12px 16px; color: var(--pi-muted); }
    .result { margin: 12px 16px; border-color: var(--pi-success-border); background: var(--pi-success-bg); }
    .preview { display: grid; gap: 10px; min-width: 0; }
    .review-summary { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .review-summary li { display: flex; align-items: flex-start; gap: 8px; line-height: 1.5; }
    .review-summary svg { flex: 0 0 auto; margin-block-start: 1px; color: var(--pi-muted); }
    .review-summary .summary-warning { color: var(--pi-warning, var(--pi-text)); }
    .review-summary .summary-danger { color: var(--pi-danger); }
    .review-summary .summary-warning svg, .review-summary .summary-danger svg { color: inherit; }
    .selection-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .selection-controls span { flex: 1 1 200px; color: var(--pi-muted); }
    .table-scroll { max-width: 100%; overflow: auto; }
    table { width: 100%; table-layout: fixed; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--pi-border-muted); padding: 8px; text-align: end; overflow-wrap: anywhere; }
    thead th:first-child, td.select-cell { width: 52px; text-align: center; }
    thead th:nth-child(3), thead th:nth-child(4) { width: 64px; }
    th:nth-child(2) { text-align: start; }
    tbody tr.unselected { color: var(--pi-muted); }
    tbody th { font-family: var(--pi-mono, ui-monospace, monospace); font-weight: 400; }
    .select-cell input { accent-color: var(--pi-accent); width: 18px; height: 18px; cursor: pointer; }
    tfoot th, tfoot td { border-bottom: 0; font-weight: 600; }
    footer { flex-wrap: wrap; }
    footer > .ui-button { flex: 1 1 auto; }
    @media (max-width: 540px) {
      .cleanup-rule { grid-template-columns: minmax(0, 1fr); }
      .threshold-field { padding-inline-start: 24px; }
      thead th:first-child, td.select-cell { width: 40px; }
      thead th:nth-child(3), thead th:nth-child(4) { width: 44px; }
      th, td { padding: 8px 4px; }
    }
  `];
}

function checkedValue(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false;
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}
