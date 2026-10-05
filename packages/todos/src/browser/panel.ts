import type { PluginBackend } from "@jmfederico/pi-web/plugin-api";
import { STATUSES, isStatus, resultTask, resultTasks, type Task, type Mutation, type TaskFilter } from "./protocol.js";

export interface PanelSource { machineId: string; backend?: PluginBackend; lifetime: AbortSignal }

/** DOM-owned state: no network work from the host's synchronous render callback. */
export class TodosPanel extends HTMLElement {
  private current: PanelSource | undefined;
  private controller: AbortController | undefined;
  private edit: Task | undefined;
  private busy = false;
  private refreshRevision = 0;
  private message: HTMLParagraphElement | undefined;
  private list: HTMLUListElement | undefined;
  private titleInput: HTMLInputElement | undefined;
  private contextInput: HTMLTextAreaElement | undefined;
  private statusInput: HTMLSelectElement | undefined;
  private archivedInput: HTMLInputElement | undefined;
  private editorHeading: HTMLHeadingElement | undefined;
  private filter: TaskFilter = {};
  private readonly stop = () => { this.controller?.abort(); };

  set source(value: PanelSource) {
    if (this.current?.machineId === value.machineId && this.current.lifetime === value.lifetime) return;
    this.current?.lifetime.removeEventListener("abort", this.stop);
    this.stop();
    this.current = value;
    this.current.lifetime.addEventListener("abort", this.stop, { once: true });
    this.edit = undefined;
    this.filter = {};
    if (this.isConnected) this.mount();
  }
  connectedCallback(): void { this.mount(); }
  disconnectedCallback(): void {
    this.stop();
    this.current?.lifetime.removeEventListener("abort", this.stop);
  }
  private mount(): void {
    this.stop();
    this.controller = new AbortController();
    this.current?.lifetime.addEventListener("abort", this.stop, { once: true });
    this.busy = false;
    this.replaceChildren();
    const style = document.createElement("style");
    style.textContent = `pi-todos-panel { display: block; padding: 1rem; overflow-wrap: anywhere; }
      pi-todos-panel form { display: grid; gap: .5rem; margin-block: 1rem; }
      pi-todos-panel label { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
      pi-todos-panel input:not([type=checkbox]), pi-todos-panel textarea { flex: 1; min-width: 8rem; }
      pi-todos-panel li { margin-block: .75rem; }
      pi-todos-panel li p { white-space: pre-wrap; margin-block: .25rem; }
      pi-todos-panel button { justify-self: start; }`;
    const heading = document.createElement("h2"); heading.textContent = "To-dos";
    const note = document.createElement("p"); note.textContent = "Shared unassigned tasks. Project assignment is not available in this slice.";
    this.message = document.createElement("p"); this.message.setAttribute("role", "status");
    const filters = document.createElement("form");
    const text = document.createElement("input"); text.type = "search"; text.maxLength = 2000;
    text.value = this.filter.text ?? "";
    const status = this.statusSelect(true); status.value = this.filter.status ?? "";
    const archived = document.createElement("select");
    for (const [value, label] of [["active", "Not archived"], ["archived", "Archived"], ["all", "All"]]) {
      const option = document.createElement("option"); option.value = value ?? ""; option.textContent = label ?? ""; archived.append(option);
    }
    archived.value = this.filter.archived === "all" ? "all" : this.filter.archived === true ? "archived" : "active";
    const refresh = document.createElement("button"); refresh.type = "submit"; refresh.textContent = "Refresh";
    filters.append(this.label("Search title/context", text), this.label("Filter status", status), this.label("Archived filter", archived), refresh);
    filters.addEventListener("submit", (event) => {
      event.preventDefault();
      this.filter = { text: text.value, archived: archived.value === "all" ? "all" : archived.value === "archived" };
      if (isStatus(status.value)) this.filter.status = status.value;
      void this.refresh();
    });
    this.list = document.createElement("ul"); this.list.setAttribute("aria-label", "To-do list");
    const form = document.createElement("form");
    this.editorHeading = document.createElement("h3");
    this.titleInput = document.createElement("input"); this.titleInput.required = true; this.titleInput.maxLength = 200;
    this.contextInput = document.createElement("textarea"); this.contextInput.maxLength = 2000;
    this.statusInput = this.statusSelect(false);
    this.archivedInput = document.createElement("input"); this.archivedInput.type = "checkbox";
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "New task";
    cancel.addEventListener("click", () => { if (!this.busy) this.setEditor(); });
    form.append(this.editorHeading, this.label("Title", this.titleInput), this.label("Context", this.contextInput), this.label("Status", this.statusInput), this.label("Archived", this.archivedInput), save, cancel);
    form.addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
    this.append(style, heading, note, filters, this.message, this.list, form);
    this.setEditor(this.edit);
    void this.refresh();
  }
  private label(text: string, input: HTMLElement): HTMLLabelElement {
    const label = document.createElement("label"); label.append(document.createTextNode(`${text} `), input); return label;
  }
  private statusSelect(all: boolean): HTMLSelectElement {
    const select = document.createElement("select");
    if (all) { const option = document.createElement("option"); option.value = ""; option.textContent = "All statuses"; select.append(option); }
    for (const status of STATUSES) { const option = document.createElement("option"); option.value = status; option.textContent = status; select.append(option); }
    return select;
  }
  private setEditor(task?: Task): void {
    this.edit = task;
    if (this.editorHeading) this.editorHeading.textContent = task === undefined ? "New task" : `Edit ${task.id} (revision ${String(task.revision)})`;
    if (this.titleInput) this.titleInput.value = task?.title ?? "";
    if (this.contextInput) this.contextInput.value = task?.context ?? "";
    if (this.statusInput) this.statusInput.value = task?.status ?? "Open";
    if (this.archivedInput) this.archivedInput.checked = task?.archived ?? false;
  }
  private backend(): PluginBackend {
    if (this.current?.backend?.version !== 1 || this.current.lifetime.aborted) throw new Error("To-do backend unavailable. Enable the matching server entry on an updated PI WEB host.");
    return this.current.backend;
  }
  private notice(text: string): void { if (this.message) this.message.textContent = text; }
  private async refresh(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined || controller.signal.aborted) return;
    const live = () => !controller.signal.aborted;
    const revision = ++this.refreshRevision;
    this.notice("Loading…");
    try {
      const tasks = resultTasks(await this.backend().request("list", this.filter, { signal: controller.signal }));
      if (!live() || revision !== this.refreshRevision) return;
      this.list?.replaceChildren();
      for (const task of tasks) {
        const item = document.createElement("li");
        const summary = document.createElement("span"); summary.textContent = `${task.title} — ${task.status}${task.archived ? " (archived)" : ""}`;
        const context = document.createElement("p"); context.textContent = task.context;
        const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit";
        edit.setAttribute("aria-label", `Edit ${task.title}`);
        edit.addEventListener("click", () => { if (!this.busy) { this.setEditor(task); this.notice("Editing the displayed revision. Refresh and select Edit again to load newer changes."); } });
        item.append(summary, context, edit); this.list?.append(item);
      }
      this.notice(tasks.length === 0 ? "No tasks match." : `${String(tasks.length)} task(s).`);
    } catch (error) { if (live() && revision === this.refreshRevision) this.notice(String(error)); }
  }
  private async save(): Promise<void> {
    const controller = this.controller;
    if (this.busy || controller === undefined || controller.signal.aborted || this.titleInput === undefined || this.contextInput === undefined || this.statusInput === undefined || this.archivedInput === undefined) return;
    const live = () => !controller.signal.aborted;
    const status = this.statusInput.value;
    if (!isStatus(status)) return;
    const mutation: Mutation = {
      ...(this.edit === undefined ? {} : { id: this.edit.id, revision: this.edit.revision }),
      title: this.titleInput.value, context: this.contextInput.value, status, archived: this.archivedInput.checked,
    };
    this.busy = true;
    this.refreshRevision++; // An older list completion must not hide a mutation error.
    this.notice("Saving…");
    this.querySelectorAll("input, textarea, select, button").forEach((control) => { control.setAttribute("disabled", ""); });
    try {
      resultTask(await this.backend().request("mutate", mutation, { signal: controller.signal }));
      if (!live()) return;
      this.setEditor();
      await this.refresh();
    } catch (error) {
      if (live()) this.notice(`${String(error)} Your draft is retained. Refresh and select Edit to load the current revision. After a network error, inspect the list before creating again; requests are never retried automatically.`);
    } finally {
      if (live()) {
        this.busy = false;
        this.querySelectorAll("[disabled]").forEach((control) => { control.removeAttribute("disabled"); });
      }
    }
  }
}
