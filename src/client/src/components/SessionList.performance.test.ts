// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import * as sessionPaths from "../sessionPaths";
import { SessionList } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, path: `/sessions/${id}.jsonl`, cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z", modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1, firstMessage: id, persisted: true, ...overrides,
  };
}

async function mount(sessions: SessionInfo[], collapsed = false): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  list.collapsible = true;
  list.collapsed = collapsed;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function row(list: SessionList, id: string): HTMLElement {
  const element = list.shadowRoot?.querySelector<HTMLElement>(`.action-row[title="/sessions/${id}.jsonl"]`);
  if (!element) throw new Error(`Missing session row: ${id}`);
  return element;
}

function button(root: ParentNode | null, selector: string): HTMLButtonElement {
  const element = root?.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing button: ${selector}`);
  return element;
}

describe("SessionList row identity and derived data", () => {
  it.each([false, true])("preserves row and focused action identity across prepend/removal (archived=%s)", async (archived) => {
    const a = session("a", { archived });
    const b = session("b", { archived });
    const list = await mount([a, b]);
    if (archived) {
      button(list.shadowRoot, ".subheading .section-toggle").click();
      await list.updateComplete;
    }
    const originalRow = row(list, "b");
    const action = button(originalRow, ".action-menu-toggle");
    action.focus();
    const prepended = session("new", { archived });
    const renamed = { ...b, name: "Renamed" };
    list.sessions = [prepended, a, renamed];
    await list.updateComplete;
    expect(row(list, "b")).toBe(originalRow);
    expect(list.shadowRoot?.activeElement).toBe(action);
    expect(originalRow.textContent).toContain("Renamed");

    list.sessions = [prepended, renamed];
    await list.updateComplete;
    expect(row(list, "b")).toBe(originalRow);
    expect(list.shadowRoot?.activeElement).toBe(action);
    const select = vi.fn();
    list.onSelect = select;
    originalRow.click();
    expect(select).toHaveBeenCalledWith(list.sessions[1]);
  });

  it("reuses hierarchy and descendant work across UI updates, invalidating on array replacement", async () => {
    // Path normalization is the shared computational boundary of both tree builders
    // and descendant counting, not row rendering. Measure work, not private cache fields.
    const normalize = vi.spyOn(sessionPaths, "normalizeSessionPath");
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const list = await mount([parent, child]);
    expect(normalize).toHaveBeenCalled();
    normalize.mockClear();

    button(row(list, "parent"), ".action-menu-toggle").click();
    await list.updateComplete;
    expect(row(list, "parent").textContent).toContain("Archive with descendants (1)");
    list.unreadSessionIds = new Set([child.id]);
    list.sending = { child: true };
    list.activities = {};
    list.statuses = {};
    await list.updateComplete;
    expect(row(list, "child").classList.contains("unread")).toBe(true);
    expect(row(list, "child").querySelector(".activity-indicator.sending")).not.toBeNull();
    list.collapsed = true;
    await list.updateComplete;
    list.collapsed = false;
    await list.updateComplete;
    expect(normalize).not.toHaveBeenCalled();

    list.sessions = [parent, session("child", { archived: true })];
    await list.updateComplete;
    expect(normalize).toHaveBeenCalled();
    expect(list.shadowRoot?.querySelectorAll(".action-row")).toHaveLength(1);
    button(row(list, "parent"), ".action-menu-toggle").click();
    await list.updateComplete;
    expect(row(list, "parent").textContent).not.toContain("Archive with descendants");
    button(list.shadowRoot, ".subheading .section-toggle").click();
    await list.updateComplete;
    expect(row(list, "child").style.getPropertyValue("--depth")).toBe("0");
  });

  it("defers descendant work until expansion and uses the latest collapsed sessions", async () => {
    const normalize = vi.spyOn(sessionPaths, "normalizeSessionPath");
    const parent = session("parent");
    const list = await mount([parent], true);
    list.sessions = [parent, session("child", { parentSessionPath: parent.path })];
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".section-count")?.textContent).toBe("2");
    expect(list.shadowRoot?.querySelector(".action-row")).toBeNull();
    normalize.mockClear();
    list.sending = { parent: true };
    await list.updateComplete;
    expect(normalize).not.toHaveBeenCalled();
    list.collapsed = false;
    await list.updateComplete;
    expect(normalize).toHaveBeenCalled();
    expect(row(list, "child").style.getPropertyValue("--depth")).toBe("1");
    button(row(list, "parent"), ".action-menu-toggle").click();
    await list.updateComplete;
    expect(row(list, "parent").textContent).toContain("Archive with descendants (1)");
  });
});
