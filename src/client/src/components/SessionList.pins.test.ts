// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { pinnedSessionRows, SessionList, sessionRowsForCurrentTree } from "./SessionList";

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

async function mount(sessions: SessionInfo[], pins: string[] = []): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  list.pinnedRootIds = pins;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function row(list: SessionList, id: string): HTMLElement {
  const result = list.shadowRoot?.querySelector<HTMLElement>(`.action-row[title="/sessions/${id}.jsonl"]`);
  if (!result) throw new Error(`Missing row ${id}`);
  return result;
}

function shadow(list: SessionList): ShadowRoot {
  if (!list.shadowRoot) throw new Error("Missing shadow root");
  return list.shadowRoot;
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent.trim() === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}

async function openMenu(list: SessionList, id: string): Promise<HTMLElement> {
  row(list, id).querySelector<HTMLButtonElement>(".action-menu-toggle")?.click();
  await list.updateComplete;
  const menu = list.shadowRoot?.querySelector<HTMLElement>(".action-menu-panel");
  if (!menu) throw new Error("Missing menu");
  return menu;
}

function rowIds(list: SessionList): string[] {
  return [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? [])].map((item) => item.title.replace("/sessions/", "").replace(".jsonl", ""));
}

describe("session root pins", () => {
  it("projects ordered complete trees once, preserving child nesting and unpinned recency", () => {
    const recent = session("recent");
    const a = session("a");
    const b = session("b");
    const user = session("user", { parentSessionPath: a.path });
    const agent = session("agent", { parentSessionPath: a.path, agentSubsession: true });
    const nested = session("nested", { parentSessionPath: agent.path });
    const bChild = session("b-child", { parentSessionPath: b.path });
    const orphan = session("orphan", { parentSessionPath: "/missing.jsonl" });
    const archived = session("archived", { archived: true });
    const archivedChild = session("archived-child", { parentSessionPath: archived.path });
    const rows = sessionRowsForCurrentTree([recent, a, user, agent, nested, b, bChild, orphan, archived, archivedChild]);
    const result = pinnedSessionRows(rows, ["b", "missing", "agent", "orphan", "archived", "a", "b"]);
    expect(result.pinnedRootIds).toEqual(["b", "a"]);
    expect(result.pinnedRowCount).toBe(6);
    expect(result.rows.map(({ session: item }) => item.id)).toEqual([
      "b", "b-child", "a", "agent", "nested", "user", "recent", "orphan", "archived", "archived-child",
    ]);
    expect(result.rows.filter((item) => ["a", "agent", "nested", "user"].includes(item.session.id))).toEqual(rows.filter((item) => ["a", "agent", "nested", "user"].includes(item.session.id)));
    expect(pinnedSessionRows(rows, []).rows).toEqual(rows);
  });

  it("identifies pins by section headings without icons, preserving agent nesting and archive order", async () => {
    const a = session("a");
    const agent = session("agent", { parentSessionPath: a.path, agentSubsession: true });
    const child = session("child", { parentSessionPath: agent.path });
    const b = session("b");
    const archived = session("archived", { archived: true });
    const list = await mount([b, a, agent, child, archived], ["a", "child", "archived"]);
    expect(rowIds(list)).toEqual(["a", "child", "b"]);
    expect([...shadow(list).querySelectorAll(".pin-heading")].map((item) => item.textContent)).toEqual(["Pinned", "Recent"]);
    expect(shadow(list).querySelector('[aria-label="Pinned session"]')).toBeNull();
    expect(shadow(list).textContent).not.toContain("📌");
    const contents = [...shadow(list).querySelectorAll(".pin-heading, .action-row")].map((item) => item.classList.contains("action-row") ? item.getAttribute("title") : item.textContent);
    expect(contents).toEqual(["Pinned", a.path, child.path, "Recent", b.path]);
    button(shadow(list), "▸ Agent subsessions (1)").click();
    await list.updateComplete;
    expect(rowIds(list)).toEqual(["a", "agent", "child", "b"]);
    expect(row(list, "child").style.getPropertyValue("--depth")).toBe("2");
    button(shadow(list), "▸ Archived").click();
    await list.updateComplete;
    expect(rowIds(list)).toEqual(["a", "agent", "child", "b", "archived"]);
    list.pinnedRootIds = ["b", "a"];
    await list.updateComplete;
    expect(rowIds(list)).toEqual(["b", "a", "agent", "child", "archived"]);
    expect(shadow(list).querySelectorAll(".pin-heading")).toHaveLength(2);
    list.pinnedRootIds = ["missing", "child", "archived"];
    await list.updateComplete;
    expect(rowIds(list)).toEqual(["b", "a", "agent", "child", "archived"]);
    expect(shadow(list).querySelectorAll(".pin-heading")).toHaveLength(0);
  });

  it("offers pin actions only on actual current roots, including transient roots", async () => {
    const root = session("root");
    const archived = session("archived", { archived: true });
    const list = await mount([
      root, session("child", { parentSessionPath: root.path }),
      session("orphan", { parentSessionPath: "/missing.jsonl" }),
      archived, session("active-child", { parentSessionPath: archived.path }),
      session("transient", { persisted: false, messageCount: 0 }),
    ], ["child", "orphan", "archived"]);
    const onPin = vi.fn();
    const onSelect = vi.fn();
    list.onPin = onPin;
    list.onSelect = onSelect;
    for (const id of ["child", "orphan", "archived", "active-child"]) {
      const menu = await openMenu(list, id);
      expect(menu.textContent).not.toMatch(/Pin session|Unpin session|Move up|Move down/);
    }
    button(await openMenu(list, "root"), "Pin session").click();
    await list.updateComplete;
    expect(onPin).toHaveBeenCalledWith(root);
    expect(shadow(list).querySelector(".action-menu-panel")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(list.pinnedRootIds).toEqual(["child", "orphan", "archived"]);
    expect((await openMenu(list, "transient")).textContent).toContain("Pin session");
  });

  it("keeps the menu open for repeated pin moves and updates boundary controls", async () => {
    const a = session("a");
    const b = session("b");
    const c = session("c");
    const list = await mount([c, b, a], ["missing", "a", "b", "c", "stale"]);
    const move = vi.fn((item: SessionInfo, direction: -1 | 1) => {
      const pins = list.pinnedRootIds.filter((id) => ["a", "b", "c"].includes(id));
      const index = pins.indexOf(item.id);
      pins.splice(index, 1);
      pins.splice(index + direction, 0, item.id);
      list.pinnedRootIds = ["missing", ...pins, "stale"];
    });
    const unpin = vi.fn();
    list.onMovePin = move;
    list.onUnpin = unpin;
    const menu = await openMenu(list, "a");
    const up = button(menu, "Move up");
    const down = button(menu, "Move down");
    expect(up.disabled).toBe(true);
    up.click();
    expect(move).not.toHaveBeenCalled();
    down.focus();
    down.click();
    await list.updateComplete;
    expect(move).toHaveBeenLastCalledWith(a, 1);
    expect(shadow(list).querySelector(".action-menu-panel")).toBe(menu);
    expect(shadow(list).activeElement).toBe(down);
    expect(rowIds(list)).toEqual(["b", "a", "c"]);
    expect(up.disabled).toBe(false);
    down.click();
    await list.updateComplete;
    expect(rowIds(list)).toEqual(["b", "c", "a"]);
    expect(down.disabled).toBe(true);
    expect(shadow(list).activeElement).toBe(up);
    expect(shadow(list).querySelector(".action-menu-panel")).toBe(menu);
    up.click();
    await list.updateComplete;
    expect(move).toHaveBeenLastCalledWith(a, -1);
    expect(rowIds(list)).toEqual(["b", "a", "c"]);
    expect(down.disabled).toBe(false);
    document.body.click();
    await list.updateComplete;
    expect(shadow(list).querySelector(".action-menu-panel")).toBeNull();
    button(await openMenu(list, "c"), "Unpin session").click();
    expect(unpin).toHaveBeenCalledWith(c);
    await list.updateComplete;
    expect(shadow(list).querySelector(".action-menu-panel")).toBeNull();
  });
});
