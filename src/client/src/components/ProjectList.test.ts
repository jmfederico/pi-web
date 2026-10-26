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

describe("project drag reorder", () => {
  it("reports the neighbor a dragged row lands against", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    stubRowRects(list);

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
    stubRowRects(list);

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
    stubRowRects(list);

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
    stubRowRects(list);

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
    stubRowRects(list);

    pointer(rowFor(list, "c"), "pointerdown", 120);
    pointer(rowFor(list, "c"), "pointermove", 10);
    rowFor(list, "c").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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
    stubRowRects(list);

    const toggle = rowFor(list, "c").querySelector<HTMLButtonElement>(".action-menu-toggle");
    if (toggle === null) throw new Error("Expected a menu toggle");
    pointer(toggle, "pointerdown", 120);
    pointer(toggle, "pointermove", 10);
    pointer(toggle, "pointerup", 10);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("ignores drags when the parent passes no reorder callback", async () => {
    const list = await mountProjectList([project("a"), project("b")], undefined);
    stubRowRects(list);

    pointer(rowFor(list, "b"), "pointerdown", 60);
    pointer(rowFor(list, "b"), "pointermove", 10);
    await list.updateComplete;
    pointer(rowFor(list, "b"), "pointerup", 10);

    expect(list.shadowRoot?.querySelector(".action-row.dragging")).toBeNull();
  });
});

function pointer(target: Element, type: string, clientY: number, init: { clientX?: number; pointerType?: string } = {}): void {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: 1,
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
    stubRowRects(list);

    pointer(rowFor(list, "c"), "pointerdown", 120);
    pointer(rowFor(list, "c"), "pointermove", 110);
    const ghost = document.body.querySelector<HTMLElement>(".pi-drag-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.querySelector(".action-menu")).toBeNull();
    const first = ghost?.style.transform;
    pointer(rowFor(list, "c"), "pointermove", 60);
    expect(ghost?.style.transform).not.toBe(first);
    expect(ghost?.style.transform).toContain("translate");

    pointer(rowFor(list, "c"), "pointerup", 60);
    expect(document.body.querySelector(".pi-drag-ghost")).toBeNull();
  });

  it("removes the ghost when Escape cancels", async () => {
    const list = await mountProjectList([project("a"), project("b")], undefined);
    list.onReorder = vi.fn();
    stubRowRects(list);

    pointer(rowFor(list, "b"), "pointerdown", 60);
    pointer(rowFor(list, "b"), "pointermove", 20);
    expect(document.body.querySelector(".pi-drag-ghost")).not.toBeNull();
    rowFor(list, "b").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.body.querySelector(".pi-drag-ghost")).toBeNull();
  });
});

describe("touch long-press reorder", () => {
  it("lifts the row after the press elapses and reorders on release", async () => {
    const projects = [project("a"), project("b"), project("c")];
    const list = await mountProjectList(projects, undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    stubRowRects(list);

    const row = rowFor(list, "c");
    pointer(row, "pointerdown", 120, { pointerType: "touch" });
    await wait(400);
    await list.updateComplete;
    expect(row.classList.contains("dragging")).toBe(true);
    expect(document.body.querySelector(".pi-drag-ghost")).not.toBeNull();

    pointer(row, "pointermove", 10, { pointerType: "touch" });
    pointer(row, "pointerup", 10, { pointerType: "touch" });

    expect(onReorder).toHaveBeenCalledExactlyOnceWith(projects[2], projects[0], "before");
    expect(document.body.querySelector(".pi-drag-ghost")).toBeNull();
  });

  it("treats movement before the press elapses as scroll intent, not a drag", async () => {
    const list = await mountProjectList([project("a"), project("b"), project("c")], undefined);
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    list.onReorder = onReorder;
    list.onSelect = onSelect;
    stubRowRects(list);

    const row = rowFor(list, "c");
    pointer(row, "pointerdown", 120, { pointerType: "touch" });
    pointer(row, "pointermove", 140, { pointerType: "touch" });
    await wait(400);
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".action-row.dragging")).toBeNull();
    expect(document.body.querySelector(".pi-drag-ghost")).toBeNull();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("does not lift when the press is released early", async () => {
    const list = await mountProjectList([project("a"), project("b")], undefined);
    const onReorder = vi.fn();
    list.onReorder = onReorder;
    stubRowRects(list);

    const row = rowFor(list, "b");
    pointer(row, "pointerdown", 60, { pointerType: "touch" });
    pointer(row, "pointerup", 60, { pointerType: "touch" });
    await wait(400);
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".action-row.dragging")).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function stubRowRects(list: ProjectList): void {
  const rows = [...(list.shadowRoot?.querySelectorAll<HTMLElement>("[data-project-id]") ?? [])];
  rows.forEach((row, index) => {
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 50, 200, 50));
  });
}
