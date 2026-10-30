import { css, html, LitElement, nothing } from "lit";
import type { ApplicationPanelContextV5, LocalizedMessages, PluginLocalization, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import definitions from "./messages.js";
import { needsAttention, overviewGroups } from "./overview.js";
import { readHistory, readOverview, type ExecutionView, type HistoryPage, type TaskOverview, type TaskView } from "./responses.js";

export const panelTag = "pi-web-scheduled-tasks-panel";
export interface PanelContent {
  localization: PluginLocalization;
  messages: LocalizedMessages<typeof definitions>;
  styles: StylesheetIntegrationCapabilityV1;
  lifetimeSignal: AbortSignal;
}

export class ScheduledTasksPanel extends LitElement {
  private contentValue: PanelContent | undefined;
  private contextValue: ApplicationPanelContextV5 | undefined;
  private releaseStyles: (() => void) | undefined;
  private releaseLocalization: (() => void) | undefined;
  private pending: AbortController | undefined;
  private tasks: TaskOverview[] = [];
  private history: HistoryPage = { executions: [], nextOffset: null };
  private taskId: string | undefined;
  private view: "overview" | "task" | "history" = "overview";
  private offset = 0;
  private allTasksExpanded = false;
  private busy = false;
  private loaded = false;
  private issue: "unavailable" | "loadFailed" | "invalidResponse" | "navigationFailed" | undefined;
  private diagnostic: string | undefined;
  private readonly stop = () => { this.pending?.abort(); };

  set content(value: PanelContent) {
    if (value === this.contentValue) return;
    this.detach();
    this.contentValue = value;
    if (this.isConnected) this.attach();
    this.requestUpdate();
  }
  set context(value: ApplicationPanelContextV5) {
    const previous = this.contextValue;
    this.contextValue = value;
    if (previous?.machine.id === value.machine.id && !!previous.backend === !!value.backend) return;
    this.pending?.abort();
    this.tasks = []; this.history = { executions: [], nextOffset: null }; this.taskId = undefined; this.view = "overview"; this.offset = 0; this.allTasksExpanded = false; this.loaded = false;
    if (this.isConnected) void this.load();
  }
  override connectedCallback(): void {
    super.connectedCallback();
    this.attach();
    void this.load();
  }
  override disconnectedCallback(): void {
    this.pending?.abort();
    this.detach();
    super.disconnectedCallback();
  }
  private attach(): void {
    const content = this.contentValue;
    if (!content) return;
    if (this.shadowRoot) this.releaseStyles ??= content.styles.registerRoot(this.shadowRoot, { sharedUi: true });
    this.releaseLocalization ??= content.localization.subscribe(() => { this.requestUpdate(); });
    content.lifetimeSignal.addEventListener("abort", this.stop, { once: true });
  }
  private detach(): void {
    this.releaseStyles?.(); this.releaseStyles = undefined;
    this.releaseLocalization?.(); this.releaseLocalization = undefined;
    this.contentValue?.lifetimeSignal.removeEventListener("abort", this.stop);
  }
  private async load(): Promise<void> {
    this.pending?.abort();
    const controller = new AbortController(); this.pending = controller;
    const context = this.contextValue;
    if (!context || !this.contentValue || this.contentValue.lifetimeSignal.aborted) return;
    this.issue = undefined; this.diagnostic = undefined;
    if (!context.backend) { this.issue = "unavailable"; this.busy = false; this.requestUpdate(); return; }
    this.busy = true; this.requestUpdate();
    try {
      const peer = context.backend.forScope({ kind: "machine" });
      if (!peer.request) throw new Error("Scheduled tasks backend does not support requests");
      const options = { signal: controller.signal };
      const [overview, history] = await Promise.all([
        peer.request("overview", {}, options),
        this.view === "overview" ? Promise.resolve(null) : peer.request("history", { ...(this.taskId === undefined ? {} : { taskId: this.taskId }), limit: 20, offset: this.offset }, options),
      ]);
      if (controller.signal.aborted) return;
      try {
        const tasks = readOverview(overview);
        const page = history === null ? { executions: [], nextOffset: null } : readHistory(history);
        this.tasks = tasks; this.history = page; this.loaded = true;
      } catch { this.issue = "invalidResponse"; }
    } catch (error) {
      if (controller.signal.aborted) return;
      this.issue = "loadFailed";
      this.diagnostic = error instanceof Error ? error.message : String(error);
    } finally {
      if (!controller.signal.aborted) { this.busy = false; this.requestUpdate(); }
    }
  }
  private showHistory(taskId?: string): void {
    this.taskId = taskId; this.view = taskId === undefined ? "history" : "task";
    this.offset = 0; this.history = { executions: [], nextOffset: null };
    void this.load();
    void this.focusView();
  }
  private async focusView(): Promise<void> {
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(".view-title")?.focus();
    const body = this.renderRoot.querySelector(".body");
    if (body) body.scrollTop = 0;
  }
  private async showOverview(): Promise<void> {
    const previous = this.taskId;
    this.view = "overview"; this.taskId = undefined; this.offset = 0;
    void this.load();
    await this.updateComplete;
    const control = [...this.renderRoot.querySelectorAll<HTMLButtonElement>("[data-task-id]")].find((button) => button.dataset["taskId"] === previous);
    if (control) control.focus();
    else await this.focusView();
  }
  private page(offset: number): void { this.offset = offset; this.history = { executions: [], nextOffset: null }; void this.load(); }
  private async openConversation(execution: ExecutionView): Promise<void> {
    const context = this.contextValue;
    if (!context || execution.sessionId === null) return;
    try {
      await context.navigate({ machineId: context.machine.id, projectId: execution.task.projectId, workspaceId: execution.task.workspaceId, sessionId: execution.sessionId, view: "chat" });
    } catch {
      if (this.contextValue?.machine.id !== context.machine.id || !this.isConnected) return;
      this.issue = "navigationFailed"; this.requestUpdate();
    }
  }
  private time(at: string): string {
    return this.contentValue?.localization.date(new Date(at), { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) ?? at;
  }
  private renderTarget(task: TaskView) {
    return this.contentValue?.messages.t("target", { project: task.projectId, workspace: task.workspaceId });
  }
  private renderNext(task: TaskView) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    if (task.archived) return messages.t("archived");
    if (task.paused) return messages.t("paused");
    return task.nextDue === null ? messages.t("noNext") : messages.t("next", { at: this.time(task.nextDue) });
  }
  private renderNotices(execution: ExecutionView) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    return execution.notices?.map((notice) => html`<p class="run-warning">${messages.t("runWarning", { notice })}</p>`) ?? nothing;
  }
  private renderTechnical(task: TaskView, execution?: ExecutionView) {
    const content = this.contentValue;
    if (!content) return nothing;
    const { messages, localization } = content;
    return html`<details class="technical"><summary>${messages.t("technical")}</summary>
      <div class="detail-stack meta">
        <span>${this.renderTarget(task)}</span>
        ${task.model !== undefined ? html`<span>${messages.t("requestedModel", { value: task.model })}</span>` : nothing}
        ${task.thinkingLevel !== undefined ? html`<span>${messages.t("requestedThinking", { value: task.thinkingLevel })}</span>` : nothing}
        ${execution?.model !== undefined ? html`<span>${messages.t("effectiveModel", { value: execution.model })}</span>` : nothing}
        ${execution?.thinkingLevel !== undefined ? html`<span>${messages.t("effectiveThinking", { value: execution.thinkingLevel })}</span>` : nothing}
        <span>${task.schedule.kind === "cron" ? html`<code>${task.schedule.expression}</code>` : messages.t("once", { at: localization.date(new Date(task.schedule.at), { dateStyle: "full", timeStyle: "long", timeZone: task.timezone }) })} · ${task.timezone}</span>
        ${execution ? html`<span>${messages.t(execution.trigger)} · ${messages.t("recordedAt", { at: this.time(execution.createdAt) })}</span>
          <span>${messages.t("execution", { id: execution.id, revision: execution.task.revision })}</span>
          ${execution.sessionId !== null ? html`<span>${messages.t("conversation", { id: execution.sessionId })}</span>` : nothing}
          ${execution.dispatchError !== null ? html`<p class="diagnostic">${execution.dispatchError}</p>` : nothing}` : nothing}
      </div>
    </details>`;
  }
  private renderExecution(execution: ExecutionView) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    return html`<div class="execution" data-status=${execution.status}>
      <div class="heading"><strong class="outcome">${messages.t(execution.status)}</strong>
        <span class="meta">${messages.t("recordedAt", { at: this.time(execution.createdAt) })}</span></div>
      ${execution.sessionId !== null ? html`<button type="button" class="ui-button ui-button--action conversation" @click=${() => this.openConversation(execution)}>${messages.t("openConversation")}</button>` : nothing}
      ${execution.latestReport ? html`<p class="summary">${execution.latestReport.summary}</p>` : nothing}
      ${execution.status === "uncertain" || execution.status === "failed" || execution.status === "errored"
        ? html`<p class="meta">${messages.t(execution.status === "uncertain" ? "uncertainHelp" : execution.status === "failed" ? "failedHelp" : "erroredHelp")}</p>` : nothing}
      ${this.renderNotices(execution)}
      ${this.renderTechnical(execution.task, execution)}
    </div>`;
  }
  private renderTaskLink(task: TaskOverview) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    return html`<button type="button" class="ui-button task-link" data-task-id=${task.id}
      aria-label=${messages.t("viewTask", { name: task.name })}
      @click=${() => { this.showHistory(task.id); }}>${task.name}</button>`;
  }
  private renderOverviewTask(task: TaskOverview, upcoming = false) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    const execution = task.latestExecution;
    return html`<article class="task" data-attention=${!upcoming && needsAttention(task)}>
      <h3>${this.renderTaskLink(task)}</h3>
      ${upcoming ? html`<p class="next meta">${this.renderNext(task)}</p>` : execution ? html`
        <div class="heading"><span class="outcome" data-status=${execution.status}>${messages.t(execution.status)}</span>
          <span class="meta">${this.time(execution.createdAt)}</span></div>
        ${execution.latestReport ? html`<p class="summary preview">${execution.latestReport.summary}</p>` : nothing}
        ${this.renderNotices(execution)}
        ${execution.status === "uncertain" ? html`<p class="meta">${messages.t("uncertainHelp")}</p>` : nothing}
        ${execution.sessionId !== null ? html`<button type="button" class="ui-button ui-button--action conversation" @click=${() => this.openConversation(execution)}>${messages.t("openConversation")}</button>` : nothing}
      ` : nothing}
    </article>`;
  }
  private renderOverview() {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    if (this.tasks.length === 0) return html`<section class="empty"><h2 class="view-title" tabindex="-1">${messages.t("emptyTasks")}</h2><p class="meta">${messages.t("emptyGuidance")}</p></section>`;
    const groups = overviewGroups(this.tasks);
    return html`
      <section aria-labelledby="attention-title">
        <h2 id="attention-title" class="view-title" tabindex="-1">${messages.t("attention")}</h2>
        ${groups.attention.length ? groups.attention.map((task) => this.renderOverviewTask(task)) : html`<p class="quiet">${messages.t("noAttention")}</p>`}
      </section>
      ${groups.recent.length ? html`<section aria-labelledby="results-title"><h2 id="results-title">${messages.t("recent")}</h2>
        <p class="section-note meta">${messages.t("resultOrder")}</p>
        ${groups.recent.map((task) => this.renderOverviewTask(task))}</section>` : nothing}
      <section aria-labelledby="upcoming-title"><h2 id="upcoming-title">${messages.t("upcoming")}</h2>
        ${groups.upcoming.length ? groups.upcoming.map((task) => this.renderOverviewTask(task, true)) : html`<p class="quiet">${messages.t("noUpcoming")}</p>`}
      </section>
      ${groups.awaiting.length ? html`<section aria-labelledby="awaiting-title"><h2 id="awaiting-title">${messages.t("awaiting")}</h2>
        ${groups.awaiting.map((task) => this.renderOverviewTask(task))}</section>` : nothing}
      <details class="all-tasks" ?open=${this.allTasksExpanded} @toggle=${(event: Event) => { if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.isConnected) this.allTasksExpanded = event.currentTarget.open; }}><summary>${messages.t("allTasks", { count: this.tasks.length })}</summary>
        ${[...this.tasks].sort((a, b) => a.name.localeCompare(b.name)).map((task) => html`<article class="task compact">
          <h3>${this.renderTaskLink(task)}</h3><p class="meta">${this.renderNext(task)}</p></article>`)}
      </details>`;
  }
  private renderHistory() {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    const selected = this.tasks.find((task) => task.id === this.taskId);
    return html`
      <div class="detail-heading"><h2 class="view-title" tabindex="-1">${selected?.name ?? messages.t("history")}</h2>
        ${selected ? html`<p class="next meta">${this.renderNext(selected)}</p>${this.renderTechnical(selected)}` : nothing}</div>
      <section aria-label=${messages.t("history")}>
        ${selected ? html`<h2>${messages.t("history")}</h2>` : nothing}
        ${this.history.executions.length === 0 && !this.busy ? html`<p class="quiet">${messages.t(selected && this.offset === 0 ? "noExecution" : "emptyHistory")}</p>` : nothing}
        ${this.history.executions.map((execution) => html`<article class="history-entry">
          ${selected ? nothing : html`<h3>${execution.task.name}</h3>`}${this.renderExecution(execution)}</article>`)}
        ${this.offset > 0 || this.history.nextOffset !== null ? html`<nav class="pages" aria-label=${messages.t("history")}>
          <button type="button" class="ui-button ui-button--action" ?disabled=${this.busy || this.offset === 0} @click=${() => { this.page(Math.max(0, this.offset - 20)); }}>${messages.t("previous")}</button>
          <button type="button" class="ui-button ui-button--action" ?disabled=${this.busy || this.history.nextOffset === null} @click=${() => { if (this.history.nextOffset !== null) this.page(this.history.nextOffset); }}>${messages.t("nextPage")}</button>
        </nav>` : nothing}
      </section>`;
  }
  override render() {
    const content = this.contentValue;
    if (!content) return nothing;
    const { messages, localization } = content;
    return html`<div class="panel" dir=${localization.direction}>
      <header class="ui-toolbar"><strong class="ui-toolbar-title title">${messages.t("title")}</strong>
        <div class="ui-toolbar-group"><button type="button" class="ui-button" ?disabled=${this.busy} @click=${() => this.load()}>${messages.t("refresh")}</button></div></header>
      <div class="body" aria-busy=${this.busy}>
        ${this.view !== "overview" ? html`<button type="button" class="ui-button ui-button--action back" @click=${() => this.showOverview()}>${messages.t("overview")}</button>` : nothing}
        ${this.issue ? html`<div role="alert" class="error"><p>${messages.t(this.issue)}</p>${this.diagnostic !== undefined ? html`<details><summary>${messages.t("errorDetails")}</summary><p class="diagnostic">${this.diagnostic}</p></details>` : nothing}</div>` : nothing}
        ${this.busy ? html`<p role="status" class="meta">${messages.t("loading")}</p>` : nothing}
        ${this.loaded ? this.view === "overview" ? this.renderOverview() : this.renderHistory() : nothing}
        ${this.view === "overview" && this.loaded ? html`<footer>
          <button type="button" class="ui-button ui-button--action" @click=${() => { this.showHistory(); }}>${messages.t("allHistory")}</button>
          <details class="guidance"><summary>${messages.t("manage")}</summary><p class="meta">${messages.t("guidance")}</p></details>
        </footer>` : nothing}
      </div>
    </div>`;
  }
  static override styles = css`
    :host { display: flex; flex: 1; min-height: 0; min-width: 0; color: var(--pi-text); font: 13px var(--pi-font-ui, system-ui, sans-serif); }
    .panel { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
    .title { padding-inline: 12px; }
    .body { overflow: auto; padding: 20px 16px; min-height: 0; overflow-wrap: anywhere; }
    h2 { font-size: 14px; margin: 0; font-weight: 600; }
    h3 { font-size: inherit; margin: 0; min-width: 0; }
    p { margin: 0; line-height: 1.5; }
    section + section { margin-top: 28px; }
    .heading { display: flex; align-items: baseline; justify-content: space-between; gap: 4px 12px; flex-wrap: wrap; }
    .task, .history-entry { display: grid; gap: 8px; padding-block: 14px; border-bottom: 1px solid var(--pi-border-muted); }
    .task[data-attention="true"] .outcome, .execution[data-status="failed"] .outcome, .execution[data-status="errored"] .outcome, .execution[data-status="uncertain"] .outcome { color: var(--pi-danger); }
    .ui-button.task-link { --ui-control-size: 32px; --ui-control-padding: 4px 0; justify-content: flex-start; text-align: start; white-space: normal; color: var(--pi-text); font: inherit; font-weight: 600; width: 100%; height: auto; }
    .meta { color: var(--pi-text-secondary); font-size: 12px; }
    .quiet { color: var(--pi-text-secondary); padding-top: 10px; }
    .section-note { margin-top: 6px; }
    .next { font-variant-numeric: tabular-nums; }
    .execution, .detail-stack { display: grid; gap: 10px; min-width: 0; }
    .outcome { font-size: 12px; font-weight: 500; }
    .run-warning { font-size: 12px; white-space: pre-wrap; }
    .summary, .diagnostic { white-space: pre-wrap; line-height: 1.5; }
    .preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .diagnostic, code { font: 12px var(--pi-mono, monospace); }
    .error { color: var(--pi-danger); margin-bottom: 16px; }
    .error p { margin-block: 8px; }
    .conversation { justify-self: start; max-width: 100%; }
    .pages { display: flex; gap: 8px; padding-block: 16px; }
    .all-tasks { margin-top: 24px; }
    summary { cursor: pointer; padding-block: 10px; font-size: 12px; color: var(--pi-text-secondary); }
    summary:hover { color: var(--pi-text); }
    summary:focus-visible, .view-title:focus-visible { outline: 2px solid var(--pi-text-secondary); outline-offset: 2px; }
    .technical .detail-stack { padding-block: 4px 12px; }
    .detail-heading { margin-block: 20px 24px; }
    .detail-heading h2 { font-size: 18px; line-height: 1.4; margin-bottom: 8px; }
    footer { display: grid; justify-items: start; gap: 12px; margin-top: 24px; }
    .guidance p { padding-bottom: 12px; }
    .empty { padding-block: 8px 16px; }
    .empty p { margin-top: 10px; }
  `;
}

export function definePanel(): void { if (!customElements.get(panelTag)) customElements.define(panelTag, ScheduledTasksPanel); }
