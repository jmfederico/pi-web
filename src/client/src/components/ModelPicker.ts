import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { CommandOption, SessionModelCatalogEntry, SessionModelScopeMode } from "../api";
import { keyboardEventOriginatesFromNativeActivationControl } from "./keyboardEventTarget";
import "./ModalSurface";
import { scrollWhenSelected } from "./scrollWhenSelected";

/**
 * Scope the model dialog lists: `enabled` is the session's pickable model list
 * (pi's enabled-models scope); `all` is the session machine's full catalog
 * with per-model membership controls.
 */
export type ModelPickerMode = "enabled" | "all";

/** Filtered All-mode catalog view in the machine catalog's natural order. */
export interface ModelCatalogView {
  rows: SessionModelCatalogEntry[];
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

function modelCatalogInNaturalOrder(catalog: readonly SessionModelCatalogEntry[]): SessionModelCatalogEntry[] {
  if (!catalog.every((entry) => entry.catalogIndex !== undefined)) return [...catalog];
  return [...catalog].sort((left, right) => (left.catalogIndex ?? 0) - (right.catalogIndex ?? 0));
}

/**
 * Case-insensitive substring filter over the All-mode catalog, mirroring pi's
 * model search text (id, provider, name). A dialog-owned stable order can be
 * supplied so a response from an older server cannot regroup rows mid-edit.
 */
export function modelCatalogView(
  catalog: readonly SessionModelCatalogEntry[],
  query: string,
  stableOrder?: readonly string[],
): ModelCatalogView {
  const naturalRows = modelCatalogInNaturalOrder(catalog);
  const rowsByValue = new Map(naturalRows.map((entry) => [modelCatalogEntryValue(entry), entry]));
  const listed = new Set<string>();
  const orderedRows = stableOrder === undefined
    ? naturalRows
    : [
        ...stableOrder.flatMap((value) => {
          const entry = rowsByValue.get(value);
          if (entry === undefined || listed.has(value)) return [];
          listed.add(value);
          return [entry];
        }),
        ...naturalRows.filter((entry) => !listed.has(modelCatalogEntryValue(entry))),
      ];
  const normalized = query.trim().toLowerCase();
  return {
    rows: normalized === ""
      ? orderedRows
      : orderedRows.filter((entry) => `${entry.provider} ${entry.id} ${entry.name ?? ""}`.toLowerCase().includes(normalized)),
  };
}

export interface ModelCatalogToggleAllPlan {
  mode: SessionModelScopeMode;
  /** False when narrowing the scope cannot identify the current model to retain. */
  canApply: boolean;
  hasChanges: boolean;
}

/** Toggle between every model and the smallest usable scope: the current model. */
export function modelCatalogToggleAllPlan(
  catalog: readonly SessionModelCatalogEntry[],
  currentValue: string | undefined,
): ModelCatalogToggleAllPlan {
  const enabledEntries = catalog.filter((entry) => entry.enabled);
  const current = currentValue === undefined
    ? undefined
    : catalog.find((entry) => modelCatalogEntryValue(entry) === currentValue);
  const onlyCurrentEnabled = current?.enabled === true && enabledEntries.length === 1;
  const mode: SessionModelScopeMode = enabledEntries.length === 0 || onlyCurrentEnabled ? "all" : "current";
  return {
    mode,
    canApply: mode === "all" || current !== undefined,
    hasChanges: mode === "all"
      ? enabledEntries.length < catalog.length
      : current !== undefined && (!current.enabled || enabledEntries.some((entry) => entry !== current)),
  };
}

interface ModelPickerRow {
  value: string;
  entry?: SessionModelCatalogEntry | undefined;
}

/**
 * The session model selection dialog. Enabled mode keeps the classic
 * searchable pick list; All models mode lists the machine's full catalog with
 * per-model membership controls editing pi's enabled-models scope (shared with
 * the pi TUI). Workspace `.pi/settings.json` overrides are displayed but
 * read-only because this picker edits global settings only. Scope is selection
 * UX only, never an authorization boundary.
 */
@customElement("model-picker")
export class ModelPicker extends LitElement {
  @property() override title = "Select Model";
  /** Enabled-mode rows: the session's pickable models, pre-labeled by the host. */
  @property({ attribute: false }) options: CommandOption[] = [];
  /** All-mode rows, including enabled state and (on current servers) each model's natural catalog index. Workspace overrides mark rows `editable: false`. */
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
  /** Atomically applies the bulk availability preset selected by the toggle-all action. */
  @property({ attribute: false }) onSetScope?: (mode: SessionModelScopeMode) => unknown;

