// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Workspace, WorkspaceActivity } from "../api";
import { WorkspaceList } from "./WorkspaceList";

let restoreClipboardStub: () => void = () => undefined;

afterEach(() => {
  restoreClipboardStub();
  restoreClipboardStub = () => undefined;
  document.body.replaceChildren();
});

describe("workspace-list removal actions", () => {
  it("shows provider wording for neutral removal metadata and no removal action without it", async () => {
    const removable = workspace("neutral", {
      isMain: false,
      removal: {
        actionLabel: "Disconnect view",
        confirmation: "Disconnect this view without deleting files?",
        precondition: "removal-v1",
      },
    });
    const withoutRemoval = workspace("plain");
    const onDelete = vi.fn();
    const list = new WorkspaceList();
    list.workspaces = [removable, withoutRemoval];
    list.onDelete = onDelete;
    document.body.append(list);
    await list.updateComplete;

    const toggles = list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-toggle");
    toggles?.[0]?.click();
    await list.updateComplete;

    const action = list.shadowRoot?.querySelector<HTMLButtonElement>(".workspace-menu-actions .danger");
    expect(action?.textContent).toBe("Disconnect view");
    expect(action?.title).toBe("Disconnect view");
    action?.click();
    expect(onDelete).toHaveBeenCalledWith(removable);
    await list.updateComplete;

    list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-toggle")[1]?.click();
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".workspace-menu-actions")).toBeNull();
  });
});

describe("workspace unread indicator", () => {
  it("shows an unread dot only on workspaces tracked as unread", async () => {
    const list = await mountWorkspaceList([workspace("ws-a"), workspace("ws-b")], new Set(["ws-b"]));

    expect(unreadDot(rowFor(list, "ws-a"))).toBeNull();
    const dot = unreadDot(rowFor(list, "ws-b"));
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("title")).toBe("Unread sessions in this workspace");
  });

  it("clears the dot once the workspace is no longer tracked as unread", async () => {
    const list = await mountWorkspaceList([workspace("ws-a")], new Set(["ws-a"]));
    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).not.toBeNull();

    list.unreadWorkspaceIds = new Set();
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("wraps the work dot in an unread ring when the workspace is busy and unread", async () => {
    const list = await mountWorkspaceList([workspace("ws-a")], new Set(["ws-a"]));
    list.activities = { "/repo/ws-a": workspaceActivity("/repo/ws-a", false, true) };
    await list.updateComplete;

    const row = rowFor(list, "ws-a");
    const ring = row.querySelector(".unread-ring");
    expect(ring?.querySelector(".activity-indicator.terminal")).not.toBeNull();
    expect(ring?.getAttribute("title")).toBe("Unread sessions in this workspace · Workspace terminal active");
    expect(row.querySelector(".activity-indicator.unread")).toBeNull();
  });
});

describe("workspace detail copy buttons", () => {
  it("copies the workspace path from the menu details and keeps the menu open", async () => {
    const writeText = stubClipboardWriteText(() => Promise.resolve());
    const list = await mountWorkspaceList([workspace("ws-a")], new Set());
    openMenu(list, "ws-a");
    await list.updateComplete;

    detailCopyButton(list, "Copy path").click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith("/repo/ws-a"); });
    await vi.waitFor(() => { expect(detailCopyButton(list, "Copied").textContent).toContain("✓"); });

    expect(list.shadowRoot?.querySelector(".workspace-menu-panel")).not.toBeNull();
  });

  it("copies the bare branch name without the main suffix", async () => {
    const writeText = stubClipboardWriteText(() => Promise.resolve());
    const list = await mountWorkspaceList([{ ...workspace("ws-a"), branch: "feature-x" }], new Set());
    openMenu(list, "feature-x");
    await list.updateComplete;

    detailCopyButton(list, "Copy branch").click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith("feature-x"); });
  });

  it("offers to copy the workspace label when there is no branch", async () => {
    const writeText = stubClipboardWriteText(() => Promise.resolve());
    const list = await mountWorkspaceList([workspace("ws-a")], new Set());
    openMenu(list, "ws-a");
    await list.updateComplete;

    detailCopyButton(list, "Copy workspace label").click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith("ws-a"); });
  });

  it("keeps the copy action unchanged when the clipboard write fails", async () => {
    const writeText = stubClipboardWriteText(() => Promise.reject(new Error("denied")));
    const list = await mountWorkspaceList([workspace("ws-a")], new Set());
    openMenu(list, "ws-a");
    await list.updateComplete;

    detailCopyButton(list, "Copy path").click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalled(); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await list.updateComplete;

    expect(detailCopyButton(list, "Copy path")).toBeDefined();
    expect(list.shadowRoot?.querySelector(".workspace-menu-panel .detail-copy[aria-label='Copied']")).toBeNull();
  });
});

function openMenu(list: WorkspaceList, workspaceLabel: string): void {
  const toggle = rowFor(list, workspaceLabel).querySelector<HTMLButtonElement>(".action-menu-toggle");
  if (toggle === null) throw new Error(`Expected a menu toggle for ${workspaceLabel}`);
  toggle.click();
}

function detailCopyButton(list: WorkspaceList, label: string): HTMLButtonElement {
  const buttons = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".workspace-menu-panel .detail-copy") ?? [])];
  const button = buttons.find((candidate) => candidate.getAttribute("aria-label") === label);
  if (button === undefined) throw new Error(`Expected a detail copy button labeled ${label}`);
  return button;
}

function stubClipboardWriteText(writeText: (text: string) => Promise<void>): Mock<(text: string) => Promise<void>> {
  const mock = vi.fn<(text: string) => Promise<void>>(writeText);
  const secureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  const clipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: mock }, configurable: true });
  restoreClipboardStub = () => {
    restoreStubbedProperty(window, "isSecureContext", secureContext);
    restoreStubbedProperty(window.navigator, "clipboard", clipboard);
  };
  return mock;
}

function restoreStubbedProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
}

async function mountWorkspaceList(workspaces: Workspace[], unreadWorkspaceIds: ReadonlySet<string>): Promise<WorkspaceList> {
  const list = new WorkspaceList();
  list.workspaces = workspaces;
  list.unreadWorkspaceIds = unreadWorkspaceIds;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function rowFor(list: WorkspaceList, workspaceLabel: string): Element {
  const rows = [...(list.shadowRoot?.querySelectorAll(".workspace-row") ?? [])];
  const row = rows.find((candidate) => candidate.textContent.includes(workspaceLabel));
  if (row === undefined) throw new Error(`Expected a workspace row for ${workspaceLabel}`);
  return row;
}

function unreadDot(row: Element): Element | null {
  return row.querySelector(".activity-indicator.unread");
}

function workspaceActivity(cwd: string, hasSessionActivity: boolean, hasTerminalActivity: boolean): WorkspaceActivity {
  return { cwd, hasSessionActivity, hasTerminalActivity, updatedAt: "2026-06-04T00:00:00.000Z" };
}

function workspace(id: string, patch: Partial<Workspace> = {}): Workspace {
  return { id, projectId: "project-1", path: `/repo/${id}`, label: id, isMain: true, effectiveConfig: {}, ...patch };
}
