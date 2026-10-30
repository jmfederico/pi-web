// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installPopoverFake } from "../anchoredPopup.testSupport";
installPopoverFake();
import { trustApi, type Machine, type Project, type SessionInfo, type Workspace } from "../../api";
import type { MachineStatusSnapshot } from "../../../../shared/machineStatus";
import { machineStatusSnapshot } from "../../machineStatus.testSupport";
import { MachineList } from "../MachineList";
import { MachineSwitcher } from "../MachineSwitcher";
import { ProjectList } from "../ProjectList";
import { WorkspaceList } from "../WorkspaceList";
import { SessionList } from "../SessionList";
import { AppNavigationPanel, shouldShowMachinesSection } from "./AppNavigationPanel";
import type { NavigationSectionResizeHandle } from "./NavigationSectionResizeHandle";
import { NAVIGATION_SECTION_SIZE_STORAGE_KEY } from "../../appShell/navigationSectionResizeController";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shouldShowMachinesSection", () => {
  it("hides machine navigation when there is no machine choice", () => {
    expect(shouldShowMachinesSection([])).toBe(false);
    expect(shouldShowMachinesSection([machine("local")])).toBe(false);
  });

  it("shows machine navigation when there are multiple machines", () => {
    expect(shouldShowMachinesSection([machine("local"), machine("remote-a")])).toBe(true);
  });
});

describe("folder workspace navigation", () => {
  it.each([false, true])("skips hidden workspace controls in both keyboard directions (compact=%s)", async (compact) => {
    const panel = await mountPanel({}, machine("local"));
    panel.compact = compact;
    panel.workspaceSelectionVisible = false;
    panel.sessions = [session("root")];
    panel.onFocusNavigationTarget = vi.fn();
    await panel.updateComplete;
    const projects = section(panel, "project-list", ProjectList);
    const sessions = section(panel, "session-list", SessionList);
    await Promise.all([projects.updateComplete, sessions.updateComplete]);

    expect(panel.shadowRoot?.querySelector("workspace-list")).toBeNull();
    expect(await panel.focusSection("workspaces")).toBe(false);
    control(projects, ".action-row").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(panel.onFocusNavigationTarget).toHaveBeenLastCalledWith("sessions");
    control(sessions, ".action-row").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(panel.onFocusNavigationTarget).toHaveBeenLastCalledWith("projects");
  });
});