  @state() private mode: ModelPickerMode = "enabled";
  @state() private selectedIndex = 0;
  @state() private query = "";
  @state() private pendingToggles: ReadonlySet<string> = new Set();
  @state() private toggleAllPending = false;
  /** Stable for this dialog's lifetime so membership responses never move natural rows. */
  private catalogOrder: string[] = [];
  private catalogScrollTopBeforeUpdate: number | undefined;
  private focusAfterToggle: HTMLElement | undefined;

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
        ${!this.modelScopeEditable ? html`
          <div class="scope-notice" role="status">
            <strong>Project override</strong>
            <span>Showing models from this workspace’s <code>.pi/settings.json</code>. Model availability selection is disabled.</span>
          </div>
        ` : nothing}
        <div class="search-row">
          <input class="search" aria-label="Search models" placeholder="Search" .value=${this.query} @input=${(event: Event) => { this.handleSearchInput(event); }}>
          ${this.mode === "all" ? this.renderToggleAllButton() : nothing}
        </div>
        <div
          class="options"
          role="region"
          aria-label=${this.mode === "all" ? "All models in catalog order" : "Enabled models"}
          tabindex="0"
          aria-busy=${this.membershipChangePending ? "true" : "false"}
        >
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
    if (!changed.has("catalog")) return;
    if (this.mode === "all") {
      this.catalogScrollTopBeforeUpdate = this.shadowRoot?.querySelector<HTMLElement>(".options")?.scrollTop;
    }
    this.rememberCatalogOrder();
    if (this.mode !== "all") return;

