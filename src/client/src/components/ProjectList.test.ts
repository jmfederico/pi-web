// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { ProjectList } from "./ProjectList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("project sidebar styling contract", () => {
  it("adds anatomy hooks to existing elements and keeps menu activation independent", async () => {
    const first = project("first");
    const second = project("second / special");
    const list = await mountProjectList([first, second], undefined);
    list.selected = first;
    list.onSelect = vi.fn();

    await list.updateComplete;

    const root = list.shadowRoot;
    if (root === null) throw new Error("Expected a shadow root");
    const section = root.querySelector("section");
    const row = rowFor(list, second.name);
    expect(section?.getAttribute("data-ui-context")).toBe("projects");
    expect(section?.getAttribute("data-collapsed")).toBe("false");
    expect(section?.querySelector(".ui-nav-list")).not.toBeNull();
    expect(row.matches(".ui-nav-row")).toBe(true);
    expect(row.querySelector(":scope > .ui-nav-row-main")).not.toBeNull();
    expect(row.querySelector(".ui-nav-row-label")).not.toBeNull();
    expect(row.querySelector(".ui-nav-row-meta")).not.toBeNull();
    const actions = row.querySelector(":scope > .ui-nav-row-actions");
    expect(actions?.parentElement).toBe(row);
    const trigger = actions?.querySelector<HTMLButtonElement>(".ui-nav-row-action");
    if (!trigger) throw new Error("Expected a row action");
    expect(trigger.classList.contains("ui-popup-trigger")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    await list.updateComplete;

    const panel = root.getElementById(trigger.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    expect(panel?.matches(".ui-nav-row-menu.ui-menu.ui-popup-panel[popover]")).toBe(true);
    expect(panel?.getAttribute("data-ui-context")).toBe("project-actions");
    expect(trigger.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.id).not.toBe("");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(list.onSelect).not.toHaveBeenCalled();
    expect(list.selected).toBe(first);
    expect(row.getAttribute("data-current")).toBe("false");
    expect(row.hasAttribute("aria-current")).toBe(false);
    trigger.click();
    await list.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".ui-nav-row-menu")).toBeNull();
    const main = row.querySelector<HTMLElement>(".ui-nav-row-main");
    if (main === null) throw new Error("Expected row content");
    main.click();
    expect(list.onSelect).toHaveBeenCalledExactlyOnceWith(second);
  });

  it("refreshes current, activity, busy and unread hooks without replacing the row", async () => {
    const first = project("first");
    const second = project("second");
    const list = await mountProjectList([first, second], undefined);
    const row = rowFor(list, "first");
    expect(row.getAttribute("data-current")).toBe("false");
    expect(row.hasAttribute("aria-current")).toBe(false);
    expect(row.getAttribute("data-activity")).toBe("idle");
    expect(row.getAttribute("data-busy")).toBe("false");
    expect(row.getAttribute("data-unread")).toBe("false");
    list.selected = { ...first };
    list.statusSnapshot = machineStatusSnapshot({ projects: { first: { "core:working": true, "core:unread": true } } });
    await list.updateComplete;
    expect(rowFor(list, "first")).toBe(row);
    expect(row.getAttribute("data-current")).toBe("true");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.getAttribute("data-activity")).toBe("session");
    expect(row.getAttribute("data-busy")).toBe("true");
    expect(row.getAttribute("data-unread")).toBe("true");

    list.selected = second;
    list.statusSnapshot = machineStatusSnapshot({ revision: 2, projects: { first: { "core:terminal": true } } });
    await list.updateComplete;
    expect(row.getAttribute("data-current")).toBe("false");
    expect(row.hasAttribute("aria-current")).toBe(false);
    expect(rowFor(list, "second").getAttribute("aria-current")).toBe("true");
    expect(row.getAttribute("data-activity")).toBe("terminal");
    expect(row.getAttribute("data-busy")).toBe("false");
    expect(row.getAttribute("data-unread")).toBe("false");
    list.statusSnapshot = undefined;
    await list.updateComplete;
    expect(row.getAttribute("data-activity")).toBe("idle");
    expect(row.getAttribute("data-busy")).toBe("false");
  });

  it("exposes collapse hooks on the existing section and toggle", async () => {
    const first = project("first");
    const second = project("second");
    const list = await mountProjectList([first, second], undefined);
    list.collapsible = true;
    list.onToggleCollapsed = vi.fn(() => { list.collapsed = !list.collapsed; });
    await list.updateComplete;
    const section = list.shadowRoot?.querySelector("section");
    const toggle = section?.querySelector<HTMLButtonElement>(".ui-nav-section-toggle");
    if (!section || !toggle) throw new Error("Expected a collapsible section");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    await list.updateComplete;
    expect(list.onToggleCollapsed).toHaveBeenCalledTimes(1);
    expect(section.getAttribute("data-collapsed")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(section.querySelector(".ui-nav-list")).toBeNull();
    toggle.click();
    await list.updateComplete;
    expect(section.getAttribute("data-collapsed")).toBe("false");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(section.querySelectorAll(".ui-nav-list > .ui-nav-row")).toHaveLength(2);
  });
});

