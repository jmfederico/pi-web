import type { ReactiveController, ReactiveControllerHost } from "lit";

export type NavigationSection = "machines" | "projects" | "workspaces" | "sessions";
export type ExpandedNavigationSection = NavigationSection | "none" | undefined;

export interface NavigationSelectionState {
  selectedProject: object | undefined;
  selectedWorkspace: object | undefined;
}

export function defaultNavigationSection(state: NavigationSelectionState): NavigationSection {
  if (state.selectedProject === undefined) return "projects";
  if (state.selectedWorkspace === undefined) return "workspaces";
  return "sessions";
}

export function expandedNavigationSection(expanded: ExpandedNavigationSection, state: NavigationSelectionState): NavigationSection | undefined {
  if (expanded === "none") return undefined;
  return expanded ?? defaultNavigationSection(state);
}

export function isNavigationSectionCollapsed(section: NavigationSection, options: { isMobileLayout: boolean; expanded: ExpandedNavigationSection; state: NavigationSelectionState }): boolean {
  return options.isMobileLayout && expandedNavigationSection(options.expanded, options.state) !== section;
}

export function toggleNavigationSection(expanded: ExpandedNavigationSection, section: NavigationSection, options: { isMobileLayout: boolean; state: NavigationSelectionState }): ExpandedNavigationSection {
  if (!options.isMobileLayout) return expanded;
  return expandedNavigationSection(expanded, options.state) === section ? "none" : section;
}

export function expandNavigationSection(expanded: ExpandedNavigationSection, section: NavigationSection, isMobileLayout: boolean): ExpandedNavigationSection {
  return isMobileLayout ? section : expanded;
}

export class MobileNavigationController implements ReactiveController {
  private expanded: ExpandedNavigationSection;

  hostConnected(): void {
    return;
  }

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getState: () => NavigationSelectionState,
    private readonly isMobileLayout: () => boolean,
  ) {
    host.addController(this);
  }

  expandedSection(): NavigationSection | undefined {
    return expandedNavigationSection(this.expanded, this.getState());
  }

  isCollapsed(section: NavigationSection): boolean {
    return isNavigationSectionCollapsed(section, {
      isMobileLayout: this.isMobileLayout(),
      expanded: this.expanded,
      state: this.getState(),
    });
  }

  toggle(section: NavigationSection): void {
    this.setExpanded(toggleNavigationSection(this.expanded, section, { isMobileLayout: this.isMobileLayout(), state: this.getState() }));
  }

  expand(section: NavigationSection): void {
    this.setExpanded(expandNavigationSection(this.expanded, section, this.isMobileLayout()));
  }

  open(section: NavigationSection, openNavigationView: () => void): void {
    if (!this.isMobileLayout()) return;
    this.expand(section);
    openNavigationView();
  }

  private setExpanded(expanded: ExpandedNavigationSection): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.host.requestUpdate();
  }
}
