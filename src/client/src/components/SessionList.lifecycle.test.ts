// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SessionInfo } from "../api";
import type { SessionList as SessionListElement } from "./SessionList";

const { SessionList } = await loadSessionList();

async function loadSessionList() {
  const notice = "Lit is in dev mode. Not recommended for production! See https://lit.dev/msg/dev-mode for more information.";
  const originalWarn = console.warn;
  const warnings = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (args.length === 1 && args[0] === notice) return;
    originalWarn(...args);
  });
  try {
    const component = await import("./SessionList");
    expect(warnings.mock.calls).toEqual([[notice]]);
    return component;
  } finally {
    warnings.mockRestore();
  }
}

let scrollIntoView: MockInstance;
let warnings: MockInstance;
let errors: MockInstance;

beforeEach(() => {
  // Observe the browser boundary; rendering, lifecycle and row selection stay real.
  scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
  warnings = vi.spyOn(console, "warn");
  errors = vi.spyOn(console, "error");
});

afterEach(() => {
  const warningCalls = [...warnings.mock.calls];
  const errorCalls = [...errors.mock.calls];
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  expect(warningCalls).toEqual([]);
  expect(errorCalls).toEqual([]);
});

interface Commit {
  selectedPath: string | null;
  archiveExpanded: string | null;
  rowPaths: string[];
  panels: number;
  hasBody: boolean;
}

function observeCommits(list: SessionListElement): Commit[] {
  const commits: Commit[] = [];
  // Lit calls hostUpdated after committing DOM, before the component's updated.
  list.addController({
    hostUpdated() {
      commits.push({
        selectedPath: list.renderRoot.querySelector<HTMLElement>(".action-row.selected")?.title ?? null,
        archiveExpanded: list.renderRoot.querySelector(".subheading .section-toggle")?.getAttribute("aria-expanded") ?? null,
        rowPaths: [...list.renderRoot.querySelectorAll<HTMLElement>(".action-row")].map((row) => row.title),
        panels: list.renderRoot.querySelectorAll(".action-menu-panel").length,
        hasBody: list.renderRoot.querySelector(".list-body") !== null,
      });
    },
  });
  return commits;
}

function expectRevealAfterCommit(list: SessionListElement, commits: Commit[], path: string): void {
  expect(commits).toHaveLength(1);
  expect(commits[0]?.selectedPath).toBe(path);
  const selectedRow = list.renderRoot.querySelector<HTMLElement>(".action-row.selected");
  expect(selectedRow?.title).toBe(path);
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(scrollIntoView.mock.contexts).toEqual([selectedRow]);
}

function recordRevealOrdering(list: SessionListElement, commits: Commit[]): number[] {
  const committedCounts: number[] = [];
  scrollIntoView.mockImplementation(function (this: HTMLElement) {
    expect(this.isConnected).toBe(true);
    expect(list.renderRoot.querySelector(".action-row.selected")).toBe(this);
    committedCounts.push(commits.length);
  });
  return committedCounts;
}

function createList(sessions: SessionInfo[], selected?: SessionInfo, collapsed = false): SessionListElement {
  const list = new SessionList();
  list.sessions = sessions;
  if (selected !== undefined) list.selected = selected;
  list.collapsible = true;
  list.collapsed = collapsed;
  return list;
}

function button(list: SessionListElement, selector: string): HTMLButtonElement {
  const result = list.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (!result) throw new Error(`Missing button: ${selector}`);
  return result;
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, path: `/sessions/${id}.jsonl`, cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z", modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1, firstMessage: id, persisted: true, ...overrides,
  };
}

const archive = { archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };

