import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Project } from "../api";
import { listStyles } from "./shared";

@customElement("project-list")
export class ProjectList extends LitElement {
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selected?: Project;
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onClose?: (project: Project) => void;
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
  }

  override render() {
    return html`
      <section>
        <h2>Projects</h2>
        ${this.projects.map((project) => html`
          <div class=${`action-row ${this.selected?.id === project.id ? "selected" : ""}`}>
            <button class="action-main" @click=${() => this.onSelect?.(project)}>
              <span>${project.name}</span><small>${project.path}</small>
            </button>
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
