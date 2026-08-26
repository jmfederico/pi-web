// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Machine, Project, SessionInfo, Workspace } from "../../api";
import type { NavigationSection } from "../../appShell/navigationState";
import { AppContextBar, type BreadcrumbMode } from "./AppContextBar";

afterEach(() => {
  document.body.replaceChildren();
});

describe("app-context-bar", () => {
  it("shows the selected session as the current crumb and opens the sessions nav", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ project: project(), workspace: workspace(), session: session("Fix the bug"), onOpenSection: (section) => opened.push(section) });

    expect(currentLabel(bar)).toBe("Fix the bug");
    currentCrumb(bar).click();
    expect(opened).toEqual(["sessions"]);
  });

  it("shows selected levels as ancestor crumbs that open their own section", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ project: project({ name: "acme" }), workspace: workspace({ label: "feature", isMain: false, path: "/repo/feature" }), session: session("Fix the bug"), onOpenSection: (section) => opened.push(section) });

    expect(crumbLabels(bar)).toEqual(["acme", "feature", "Fix the bug"]);
    // The workspace ancestor shows its label without the path, and targets workspaces.
    expect(crumbLabels(bar)).not.toContain("/repo/feature");
    crumb(bar, "feature").click();
    expect(opened).toEqual(["workspaces"]);
  });

  it("offers a dashed next-step crumb when a deeper level is unset", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ project: project(), workspace: workspace(), onOpenSection: (section) => opened.push(section) });

    expect(currentLabel(bar)).toBe("Open a session");
    expect(currentCrumb(bar).classList.contains("empty")).toBe(true);
    currentCrumb(bar).click();
    expect(opened).toEqual(["sessions"]);
  });

  it("shows the project and opens the workspaces nav when no workspace is selected", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ project: project({ name: "acme" }), onOpenSection: (section) => opened.push(section) });

    expect(crumbLabels(bar)).toEqual(["acme", "Select a workspace"]);
    currentCrumb(bar).click();
    expect(opened).toEqual(["workspaces"]);
  });

  it("prompts to select a project and opens the projects nav when nothing is selected", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ onOpenSection: (section) => opened.push(section) });

    expect(currentLabel(bar)).toBe("Select a project");
    currentCrumb(bar).click();
    expect(opened).toEqual(["projects"]);
  });

  it("compact mode shows only the deepest crumb and hides the machine chip", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ machines: [machine(), machine({ id: "m2", name: "studio-02" })], machine: machine(), project: project({ name: "acme" }), workspace: workspace({ label: "feature", isMain: false }), session: session("Fix the bug"), breadcrumbMode: "compact", onOpenSection: (section) => opened.push(section) });

    expect(crumbLabels(bar)).toEqual(["Fix the bug"]);
    expect(bar.shadowRoot?.querySelector(".context-bar > .crumb")).toBeNull();
    currentCrumb(bar).click();
    expect(opened).toEqual(["sessions"]);
  });

  it("pins the machine crumb only on a federated gateway", async () => {
    const single = await mount({ machines: [machine()], machine: machine(), project: project() });
    expect(single.shadowRoot?.querySelector(".context-bar > .crumb")).toBeNull();

    const opened: NavigationSection[] = [];
    const federated = await mount({ machines: [machine(), machine({ id: "m2", name: "studio-02" })], machine: machine(), project: project(), onOpenSection: (section) => opened.push(section) });
    const machineCrumb = federated.shadowRoot?.querySelector<HTMLButtonElement>(".context-bar > .crumb");
    expect((machineCrumb?.querySelector(".crumb-value")?.textContent ?? "").trim()).toBe("studio-01");
    machineCrumb?.click();
    expect(opened).toEqual(["machines"]);
  });

  it("closes the navigation instead of reopening it when it is already open", async () => {
    const opened: NavigationSection[] = [];
    let closed = 0;
    const bar = await mount({ project: project(), workspace: workspace(), session: session("Fix the bug"), navigationOpen: true, onOpenSection: (section) => opened.push(section), onCloseNavigation: () => { closed += 1; } });

    expect(currentCrumb(bar).getAttribute("aria-expanded")).toBe("true");
    currentCrumb(bar).click();
    expect(closed).toBe(1);
    expect(opened).toEqual([]);
  });

  it("renders the actions button only when onShowActions is provided", async () => {
    let shown = 0;
    const withActions = await mount({ project: project(), onShowActions: () => { shown += 1; } });
    const button = withActions.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Show Actions"]');
    expect(button).not.toBeNull();
    button?.click();
    expect(shown).toBe(1);

    const withoutActions = await mount({ project: project() });
    expect(withoutActions.shadowRoot?.querySelector('[aria-label="Show Actions"]')).toBeNull();
  });

  it("shows the tools menu button only when the tool bar has collapsed", async () => {
    const withoutButton = await mount({ project: project(), onOpenTabsMenu: () => undefined });
    expect(withoutButton.shadowRoot?.querySelector('[aria-label="Tools"]')).toBeNull();

    let opened = 0;
    const withButton = await mount({ project: project(), showTabsMenuButton: true, onOpenTabsMenu: () => { opened += 1; } });
    const button = withButton.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Tools"]');
    expect(button).not.toBeNull();
    button?.click();
    expect(opened).toBe(1);
  });
});