describe("SessionList first-commit derived state", () => {
  it("includes an initially selected archive in the first commit and reveals it afterwards", async () => {
    const archived = session("archived", archive);
    const list = createList([archived], archived);
    const commits = observeCommits(list);
    const revealCounts = recordRevealOrdering(list, commits);
    document.body.append(list);

    const firstComplete = await list.updateComplete;

    expect(commits[0]?.selectedPath).toBe(archived.path);
    expect(commits[0]?.archiveExpanded).toBe("true");
    expect(firstComplete).toBe(true);
    expect(list.isUpdatePending).toBe(false);
    expectRevealAfterCommit(list, commits, archived.path);
    expect(revealCounts).toEqual([1]);
  });

  it.each(["different-id", "same-id"])("reveals a %s current-to-archive transition in its first commit", async (identity) => {
    const current = session("current");
    const list = createList([current], current);
    document.body.append(list);
    expect(await list.updateComplete).toBe(true);
    scrollIntoView.mockClear();
    const commits = observeCommits(list);
    const revealCounts = recordRevealOrdering(list, commits);
    const archived = session(identity === "same-id" ? current.id : "archived", archive);

    list.sessions = identity === "same-id" ? [archived] : [current, archived];
    list.selected = archived;
    const firstComplete = await list.updateComplete;

    expect(commits[0]?.selectedPath).toBe(archived.path);
    expect(commits[0]?.archiveExpanded).toBe("true");
    expect(firstComplete).toBe(true);
    expect(list.isUpdatePending).toBe(false);
    expectRevealAfterCommit(list, commits, archived.path);
    expect(revealCounts).toEqual([1]);

    // The per-update forced reveal must not survive same-id/status churn.
    commits.length = 0;
    scrollIntoView.mockClear();
    const refreshed = { ...archived, messageCount: 2 };
    list.sessions = list.sessions.map((item) => item.id === refreshed.id ? refreshed : { ...item });
    list.selected = refreshed;
    list.sending = { [refreshed.id]: true };
    expect(await list.updateComplete).toBe(true);
    expect(commits).toHaveLength(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not force a same-id archive reveal when the archive section is already expanded", async () => {
    const current = session("current");
    const existingArchive = session("existing", archive);
    const list = createList([current, existingArchive], current);
    document.body.append(list);
    await list.updateComplete;
    scrollIntoView.mockClear();
    button(list, ".subheading .section-toggle").click();
    expect(await list.updateComplete).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
    const commits = observeCommits(list);

    const archived = { ...current, ...archive };
    list.sessions = [archived, existingArchive];
    list.selected = archived;
    expect(await list.updateComplete).toBe(true);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.selectedPath).toBe(current.path);
    expect(commits[0]?.archiveExpanded).toBe("true");
    expect(list.isUpdatePending).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("respects manual archive collapse across same-id object and array refresh", async () => {
    const current = session("current");
    const archived = session("archived", archive);
    const list = createList([current, archived], current);
    const onArchivedCollapsed = vi.fn();
    list.onArchivedCollapsed = onArchivedCollapsed;
    document.body.append(list);
    await list.updateComplete;
    button(list, ".subheading .section-toggle").click();
    await list.updateComplete;
    list.selected = archived;
    await list.updateComplete;
    button(list, ".subheading .section-toggle").click();
    expect(await list.updateComplete).toBe(true);
    expect(onArchivedCollapsed).toHaveBeenCalledOnce();
    scrollIntoView.mockClear();
    const commits = observeCommits(list);

    const refreshed = { ...archived, messageCount: 2 };
    list.sessions = [{ ...current }, refreshed];
    list.selected = refreshed;
    expect(await list.updateComplete).toBe(true);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.archiveExpanded).toBe("false");
    expect(commits[0]?.selectedPath).toBeNull();
    expect(commits[0]?.rowPaths).toEqual([current.path]);
    expect(list.isUpdatePending).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("restores the last archive and resets expansion without a follow-up commit", async () => {
    const archived = session("archived", archive);
    const current = session("current");
    const list = createList([current, archived], current);
    document.body.append(list);
    await list.updateComplete;
    button(list, ".subheading .section-toggle").click();
    await list.updateComplete;
    list.selected = archived;
    await list.updateComplete;
    scrollIntoView.mockClear();
    const commits = observeCommits(list);
    const revealCounts = recordRevealOrdering(list, commits);

    const restored = session("archived");
    list.sessions = [current, restored];
    list.selected = restored;
    const firstComplete = await list.updateComplete;

    expect(commits[0]?.selectedPath).toBe(restored.path);
    expect(commits[0]?.archiveExpanded).toBeNull();
    expect(firstComplete).toBe(true);
    expect(list.isUpdatePending).toBe(false);
    expect(list.renderRoot.querySelector(".action-row.selected.archived")).toBeNull();
    expectRevealAfterCommit(list, commits, restored.path);
    expect(revealCounts).toEqual([1]);

    // Reset is observable when a later unselected archive arrives: it stays closed.
    commits.length = 0;
    scrollIntoView.mockClear();
    list.sessions = [current, restored, session("another", archive)];
    expect(await list.updateComplete).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.archiveExpanded).toBe("false");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("defers archived scrolling while the outer list is collapsed until expansion commits", async () => {
    const archived = session("archived", archive);
    const list = createList([archived], archived, true);
    const commits = observeCommits(list);
    const revealCounts = recordRevealOrdering(list, commits);
    document.body.append(list);

    const firstComplete = await list.updateComplete;

    expect(commits).toHaveLength(1);
    expect(commits[0]?.rowPaths).toEqual([]);
    expect(firstComplete).toBe(true);
    expect(list.isUpdatePending).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();

    commits.length = 0;
    list.collapsed = false;
    expect(await list.updateComplete).toBe(true);
    expectRevealAfterCommit(list, commits, archived.path);
    expect(revealCounts).toEqual([1]);

    commits.length = 0;
    scrollIntoView.mockClear();
    list.collapsed = true;
    expect(await list.updateComplete).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.rowPaths).toEqual([]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([false, true])("collapses with no correction render and does not reopen a menu (open=%s)", async (openMenu) => {
    const current = session("current");
    const list = createList([current]);
    document.body.append(list);
    await list.updateComplete;
    if (openMenu) {
      button(list, ".action-menu-toggle").click();
      expect(await list.updateComplete).toBe(true);
      expect(list.renderRoot.querySelectorAll(".action-menu-panel")).toHaveLength(1);
    }
    const commits = observeCommits(list);

    list.collapsed = true;
    const firstComplete = await list.updateComplete;

    expect(commits[0]).toEqual({ selectedPath: null, archiveExpanded: null, rowPaths: [], panels: 0, hasBody: false });
    expect(firstComplete).toBe(true);
    expect(list.isUpdatePending).toBe(false);
    expect(commits).toHaveLength(1);
    expect(list.renderRoot.querySelectorAll(".action-row, .action-menu-panel")).toHaveLength(0);
    // Await the same completed cycle while remaining collapsed, not a settling helper.
    expect(await list.updateComplete).toBe(true);
    expect(commits).toHaveLength(1);

    commits.length = 0;
    list.collapsed = false;
    expect(await list.updateComplete).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.rowPaths).toEqual([current.path]);
    expect(commits[0]?.panels).toBe(0);
    expect(list.renderRoot.querySelector(".action-menu-panel")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