describe("section resize boundaries", () => {
  it("disables resizing in one-column navigation without discarding saved desktop heights", async () => {
    const saved = JSON.stringify({ version: 1, projects: 180, workspaces: 220 });
    localStorage.setItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY, saved);
    const panel = await mountPanel({}, machine("local"), false);
    const root = panel.shadowRoot;
    if (root === null) throw new Error("Missing navigation panel root");
    expect(root.querySelectorAll("[data-manual-size]")).toHaveLength(2);
    panel.compact = true;
    await panel.updateComplete;
    expect(root.querySelector("navigation-section-resize-handle")).toBeNull();
    expect(root.querySelector("[data-manual-size]")).toBeNull();
    expect(localStorage.getItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY)).toBe(saved);
    panel.compact = false;
    await panel.updateComplete;
    expect(root.querySelectorAll("navigation-section-resize-handle")).toHaveLength(2);
    expect(root.querySelectorAll("[data-manual-size]")).toHaveLength(2);
    expect(localStorage.getItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY)).toBe(saved);
  });

  it("owns layout observation, supplies measurements, and tracks replaced sections and reconnection", async () => {
    const observers: LayoutObserver[] = [];
    class LayoutObserver implements ResizeObserver {
      readonly targets = new Set<Element>();
      constructor(private readonly callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element): void { this.targets.add(target); }
      unobserve(target: Element): void { this.targets.delete(target); }
      disconnect(): void { this.targets.clear(); }
      notify(): void { this.callback([], this); }
    }
    vi.stubGlobal("ResizeObserver", LayoutObserver);
    const panel = await mountPanel({}, machine("local"), false);
    const observer = observers.find((item) => item.targets.has(panel));
    if (observer === undefined) throw new Error("Panel did not observe its layout");
    const projects = section(panel, "project-list", ProjectList);
    const workspaces = section(panel, "workspace-list", WorkspaceList);
    const sessions = section(panel, "session-list", SessionList);
    // Geometry is an injected browser boundary here, not a happy-dom layout assertion.
    vi.spyOn(projects, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 120));
    vi.spyOn(workspaces, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 80));
    vi.spyOn(sessions, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 300));
    observer.notify();
    await panel.updateComplete;
    const handles = panel.shadowRoot?.querySelectorAll<NavigationSectionResizeHandle>("navigation-section-resize-handle");
    expect(handles?.[0]?.measurement).toEqual({ height: 120, maxHeight: 376 });
    expect(handles?.[1]?.measurement).toEqual({ height: 80, maxHeight: 336 });

    panel.workspaceSelectionVisible = false;
    await panel.updateComplete;
    expect(observer.targets.has(workspaces)).toBe(false);
    panel.workspaceSelectionVisible = true;
    await panel.updateComplete;
    const replacement = section(panel, "workspace-list", WorkspaceList);
    expect(replacement).not.toBe(workspaces);
    expect(observer.targets.has(replacement)).toBe(true);
    vi.spyOn(replacement, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 140));
    observer.notify();
    await panel.updateComplete;
    const workspaceHandle = panel.shadowRoot?.querySelectorAll<NavigationSectionResizeHandle>("navigation-section-resize-handle")[1];
    expect(workspaceHandle?.measurement).toEqual({ height: 140, maxHeight: 396 });

    panel.remove();
    expect(observer.targets.size).toBe(0);
    document.body.append(panel);
    await panel.updateComplete;
    const reconnected = observers.find((item) => item.targets.has(panel));
    expect(reconnected).toBeDefined();
    expect(reconnected).not.toBe(observer);
  });

  it("assigns each divider to the expanded section above, including when workspaces are hidden", async () => {
    const panel = await mountPanel({}, machine("local"), false);
    const root = panel.shadowRoot;
    if (root === null) throw new Error("Missing navigation panel root");
    const controls = () => [...root.querySelectorAll<NavigationSectionResizeHandle>("navigation-section-resize-handle")]
      .map((handle) => handle.controls);
    expect(controls()).toEqual(["navigation-projects", "navigation-workspaces"]);

    panel.workspaceSelectionVisible = false;
    await panel.updateComplete;
    expect(controls()).toEqual(["navigation-projects"]);

    panel.workspaceSelectionVisible = true;
    panel.projectsCollapsed = true;
    await panel.updateComplete;
    expect(controls()).toEqual(["navigation-workspaces"]);

    panel.workspacesCollapsed = true;
    await panel.updateComplete;
    expect(controls()).toEqual([]);
  });
});

describe("header identity", () => {
  it("leaves header identity to the machine switcher without a separate brand title", async () => {
    const panel = await mountHeaderPanel([machine("local")]);

    expect(panel.shadowRoot?.querySelector("header")?.textContent).not.toContain("PI WEB");
    expect(panel.shadowRoot?.querySelector("machine-switcher")).toBeInstanceOf(MachineSwitcher);
  });

  it("opens Actions from a named button with a decorative icon and responsive label", async () => {
    const panel = await mountHeaderPanel([machine("local")]);
    panel.onShowActions = vi.fn();
    await panel.updateComplete;
    const button = panel.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Show Actions"]');
    if (!button) throw new Error("Missing Actions button");

    expect(button.title).toBe("Show Actions");
    expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(button.querySelector(".actions-label")?.textContent).toBe("Actions");
    button.click();
    expect(panel.onShowActions).toHaveBeenCalledOnce();
  });

});

describe("machine status wiring", () => {
  it("gives machine sections every snapshot and project and workspace sections the selected machine's", async () => {
    const local = machineStatusSnapshot({ machine: { "core:working": true }, sessions: { "child-1": { "core:working": true } } });
    const remote = machineStatusSnapshot({ machine: { "core:unread": true } });
    const panel = await mountPanel({ local, "remote-a": remote }, machine("local"));

    expect(section(panel, "machine-switcher", MachineSwitcher).statusSnapshots).toEqual({ local, "remote-a": remote });
    expect(section(panel, "machine-list", MachineList).statusSnapshots).toEqual({ local, "remote-a": remote });
    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBe(local);
    expect(section(panel, "workspace-list", WorkspaceList).statusSnapshot).toBe(local);
    expect(section(panel, "session-list", SessionList).sessionFlags).toBe(local.sessions);

    panel.selectedMachine = machine("remote-a");
    await panel.updateComplete;
    expect(section(panel, "session-list", SessionList).sessionFlags).toBe(remote.sessions);
  });

  it("reads the local machine's snapshot before a machine has been selected", async () => {
    // `selectedMachine` is undefined until machines load, and can stay undefined
    // if that load fails, while local project rows already render. The app keys
    // snapshots by `selectedMachine?.id ?? LOCAL_MACHINE_ID`, so this panel must
    // resolve the same id instead of blanking every indicator.
    const local = machineStatusSnapshot({ projects: { "project-1": { "core:working": true } } });
    const panel = await mountPanel({ local }, undefined);

    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBe(local);
    expect(section(panel, "workspace-list", WorkspaceList).statusSnapshot).toBe(local);
  });

  it("leaves project and workspace sections without a snapshot when the selected machine has none", async () => {
    const panel = await mountPanel({ "remote-a": machineStatusSnapshot() }, machine("local"));

    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBeUndefined();
    expect(section(panel, "workspace-list", WorkspaceList).statusSnapshot).toBeUndefined();
    expect(section(panel, "session-list", SessionList).sessionFlags).toBeUndefined();
  });
});

