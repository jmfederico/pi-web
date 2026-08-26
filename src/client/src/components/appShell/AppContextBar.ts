import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Machine, Project, SessionInfo, Workspace } from "../../api";
import { shortSessionId } from "../../sessionLabels";
import type { NavigationSection } from "../../appShell/navigationState";

// Mobile-only top bar. It shows the full location as a breadcrumb —
// machine › project › workspace › session — so you always know where you are,
// which matters most on multi-machine gateways. Each crumb opens the navigation
// at that level; the deepest crumb reads as "you are here" and toggles the
// navigation open and closed. When the gateway is federated the machine crumb is
// pinned so it never scrolls out of view. The command palette (⚡) and, when the
// tool bar has collapsed, the tools menu sit on the right.

const MONITOR_ICON = html`<svg class="crumb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8"></path><path d="M12 16v4"></path></svg>`;
const FOLDER_ICON = html`<svg class="crumb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
const BRANCH_ICON = html`<svg class="crumb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="6" cy="6" r="2.2"></circle><circle cx="6" cy="18" r="2.2"></circle><circle cx="18" cy="8" r="2.2"></circle><path d="M6 8.2v7.6"></path><path d="M18 10.2a6 6 0 0 1-6 6H8.2"></path></svg>`;
const CHAT_ICON = html`<svg class="crumb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-6l-5 4v-4H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z"></path></svg>`;
const SEPARATOR = html`<svg class="crumb-sep" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"></path></svg>`;

export type BreadcrumbMode = "expanded" | "compact";

interface Crumb {
  key: string;
  label: string;
  title: string;
  ariaContext: string;
  icon: TemplateResult;
  section: NavigationSection;
  /** A dashed "pick this next" crumb rather than a selected level. */
  empty: boolean;
}

