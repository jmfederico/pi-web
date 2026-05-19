import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Project, Workspace, WorkspaceActivity } from "../api";
import { projectActivityIndicator } from "../workspaceActivity";
import { renderActivityIndicator } from "./activityBadge";
import { activateSelectableRow, activateSelectableRowFromKeyboard } from "./selectableRow";
import { listStyles } from "./shared";

@customElement("project-list")
export class ProjectList extends LitElement {
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selected?: Project;
  @property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
  @property({ attribute: false }) workspacesByProjectId: Record<string, Workspace[]> = {};
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onClose?: (project: Project) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @state() private openMenuProjectId: string | undefined;
  @state() private menuStyle = "";
  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuProjectId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("projects") && this.openMenuProjectId !== undefined && !this.projects.some((project) => project.id === this.openMenuProjectId)) this.openMenuProjectId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuProjectId = undefined;
  }

  override render() {
    return html`
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : this.projects.map((project) => html`
          <div
            class=${`action-row ${this.selected?.id === project.id ? "selected" : ""}`}
            tabindex="0"
            title=${project.path}
            @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(project)); }}
            @keydown=${(event: KeyboardEvent) => { activateSelectableRowFromKeyboard(event, () => this.onSelect?.(project)); }}
          >
            <div class="action-main">
              <span>${project.name}</span><small>${this.renderActivity(project)}${project.path}</small>
            </div>
            <div class="action-menu">
              <button class="action-menu-toggle" title="Project actions" aria-label=${`Actions for ${project.name}`} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id, event.currentTarget); }}>⋯</button>
              ${this.openMenuProjectId === project.id ? html`
                <div class="action-menu-panel" style=${this.menuStyle}>
                  <button title="Close project" @click=${() => { this.close(project); }}>Close</button>
                </div>
              ` : null}
            </div>
          </div>
        `)}
      </section>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return "Projects";
    const selectedSummary = this.selected?.name ?? "No project selected";
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Projects</span><small class="section-selected" title=${selectedTitle}>${selectedSummary}</small></span><small class="section-count">${this.projects.length}</small></button>`;
  }

  private renderActivity(project: Project) {
    const kind = projectActivityIndicator(project, this.workspacesByProjectId[project.id] ?? [], this.activities);
    return renderActivityIndicator(kind, kind === "terminal" ? "Project terminal active" : "Project active") ?? "";
  }

  private toggleMenu(projectId: string, target: EventTarget | null) {
    if (this.openMenuProjectId === projectId) {
      this.openMenuProjectId = undefined;
      return;
    }
    if (target instanceof HTMLElement) {
      const rect = target.getBoundingClientRect();
      this.menuStyle = `top: ${String(rect.bottom + 4)}px; right: ${String(window.innerWidth - rect.right)}px;`;
    }
    this.openMenuProjectId = projectId;
  }

  private close(project: Project) {
    this.openMenuProjectId = undefined;
    if (confirm(`Close ${project.name}?\n\nThis only removes it from Pi Web; it will not change the project folder.`)) this.onClose?.(project);
  }

  static override styles = listStyles;
}