describe("stable list inputs", () => {
  it("forwards Mark as unread through a stable callback to the latest parent handler", async () => {
    const panel = await mountPanel({}, machine("local"));
    const read = session("read");
    const oldMarkUnread = vi.fn();
    panel.sessions = [read];
    panel.onMarkSessionUnread = oldMarkUnread;
    panel.onSelectSession = vi.fn();
    await panel.updateComplete;
    const sessions = section(panel, "session-list", SessionList);
    await sessions.updateComplete;
    const callback = sessions.onMarkUnread;

    const markUnread = vi.fn();
    panel.onMarkSessionUnread = markUnread;
    await panel.updateComplete;
    await sessions.updateComplete;
    expect(sessions.onMarkUnread).toBe(callback);

    control(sessions, ".action-menu-toggle").click();
    await sessions.updateComplete;
    control(sessions, 'button[title="Mark session as unread"]').click();
    await sessions.updateComplete;
    expect(markUnread).toHaveBeenCalledExactlyOnceWith(read);
    expect(oldMarkUnread).not.toHaveBeenCalled();
    expect(panel.onSelectSession).not.toHaveBeenCalled();
    expect(sessions.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
  });


  it("skips unchanged lists on panel updates while invoking the latest callbacks", async () => {
    const panel = await mountPanel({}, machine("local"));
    const currentSession = session("session-1");
    panel.sessions = [currentSession];
    const oldSelect = vi.fn();
    panel.onSelectProject = oldSelect;
    panel.onSelectWorkspace = oldSelect;
    panel.onSelectSession = oldSelect;
    const projects = section(panel, "project-list", ProjectList);
    const workspaces = section(panel, "workspace-list", WorkspaceList);
    const sessions = section(panel, "session-list", SessionList);
    const lists = [projects, workspaces, sessions];
    const settle = async () => {
      await panel.updateComplete;
      await Promise.all(lists.map((list) => list.updateComplete));
    };
    await settle();
    // Render counts are the regression contract, not a proxy for visible output.
    const renders = lists.map((list) => vi.spyOn(list, "render"));
    const panelRender = vi.spyOn(panel, "render");
    panel.selectedMachine = { ...machine("local"), name: "Renamed machine" };
    await settle();
    expect(panelRender).toHaveBeenCalledOnce();
    for (const render of renders) expect(render).not.toHaveBeenCalled();

    const selectProject = vi.fn();
    const selectWorkspace = vi.fn();
    const selectSession = vi.fn();
    const focus = vi.fn();
    panel.onSelectProject = selectProject;
    panel.onSelectWorkspace = selectWorkspace;
    panel.onSelectSession = selectSession;
    panel.onFocusNavigationTarget = focus;
    panel.machines = [machine("local")];
    await settle();
    for (const render of renders) expect(render).not.toHaveBeenCalled();
    for (const list of lists) control(list, ".action-row").click();
    expect(selectProject).toHaveBeenCalledWith(panel.projects[0]);
    expect(selectWorkspace).toHaveBeenCalledWith(panel.workspaces[0]);
    expect(selectSession).toHaveBeenCalledWith(currentSession);
    expect(oldSelect).not.toHaveBeenCalled();

    control(projects, ".action-row").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(focus).not.toHaveBeenCalled();
    panel.machines = [machine("local"), machine("remote-a")];
    await settle();
    control(projects, ".action-row").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(focus).toHaveBeenCalledWith("machines");
  });

  it("still renders changed list data and workspace label providers", async () => {
    const panel = await mountPanel({}, machine("local"));
    const projects = section(panel, "project-list", ProjectList);
    const workspaces = section(panel, "workspace-list", WorkspaceList);
    const sessions = section(panel, "session-list", SessionList);
    await Promise.all([projects.updateComplete, workspaces.updateComplete, sessions.updateComplete]);
    panel.projects = [project("latest-project")];
    panel.workspaces = [workspace("latest-workspace", "latest-project")];
    panel.sessions = [session("latest-session")];
    await panel.updateComplete;
    await Promise.all([projects.updateComplete, workspaces.updateComplete, sessions.updateComplete]);
    expect(projects.shadowRoot?.textContent).toContain("latest-project");
    expect(workspaces.shadowRoot?.textContent).toContain("latest-workspace");
    expect(sessions.shadowRoot?.textContent).toContain("latest-session");

    panel.workspaceLabelItems = (workspace) => [{ type: "text", text: `Label for ${workspace.id}` }];
    await panel.updateComplete;
    await workspaces.updateComplete;
    expect(workspaces.shadowRoot?.textContent).toContain("Label for latest-workspace");
  });
});

describe("navigation order controls", () => {
  it("forwards moves and root-session pins without selecting an item", async () => {
    vi.spyOn(trustApi, "workspaceTrust").mockResolvedValue({ path: "/repo/first", decision: null, trusted: false });
    const panel = await mountPanel({}, machine("local"));
    panel.projects = [project("first"), project("second")];
    panel.workspaces = [workspace("first", "first"), workspace("second", "first")];
    panel.sessions = [session("root")];
    panel.onMoveProject = vi.fn();
    panel.onMoveWorkspace = vi.fn();
    panel.onPinSession = vi.fn();
    panel.onSelectSession = vi.fn();
    await panel.updateComplete;
    const projects = section(panel, "project-list", ProjectList);
    const workspaces = section(panel, "workspace-list", WorkspaceList);
    const sessions = section(panel, "session-list", SessionList);
    await Promise.all([projects.updateComplete, workspaces.updateComplete, sessions.updateComplete]);
    for (const list of [projects, workspaces]) {
      control(list, ".action-menu-toggle").click();
      await list.updateComplete;
      menuButton(list, "Move down").click();
    }
    expect(panel.onMoveProject).toHaveBeenCalledWith(panel.projects[0], 1);
    expect(panel.onMoveWorkspace).toHaveBeenCalledWith(panel.workspaces[0], 1);
    control(sessions, ".action-menu-toggle").click();
    await sessions.updateComplete;
    menuButton(sessions, "Pin session").click();
    expect(panel.onPinSession).toHaveBeenCalledWith(panel.sessions[0]);
    expect(panel.onSelectSession).not.toHaveBeenCalled();

    panel.pinnedRootIds = ["root"];
    await panel.updateComplete;
    await sessions.updateComplete;
    expect(sessions.pinnedRootIds).toEqual(["root"]);
    expect(panel.shadowRoot?.textContent).not.toContain("Saving navigation order");
    expect(panel.shadowRoot?.querySelector(".order-status")).toBeNull();
  });
});

function menuButton(list: ProjectList | WorkspaceList | SessionList, text: string): HTMLButtonElement {
  const button = [...(list.shadowRoot?.querySelectorAll("button") ?? [])].find((item) => item.textContent.trim() === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${text}`);
  return button;
}

function control(list: ProjectList | WorkspaceList | SessionList, selector: string): HTMLElement {
  const element = list.shadowRoot?.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
  return element;
}

function session(id: string): SessionInfo {
  return {
    id, path: `/sessions/${id}.jsonl`, cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z", modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1, firstMessage: id,
  };
}

async function mountPanel(machineStatusSnapshots: Record<string, MachineStatusSnapshot>, selectedMachine: Machine | undefined, compact = true): Promise<AppNavigationPanel> {
  const panel = new AppNavigationPanel();
  panel.compact = compact;
  panel.machines = [machine("local"), machine("remote-a")];
  if (selectedMachine !== undefined) panel.selectedMachine = selectedMachine;
  panel.projects = [project("project-1")];
  panel.workspaces = [workspace("ws-1", "project-1")];
  panel.machineStatusSnapshots = machineStatusSnapshots;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function section<T>(panel: AppNavigationPanel, selector: string, type: abstract new (...args: never) => T): T {
  const element = panel.shadowRoot?.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Expected a ${selector} section`);
  return element;
}

async function mountHeaderPanel(machines: Machine[]): Promise<AppNavigationPanel> {
  const panel = new AppNavigationPanel();
  panel.machines = machines;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}

function workspace(id: string, projectId: string): Workspace {
  return { id, projectId, path: `/repo/${id}`, label: id, isMain: true, effectiveConfig: {} };
}
