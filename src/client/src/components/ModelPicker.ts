import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CommandOption, SessionModelCatalogEntry } from "../api";
import { keyboardEventOriginatesFromNativeActivationControl } from "./keyboardEventTarget";
import "./ModalSurface";
import { scrollWhenSelected } from "./scrollWhenSelected";

/**
 * Scope the model dialog lists: `enabled` is the session's pickable model list
 * (pi's enabled-models scope); `all` is the session machine's full catalog
 * with per-model membership controls.
 */
export type ModelPickerMode = "enabled" | "all";

/** Filtered All-mode catalog view. Catalog order (enabled first) is preserved. */
export interface ModelCatalogView {
  rows: SessionModelCatalogEntry[];
  /** Group headers only help the unfiltered list; while searching, one flat list is clearer. */
  showGroupHeaders: boolean;
}

/** The wire value identifying one model row: `${provider}/${id}`. */
export function modelCatalogEntryValue(entry: Pick<SessionModelCatalogEntry, "provider" | "id">): string {
  return `${entry.provider}/${entry.id}`;
}

/** Case-insensitive substring filter over the Enabled-mode options (CommandPicker semantics). */
export function filterModelOptions(options: readonly CommandOption[], query: string): CommandOption[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return [...options];
  return options.filter((option) => `${option.label} ${option.description ?? ""} ${option.value}`.toLowerCase().includes(normalized));
}

/** Case-insensitive substring filter over the All-mode catalog, mirroring pi's model search text (id, provider, name). */
export function modelCatalogView(catalog: readonly SessionModelCatalogEntry[], query: string): ModelCatalogView {
  const normalized = query.trim().toLowerCase();
  const rows = normalized === ""
    ? [...catalog]
    : catalog.filter((entry) => `${entry.provider} ${entry.id} ${entry.name ?? ""}`.toLowerCase().includes(normalized));
  const showGroupHeaders = normalized === "" && rows.some((entry) => entry.enabled) && rows.some((entry) => !entry.enabled);
  return { rows, showGroupHeaders };
}

interface ModelPickerRow {
  value: string;
  entry?: SessionModelCatalogEntry | undefined;
}

/**
 * The session model selection dialog. Enabled mode keeps the classic
 * searchable pick list; All models mode lists the machine's full catalog with
 * per-model checkboxes editing pi's enabled-models scope (shared with the pi
 * TUI). Scope is selection UX only, never an authorization boundary.
 */
@customElement("model-picker")
export class ModelPicker extends LitElement {
  @property() override title = "Select Model";
  /** Enabled-mode rows: the session's pickable models, pre-labeled by the host. */
  @property({ attribute: false }) options: CommandOption[] = [];
  /** All-mode rows: the machine's catalog, already grouped enabled-first by the server. */
  @property({ attribute: false }) catalog: SessionModelCatalogEntry[] = [];
  @property({ attribute: false }) selectedValue?: string;
  @property({ attribute: false }) onPick?: (value: string) => void;
  @property({ attribute: false }) onCancel?: () => void;
  /**
   * Requests a change to one model's membership in pi's enabled-models scope.
   * Resolves once the host has applied the fresh catalog (or reported the
   * failure); the checkbox is controlled, so it tracks the catalog, not clicks.
   */
  @property({ attribute: false }) onToggleEnabled?: (provider: string, modelId: string, enabled: boolean) => unknown;

  @state() private mode: ModelPickerMode = "enabled";
  @state() private selectedIndex = 0;
  @state() private query = "";
  @state() private pendingToggles: ReadonlySet<string> = new Set();

  override render() {
    const rows = this.visibleRows();
    return html`
      <modal-surface
        .onClose=${() => this.onCancel?.()}
        .initialFocus=${"input.search"}
        .label=${this.title}
        @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}
      >
        <header>
          <strong>${this.title}</strong>
          <button aria-label="Close" @click=${() => this.onCancel?.()}>×</button>
        </header>
        <div class="scope-toggle" role="group" aria-label="Model scope">
          ${this.renderScopeToggleButton("enabled", "Enabled")}
          ${this.renderScopeToggleButton("all", "All models")}
        </div>
        <input class="search" placeholder="Search" .value=${this.query} @input=${(event: Event) => { this.handleSearchInput(event); }}>
        <div class="options" tabindex="0">
          ${this.mode === "all" ? this.renderCatalogList() : this.renderEnabledList()}
          ${rows.length === 0 ? html`<div class="empty">No matching options</div>` : null}
        </div>
      </modal-surface>
    `;
  }