    // The server keeps scope order enabled-first. Anchor keyboard selection by
    // value while the dialog's natural row order stays fixed across responses.
    const previousCatalog = changed.get("catalog");
    if (previousCatalog === undefined) return;
    const previousRows = modelCatalogView(previousCatalog, this.query, this.catalogOrder).rows;
    const anchored = previousRows[this.selectedIndex];
    const rows = modelCatalogView(this.catalog, this.query, this.catalogOrder).rows;
    const anchoredValue = anchored === undefined ? undefined : modelCatalogEntryValue(anchored);
    const nextIndex = anchoredValue === undefined ? -1 : rows.findIndex((entry) => modelCatalogEntryValue(entry) === anchoredValue);
    this.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(this.selectedIndex, Math.max(rows.length - 1, 0));
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("catalog") || this.catalogScrollTopBeforeUpdate === undefined) return;
    const options = this.shadowRoot?.querySelector<HTMLElement>(".options");
    if (options !== null && options !== undefined) options.scrollTop = this.catalogScrollTopBeforeUpdate;
    this.catalogScrollTopBeforeUpdate = undefined;
  }

  private get membershipChangePending(): boolean {
    return this.toggleAllPending || this.pendingToggles.size > 0;
  }

  private get modelScopeEditable(): boolean {
    return this.catalog.every((entry) => entry.editable !== false);
  }

  private renderScopeToggleButton(mode: ModelPickerMode, label: string): TemplateResult {
    return html`<button ?disabled=${this.membershipChangePending} aria-pressed=${this.mode === mode ? "true" : "false"} @click=${() => { this.selectMode(mode); }}>${label}</button>`;
  }

  private renderToggleAllButton(): TemplateResult {
    const plan = modelCatalogToggleAllPlan(this.catalog, this.selectedValue);
    const label = plan.mode === "all" ? "Select all" : "Deselect all";
    return html`
      <button
        class="toggle-all"
        ?disabled=${!this.modelScopeEditable || !plan.canApply || !plan.hasChanges || this.toggleAllPending || this.pendingToggles.size > 0}
        aria-describedby="model-scope-status"
        title=${!this.modelScopeEditable ? "Workspace settings control model availability" : !plan.canApply ? "The current model is unavailable" : nothing}
        @click=${() => { this.requestToggleAll(); }}
      >${label}</button>
      <span id="model-scope-status" class="scope-status" aria-live="polite">${this.membershipChangePending ? "Updating model availability" : !this.modelScopeEditable ? "Workspace settings control model availability" : !plan.canApply ? "The current model is unavailable" : nothing}</span>
    `;
  }

  private rememberCatalogOrder(): void {
    const knownCatalogValues = new Set(this.catalogOrder);
    for (const entry of modelCatalogView(this.catalog, "").rows) {
      const value = modelCatalogEntryValue(entry);
      if (knownCatalogValues.has(value)) continue;
      knownCatalogValues.add(value);
      this.catalogOrder.push(value);
    }
  }

  private renderEnabledList(): TemplateResult[] {
    return filterModelOptions(this.options, this.query).map((option, index) => html`
      <button
        class=${index === this.selectedIndex ? "selected" : ""}
        ?disabled=${this.membershipChangePending}
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

  private renderCatalogList(): TemplateResult {
    const rows = modelCatalogView(this.catalog, this.query, this.catalogOrder).rows;
    return html`${repeat(rows, modelCatalogEntryValue, (entry, index) => this.renderCatalogRow(entry, index))}`;
  }

  private renderCatalogRow(entry: SessionModelCatalogEntry, index: number): TemplateResult {
    const value = modelCatalogEntryValue(entry);
    const selected = index === this.selectedIndex;
    const protectsCurrentModel = value === this.selectedValue && entry.enabled;
    const membershipDisabled = !this.modelScopeEditable || this.membershipChangePending || protectsCurrentModel;
    const membershipLabel = !this.modelScopeEditable
      ? `Model availability for ${value} is controlled by workspace settings`
      : protectsCurrentModel ? `Current model ${value} cannot be deselected` : `${entry.enabled ? "Disable" : "Enable"} ${value}`;
    return html`
      <div class="catalog-row ${selected ? "selected" : ""}" data-model-value=${value} ${scrollWhenSelected(selected, value)}>
        <input
          type="checkbox"
          .checked=${entry.enabled}
          ?disabled=${membershipDisabled}
          aria-label=${membershipLabel}
          title=${!this.modelScopeEditable ? "Workspace settings control model availability" : protectsCurrentModel ? "The current model must remain enabled" : nothing}
          @focus=${() => { this.selectedIndex = index; }}
          @click=${(event: MouseEvent) => { this.handleEnableToggleClick(entry, event); }}
        />
        <button
          class="membership"
          ?disabled=${membershipDisabled}
          aria-label=${membershipLabel}
          aria-current=${value === this.selectedValue ? "true" : nothing}
          @focus=${() => { this.selectedIndex = index; }}
          @click=${(event: MouseEvent) => { this.requestEnabledToggle(entry, event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined); }}
        >
          <span>${entry.id}${value === this.selectedValue ? " ✓ current" : ""}</span>
          <small>${entry.provider}</small>
        </button>
      </div>
    `;
  }

  private visibleRows(): ModelPickerRow[] {
    if (this.mode === "all") {
      return modelCatalogView(this.catalog, this.query, this.catalogOrder).rows.map((entry) => ({ value: modelCatalogEntryValue(entry), entry }));
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
  // navigation idiom, while focused row controls keep their own semantics.
  private handleKeyDown(event: KeyboardEvent) {
    const focusedCheckbox = event.composedPath().find((target): target is HTMLInputElement => target instanceof HTMLInputElement && target.type === "checkbox");
    if (focusedCheckbox !== undefined) {
      // Browsers do not consistently activate checkboxes with Enter. Support it
      // explicitly, but never let row-navigation keys move a hidden selection
      // away from the checkbox that still holds focus.
      if (event.key === "Enter") {
        event.preventDefault();
        focusedCheckbox.click();
      }
      return;
    }
    if (keyboardEventOriginatesFromNativeActivationControl(event)) return;
    if (this.membershipChangePending && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      return;
    }
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
      if (row?.entry !== undefined) this.requestEnabledToggle(row.entry);
      else if (row !== undefined) this.onPick?.(row.value);
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
    const checkbox = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : undefined;
    if (checkbox !== undefined) checkbox.checked = entry.enabled;
    this.requestEnabledToggle(entry, checkbox);
  }

  private requestEnabledToggle(entry: SessionModelCatalogEntry, focusTarget?: HTMLElement): void {
    const value = modelCatalogEntryValue(entry);
    if (!this.modelScopeEditable || (value === this.selectedValue && entry.enabled) || this.membershipChangePending) return;
    if (focusTarget !== undefined && this.shadowRoot?.activeElement === focusTarget) this.focusAfterToggle = focusTarget;
    const pending = new Set(this.pendingToggles);
    pending.add(value);
    this.pendingToggles = pending;
    void this.settleEnabledToggle(value, entry);
  }

  private requestToggleAll(): void {
    if (!this.modelScopeEditable || this.toggleAllPending || this.pendingToggles.size > 0) return;
    const plan = modelCatalogToggleAllPlan(this.catalog, this.selectedValue);
    if (!plan.canApply || !plan.hasChanges) return;
    this.toggleAllPending = true;
    void this.settleToggleAll(plan.mode);
  }

  private async settleToggleAll(mode: SessionModelScopeMode): Promise<void> {
    try {
      await this.onSetScope?.(mode);
    } catch (error: unknown) {
      console.warn(`Failed to ${mode === "all" ? "enable all models" : "keep only the current model"}`, error);
    } finally {
      this.toggleAllPending = false;
    }
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
      const focusTarget = this.focusAfterToggle;
      this.focusAfterToggle = undefined;
      await this.updateComplete;
      if (focusTarget?.isConnected === true && this.shadowRoot?.activeElement === null) {
        focusTarget.focus({ preventScroll: true });
      }
    }
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 10; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    modal-surface { --modal-surface-width: min(720px, calc(100vw - 40px)); --modal-surface-max-height: min(640px, calc(100vh - 40px)); }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    .scope-toggle { display: flex; gap: 4px; margin: 10px 12px 0; padding: 3px; border: 1px solid var(--pi-border); border-radius: 8px; }
    .scope-toggle button { flex: 1; padding: 6px 10px; border-radius: 6px; color: var(--pi-muted); }
    .scope-toggle button[aria-pressed="true"] { background: var(--pi-selection-bg); color: var(--pi-text); }
    .scope-notice { display: grid; gap: 3px; margin: 10px 12px 0; padding: 8px 10px; border: 1px solid var(--pi-border); border-radius: 8px; color: var(--pi-muted); }
    .scope-notice strong { color: var(--pi-text); }
    .scope-notice code { font: inherit; color: var(--pi-text); }
    .options { min-height: 0; overflow: auto; outline: none; }
    button { border: 0; background: transparent; color: var(--pi-text); cursor: pointer; }
    header button { font-size: 20px; color: var(--pi-muted); }
    .search-row { display: flex; align-items: center; gap: 8px; margin: 10px 12px; }
    input.search { flex: 1; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); padding: 8px 10px; outline: none; }
    input.search:focus { border-color: var(--pi-accent); }
    .toggle-all { flex: none; padding: 8px 10px; border: 1px solid var(--pi-border); border-radius: 8px; white-space: nowrap; }
    .toggle-all:hover:not(:disabled) { background: var(--pi-selection-bg); }
    .toggle-all:disabled { cursor: default; opacity: 0.55; }
    .scope-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .options > button { display: block; width: 100%; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); text-align: left; }
    .options > button.selected, .options > button:hover { background: var(--pi-selection-bg); }
    .catalog-row { display: flex; align-items: center; border-bottom: 1px solid var(--pi-border-muted); }
    .catalog-row.selected, .catalog-row:hover { background: var(--pi-selection-bg); }
    .catalog-row input[type="checkbox"] { margin: 0 0 0 12px; accent-color: var(--pi-accent); }
    .catalog-row .membership { flex: 1; min-width: 0; display: block; padding: 10px 12px; text-align: left; }
    small { display: block; margin-top: 4px; color: var(--pi-muted); }
    .empty { padding: 24px; color: var(--pi-muted); text-align: center; }
  `;
}