describe("project move actions", () => {
  it.each([0, 1, 2])("disables only boundary moves for row %i in parent order", async (index) => {
    const projects = [project("z"), project("a"), project("m")];
    const item = projects[index];
    if (item === undefined) throw new Error("Expected a project");
    const list = await mountProjectList(projects, undefined);
    const onMove = vi.fn();
    list.onMove = onMove;
    openMenu(list, item.name);
    await list.updateComplete;

    const up = moveButton(list, "Move up");
    const down = moveButton(list, "Move down");
    expect(up.disabled).toBe(index === 0);
    expect(down.disabled).toBe(index === 2);
    (index === 0 ? up : index === 2 ? down : undefined)?.click();
    expect(onMove).not.toHaveBeenCalled();
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).not.toBeNull();
  });

  it("disables both directions for a single project", async () => {
    const list = await mountProjectList([project("only")], undefined);
    list.onMove = vi.fn();
    openMenu(list, "only");
    await list.updateComplete;
    expect(moveButton(list, "Move up").disabled).toBe(true);
    expect(moveButton(list, "Move down").disabled).toBe(true);
  });

  it.each([-1, 1] as const)("keeps the menu open for repeated moves with direction %i without selecting", async (direction) => {
    const projects: [Project, Project, Project] = [project("z"), project("a"), project("m")];
    const list = await mountProjectList(projects, undefined);
    const onSelect = vi.fn();
    const onMove = vi.fn((item: Project, delta: -1 | 1) => {
      const reordered = [...list.projects];
      const index = reordered.indexOf(item);
      reordered.splice(index, 1);
      reordered.splice(index + delta, 0, item);
      list.projects = reordered;
    });
    list.onSelect = onSelect;
    list.onMove = onMove;
    list.selected = projects[0];
    const row = rowFor(list, "a");
    openMenu(list, "a");
    await list.updateComplete;
    const action = moveButton(list, direction === -1 ? "Move up" : "Move down");
    action.focus();
    action.click();
    await list.updateComplete;

    expect(onMove).toHaveBeenCalledExactlyOnceWith(projects[1], direction);
    expect(onSelect).not.toHaveBeenCalled();
    expect(list.selected).toBe(projects[0]);
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).not.toBeNull();
    expect(rowFor(list, "a")).toBe(row);
    expect([...(list.shadowRoot?.querySelectorAll(".action-row") ?? [])].indexOf(row)).toBe(1 + direction);
    expect(action.disabled).toBe(true);
    const reverse = moveButton(list, direction === -1 ? "Move down" : "Move up");
    expect(list.shadowRoot?.activeElement).toBe(reverse);
    reverse.click();
    await list.updateComplete;
    expect(onMove).toHaveBeenLastCalledWith(projects[1], -direction);
    expect(list.projects).toEqual(projects);
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).not.toBeNull();
    expect(action.disabled).toBe(false);
    document.body.click();
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
  });

  it("leaves ordering unchanged when the parent only receives the callback", async () => {
    const projects = [project("z"), project("a")];
    const list = await mountProjectList(projects, undefined);
    list.onMove = vi.fn();
    openMenu(list, "z");
    await list.updateComplete;
    moveButton(list, "Move down").click();
    await list.updateComplete;
    expect(list.projects).toBe(projects);
    expect(list.projects.map((item) => item.id)).toEqual(["z", "a"]);
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).not.toBeNull();
  });
});

