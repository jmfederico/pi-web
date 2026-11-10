// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspacesApi, type Project } from "../api";
import * as clipboard from "../clipboard";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { ProjectList } from "./ProjectList";

beforeEach(() => {
  vi.spyOn(workspacesApi, "workspaces").mockResolvedValue([]);
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
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

  it("keeps intervention attention independent from actual work and unread", async () => {
    const first = project("first");
    const list = await mountProjectList([first], machineStatusSnapshot({ projects: { first: { "core:intervention-required": true, "core:working": true, "core:unread": true } } }));
    const row = rowFor(list, "first");
    expect(row.getAttribute("data-activity")).toBe("intervention-required");
    expect(row.getAttribute("data-busy")).toBe("true");
    expect(row.querySelector(".unread-ring .intervention-required")).not.toBeNull();
    list.statusSnapshot = machineStatusSnapshot({ projects: { first: { "core:intervention-required": true } } });
    await list.updateComplete;
    expect(row.getAttribute("data-activity")).toBe("intervention-required");
    expect(row.getAttribute("data-busy")).toBe("false");
    expect(row.querySelector(".unread-ring")).toBeNull();
    expect(row.querySelector(".activity-indicator.intervention-required")?.getAttribute("title")).toBe("Needs input");
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

describe("project path copying", () => {
  it("copies the full path without selecting or reordering the project and keeps the menu open", async () => {
    const write = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValue(true);
    const item = { ...project("a"), path: "/repo/a long path/日本語" };
    const list = await mountProjectList([item, project("b")], undefined);
    list.onSelect = vi.fn();
    list.onReorder = vi.fn();
    await stubRowRects(list);
    rowFor(list, "a").querySelector<HTMLButtonElement>(".action-menu-toggle")?.click();
    await list.updateComplete;
    const path = list.shadowRoot?.querySelector(".workspace-detail-row dd");
    expect(path?.querySelector("bdi")?.textContent).toBe(item.path);
    const button = path?.querySelector<HTMLButtonElement>("button");
    if (!button) throw new Error("Missing path copy action");
    pointer(button, "pointerdown", 120);
    pointer(button, "pointermove", 10);
    pointer(button, "pointerup", 10);
    button.click();
    await vi.waitFor(() => { expect(button.getAttribute("aria-label")).toBe("Copied"); });
    expect(write).toHaveBeenCalledExactlyOnceWith(item.path);
    expect(list.onSelect).not.toHaveBeenCalled();
    expect(list.onReorder).not.toHaveBeenCalled();
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).not.toBeNull();
  });

  it("reports a failed copy and allows retry without closing the menu", async () => {
    const write = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const list = await mountProjectList([project("a")], undefined);
    rowFor(list, "a").querySelector<HTMLButtonElement>(".action-menu-toggle")?.click();
    await list.updateComplete;
    const details = list.shadowRoot?.querySelector(".workspace-menu-details");
    const button = details?.querySelector<HTMLButtonElement>("button");
    if (!button) throw new Error("Missing path copy action");
    button.click();
    await vi.waitFor(() => { expect(details?.querySelector('[role="alert"]')).not.toBeNull(); });
    expect(button.getAttribute("aria-label")).toBe("Copy path");
    button.click();
    await vi.waitFor(() => { expect(details?.querySelector('[role="alert"]')).toBeNull(); });
    expect(write).toHaveBeenCalledTimes(2);
    expect(button.getAttribute("aria-label")).toBe("Copied");
  });
});

describe("project drag reorder", () => {
  it("reports the neighbor a dragged row lands against", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    await stubRowRects(list);

    pointer(rowFor(list, "c"), "pointerdown", 120);
    pointer(rowFor(list, "c"), "pointermove", 10);
    await list.updateComplete;
    expect(rowFor(list, "a").classList.contains("drop-before")).toBe(true);
    pointer(rowFor(list, "c"), "pointerup", 10);

    expect(onReorder).toHaveBeenCalledExactlyOnceWith(projects[2], projects[0], "before");
  });

  it("reports an append when dragged past the last row", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    await stubRowRects(list);

    pointer(rowFor(list, "a"), "pointerdown", 10);
    pointer(rowFor(list, "a"), "pointermove", 200);
    await list.updateComplete;
    expect(rowFor(list, "c").classList.contains("drop-after")).toBe(true);
    pointer(rowFor(list, "a"), "pointerup", 200);

    expect(onReorder).toHaveBeenCalledExactlyOnceWith(projects[0], projects[2], "after");
  });

  it("stays a click until the pointer moves past the threshold", async () => {
    const projects = [project("a"), project("b")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    list.onReorder = onReorder;
    list.onSelect = onSelect;
    await stubRowRects(list);

    pointer(rowFor(list, "b"), "pointerdown", 60);
    pointer(rowFor(list, "b"), "pointermove", 62);
    pointer(rowFor(list, "b"), "pointerup", 62);
    rowFor(list, "b").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(onReorder).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(projects[1]);
  });

  it("swallows the click that ends a drag", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onSelect = vi.fn();
    list.onReorder = vi.fn();
    list.onSelect = onSelect;
    await stubRowRects(list);

    pointer(rowFor(list, "c"), "pointerdown", 120);
    pointer(rowFor(list, "c"), "pointermove", 10);
    pointer(rowFor(list, "c"), "pointerup", 10);
    rowFor(list, "c").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("cancels on Escape without reordering", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    await stubRowRects(list);

    pointer(rowFor(list, "c"), "pointerdown", 120);
    pointer(rowFor(list, "c"), "pointermove", 10);
    rowFor(list, "c").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await list.updateComplete;
    pointer(rowFor(list, "c"), "pointerup", 10);

    expect(onReorder).not.toHaveBeenCalled();
    expect(list.shadowRoot?.querySelector(".action-row.dragging")).toBeNull();
  });

  it("does not start a drag from the row menu button", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    await stubRowRects(list);

    const toggle = rowFor(list, "c").querySelector<HTMLButtonElement>(".action-menu-toggle");
    if (toggle === null) throw new Error("Expected a menu toggle");
    pointer(toggle, "pointerdown", 120);
    pointer(toggle, "pointermove", 10);
    pointer(toggle, "pointerup", 10);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("ignores drags when the parent passes no reorder callback", async () => {
    const list = await mountProjectList([project("a"), project("b")], undefined);
    await stubRowRects(list);

    pointer(rowFor(list, "b"), "pointerdown", 60);
    pointer(rowFor(list, "b"), "pointermove", 10);
    await list.updateComplete;
    pointer(rowFor(list, "b"), "pointerup", 10);

    expect(list.shadowRoot?.querySelector(".action-row.dragging")).toBeNull();
  });
});

function pointer(target: Element, type: string, clientY: number, init: { clientX?: number; pointerType?: string; pointerId?: number; isPrimary?: boolean } = {}): void {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: init.pointerId ?? 1,
    isPrimary: init.isPrimary ?? true,
    button: 0,
    clientY,
    clientX: init.clientX ?? 40,
    pointerType: init.pointerType ?? "mouse",
    bubbles: true,
    composed: true,
  }));
}

