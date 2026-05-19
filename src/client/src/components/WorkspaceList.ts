import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Workspace, WorkspaceActivity } from "../api";
import type { WorkspaceLabelItem } from "../plugins/types";
import { workspaceActivityFor, workspaceActivityIndicator } from "../workspaceActivity";
import { renderActivityIndicator } from "./activityBadge";
import { activateSelectableRow, activateSelectableRowFromKeyboard } from "./selectableRow";
import { listStyles } from "./shared";
import { renderWorkspaceLabelItems } from "./workspaceLabel";

@customElement("workspace-list")
export class WorkspaceList extends LitElement {
  @property({ attribute: false }) workspaces: Workspace[] = [];
  @property({ attribute: false }) selected?: Workspace;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) workspaceLabelItems: (workspace: Workspace) => WorkspaceLabelItem[] = () => [];
  @property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
  @property({ attribute: false }) onSelect?: (workspace: Workspace) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;

  protected override updated(changed: PropertyValues<this>): void {
    if ((changed.has("selected") || changed.has("workspaces") || changed.has("collapsed")) && !this.collapsed) this.scrollSelectedIntoView();
  }

  override render() {
    return html`
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : this.workspaces.map((workspace) => {
          const label = `${workspace.label}${workspace.isMain ? " · main" : ""}`;
          return html`
            <div
              class=${`action-row workspace-row ${this.selected?.id === workspace.id ? "selected" : ""}`}
              tabindex="0"
              title=${workspace.path}
              @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(workspace)); }}
              @keydown=${(event: KeyboardEvent) => { activateSelectableRowFromKeyboard(event, () => this.onSelect?.(workspace)); }}
            >
              <div class="action-main">
                <span class="workspace-label">
                  <span class="workspace-label-base">${label}</span>
                  ${renderWorkspaceLabelItems(this.workspaceLabelItems(workspace))}
                </span>
                <small>${this.renderActivity(workspace)}${workspace.path}</small>
              </div>
            </div>
          `;
        })}
      </section>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return "Workspaces";
    const selectedSummary = this.selected === undefined ? "No workspace selected" : `${this.selected.label}${this.selected.isMain ? " · main" : ""} · ${this.selected.path}`;
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Workspaces</span><small class="section-selected" title=${selectedTitle}>${selectedSummary}</small></span><small class="section-count">${this.workspaces.length}</small></button>`;
  }

  private renderActivity(workspace: Workspace) {
    const kind = workspaceActivityIndicator(workspaceActivityFor(workspace, this.activities));
    return renderActivityIndicator(kind, kind === "terminal" ? "Workspace terminal active" : "Workspace active") ?? "";
  }

  private scrollSelectedIntoView(): void {
    this.renderRoot.querySelector<HTMLElement>(".action-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  static override styles = listStyles;
}