interface Props {
  machines?: Machine[];
  machine?: Machine;
  project?: Project;
  workspace?: Workspace;
  session?: SessionInfo;
  navigationOpen?: boolean;
  breadcrumbMode?: BreadcrumbMode;
  onOpenSection?: (section: NavigationSection) => void;
  onCloseNavigation?: () => void;
  onShowActions?: () => void;
  onOpenTabsMenu?: () => void;
  showTabsMenuButton?: boolean;
}

async function mount(props: Props): Promise<AppContextBar> {
  const bar = new AppContextBar();
  if (props.machines !== undefined) bar.machines = props.machines;
  if (props.machine !== undefined) bar.machine = props.machine;
  if (props.project !== undefined) bar.project = props.project;
  if (props.workspace !== undefined) bar.workspace = props.workspace;
  if (props.session !== undefined) bar.session = props.session;
  if (props.navigationOpen !== undefined) bar.navigationOpen = props.navigationOpen;
  if (props.breadcrumbMode !== undefined) bar.breadcrumbMode = props.breadcrumbMode;
  if (props.onOpenSection !== undefined) bar.onOpenSection = props.onOpenSection;
  if (props.onCloseNavigation !== undefined) bar.onCloseNavigation = props.onCloseNavigation;
  if (props.onShowActions !== undefined) bar.onShowActions = props.onShowActions;
  if (props.onOpenTabsMenu !== undefined) bar.onOpenTabsMenu = props.onOpenTabsMenu;
  if (props.showTabsMenuButton !== undefined) bar.showTabsMenuButton = props.showTabsMenuButton;
  document.body.append(bar);
  await bar.updateComplete;
  return bar;
}

function pathCrumbButtons(bar: AppContextBar): HTMLButtonElement[] {
  return Array.from(bar.shadowRoot?.querySelectorAll<HTMLButtonElement>(".crumbs .crumb") ?? []);
}

function crumbLabels(bar: AppContextBar): string[] {
  return pathCrumbButtons(bar).map((button) => (button.querySelector(".crumb-value")?.textContent ?? "").trim());
}

function crumb(bar: AppContextBar, label: string): HTMLButtonElement {
  const found = pathCrumbButtons(bar).find((button) => (button.querySelector(".crumb-value")?.textContent ?? "").trim() === label);
  if (found === undefined) throw new Error(`Expected a "${label}" crumb`);
  return found;
}

function currentCrumb(bar: AppContextBar): HTMLButtonElement {
  const button = bar.shadowRoot?.querySelector<HTMLButtonElement>(".crumb.current");
  if (button === null || button === undefined) throw new Error("Expected a current crumb");
  return button;
}

function currentLabel(bar: AppContextBar): string {
  return (currentCrumb(bar).querySelector(".crumb-value")?.textContent ?? "").trim();
}

function machine(patch: Partial<Machine> = {}): Machine {
  return { id: "m1", name: "studio-01", kind: "local", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", ...patch };
}

function project(patch: Partial<Project> = {}): Project {
  return { id: "p", name: "projects", path: "/repo", createdAt: "2026-07-20T00:00:00.000Z", ...patch };
}

function workspace(patch: Partial<Workspace> = {}): Workspace {
  return { id: "w", projectId: "p", path: "/repo", label: "projects", isMain: true, effectiveConfig: {}, ...patch };
}

function session(firstMessage: string): SessionInfo {
  return { id: "s", cwd: "/repo", path: "/repo/s.jsonl", created: "2026-07-20T00:00:00.000Z", modified: "2026-07-20T00:00:00.000Z", messageCount: 1, firstMessage };
}