@customElement("app-context-bar")
export class AppContextBar extends LitElement {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) machine?: Machine;
  @property({ attribute: false }) project?: Project;
  @property({ attribute: false }) workspace?: Workspace;
  @property({ attribute: false }) session?: SessionInfo;
  @property({ attribute: false }) refreshControl: unknown;
  /** Whether the navigation view is currently open (drives the toggle + caret). */
  @property({ attribute: false }) navigationOpen = false;
  @property({ attribute: false }) onOpenSection?: (section: NavigationSection) => void;
  @property({ attribute: false }) onCloseNavigation?: () => void;
  @property({ attribute: false }) onShowActions?: () => void;
  /** Opens the tools sheet. Shown as a menu button only while `showTabsMenuButton`. */
  @property({ attribute: false }) onOpenTabsMenu?: () => void;
  /** When the tool bar is collapsed (nothing pinned), the sheet's menu button lives here. */
  @property({ attribute: false }) showTabsMenuButton = false;
  /** "expanded" shows the full path; "compact" shows just the deepest crumb. */
  @property({ attribute: false }) breadcrumbMode: BreadcrumbMode = "expanded";

  @query(".crumbs") private crumbsElement?: HTMLElement | null;
  @state() private canScrollLeft = false;
  @state() private canScrollRight = false;
  private observedCrumbs: HTMLElement | undefined;
  private crumbsResizeObserver: ResizeObserver | undefined;
  private lastCurrentKey = "";

  override disconnectedCallback(): void {
    this.crumbsResizeObserver?.disconnect();
    this.crumbsResizeObserver = undefined;
    this.observedCrumbs = undefined;
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    this.observeCrumbs();
    this.updateScrollState();
  }

  override updated(): void {
    this.observeCrumbs();
    this.revealCurrentCrumb();
    this.updateScrollState();
  }

  override render() {
    return this.breadcrumbMode === "compact" ? this.renderCompact() : this.renderExpanded();
  }

  private renderExpanded() {
    const machineCrumb = this.machineCrumb();
    const pathCrumbs = this.pathCrumbs();
    const currentIndex = pathCrumbs.length - 1;
    return html`
      <nav class="context-bar" aria-label="Current location">
        ${machineCrumb === undefined ? null : html`${this.renderCrumb(machineCrumb, false)}${SEPARATOR}`}
        <div class=${this.crumbsFrameClass()}>
          <ol class="crumbs" @scroll=${this.onCrumbsScroll}>
            ${pathCrumbs.map((crumb, index) => html`
              <li class="crumb-item">
                ${index === 0 ? nothing : SEPARATOR}
                ${this.renderCrumb(crumb, index === currentIndex)}
              </li>
            `)}
          </ol>
        </div>
        ${this.hasContextActions() ? html`<div class="context-actions">${this.renderTabsMenuButton()}${this.renderActionsButton()}${this.refreshControl}</div>` : null}
      </nav>
    `;
  }

  // Compact: just the deepest crumb ("you are here"), no ancestors or machine
  // chip. Every level stays reachable by opening the navigation from it.
  private renderCompact() {
    const current = this.pathCrumbs().at(-1);
    return html`
      <nav class="context-bar" aria-label="Current location">
        <div class="crumbs-frame">
          <ol class="crumbs">
            <li class="crumb-item">${current === undefined ? null : this.renderCrumb(current, true)}</li>
          </ol>
        </div>
        ${this.hasContextActions() ? html`<div class="context-actions">${this.renderTabsMenuButton()}${this.renderActionsButton()}${this.refreshControl}</div>` : null}
      </nav>
    `;
  }

  private renderCrumb(crumb: Crumb, current: boolean): TemplateResult {
    const classes = ["crumb", ...(current ? ["current"] : []), ...(crumb.empty ? ["empty"] : [])].join(" ");
    const verb = current && this.navigationOpen ? "Close navigation." : "Open navigation.";
    return html`
      <button
        type="button"
        class=${classes}
        title=${crumb.title}
        aria-label=${`${crumb.ariaContext} ${verb}`.trim()}
        aria-expanded=${current ? String(this.navigationOpen) : nothing}
        @click=${() => { this.onCrumbClick(crumb.section, current); }}
      >
        ${crumb.icon}
        <span class="crumb-value">${crumb.label}</span>
        ${current ? html`<svg class=${`crumb-caret${this.navigationOpen ? " open" : ""}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"></path></svg>` : null}
      </button>
    `;
  }

  // Ancestor crumbs jump the navigation to their level. The deepest crumb — the
  // one you're at — toggles the navigation, so it stays the single close point.
  private onCrumbClick(section: NavigationSection, current: boolean): void {
    if (current && this.navigationOpen) this.onCloseNavigation?.();
    else this.onOpenSection?.(section);
  }

  private machineCrumb(): Crumb | undefined {
    if (this.machines.length <= 1) return undefined;
    const label = this.machine === undefined ? "Select machine" : this.machine.name;
    const title = this.machine === undefined ? "No machine selected" : this.machine.baseUrl ?? this.machine.name;
    return { key: this.machine?.id ?? "machine", label, title, ariaContext: `Machine: ${label}.`, icon: MONITOR_ICON, section: "machines", empty: this.machine === undefined };
  }

  // Selected levels become filled crumbs; the first unmet level becomes a single
  // dashed "pick this next" crumb, rather than trailing placeholders for every
  // remaining level.
  private pathCrumbs(): Crumb[] {
    if (this.project === undefined) {
      return [{ key: "project", label: "Select a project", title: "No project selected", ariaContext: "", icon: FOLDER_ICON, section: "projects", empty: true }];
    }
    const crumbs: Crumb[] = [
      { key: `project:${this.project.id}`, label: this.project.name, title: `${this.project.name} — ${this.project.path}`, ariaContext: `Project: ${this.project.name}.`, icon: FOLDER_ICON, section: "projects", empty: false },
    ];
    if (this.workspace === undefined) {
      crumbs.push({ key: "workspace", label: "Select a workspace", title: "No workspace selected", ariaContext: "Choose a workspace.", icon: BRANCH_ICON, section: "workspaces", empty: true });
      return crumbs;
    }
    const workspaceLabel = workspaceButtonLabel(this.workspace);
    crumbs.push({ key: `workspace:${this.workspace.id}`, label: workspaceLabel, title: `${workspaceLabel} — ${this.workspace.path}`, ariaContext: `Workspace: ${workspaceLabel}.`, icon: BRANCH_ICON, section: "workspaces", empty: false });
    if (this.session === undefined) {
      crumbs.push({ key: "session", label: "Open a session", title: "No session selected", ariaContext: "Open a session.", icon: CHAT_ICON, section: "sessions", empty: true });
      return crumbs;
    }
    const sessionLabel = sessionContextLabel(this.session);
    crumbs.push({ key: `session:${this.session.id}`, label: sessionLabel, title: this.session.path, ariaContext: `Session: ${sessionLabel}.`, icon: CHAT_ICON, section: "sessions", empty: false });
    return crumbs;
  }

  private renderTabsMenuButton() {
    if (!this.showTabsMenuButton || this.onOpenTabsMenu === undefined) return null;
    return html`
      <button type="button" class="context-action-button" title="Tools" aria-label="Tools" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onOpenTabsMenu?.(); }}>
        <svg class="context-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.6"></rect>
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.6"></rect>
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.6"></rect>
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.6"></rect>
        </svg>
      </button>
    `;
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
    return this.refreshControl !== undefined || this.onShowActions !== undefined || (this.showTabsMenuButton && this.onOpenTabsMenu !== undefined);
  }

  private crumbsFrameClass(): string {
    return `crumbs-frame${this.canScrollLeft ? " can-scroll-left" : ""}${this.canScrollRight ? " can-scroll-right" : ""}`;
  }

  // Bring the deepest crumb into view whenever the location changes, so the place
  // you just landed reads first; the machine crumb stays pinned to its left.
  private revealCurrentCrumb(): void {
    const crumbs = this.crumbsElement;
    if (!(crumbs instanceof HTMLElement)) return;
    const currentKey = this.pathCrumbs().at(-1)?.key ?? "";
    if (currentKey === this.lastCurrentKey) return;
    this.lastCurrentKey = currentKey;
    const current = crumbs.querySelector<HTMLElement>(".crumb.current");
    // When the current crumb fits, rest it against the right edge with as many
    // ancestors visible as fit. When it is wider than the frame, align its start
    // instead so a long label reads from the beginning rather than clipped mid-word.
    if (current === null || current.getBoundingClientRect().width <= crumbs.clientWidth) {
      crumbs.scrollLeft = crumbs.scrollWidth;
      return;
    }
    crumbs.scrollLeft += current.getBoundingClientRect().left - crumbs.getBoundingClientRect().left;
  }

  private observeCrumbs(): void {
    const crumbs = this.crumbsElement instanceof HTMLElement ? this.crumbsElement : undefined;
    if (this.observedCrumbs === crumbs) return;
    this.crumbsResizeObserver?.disconnect();
    this.observedCrumbs = crumbs;
    this.crumbsResizeObserver = undefined;
    if (crumbs === undefined || typeof ResizeObserver === "undefined") return;
    this.crumbsResizeObserver = new ResizeObserver(() => { this.updateScrollState(); });
    this.crumbsResizeObserver.observe(crumbs);
  }

  private updateScrollState(): void {
    const crumbs = this.crumbsElement instanceof HTMLElement ? this.crumbsElement : undefined;
    const maxScrollLeft = crumbs === undefined ? 0 : Math.max(0, crumbs.scrollWidth - crumbs.clientWidth);
    const canScrollLeft = crumbs !== undefined && crumbs.scrollLeft > 1;
    const canScrollRight = crumbs !== undefined && maxScrollLeft - crumbs.scrollLeft > 1;
    if (this.canScrollLeft !== canScrollLeft) this.canScrollLeft = canScrollLeft;
    if (this.canScrollRight !== canScrollRight) this.canScrollRight = canScrollRight;
  }

  private readonly onCrumbsScroll = () => { this.updateScrollState(); };

  static override styles = css`
    /* Keep any menu opened from the actions button above the content below. */
    :host { position: relative; z-index: 20; flex: 0 0 auto; min-width: 0; }
    .context-bar { display: flex; align-items: center; gap: 4px; min-height: 52px; min-width: 0; padding: 4px 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }

    /* The scrollable path, with soft edge fades when there is more to see. */
    .crumbs-frame { position: relative; flex: 1 1 auto; min-width: 0; }
    .crumbs-frame::before, .crumbs-frame::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 22px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
    .crumbs-frame::before { left: 0; background: linear-gradient(90deg, var(--pi-bg), transparent); }
    .crumbs-frame::after { right: 0; background: linear-gradient(270deg, var(--pi-bg), transparent); }
    .crumbs-frame.can-scroll-left::before, .crumbs-frame.can-scroll-right::after { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .crumbs-frame::before, .crumbs-frame::after { transition: none; } }
    .crumbs { display: flex; align-items: center; gap: 2px; margin: 0; padding: 0; list-style: none; min-width: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none; }
    .crumbs::-webkit-scrollbar { display: none; }
    .crumb-item { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 2px; min-width: 0; }

    .crumb { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--pi-muted); font: inherit; font-size: 14px; line-height: 1.2; text-align: left; padding: 6px 8px; cursor: pointer; white-space: nowrap; }
    .crumb:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .crumb:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .crumb-icon { flex: 0 0 auto; width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .crumb-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* The current level reads as "you are here": a filled pill, stronger text,
       an accent icon and the toggle caret. */
    .crumb.current { max-width: min(58vw, 320px); color: var(--pi-text); font-weight: 600; background: var(--pi-surface); border-color: var(--pi-border-muted); }
    .crumb.current .crumb-icon { color: var(--pi-accent); }
    .crumb.empty { color: var(--pi-muted); font-weight: 500; border-style: dashed; border-color: var(--pi-border); background: transparent; }
    .crumb-caret { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: var(--pi-dim); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; transition: transform .15s ease; }
    .crumb-caret.open { transform: rotate(180deg); }
    @media (prefers-reduced-motion: reduce) { .crumb-caret { transition: none; } }

    /* The machine crumb is pinned (never scrolls) and accent-tinted, so the
       federation anchor is always in view. */
    .context-bar > .crumb { flex: 0 0 auto; max-width: 34vw; color: var(--pi-accent); background: color-mix(in srgb, var(--pi-accent) 12%, transparent); border-color: color-mix(in srgb, var(--pi-accent) 26%, transparent); }
    .context-bar > .crumb .crumb-icon { color: var(--pi-accent); }
    .context-bar > .crumb:hover { background: color-mix(in srgb, var(--pi-accent) 18%, transparent); color: var(--pi-accent); }
    .context-bar > .crumb.empty { color: var(--pi-muted); background: transparent; border-style: dashed; border-color: var(--pi-border); }
    .context-bar > .crumb-sep { flex: 0 0 auto; }

    .crumb-sep { flex: 0 0 auto; width: 15px; height: 15px; fill: none; stroke: var(--pi-dim); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: .8; pointer-events: none; }

    .context-actions { flex: 0 0 auto; margin-left: auto; display: flex; align-items: center; gap: 6px; padding-left: 2px; }
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
