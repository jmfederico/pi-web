import { css, html, LitElement, nothing } from "lit";
import type { ApplicationPanelContextV5, LocalizedMessages, PluginLocalization, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import definitions from "./messages.js";
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
  private offset = 0;
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
    this.tasks = []; this.history = { executions: [], nextOffset: null }; this.taskId = undefined; this.offset = 0; this.loaded = false;
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
        peer.request("history", { ...(this.taskId === undefined ? {} : { taskId: this.taskId }), limit: 20, offset: this.offset }, options),
      ]);
      if (controller.signal.aborted) return;
      try {
        const tasks = readOverview(overview);
        const page = readHistory(history);
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
  private showHistory(taskId?: string): void { this.taskId = taskId; this.offset = 0; this.history = { executions: [], nextOffset: null }; void this.load(); }
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
  private time(at: string, timezone: string): string {
    return this.contentValue?.localization.date(new Date(at), { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone }) ?? at;
  }
  private renderTarget(task: TaskView) {
    return this.contentValue?.messages.t("target", { project: task.projectId, workspace: task.workspaceId });
  }
  private renderExecution(execution: ExecutionView, detail: boolean) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    return html`
      <div class="execution" data-status=${execution.status}>
        <strong class="outcome">${messages.t(execution.status)}</strong>
        ${detail ? html`<span class="meta">${messages.t(execution.trigger)} · ${messages.t("dispatchedAt", { at: this.time(execution.createdAt, execution.task.timezone) })} · ${execution.task.timezone}</span>` : nothing}
        ${execution.latestReport ? html`<p class="summary">${execution.latestReport.summary}</p>` : nothing}
        ${execution.dispatchError !== null ? html`<p class="diagnostic">${execution.dispatchError}</p>` : nothing}
        ${detail ? html`<span class="meta">${messages.t("execution", { id: execution.id, revision: execution.task.revision })}</span>
          <span class="meta">${this.renderTarget(execution.task)}</span>` : nothing}
        ${execution.sessionId !== null ? html`<div class="conversation"><button type="button" class="ui-button ui-button--action" @click=${() => this.openConversation(execution)}>${messages.t("openConversation")}</button>
          ${detail ? html`<span class="meta">${messages.t("conversation", { id: execution.sessionId })}</span>` : nothing}</div>` : nothing}
      </div>`;
  }
  private renderTask(task: TaskOverview) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    return html`<article class="task">
      <div class="heading"><h3>${task.name}</h3><span class="meta">${messages.t(task.archived ? "archived" : task.paused ? "paused" : "enabled")}</span></div>
      <div class="meta">${task.schedule.kind === "once" ? messages.t("once", { at: this.time(task.schedule.at, task.timezone) }) : html`<code>${task.schedule.expression}</code>`} · ${task.timezone}</div>
      <div class="next">${task.paused || task.archived || task.nextDue === null ? messages.t("noNext") : messages.t("next", { at: this.time(task.nextDue, task.timezone) })}</div>
      <div class="meta">${this.renderTarget(task)}</div>
      ${task.latestExecution ? this.renderExecution(task.latestExecution, false) : html`<p class="meta">${messages.t("noExecution")}</p>`}
      <button type="button" class="ui-button ui-button--action" aria-label=${messages.t("viewTaskHistory", { name: task.name })} aria-pressed=${this.taskId === task.id} ?disabled=${this.busy} @click=${() => { this.showHistory(task.id); }}>${messages.t("viewHistory")}</button>
    </article>`;
  }
  override render() {
    const content = this.contentValue;
    if (!content) return nothing;
    const { messages, localization } = content;
    const selected = this.tasks.find((task) => task.id === this.taskId);
    return html`<div class="panel" dir=${localization.direction}>
      <header class="ui-toolbar"><strong class="ui-toolbar-title title">${messages.t("title")}</strong>
        <div class="ui-toolbar-group"><button type="button" class="ui-button" ?disabled=${this.busy} @click=${() => this.load()}>${messages.t("refresh")}</button></div></header>
      <div class="body" aria-busy=${this.busy}>
        <p class="guidance meta">${messages.t("guidance")}</p>
        ${this.issue ? html`<div role="alert" class="error"><p>${messages.t(this.issue)}</p>${this.diagnostic !== undefined ? html`<p class="diagnostic">${this.diagnostic}</p>` : nothing}</div>` : nothing}
        ${this.busy ? html`<p role="status" class="meta">${messages.t("loading")}</p>` : nothing}
        ${this.loaded ? html`<section aria-label=${messages.t("tasks")}><h2>${messages.t("tasks")}</h2>
          ${this.tasks.length === 0 ? html`<p class="meta">${messages.t("emptyTasks")}</p>` : this.tasks.map((task) => this.renderTask(task))}</section>
          <section aria-label=${messages.t("history")}>
            <div class="heading"><h2>${selected ? messages.t("taskHistory", { name: selected.name }) : messages.t("history")}</h2>
              ${this.taskId !== undefined ? html`<button type="button" class="ui-button ui-button--action" ?disabled=${this.busy} @click=${() => { this.showHistory(); }}>${messages.t("allHistory")}</button>` : nothing}</div>
            ${this.history.executions.length === 0 ? html`<p class="meta">${messages.t("emptyHistory")}</p>` : this.history.executions.map((execution) => html`<article class="history-entry"><h3>${execution.task.name}</h3>${this.renderExecution(execution, true)}</article>`)}
            <nav class="pages" aria-label=${messages.t("history")}><button type="button" class="ui-button ui-button--action" ?disabled=${this.busy || this.offset === 0} @click=${() => { this.page(Math.max(0, this.offset - 20)); }}>${messages.t("previous")}</button>
              <button type="button" class="ui-button ui-button--action" ?disabled=${this.busy || this.history.nextOffset === null} @click=${() => { if (this.history.nextOffset !== null) this.page(this.history.nextOffset); }}>${messages.t("nextPage")}</button></nav>
          </section>` : nothing}
      </div>
    </div>`;
  }
  static override styles = css`
    :host { display: flex; flex: 1; min-height: 0; min-width: 0; color: var(--pi-text); font: 13px var(--pi-font-ui, system-ui, sans-serif); }
    .panel { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
    .title { padding-inline: 12px; }
    .body { overflow: auto; padding: 12px; min-height: 0; overflow-wrap: anywhere; }
    .guidance { margin-block: 0 20px; line-height: 1.5; }
    h2 { font-size: 14px; margin: 0; font-weight: 600; }
    h3 { font-size: 13px; margin: 0; font-weight: 600; }
    section + section { margin-top: 24px; }
    .heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .task, .history-entry { display: grid; gap: 8px; padding-block: 16px; border-bottom: 1px solid var(--pi-border-muted); }
    .task > button { justify-self: start; max-width: 100%; height: auto; min-height: 32px; white-space: normal; text-align: start; }
    .meta { color: var(--pi-text-secondary); font-size: 12px; }
    .next, time { font-variant-numeric: tabular-nums; }
    .execution { display: grid; gap: 8px; }
    .outcome { font-size: 12px; font-weight: 600; }
    .summary, .diagnostic { margin: 0; white-space: pre-wrap; line-height: 1.5; }
    .diagnostic { font: 12px var(--pi-mono, monospace); }
    .error { color: var(--pi-danger); margin-bottom: 16px; }
    .error p { margin-block: 8px; }
    .conversation { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .pages { display: flex; gap: 8px; padding-block: 12px; }
    code { font-family: var(--pi-mono, monospace); }
  `;
}

export function definePanel(): void { if (!customElements.get(panelTag)) customElements.define(panelTag, ScheduledTasksPanel); }