describe("project drag ghost", () => {
  it("follows the pointer and is removed when the drag ends", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    list.onReorder = vi.fn();
    await stubRowRects(list);

    pointer(rowFor(list, "c"), "pointerdown", 120);
    pointer(rowFor(list, "c"), "pointermove", 110);
    const ghost = list.shadowRoot?.querySelector<HTMLElement>(".list-drag-preview");
    expect(ghost).not.toBeNull();
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.querySelector(".action-menu")).toBeNull();
    const first = ghost?.style.transform;
    pointer(rowFor(list, "c"), "pointermove", 60);
    expect(ghost?.style.transform).not.toBe(first);
    expect(ghost?.style.transform).toContain("translate");

    pointer(rowFor(list, "c"), "pointerup", 60);
    expect(list.shadowRoot?.querySelector(".list-drag-preview")).toBeNull();
  });

  it("removes the ghost when Escape cancels", async () => {
    const list = await mountProjectList([project("a"), project("b")], undefined);
    list.onReorder = vi.fn();
    await stubRowRects(list);

    pointer(rowFor(list, "b"), "pointerdown", 60);
    pointer(rowFor(list, "b"), "pointermove", 20);
    expect(list.shadowRoot?.querySelector(".list-drag-preview")).not.toBeNull();
    rowFor(list, "b").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(list.shadowRoot?.querySelector(".list-drag-preview")).toBeNull();
  });
});

