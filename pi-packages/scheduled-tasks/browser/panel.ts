import { css, html, LitElement, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import type { ApplicationPanelContextV5, LocalizedMessages, PluginLocalization, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import definitions from "./messages.js";
import type { AttentionBadge } from "./attentionBadge.js";
import { needsAttention, overviewGroups, reportPreview } from "./overview.js";
import { loadTargetNames, type TargetNames } from "./targetNames.js";
import { readTaskPrompt, readExecutionPrompt, readHistory, readOverview, type ExecutionView, type HistoryPage, type TaskOverview, type TaskView } from "./responses.js";

const taskScopes = ["all", "project", "workspace"] as const;
type TaskScope = typeof taskScopes[number];

export const panelTag = "pi-web-scheduled-tasks-panel";
export interface PanelContent {
  localization: PluginLocalization;
  messages: LocalizedMessages<typeof definitions>;
  styles: StylesheetIntegrationCapabilityV1;
  lifetimeSignal: AbortSignal;
  badge: Pick<AttentionBadge, "beginOverview">;
}

export class ScheduledTasksPanel extends LitElement {
  private contentValue: PanelContent | undefined;
  private contextValue: ApplicationPanelContextV5 | undefined;
  private releaseStyles: (() => void) | undefined;
  private releaseLocalization: (() => void) | undefined;
  private pending: AbortController | undefined;
  private tasks: TaskOverview[] = [];
  private scope: TaskScope = "all";
  private targetNames: TargetNames | undefined;
  private history: HistoryPage = { executions: [], nextOffset: null };
  private taskId: string | undefined;
  private view: "overview" | "task" | "history" = "overview";
  private offset = 0;
  private archivedExpanded = false;
  private busy = false;
  private loaded = false;
  private issue: "unavailable" | "loadFailed" | "invalidResponse" | "navigationFailed" | undefined;
  private diagnostic: string | undefined;
  private readonly prompts = new Map<string, { controller: AbortController; text?: string; error?: "loadFailed" | "invalidResponse" }>();
  private clearPrompts(): void {
    for (const prompt of this.prompts.values()) prompt.controller.abort();
    this.prompts.clear();
  }
  private readonly stop = () => { this.pending?.abort(); this.clearPrompts(); };

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
    if (previous?.machine.id === value.machine.id && !!previous.backend === !!value.backend) {
      const before = previous.state;
      const after = value.state;
      if (before.selectedProject !== after.selectedProject || before.selectedWorkspace !== after.selectedWorkspace) {
        if (!this.canUseScope(this.scope)) this.scope = "all";
        this.requestUpdate();
      }
      return;
    }
    this.scope = "all";
    this.targetNames = undefined;
    this.pending?.abort();
    this.clearPrompts();
    this.tasks = []; this.history = { executions: [], nextOffset: null }; this.taskId = undefined; this.view = "overview"; this.offset = 0; this.archivedExpanded = false; this.loaded = false;
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
    this.clearPrompts();
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
      const updateBadge = this.contentValue.badge.beginOverview(context);
      const [overview, history] = await Promise.all([
        peer.request("overview", {}, options),
        this.view === "overview" ? Promise.resolve(null) : peer.request("history", { ...(this.taskId === undefined ? {} : { taskId: this.taskId }), limit: 20, offset: this.offset }, options),
      ]);
      if (controller.signal.aborted) return;
      try {
        const tasks = readOverview(overview);
        const page = history === null ? { executions: [], nextOffset: null } : readHistory(history);
        this.tasks = tasks; this.history = page; this.loaded = true;
        updateBadge(tasks.filter(needsAttention).length);
        void this.refreshTargetNames(context, [...tasks, ...page.executions.map((execution) => execution.task)], controller.signal);
      } catch { this.issue = "invalidResponse"; }
    } catch (error) {
      if (controller.signal.aborted) return;
      this.issue = "loadFailed";
      this.diagnostic = error instanceof Error ? error.message : String(error);
    } finally {
      if (!controller.signal.aborted) { this.busy = false; this.requestUpdate(); }
    }
  }
  private async refreshTargetNames(context: ApplicationPanelContextV5, tasks: TaskView[], signal: AbortSignal): Promise<void> {
    const names = await loadTargetNames(context.catalog, tasks, signal);
    if (signal.aborted) return;
    this.targetNames = names;
    this.requestUpdate();
  }
  private canUseScope(scope: TaskScope): boolean {
    const state = this.contextValue?.state;
    return scope === "all" || (scope === "project" ? !!state?.selectedProject : !!state?.selectedWorkspace);
  }
  private tasksInScope(): TaskOverview[] {
    const state = this.contextValue?.state;
    switch (this.scope) {
      case "all": return this.tasks;
      case "project": return this.tasks.filter((task) => task.projectId === state?.selectedProject?.id);
      case "workspace": {
        const workspace = state?.selectedWorkspace;
        return this.tasks.filter((task) => task.projectId === workspace?.projectId && task.workspaceId === workspace.id);
      }
    }
  }
  private showHistory(taskId?: string): void {
    this.clearPrompts();
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
    this.clearPrompts();
    const previous = this.taskId;
    this.view = "overview"; this.taskId = undefined; this.offset = 0;
    void this.load();
    await this.updateComplete;
    const control = [...this.renderRoot.querySelectorAll<HTMLButtonElement>("[data-task-id]")].find((button) => button.dataset["taskId"] === previous);
    if (control) control.focus();
    else await this.focusView();
  }
  private page(offset: number): void { this.offset = offset; this.history = { executions: [], nextOffset: null }; void this.load(); }
  private conversationUrl(execution: ExecutionView): string {
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({
      machine: this.contextValue?.machine.id ?? "", project: execution.task.projectId,
      workspace: execution.task.workspaceId, session: execution.sessionId ?? "", view: "chat",
    }).toString();
    url.hash = "";
    return url.href;
  }
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
  private time(at: string, timeZone?: string): string {
    return this.contentValue?.localization.date(new Date(at), { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(timeZone === undefined ? {} : { timeZone }) }) ?? at;
  }
  private renderTarget(task: TaskView) {
    return this.contentValue?.messages.t("target", { project: task.projectId, workspace: task.workspaceId });
  }
  private renderNext(task: TaskView) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    if (task.archived) return messages.t("archived");
    if (task.paused) return messages.t("paused");
    return task.nextDue === null ? messages.t("noNext") : messages.t("next", { at: this.time(task.nextDue, task.timezone) });
  }
  private renderTargetNames(task: TaskView) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    const state = this.contextValue?.state;
    const project = state?.selectedProject?.id === task.projectId ? state.selectedProject.name : this.targetNames?.projects.get(task.projectId);
    const selectedWorkspace = state?.selectedWorkspace;
    const workspace = selectedWorkspace?.projectId === task.projectId && selectedWorkspace.id === task.workspaceId
      ? selectedWorkspace.label : this.targetNames?.workspaces.get(task.projectId)?.get(task.workspaceId);
    const label = this.targetNames === undefined && (project === undefined || workspace === undefined)
      ? messages.t("loadingTarget")
      : messages.t("namedTarget", { project: project ?? messages.t("unknownProject"), workspace: workspace ?? messages.t("unknownWorkspace") });
    return html`<p class="meta target-names" dir="auto">${label}</p>`;
  }
  private renderNotices(execution: ExecutionView) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    return execution.notices?.map((notice) => html`<p class="run-warning">${messages.t("runWarning", { notice })}</p>`) ?? nothing;
  }
  private async loadPrompt(key: string, execution: boolean, id: string): Promise<void> {
    if (this.prompts.has(key)) return;
    const context = this.contextValue;
    if (!context?.backend) return;
    const state: { controller: AbortController; text?: string; error?: "loadFailed" | "invalidResponse" } = { controller: new AbortController() };
    this.prompts.set(key, state);
    this.requestUpdate();
    try {
      const peer = context.backend.forScope({ kind: "machine" });
      if (!peer.request) throw new Error("Scheduled tasks backend does not support requests");
      const response = await peer.request(
        execution ? "execution" : "inspect", execution ? { executionId: id } : { taskId: id }, { signal: state.controller.signal },
      );
      if (state.controller.signal.aborted) return;
      try { state.text = execution ? readExecutionPrompt(response) : readTaskPrompt(response); }
      catch { state.error = "invalidResponse"; }
    } catch {
      if (state.controller.signal.aborted) return;
      state.error = "loadFailed";
    } finally {
      if (!state.controller.signal.aborted) this.requestUpdate();
    }
  }
  private renderPrompt(task: TaskView, execution?: ExecutionView) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    const key = execution ? `execution:${execution.id}` : `task:${task.id}:${String(task.revision)}`;
    const state = this.prompts.get(key);
    const load = () => { void this.loadPrompt(key, !!execution, execution?.id ?? task.id); };
    return keyed(key, html`<details class="prompt" @toggle=${(event: Event) => {
      if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open && event.currentTarget.isConnected) load();
    }}><summary>${messages.t(execution ? "promptUsed" : "prompt")}</summary>
      ${state?.error ? html`<div role="alert"><p class="meta">${messages.t("promptLoadFailed")}</p>
        <button type="button" class="ui-button ui-button--action" @click=${() => { this.prompts.delete(key); load(); }}>${messages.t("retryPrompt")}</button></div>`
        : state?.text !== undefined ? html`<p class="prompt-text" dir="auto">${state.text}</p>`
        : html`<p class="meta" role="status">${messages.t("loadingPrompt")}</p>`}
    </details>`);
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
  private renderConversation(execution: ExecutionView) {
    const messages = this.contentValue?.messages;
    if (!messages || execution.sessionId === null) return nothing;
    return html`<a class="conversation" href=${this.conversationUrl(execution)} @click=${(event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void this.openConversation(execution);
    }}>${messages.t("openConversation")}</a>`;
  }
  private renderExecution(execution: ExecutionView) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    return html`<div class="execution" data-status=${execution.status}>
      <div class="heading"><strong class="outcome">${messages.t(execution.status)}</strong>
        <span class="meta">${messages.t("recordedAt", { at: this.time(execution.createdAt) })}</span></div>
      ${this.renderConversation(execution)}
      ${execution.latestReport ? keyed(execution.id, html`<details class="result"><summary>${messages.t("result")}</summary>
        <p class="summary">${execution.latestReport.summary}</p>
      </details>`) : nothing}
      ${execution.status === "uncertain" || execution.status === "failed" || execution.status === "errored"
        ? html`<p class="meta">${messages.t(execution.status === "uncertain" ? "uncertainHelp" : execution.status === "failed" ? "failedHelp" : "erroredHelp")}</p>` : nothing}
      ${this.renderNotices(execution)}
      ${this.renderPrompt(execution.task, execution)}
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
  private renderReportPreview(execution: ExecutionView) {
    const messages = this.contentValue?.messages;
    if (!messages || !execution.latestReport) return nothing;
    const { summary } = execution.latestReport;
    const preview = reportPreview(summary);
    return preview.truncated ? keyed(execution.id, html`<div class="overview-report">
      <details><summary>${messages.t("readReport")}</summary>
        <p class="summary" dir="auto">${summary}</p>
      </details>
      <p class="report-preview" dir="auto">${preview.text}…</p>
    </div>`) : html`<p class="report-preview" dir="auto">${preview.text}</p>`;
  }
  private renderOverviewTask(task: TaskOverview) {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    const execution = task.latestExecution;
    return html`<article class="task" data-attention=${needsAttention(task)}>
      <div class="task-heading">
        <h3>${this.renderTaskLink(task)}</h3>
        <p class="next meta">${this.renderNext(task)}</p>
      </div>
      ${this.renderTargetNames(task)}
      ${execution ? html`
        <div class="run-line"><strong class="outcome" data-status=${execution.status}>${messages.t(execution.status)}</strong>
          <span class="meta">${messages.t("recordedAt", { at: this.time(execution.createdAt) })}</span></div>
        ${this.renderReportPreview(execution)}
        ${execution.status === "uncertain" ? html`<p class="meta">${messages.t("uncertainHelp")}</p>` : nothing}
        ${this.renderConversation(execution)}
      ` : html`<p class="meta">${messages.t("noExecution")}</p>`}
    </article>`;
  }
  private renderScopeFilter() {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    const labels = { all: "scopeAll", project: "scopeProject", workspace: "scopeWorkspace" } as const;
    return html`<div class="ui-tabs scope-filter" role="group" aria-label=${messages.t("filterTasks")}>
      ${taskScopes.map((scope) => html`<button type="button" class="ui-button ui-tab" aria-pressed=${String(this.scope === scope)}
        ?disabled=${!this.canUseScope(scope)} @click=${() => { this.scope = scope; this.requestUpdate(); }}>${messages.t(labels[scope])}</button>`)}
    </div>`;
  }
  private renderOverview() {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    if (this.tasks.length === 0) return html`<section class="empty"><h2 class="view-title" tabindex="-1">${messages.t("emptyTasks")}</h2><p class="meta">${messages.t("emptyGuidance")}</p></section>`;
    const tasks = this.tasksInScope();
    const groups = overviewGroups(tasks);
    return html`
      ${tasks.length === 0 ? html`<p class="quiet view-title" tabindex="-1">${messages.t(this.scope === "project" ? "emptyProject" : "emptyWorkspace")}</p>` : nothing}
      ${groups.attention.length ? html`<section aria-labelledby="attention-title">
        <h2 id="attention-title" class="view-title" tabindex="-1">${messages.t("attention")}</h2>
        ${repeat(groups.attention, (task) => task.id, (task) => this.renderOverviewTask(task))}
      </section>` : nothing}
      ${groups.current.length ? html`<section aria-labelledby="tasks-title"><h2 id="tasks-title" class="view-title" tabindex="-1">${messages.t("tasks")}</h2>
        ${repeat(groups.current, (task) => task.id, (task) => this.renderOverviewTask(task))}
      </section>` : nothing}
      ${groups.archived.length ? html`<details class="archived-tasks" ?open=${this.archivedExpanded} @toggle=${(event: Event) => { if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.isConnected) this.archivedExpanded = event.currentTarget.open; }}><summary class="view-title">${messages.t("archivedTasks", { count: groups.archived.length })}</summary>
        ${repeat(groups.archived, (task) => task.id, (task) => this.renderOverviewTask(task))}
      </details>` : nothing}`;
  }
  private renderHistory() {
    const messages = this.contentValue?.messages;
    if (!messages) return nothing;
    const selected = this.tasks.find((task) => task.id === this.taskId);
    return html`
      <div class="detail-heading"><h2 class="view-title" tabindex="-1">${selected?.name ?? messages.t("history")}</h2>
        ${selected ? html`${this.renderTargetNames(selected)}<p class="next meta">${this.renderNext(selected)}</p>${this.renderPrompt(selected)}${this.renderTechnical(selected)}` : nothing}</div>
      <section aria-label=${messages.t("history")}>
        ${selected ? html`<h2>${messages.t("history")}</h2>` : nothing}
        ${this.history.executions.length === 0 && !this.busy ? html`<p class="quiet">${messages.t(selected && this.offset === 0 ? "noExecution" : "emptyHistory")}</p>` : nothing}
        ${this.history.executions.map((execution) => html`<article class="history-entry">
          ${selected?.projectId === execution.task.projectId && selected.workspaceId === execution.task.workspaceId ? nothing : html`
            ${selected ? nothing : html`<h3>${execution.task.name}</h3>`}${this.renderTargetNames(execution.task)}`}
          ${this.renderExecution(execution)}</article>`)}
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
      <header class="ui-toolbar">
        ${this.view === "overview" ? this.renderScopeFilter() : html`<strong class="ui-toolbar-title title">${messages.t("title")}</strong>`}
        <div class="ui-toolbar-group"><button type="button" class="ui-button" ?disabled=${this.busy} @click=${() => this.load()}>${messages.t("refresh")}</button></div>
      </header>
      <div class="body" aria-busy=${this.busy}><div class="reading-width">
        ${this.view !== "overview" ? html`<button type="button" class="ui-button ui-button--action back" @click=${() => this.showOverview()}>${messages.t("overview")}</button>` : nothing}
        ${this.issue ? html`<div role="alert" class="error"><p>${messages.t(this.issue)}</p>${this.diagnostic !== undefined ? html`<details><summary>${messages.t("errorDetails")}</summary><p class="diagnostic">${this.diagnostic}</p></details>` : nothing}</div>` : nothing}
        ${this.busy ? html`<p role="status" class="meta">${messages.t("loading")}</p>` : nothing}
        ${this.targetNames?.lookupFailed === true ? html`<p class="catalog-warning meta" role="status">${messages.t("targetLookupFailed")}</p>` : nothing}
        ${this.loaded ? this.view === "overview" ? this.renderOverview() : this.renderHistory() : nothing}
        ${this.view === "overview" && this.loaded ? html`<footer>
          <button type="button" class="ui-button ui-button--action" @click=${() => { this.showHistory(); }}>${messages.t("allHistory")}</button>
          <details class="guidance"><summary>${messages.t("manage")}</summary><p class="meta">${messages.t("guidance")}</p></details>
        </footer>` : nothing}
      </div></div>
    </div>`;
  }
  static override styles = css`
    :host { display: flex; flex: 1; min-height: 0; min-width: 0; color: var(--pi-text); font: 13px var(--pi-font-ui, system-ui, sans-serif); }
    .panel { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
    .title { padding-inline: 12px; }
    .body { overflow: auto; padding: 20px 16px; min-height: 0; overflow-wrap: anywhere; }
    .reading-width { max-inline-size: 760px; margin-inline: auto; }
    h2 { font-size: 15px; margin: 0; font-weight: 600; }
    h3 { font-size: 14px; margin: 0; min-width: 0; }
    p { margin: 0; line-height: 1.5; }
    section + section { margin-top: 28px; }
    .scope-filter { flex: 1 1 auto; }
    .heading, .task-heading, .run-line { display: flex; align-items: baseline; gap: 2px 12px; flex-wrap: wrap; }
    .heading, .task-heading { justify-content: space-between; }
    .task, .history-entry { display: grid; gap: 8px; padding-block: 14px; border-bottom: 1px solid var(--pi-border-muted); }
    .task[data-attention="true"] .outcome, .execution[data-status="failed"] .outcome, .execution[data-status="errored"] .outcome, .execution[data-status="uncertain"] .outcome { color: var(--pi-danger); }
    .task .outcome[data-status="completed"] { color: var(--pi-success); }
    .ui-button.task-link { --ui-control-padding: 4px 0; justify-content: flex-start; text-align: start; white-space: normal; color: var(--pi-text); font: inherit; font-weight: 600; width: 100%; height: auto; }
    .meta { color: var(--pi-text-secondary); font-size: 12px; }
    .quiet { color: var(--pi-text-secondary); padding-top: 10px; }
    .overview-report summary { width: fit-content; text-decoration: underline; text-underline-offset: 3px; }
    .overview-report details[open] + .report-preview { display: none; }
    .report-preview, .overview-report .summary { max-inline-size: 70ch; }
    .next { font-variant-numeric: tabular-nums; }
    .execution, .detail-stack { display: grid; gap: 10px; min-width: 0; }
    .outcome { font-size: 12px; font-weight: 500; }
    .run-warning { font-size: 12px; white-space: pre-wrap; }
    .prompt-text { white-space: pre-wrap; overflow-wrap: anywhere; padding-block: 4px 12px; }
    .result .summary { padding-block: 4px 12px; }
    .summary, .diagnostic { white-space: pre-wrap; line-height: 1.5; }
    .diagnostic, code { font: 12px var(--pi-mono, monospace); }
    .error { color: var(--pi-danger); margin-bottom: 16px; }
    .error p { margin-block: 8px; }
    .catalog-warning { margin-block-end: 12px; }
    .conversation { justify-self: start; max-width: 100%; color: var(--pi-text-secondary); text-decoration: underline; text-underline-offset: 3px; padding-block: 4px; line-height: 1.5; }
    .conversation:hover { color: var(--pi-text); }
    .conversation:focus-visible { outline: 2px solid var(--pi-text-secondary); outline-offset: 2px; }
    .pages { display: flex; gap: 8px; padding-block: 16px; }
    .archived-tasks { margin-top: 24px; }
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