  override firstUpdated() {
    this.anchorSelectionToSelectedValue();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("catalog") || this.mode !== "all") return;
    // A toggle regroups the catalog (enabled first): keep the selection on the
    // same row rather than on the same numeric index.
    const previousCatalog = changed.get("catalog");
    if (previousCatalog === undefined) return;
    const previousRows = modelCatalogView(previousCatalog, this.query).rows;
    const anchored = previousRows[this.selectedIndex];
    const rows = modelCatalogView(this.catalog, this.query).rows;
    const anchoredValue = anchored === undefined ? undefined : modelCatalogEntryValue(anchored);
    const nextIndex = anchoredValue === undefined ? -1 : rows.findIndex((entry) => modelCatalogEntryValue(entry) === anchoredValue);
    this.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(this.selectedIndex, Math.max(rows.length - 1, 0));
  }

  private renderScopeToggleButton(mode: ModelPickerMode, label: string): TemplateResult {
    return html`<button aria-pressed=${this.mode === mode ? "true" : "false"} @click=${() => { this.selectMode(mode); }}>${label}</button>`;
  }

  private renderEnabledList(): TemplateResult[] {
    return filterModelOptions(this.options, this.query).map((option, index) => html`
      <button
        class=${index === this.selectedIndex ? "selected" : ""}
        aria-current=${index === this.selectedIndex ? "true" : nothing}
        ${scrollWhenSelected(index === this.selectedIndex, option.value)}
        @focus=${() => { this.selectedIndex = index; }}
        @click=${() => this.onPick?.(option.value)}
      >
        <span>${option.label}</span>
        ${option.description !== undefined && option.description !== "" ? html`<small>${option.description}</small>` : null}
      </button>
    `);
  }

  private renderCatalogList(): TemplateResult[] {
    const view = modelCatalogView(this.catalog, this.query);
    const rendered: TemplateResult[] = [];
    let lastGroup: boolean | undefined;
    view.rows.forEach((entry, index) => {
      if (view.showGroupHeaders && entry.enabled !== lastGroup) {
        rendered.push(html`<div class="group-header">${entry.enabled ? "Enabled" : "Other models"}</div>`);
      }
      lastGroup = entry.enabled;
      rendered.push(this.renderCatalogRow(entry, index));
    });
    return rendered;
  }

  private renderCatalogRow(entry: SessionModelCatalogEntry, index: number): TemplateResult {
    const value = modelCatalogEntryValue(entry);
    const selected = index === this.selectedIndex;
    const pending = this.pendingToggles.has(value);
    return html`
      <div class="catalog-row ${selected ? "selected" : ""}" ${scrollWhenSelected(selected, value)}>
        <input
          type="checkbox"
          .checked=${entry.enabled}
          ?disabled=${pending}
          aria-label=${`${entry.enabled ? "Disable" : "Enable"} ${value}`}
          @click=${(event: MouseEvent) => { this.handleEnableToggleClick(entry, event); }}
        />
        <button
          class="pick"
          aria-current=${selected ? "true" : nothing}
          @focus=${() => { this.selectedIndex = index; }}
          @click=${() => this.onPick?.(value)}
        >
          <span>${entry.id}${value === this.selectedValue ? " ✓ current" : ""}</span>
          <small>${entry.provider}</small>
        </button>
      </div>
    `;
  }

  private visibleRows(): ModelPickerRow[] {
    if (this.mode === "all") {
      return modelCatalogView(this.catalog, this.query).rows.map((entry) => ({ value: modelCatalogEntryValue(entry), entry }));
    }
    return filterModelOptions(this.options, this.query).map((option) => ({ value: option.value }));
  }

  private anchorSelectionToSelectedValue(): void {
    if (this.selectedValue === undefined) {
      this.selectedIndex = 0;
      return;
    }
    const index = this.visibleRows().findIndex((row) => row.value === this.selectedValue);
    this.selectedIndex = index >= 0 ? index : 0;
  }

  private selectMode(mode: ModelPickerMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.anchorSelectionToSelectedValue();
  }

  private handleSearchInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.query = event.target.value;
      this.selectedIndex = 0;
    }
  }

  // Escape and backdrop presses are owned by the modal surface (routed to
  // `onCancel`). Search and list-container keys retain the broadened option
  // navigation idiom, while focused native buttons keep their own semantics.
  private handleKeyDown(event: KeyboardEvent) {
    if (keyboardEventOriginatesFromNativeActivationControl(event)) return;
    const rows = this.visibleRows();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (rows.length > 0) this.selectedIndex = (this.selectedIndex + 1) % rows.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length > 0) this.selectedIndex = (this.selectedIndex - 1 + rows.length) % rows.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[this.selectedIndex];
      if (row !== undefined) this.onPick?.(row.value);
    } else if (event.key === " " && this.mode === "all") {
      // Space toggles the selected row only when it did not land on an input:
      // a focused checkbox toggles through its own click and the search input
      // inserts the character.
      if (event.composedPath().some((target) => target instanceof HTMLInputElement)) return;
      const row = rows[this.selectedIndex];
      if (row?.entry === undefined) return;
      event.preventDefault();
      this.requestEnabledToggle(row.entry);
    }
  }

  private handleEnableToggleClick(entry: SessionModelCatalogEntry, event: MouseEvent): void {
    // The checkbox is controlled: cancel the native flip so the rendered state
    // keeps reflecting the catalog until the host applies the fresh one.
    event.preventDefault();
    if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.checked = entry.enabled;
    this.requestEnabledToggle(entry);
  }

  private requestEnabledToggle(entry: SessionModelCatalogEntry): void {
    const value = modelCatalogEntryValue(entry);
    if (this.pendingToggles.has(value)) return;
    const pending = new Set(this.pendingToggles);
    pending.add(value);
    this.pendingToggles = pending;
    void this.settleEnabledToggle(value, entry);
  }

  private async settleEnabledToggle(value: string, entry: SessionModelCatalogEntry): Promise<void> {
    try {
      await this.onToggleEnabled?.(entry.provider, entry.id, !entry.enabled);
    } catch (error: unknown) {
      // Hosts report toggle failures through the app error state; a throwing
      // callback is a wiring bug, so it stays observable here too.
      console.warn(`Failed to toggle model ${value}`, error);
    } finally {
      const settled = new Set(this.pendingToggles);
      settled.delete(value);
      this.pendingToggles = settled;
    }
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 10; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    modal-surface { --modal-surface-width: min(720px, calc(100vw - 40px)); --modal-surface-max-height: min(640px, calc(100vh - 40px)); }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    .scope-toggle { display: flex; gap: 4px; margin: 10px 12px 0; padding: 3px; border: 1px solid var(--pi-border); border-radius: 8px; }
    .scope-toggle button { flex: 1; padding: 6px 10px; border-radius: 6px; color: var(--pi-muted); }
    .scope-toggle button[aria-pressed="true"] { background: var(--pi-selection-bg); color: var(--pi-text); }
    .options { min-height: 0; overflow: auto; outline: none; }
    button { border: 0; background: transparent; color: var(--pi-text); cursor: pointer; }
    header button { font-size: 20px; color: var(--pi-muted); }
    input.search { margin: 10px 12px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); padding: 8px 10px; outline: none; }
    input.search:focus { border-color: var(--pi-accent); }
    .options > button { display: block; width: 100%; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); text-align: left; }
    .options > button.selected, .options > button:hover { background: var(--pi-selection-bg); }
    .catalog-row { display: flex; align-items: center; border-bottom: 1px solid var(--pi-border-muted); }
    .catalog-row.selected, .catalog-row:hover { background: var(--pi-selection-bg); }
    .catalog-row input[type="checkbox"] { margin: 0 0 0 12px; accent-color: var(--pi-accent); }
    .catalog-row .pick { flex: 1; min-width: 0; display: block; padding: 10px 12px; text-align: left; }
    .group-header { padding: 8px 12px 4px; color: var(--pi-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    small { display: block; margin-top: 4px; color: var(--pi-muted); }
    .empty { padding: 24px; color: var(--pi-muted); text-align: center; }
  `;
}