function openMenu(list: ProjectList, name: string): void {
  const toggle = rowFor(list, name).querySelector<HTMLButtonElement>(".action-menu-toggle");
  if (toggle === null) throw new Error(`Expected a menu toggle for ${name}`);
  toggle.click();
}

function moveButton(list: ProjectList, label: string): HTMLButtonElement {
  const button = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-panel button") ?? [])]
    .find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Expected ${label}`);
  return button;
}

describe("project status indicator", () => {
  it("shows an unread dot only on projects the snapshot reports as unread", async () => {
    const list = await mountProjectList(
      [project("project-a"), project("project-b")],
      machineStatusSnapshot({ projects: { "project-b": { "core:unread": true } } }),
    );

    expect(unreadDot(rowFor(list, "project-a"))).toBeNull();
    const dot = unreadDot(rowFor(list, "project-b"));
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("title")).toBe("Unread sessions in this project");
  });

  it("clears the dot once a newer snapshot reports nothing unread", async () => {
    const list = await mountProjectList([project("project-a")], machineStatusSnapshot({ projects: { "project-a": { "core:unread": true } } }));
    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).not.toBeNull();

    list.statusSnapshot = machineStatusSnapshot({ revision: 2 });
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("wraps the work dot in an unread ring when the project is busy and unread", async () => {
    const list = await mountProjectList(
      [project("project-a")],
      machineStatusSnapshot({ projects: { "project-a": { "core:working": true, "core:unread": true } } }),
    );

    const row = rowFor(list, "project-a");
    const ring = row.querySelector(".unread-ring");
    expect(ring?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(ring?.getAttribute("title")).toBe("Unread sessions in this project · Project active");
    expect(row.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("lights a project whose workspaces have never been opened, for work and for unread", async () => {
    // The row reads the server-attributed snapshot, so it no longer depends on
    // the browser having loaded that project's workspaces.
    const list = await mountProjectList(
      [project("unvisited-work"), project("unvisited-unread")],
      machineStatusSnapshot({
        projects: { "unvisited-work": { "core:working": true }, "unvisited-unread": { "core:unread": true } },
      }),
    );

    expect(rowFor(list, "unvisited-work").querySelector(".activity-indicator.session")).not.toBeNull();
    expect(unreadDot(rowFor(list, "unvisited-unread"))).not.toBeNull();
  });

  it("shows no indicator when the machine publishes no snapshot", async () => {
    const list = await mountProjectList([project("project-a")], undefined);

    expect(rowFor(list, "project-a").querySelector(".activity-indicator")).toBeNull();
  });

  it("still lights a row from a flag id this build does not know", async () => {
    const list = await mountProjectList([project("project-a")], machineStatusSnapshot({ projects: { "project-a": { "core:future": true } } }));

    expect(rowFor(list, "project-a").querySelector(".activity-indicator.session")).not.toBeNull();
  });
});

async function mountProjectList(projects: Project[], statusSnapshot: MachineStatusSnapshot | undefined): Promise<ProjectList> {
  const list = new ProjectList();
  list.projects = projects;
  list.statusSnapshot = statusSnapshot;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function rowFor(list: ProjectList, projectName: string): Element {
  const rows = [...(list.shadowRoot?.querySelectorAll(".action-row") ?? [])];
  const row = rows.find((candidate) => candidate.textContent.includes(projectName));
  if (row === undefined) throw new Error(`Expected a project row for ${projectName}`);
  return row;
}

function unreadDot(row: Element): Element | null {
  return row.querySelector(".activity-indicator.unread");
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}
