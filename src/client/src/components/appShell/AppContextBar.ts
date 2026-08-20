import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Project, SessionInfo, Workspace } from "../../api";
import { shortSessionId } from "../../sessionLabels";
import type { NavigationSection } from "../../appShell/navigationState";

// Mobile-only top bar. Rather than a breadcrumb of project/workspace/session chips,
// it shows a single button for the deepest thing currently selected (session, else
// workspace, else project). Tapping it opens the navigation so every level — plus
// the machine, on multi-machine gateways — stays reachable. The command palette
// (⚡) sits on the right and is the view switcher on this layout.
const FOLDER_ICON = html`<svg class="context-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
const CHAT_ICON = html`<svg class="context-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-6l-5 4v-4H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z"></path></svg>`;

interface ContextButton {
  label: string;
  title: string;
  ariaLabel: string;
  icon: TemplateResult;
  section: NavigationSection;
}

@customElement("app-context-bar")
export class AppContextBar extends LitElement {
  @property({ attribute: false }) project?: Project;
  @property({ attribute: false }) workspace?: Workspace;
  @property({ attribute: false }) session?: SessionInfo;
  @property({ attribute: false }) refreshControl: unknown;
  @property({ attribute: false }) onOpenSection?: (section: NavigationSection) => void;
  @property({ attribute: false }) onShowActions?: () => void;

  override render() {
    const context = this.currentContext();
    return html`
      <nav class="context-bar" aria-label="Current location">
        <button type="button" class="context-button" title=${context.title} aria-label=${context.ariaLabel} @click=${() => { this.onOpenSection?.(context.section); }}>
          ${context.icon}
          <span class="context-value">${context.label}</span>
          <svg class="context-caret" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"></path></svg>
        </button>
        ${this.hasContextActions() ? html`<div class="context-actions">${this.renderActionsButton()}${this.refreshControl}</div>` : null}
      </nav>
    `;
  }

  // The deepest selected level drives the label/icon; clicking always opens the nav
  // at the section you'd naturally pick next (matching defaultNavigationSection).
  private currentContext(): ContextButton {
    const section: NavigationSection = this.project === undefined ? "projects" : this.workspace === undefined ? "workspaces" : "sessions";
    if (this.session !== undefined) {
      const label = sessionContextLabel(this.session);
      return { label, title: this.session.path, ariaLabel: `Session: ${label}. Open navigation.`, icon: CHAT_ICON, section };
    }
    if (this.workspace !== undefined) {
      const label = workspaceButtonLabel(this.workspace);
      return { label, title: `${label} — ${this.workspace.path}`, ariaLabel: `Workspace: ${label}. Open navigation.`, icon: FOLDER_ICON, section };
    }
    if (this.project !== undefined) {
      return { label: this.project.name, title: `${this.project.name} — ${this.project.path}`, ariaLabel: `Project: ${this.project.name}. Open navigation.`, icon: FOLDER_ICON, section };
    }
    return { label: "Select a project", title: "No project selected", ariaLabel: "Open navigation.", icon: FOLDER_ICON, section };
  }

  private renderActionsButton() {
    if (this.onShowActions === undefined) return null;
    return html`
      <button type="button" class="context-action-button" title="Show Actions" aria-label="Show Actions" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onShowActions?.(); }}>
        <svg class="context-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M13 2 4 14h7l-1 8 10-13h-7V2Z"></path>
        </svg>
      </button>
    `;
  }

  private hasContextActions(): boolean {
    return this.refreshControl !== undefined || this.onShowActions !== undefined;
  }

  static override styles = css`
    /* Keep any menu opened from the actions button above the content below. */
    :host { position: relative; z-index: 20; flex: 0 0 auto; min-width: 0; }
    .context-bar { display: flex; align-items: center; gap: 8px; min-height: 52px; min-width: 0; padding: 4px 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
    .context-button { flex: 0 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 8px; border: none; border-radius: 8px; background: transparent; color: var(--pi-text); padding: 8px; font: inherit; text-align: left; cursor: pointer; }
    .context-button:hover { background: var(--pi-surface-hover); }
    .context-button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .context-icon { flex: 0 0 auto; width: 18px; height: 18px; fill: none; stroke: var(--pi-muted); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .context-value { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; }
    .context-caret { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: var(--pi-dim); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .context-actions { flex: 0 0 auto; margin-left: auto; display: flex; align-items: center; gap: 6px; }
    .context-action-button { box-sizing: border-box; width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 0; line-height: 1; cursor: pointer; }
    .context-action-button:hover, .context-action-button:focus-visible { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .context-action-icon { width: 18px; height: 18px; fill: currentColor; pointer-events: none; }
  `;
}

function workspaceButtonLabel(workspace: Workspace): string {
  return `${workspace.label}${workspace.isMain ? " · main" : ""}`;
}

function sessionContextLabel(session: SessionInfo): string {
  const name = session.name?.trim();
  if (name !== undefined && name !== "") return name;
  const firstMessage = session.firstMessage.trim();
  if (firstMessage !== "") return firstMessage;
  return shortSessionId(session.id);
}
