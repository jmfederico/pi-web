import type { ReactiveController, ReactiveControllerHost } from "lit";

export const NAVIGATION_SECTION_ORDER = ["machines", "projects", "workspaces", "scheduledTasks", "sessions"] as const;
export type NavigationSection = (typeof NAVIGATION_SECTION_ORDER)[number];
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

export function isNavigationSectionCollapsed(section: NavigationSection, options: { isMobileLayout: boolean; expanded: ExpandedNavigationSection; state: NavigationSelectionState; collapsedSections?: readonly NavigationSection[] | undefined }): boolean {
  if (options.isMobileLayout) return expandedNavigationSection(options.expanded, options.state) !== section;
  return options.collapsedSections?.includes(section) ?? false;
}

export function toggleNavigationSection(expanded: ExpandedNavigationSection, section: NavigationSection, options: { isMobileLayout: boolean; state: NavigationSelectionState }): ExpandedNavigationSection {
  if (!options.isMobileLayout) return expanded;
  return expandedNavigationSection(expanded, options.state) === section ? "none" : section;
}

export function expandNavigationSection(expanded: ExpandedNavigationSection, section: NavigationSection, isMobileLayout: boolean): ExpandedNavigationSection {
  return isMobileLayout ? section : expanded;
}

export function toggleCollapsedNavigationSection(collapsedSections: readonly NavigationSection[], section: NavigationSection): NavigationSection[] {
  const collapsed = new Set(collapsedSections);
  if (collapsed.has(section)) collapsed.delete(section);
  else collapsed.add(section);
  return orderedNavigationSections(collapsed);
}

export function nextNavigationSection(section: NavigationSection): NavigationSection | undefined {
  return NAVIGATION_SECTION_ORDER[NAVIGATION_SECTION_ORDER.indexOf(section) + 1];
}

export class NavigationSectionsController implements ReactiveController {
  private expanded: ExpandedNavigationSection;
  private collapsedSections: readonly NavigationSection[] = [];

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
      collapsedSections: this.collapsedSections,
    });
  }

  toggle(section: NavigationSection): void {
    if (this.isMobileLayout()) {
      this.setExpanded(toggleNavigationSection(this.expanded, section, { isMobileLayout: true, state: this.getState() }));
      return;
    }
    this.setCollapsedSections(toggleCollapsedNavigationSection(this.collapsedSections, section));
  }

  expand(section: NavigationSection): void {
    if (this.isMobileLayout()) {
      this.setExpanded(expandNavigationSection(this.expanded, section, true));
      return;
    }
    this.setCollapsedSections(this.collapsedSections.filter((collapsedSection) => collapsedSection !== section));
  }

  advanceAfterSelection(section: NavigationSection): void {
    if (!this.isMobileLayout()) return;
    const next = nextNavigationSection(section);
    if (next !== undefined) this.expand(next);
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

  private setCollapsedSections(collapsedSections: readonly NavigationSection[]): void {
    if (navigationSectionListsEqual(this.collapsedSections, collapsedSections)) return;
    this.collapsedSections = collapsedSections;
    this.host.requestUpdate();
  }
}

function orderedNavigationSections(sections: Iterable<NavigationSection>): NavigationSection[] {
  const sectionSet = new Set(sections);
  return NAVIGATION_SECTION_ORDER.filter((section) => sectionSet.has(section));
}

function navigationSectionListsEqual(first: readonly NavigationSection[], second: readonly NavigationSection[]): boolean {
  return first.length === second.length && first.every((section, index) => section === second[index]);
}