describe("touch long-press reorder", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it("lifts the row after the press elapses and reorders on release", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    await stubRowRects(list);

    const row = rowFor(list, "c");
    pointer(row, "pointerdown", 120, { pointerType: "touch" });
    await vi.advanceTimersByTimeAsync(400);
    await list.updateComplete;
    expect(row.classList.contains("dragging")).toBe(true);
    expect(list.shadowRoot?.querySelector(".list-drag-preview")).not.toBeNull();

    pointer(row, "pointermove", 10, { pointerType: "touch" });
    pointer(row, "pointerup", 10, { pointerType: "touch" });

    expect(onReorder).toHaveBeenCalledExactlyOnceWith(projects[2], projects[0], "before");
    expect(list.shadowRoot?.querySelector(".list-drag-preview")).toBeNull();
  });

  it("treats movement before the press elapses as scroll intent, not a drag", async () => {
    const list = await mountProjectList([project("a"), project("b"), project("c")], undefined);
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    list.onReorder = onReorder;
    list.onSelect = onSelect;
    await stubRowRects(list);

    const row = rowFor(list, "c");
    pointer(row, "pointerdown", 120, { pointerType: "touch" });
    pointer(row, "pointermove", 140, { pointerType: "touch" });
    await vi.advanceTimersByTimeAsync(400);
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".action-row.dragging")).toBeNull();
    expect(list.shadowRoot?.querySelector(".list-drag-preview")).toBeNull();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("does not lift when the press is released early", async () => {
    const list = await mountProjectList([project("a"), project("b")], undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    await stubRowRects(list);

    const row = rowFor(list, "b");
    pointer(row, "pointerdown", 60, { pointerType: "touch" });
    pointer(row, "pointerup", 60, { pointerType: "touch" });
    await vi.advanceTimersByTimeAsync(400);
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".action-row.dragging")).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("drag cancellation and ownership", () => {
  it("keeps dragging across metadata-only refreshes with unchanged order", async () => {
    const list = await mountProjectList([project("a"), project("b")], undefined);
    list.onReorder = vi.fn();
    await stubRowRects(list);
    pointer(rowFor(list, "b"), "pointerdown", 60);
    pointer(document.body, "pointermove", 10);
    list.projects = list.projects.map((item) => ({ ...item, name: item.name + " refreshed" }));
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".list-drag-preview")).not.toBeNull();
    pointer(document.body, "pointerup", 10);
    expect(list.onReorder).toHaveBeenCalledExactlyOnceWith(list.projects[1], list.projects[0], "before");
  });

  it.each([
    ["collapse", (list: ProjectList) => { list.collapsed = true; }],
    ["machine change", (list: ProjectList) => { list.machineId = "other"; }],
    ["list membership change", (list: ProjectList) => { list.projects = [project("c")]; }],
    ["disconnect", (list: ProjectList) => { list.remove(); }],
    ["window blur", () => { window.dispatchEvent(new Event("blur")); }],
    ["lost capture", (list: ProjectList) => { rowFor(list, "b").dispatchEvent(new PointerEvent("lostpointercapture")); }],
  ])("cancels an active touch drag on %s and releases scroll ownership", async (_reason, cancel) => {
    vi.useFakeTimers();
    try {
      const list = await mountProjectList([project("a"), project("b")], undefined);
      const onReorder = vi.fn();
      list.onReorder = onReorder;
      await stubRowRects(list);
      const row = rowFor(list, "b");
      pointer(row, "pointerdown", 60, { pointerType: "touch" });
      await vi.advanceTimersByTimeAsync(400);
      await list.updateComplete;
      expect(list.shadowRoot?.querySelector(".list-drag-preview")).not.toBeNull();
      const scroll = () => {
        const event = new Event("touchmove", { cancelable: true });
        Object.defineProperty(event, "touches", { value: [{}] });
        document.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(scroll()).toBe(true);
      cancel(list);
      await list.updateComplete;
      expect(scroll()).toBe(false);
      expect(list.shadowRoot?.querySelector(".list-drag-preview")).toBeNull();
      pointer(document.body, "pointerup", 10, { pointerType: "touch" });
      expect(onReorder).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a pending long press when the list is disconnected", async () => {
    vi.useFakeTimers();
    try {
      const list = await mountProjectList([project("a"), project("b")], undefined);
      list.onReorder = vi.fn();
      await stubRowRects(list);
      pointer(rowFor(list, "b"), "pointerdown", 60, { pointerType: "touch" });
      list.remove();
      await vi.advanceTimersByTimeAsync(400);
      expect(list.shadowRoot?.querySelector(".list-drag-preview")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let another pointer finish the owned gesture", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    await stubRowRects(list);
    pointer(rowFor(list, "c"), "pointerdown", 120);
    pointer(document.body, "pointermove", 10);
    pointer(rowFor(list, "b"), "pointerdown", 60, { pointerId: 2, isPrimary: false });
    pointer(document.body, "pointerup", 10, { pointerId: 2, isPrimary: false });
    expect(onReorder).not.toHaveBeenCalled();
    pointer(document.body, "pointerup", 10);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(projects[2], projects[0], "before");
  });

  it("discards a drop outside the list and lets the next keyboard activation select", async () => {
    const list = await mountProjectList([project("a"), project("b")], undefined);
    list.onReorder = vi.fn();
    list.onSelect = vi.fn();
    await stubRowRects(list);
    const row = rowFor(list, "b");
    pointer(row, "pointerdown", 60);
    pointer(document.body, "pointermove", 10);
    pointer(document.body, "pointerup", 10, { clientX: 300 });
    expect(list.onReorder).not.toHaveBeenCalled();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(list.onSelect).toHaveBeenCalledOnce();
  });
});

async function stubRowRects(list: ProjectList): Promise<void> {
  await list.updateComplete;
  const body = list.shadowRoot?.querySelector<HTMLElement>(".list-body");
  if (!body) throw new Error("Missing scroll body");
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 240));
  const rows = [...(list.shadowRoot?.querySelectorAll<HTMLElement>("[data-project-id]") ?? [])];
  rows.forEach((row, index) => {
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 50, 200, 50));
  });
}
