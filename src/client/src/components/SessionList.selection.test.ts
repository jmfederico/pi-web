// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../api";
import { SessionList } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("SessionList bulk selection toolbar", () => {
  it("offers Select visible with an empty selection and no Clear or Done buttons", async () => {
    const list = await renderSessionList([session("a"), session("b"), session("c")]);

    currentSelectionToggle(list).click();
    await list.updateComplete;

    expect(toolbarButton(list, "Select visible")).not.toBeNull();
    expect(toolbarButton(list, "Clear selected")).toBeNull();
    expect(toolbarButton(list, "Clear")).toBeNull();
    expect(toolbarButton(list, "Done")).toBeNull();
    expect(selectionCount(list)).toBeNull();
  });

  it("selects every visible session via Select visible, then clears them via Clear selected", async () => {
    const list = await renderSessionList([session("a"), session("b"), session("c")]);
    currentSelectionToggle(list).click();
    await list.updateComplete;

    toolbarButton(list, "Select visible")?.click();
    await list.updateComplete;

    expect(checkedBoxes(list)).toHaveLength(3);
    expect(toolbarButton(list, "Clear selected (3)")).not.toBeNull();
    expect(selectionCount(list)).toBeNull();
    expect(toolbarButton(list, "Select visible")).toBeNull();

    toolbarButton(list, "Clear selected (3)")?.click();
    await list.updateComplete;

    expect(checkedBoxes(list)).toHaveLength(0);
    expect(selectionCount(list)).toBeNull();
    // Clearing keeps selection mode open so the visible set can be re-selected.
    expect(toolbarButton(list, "Select visible")).not.toBeNull();
  });

  it("keeps a large selected count inside the clear action", async () => {
    const list = await renderSessionList(Array.from({ length: 121 }, (_, index) => session(String(index))));
    currentSelectionToggle(list).click();
    await list.updateComplete;

    toolbarButton(list, "Select visible")?.click();
    await list.updateComplete;

    expect(toolbarButton(list, "Clear selected (121)")).not.toBeNull();
    expect(selectionCount(list)).toBeNull();
  });

  it("clears a partial manual selection via Clear selected", async () => {
    const list = await renderSessionList([session("a"), session("b"), session("c")]);
    currentSelectionToggle(list).click();
    await list.updateComplete;

    checkboxes(list)[0]?.click();
    await list.updateComplete;

    expect(toolbarButton(list, "Clear selected (1)")).not.toBeNull();
    expect(selectionCount(list)).toBeNull();
    expect(toolbarButton(list, "Select visible")).toBeNull();

    toolbarButton(list, "Clear selected (1)")?.click();
    await list.updateComplete;

    expect(checkedBoxes(list)).toHaveLength(0);
    expect(toolbarButton(list, "Select visible")).not.toBeNull();
  });

  it("closes selection mode, discarding the selection, from the same heading toggle that opened it", async () => {
    const list = await renderSessionList([session("a"), session("b"), session("c")]);
    currentSelectionToggle(list).click();
    await list.updateComplete;
    toolbarButton(list, "Select visible")?.click();
    await list.updateComplete;
    expect(checkedBoxes(list)).toHaveLength(3);

    currentSelectionToggle(list).click();
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".bulk-row.selecting")).toBeNull();
    expect(checkboxes(list)).toHaveLength(0);
  });

  it("offers the same toggle in the archived scope", async () => {
    const archivedA = session("archived-a", { archived: true, archivedAt: "2026-06-09T00:00:00.000Z" });
    const archivedB = session("archived-b", { archived: true, archivedAt: "2026-06-09T00:00:00.000Z" });
    const list = await renderSessionList([session("current"), archivedA, archivedB]);

    archivedSectionToggle(list)?.click();
    await list.updateComplete;
    archivedSelectionToggle(list).click();
    await list.updateComplete;

    toolbarButton(list, "Select visible")?.click();
    await list.updateComplete;
    expect(checkedBoxes(list)).toHaveLength(2);
    expect(toolbarButton(list, "Clear selected (2)")).not.toBeNull();
    expect(selectionCount(list)).toBeNull();

    toolbarButton(list, "Clear selected (2)")?.click();
    await list.updateComplete;
    expect(checkedBoxes(list)).toHaveLength(0);
    expect(toolbarButton(list, "Select visible")).not.toBeNull();
  });
});

async function renderSessionList(sessions: SessionInfo[]): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function currentSelectionToggle(list: SessionList): HTMLButtonElement {
  const button = list.shadowRoot?.querySelector<HTMLButtonElement>("h2:not(.subheading) .bulk-select-entry");
  if (button === null || button === undefined) throw new Error("Expected the current selection toggle");
  return button;
}

function archivedSelectionToggle(list: SessionList): HTMLButtonElement {
  const button = list.shadowRoot?.querySelector<HTMLButtonElement>("h2.subheading .bulk-select-entry");
  if (button === null || button === undefined) throw new Error("Expected the archived selection toggle");
  return button;
}

function archivedSectionToggle(list: SessionList): HTMLButtonElement | null {
  return list.shadowRoot?.querySelector<HTMLButtonElement>("h2.subheading .section-toggle") ?? null;
}

function toolbarButton(list: SessionList, text: string): HTMLButtonElement | null {
  const buttons = list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".bulk-row.selecting button") ?? [];
  for (const button of buttons) {
    if (button.textContent.trim() === text) return button;
  }
  return null;
}

function selectionCount(list: SessionList): HTMLElement | null {
  return list.shadowRoot?.querySelector<HTMLElement>(".bulk-row.selecting small") ?? null;
}

function checkboxes(list: SessionList): HTMLInputElement[] {
  return [...(list.shadowRoot?.querySelectorAll<HTMLInputElement>("input.session-checkbox") ?? [])];
}

function checkedBoxes(list: SessionList): HTMLInputElement[] {
  return checkboxes(list).filter((checkbox) => checkbox.checked);
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}
