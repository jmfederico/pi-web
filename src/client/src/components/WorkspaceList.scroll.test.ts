// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Workspace } from "../api";
import { WorkspaceList } from "./WorkspaceList";

let scrollIntoView: MockInstance;

beforeEach(() => {
  scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("WorkspaceList selection reveal scrolling", () => {
  it("scrolls the selected row into view on the first render that has a selection", async () => {
    await renderWorkspaceList({ workspaces: [workspace("a"), workspace("b")], selected: workspace("a") });

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("scrolls when the selection changes to a different row", async () => {
    const a = workspace("a");
    const b = workspace("b");
    const list = await renderWorkspaceList({ workspaces: [a, b], selected: a });
    scrollIntoView.mockClear();

    list.selected = b;
    await settled(list);

    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("does not scroll when a topology refresh replaces the workspaces array for the same selection", async () => {
    // Browser-resume topology refreshes swap in a new workspaces array, and the
    // selected workspace may be swapped for a same-id object with it.
    const a = workspace("a");
    const b = workspace("b");
    const list = await renderWorkspaceList({ workspaces: [a, b], selected: a });
    scrollIntoView.mockClear();

    list.workspaces = [{ ...a }, { ...b }];
    list.selected = { ...a };
    await settled(list);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(list.shadowRoot?.querySelector(".action-row.selected")).not.toBeNull();
  });

  it("scrolls when the section expands, and not when it collapses", async () => {
    const a = workspace("a");
    const list = await renderWorkspaceList({ workspaces: [a], selected: a, collapsed: true });
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.collapsed = false;
    await settled(list);
    expect(scrollIntoView).toHaveBeenCalledOnce();

    scrollIntoView.mockClear();
    list.collapsed = true;
    await settled(list);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

async function renderWorkspaceList(options: { workspaces: Workspace[]; selected?: Workspace; collapsed?: boolean }): Promise<WorkspaceList> {
  const list = new WorkspaceList();
  list.workspaces = options.workspaces;
  if (options.selected !== undefined) list.selected = options.selected;
  list.collapsed = options.collapsed ?? false;
  document.body.append(list);
  await settled(list);
  return list;
}

async function settled(list: WorkspaceList): Promise<void> {
  // Mirror of SessionList's settled(): await two update cycles so any render
  // scheduled from within updated() has completed before asserting.
  await list.updateComplete;
  await list.updateComplete;
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId: "project-1",
    path: `/workspaces/${id}`,
    label: id,
    isMain: false,
    effectiveConfig: {},
    ...overrides,
  };
}
