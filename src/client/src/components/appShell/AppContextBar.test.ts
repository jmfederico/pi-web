// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Project, SessionInfo, Workspace } from "../../api";
import type { NavigationSection } from "../../appShell/navigationState";
import { AppContextBar } from "./AppContextBar";

afterEach(() => {
  document.body.replaceChildren();
});

describe("app-context-bar", () => {
  it("shows the selected session and opens the sessions nav", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ project: project(), workspace: workspace(), session: session("Fix the bug"), onOpenSection: (section) => opened.push(section) });

    expect(label(bar)).toBe("Fix the bug");
    contextButton(bar).click();
    expect(opened).toEqual(["sessions"]);
  });

  it("falls back to the workspace label without its path when no session is selected", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ project: project(), workspace: workspace({ label: "feature", isMain: false, path: "/repo/feature" }), onOpenSection: (section) => opened.push(section) });

    expect(label(bar)).toBe("feature");
    expect(label(bar)).not.toContain("/repo");
    contextButton(bar).click();
    expect(opened).toEqual(["sessions"]);
  });

  it("shows the project and opens the workspaces nav when no workspace is selected", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ project: project({ name: "acme" }), onOpenSection: (section) => opened.push(section) });

    expect(label(bar)).toBe("acme");
    contextButton(bar).click();
    expect(opened).toEqual(["workspaces"]);
  });

  it("prompts to select a project and opens the projects nav when nothing is selected", async () => {
    const opened: NavigationSection[] = [];
    const bar = await mount({ onOpenSection: (section) => opened.push(section) });

    expect(label(bar)).toBe("Select a project");
    contextButton(bar).click();
    expect(opened).toEqual(["projects"]);
  });

  it("renders the actions button only when onShowActions is provided", async () => {
    let shown = 0;
    const withActions = await mount({ project: project(), onShowActions: () => { shown += 1; } });
    const button = withActions.shadowRoot?.querySelector<HTMLButtonElement>(".context-action-button");
    expect(button).not.toBeNull();
    button?.click();
    expect(shown).toBe(1);

    const withoutActions = await mount({ project: project() });
    expect(withoutActions.shadowRoot?.querySelector(".context-action-button")).toBeNull();
  });
});

interface Props {
  project?: Project;
  workspace?: Workspace;
  session?: SessionInfo;
  onOpenSection?: (section: NavigationSection) => void;
  onShowActions?: () => void;
}

async function mount(props: Props): Promise<AppContextBar> {
  const bar = new AppContextBar();
  if (props.project !== undefined) bar.project = props.project;
  if (props.workspace !== undefined) bar.workspace = props.workspace;
  if (props.session !== undefined) bar.session = props.session;
  if (props.onOpenSection !== undefined) bar.onOpenSection = props.onOpenSection;
  if (props.onShowActions !== undefined) bar.onShowActions = props.onShowActions;
  document.body.append(bar);
  await bar.updateComplete;
  return bar;
}

function contextButton(bar: AppContextBar): HTMLButtonElement {
  const button = bar.shadowRoot?.querySelector<HTMLButtonElement>(".context-button");
  if (button === null || button === undefined) throw new Error("Expected a context button");
  return button;
}

function label(bar: AppContextBar): string {
  const value = bar.shadowRoot?.querySelector(".context-value");
  return (value?.textContent ?? "").trim();
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
