// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import * as sessionPaths from "../sessionPaths";
import { agentChildOffsets, agentSessionGroups, SessionList, sessionNavigationCandidates, sessionRowsForCurrentTree, visibleAgentSessionRows } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, path: `/sessions/${id}.jsonl`, cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z", modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1, firstMessage: id, persisted: true, ...overrides,
  };
}

function child(id: string, parent: SessionInfo, agentSubsession?: boolean): SessionInfo {
  return session(id, { parentSessionPath: parent.path, ...(agentSubsession === undefined ? {} : { agentSubsession }) });
}

async function settle(list: SessionList): Promise<void> {
  await list.updateComplete;
  await list.updateComplete;
}

async function mount(sessions: SessionInfo[], selected?: SessionInfo): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  if (selected !== undefined) list.selected = selected;
  list.collapsible = true;
  document.body.append(list);
  await settle(list);
  return list;
}

function row(list: SessionList, id: string): HTMLElement | null {
  return list.shadowRoot?.querySelector<HTMLElement>(`.action-row[title="/sessions/${id}.jsonl"]`) ?? null;
}

function button(root: ParentNode | null, selector: string): HTMLButtonElement {
  const result = root?.querySelector<HTMLButtonElement>(selector);
  if (!result) throw new Error(`Missing button: ${selector}`);
  return result;
}

function agentToggle(list: SessionList, id: string): HTMLButtonElement {
  const toggle = row(list, id)?.nextElementSibling;
  if (!(toggle instanceof HTMLButtonElement) || !toggle.matches(".agent-subsession-toggle")) {
    throw new Error(`Missing hanging agent toggle for ${id}`);
  }
  return toggle;
}

function toolbarButton(list: SessionList, text: string): HTMLButtonElement {
  const result = Array.from(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".selection-toolbar button") ?? [])
    .find((item) => item.textContent.trim() === text);
  if (!result) throw new Error(`Missing toolbar button: ${text}`);
  return result;
}

describe("conservative agent child projection", () => {
  it("uses collapsed group defaults before the navigation list mounts", () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const archived = session("archived", { archived: true });
    expect(sessionNavigationCandidates([agent, archived, parent])).toEqual([parent]);
    expect(sessionNavigationCandidates([agent, archived, parent], { collapsed: true })).toEqual([]);
  });

  it("orders agent children before user/unknown siblings while preserving order within groups and roots", () => {
    const parent = session("parent");
    const user = child("user", parent, false);
    const firstAgent = child("first-agent", parent, true);
    const unknown = child("unknown", parent);
    const secondAgent = child("second-agent", parent, true);
    const nestedUser = child("nested-user", firstAgent);
    const nestedAgent = child("nested-agent", firstAgent, true);
    const other = session("other");
    const rows = sessionRowsForCurrentTree([other, parent, user, firstAgent, unknown, secondAgent, nestedUser, nestedAgent]);
    expect(rows.map(({ session: item }) => item.id)).toEqual([
      "other", "parent", "first-agent", "nested-agent", "nested-user", "second-agent", "user", "unknown",
    ]);
    expect(visibleAgentSessionRows(rows, new Set()).map(({ session: item }) => item.id)).toEqual([
      "other", "parent", "nested-user", "user", "unknown",
    ]);
  });

  it("counts only verified direct children and preserves user/unknown descendants and orphans", () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nestedAgent = child("nested-agent", agent, true);
    const user = child("user", agent, false);
    const unknown = child("unknown", nestedAgent);
    const userAgent = child("user-agent", user, true);
    const orphan = session("orphan", { parentSessionPath: "/missing.jsonl", agentSubsession: true });
    const rows = sessionRowsForCurrentTree([parent, agent, nestedAgent, user, unknown, userAgent, orphan]);
    const groups = agentSessionGroups(rows);
    expect([...groups.countByParentId]).toEqual([["parent", 1], ["agent", 1], ["user", 1]]);
    expect(agentChildOffsets(rows, groups)).toEqual(new Map([["agent", 12], ["nested-agent", 24], ["user-agent", 12]]));
    const visible = (expanded: string[]) => visibleAgentSessionRows(rows, new Set(expanded), groups).map((item) => item.session.id);
    expect(visible([])).toEqual(["parent", "unknown", "user", "orphan"]);
    expect(visible(["user"])).toEqual(["parent", "unknown", "user", "user-agent", "orphan"]);
    expect(visible(["parent"])).toEqual(["parent", "agent", "unknown", "user", "orphan"]);
    expect(visible(["parent", "agent"])).toEqual(["parent", "agent", "nested-agent", "unknown", "user", "orphan"]);
  });

  it("insets sibling agent cards equally without narrowing user rows or other parents", () => {
    const parent = session("parent");
    const first = child("first", parent, true);
    const last = child("last", parent, true);
    const other = session("other");
    const otherChild = child("other-child", other, true);
    const rows = sessionRowsForCurrentTree([parent, first, last, child("user", parent), other, otherChild]);
    const groups = agentSessionGroups(rows);
    const visible = visibleAgentSessionRows(rows, new Set(["parent", "other"]), groups);
    expect(agentChildOffsets(visible, groups)).toEqual(new Map([["first", 12], ["last", 12], ["other-child", 12]]));
    expect(agentChildOffsets(visibleAgentSessionRows(rows, new Set(), groups), groups).size).toBe(0);
  });

  it("matches normalized parent paths and does not group missing or unverified parents", () => {
    const parent = session("parent", { path: "/sessions/parent.jsonl/" });
    const rows = sessionRowsForCurrentTree([
      parent,
      session("agent", { parentSessionPath: "/sessions/parent.jsonl", agentSubsession: true }),
      child("unknown", parent),
    ]);
    expect(visibleAgentSessionRows(rows, new Set()).map((item) => item.session.id)).toEqual(["parent", "unknown"]);
  });
});

describe("SessionList agent subsession controls", () => {
  it("offers only visible rows for incidental navigation while allowing explicit reveals", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = child("nested", agent, true);
    const archived = session("archived", { archived: true });
    const sessions = [nested, agent, parent, archived];
    const list = await mount(sessions);
    const candidates = () => list.automaticSessionCandidates(sessions).map((item) => item.id);

    expect(candidates()).toEqual([parent.id]);
    agentToggle(list, parent.id).click();
    await settle(list);
    expect(candidates()).toEqual([agent.id, parent.id]);
    agentToggle(list, agent.id).click();
    await settle(list);
    expect(candidates()).toEqual([nested.id, agent.id, parent.id]);
    agentToggle(list, parent.id).click();
    await settle(list);
    expect(candidates()).toEqual([parent.id]);

    // A deliberate selection still expands all ancestors.
    list.selected = nested;
    await settle(list);
    expect(candidates()).toEqual([nested.id, agent.id, parent.id]);
    button(list.shadowRoot, ".subheading .section-toggle").click();
    await settle(list);
    expect(candidates()).toContain(archived.id);
    list.collapsed = true;
    expect(candidates()).toEqual([]);
  });

  it("rolls nested intervention above working siblings while preserving unread", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = { ...child("nested", agent, true), interventionRequired: true };
    const sibling = child("sibling", parent, true);
    const list = await mount([parent, agent, nested, sibling]);
    list.sessionFlags = { sibling: { "core:working": true }, nested: { "core:intervention-required": true } };
    list.unreadSessionIds = new Set([nested.id]);
    await settle(list);
    const toggle = agentToggle(list, parent.id);
    expect(toggle.querySelector(".unread-ring .intervention-required")).not.toBeNull();
    expect(toggle.querySelector(".unread-ring")?.getAttribute("aria-label")).toContain("Needs input");

    toggle.click();
    await settle(list);
    expect(toggle.querySelector(".action-activity")).toBeNull();
    expect(agentToggle(list, agent.id).querySelector(".intervention-required")).not.toBeNull();
  });

  it("updates collapsed chips for nested activity, sending, and unread completions", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = child("nested", agent, true);
    const list = await mount([parent, agent, nested]);
    const toggle = agentToggle(list, "parent");
    expect(toggle.querySelector(".action-activity")).toBeNull();

    list.activities = { nested: { sessionId: nested.id, phase: "active", label: "Working", at: "now" } };
    await settle(list);
    expect(toggle.querySelector('[aria-label="Agent subsessions active"]')).not.toBeNull();
    expect(row(list, "nested")).toBeNull();
    list.sending = { agent: true };
    list.unreadSessionIds = new Set([nested.id]);
    await settle(list);
    expect(toggle.querySelector('.unread-ring[aria-label="Unread subsession activity · Sending subsession message"]')).not.toBeNull();

    toggle.click();
    await settle(list);
    expect(toggle.querySelector(".action-activity")).toBeNull();
    expect(agentToggle(list, "agent").querySelector(".activity-indicator.session")).not.toBeNull();
    toggle.click();
    list.activities = {};
    list.sending = {};
    await settle(list);
    expect(toggle.querySelector('.activity-indicator.unread[aria-label="Unread subsession activity"]')).not.toBeNull();
    list.unreadSessionIds = new Set();
    await settle(list);
    expect(toggle.querySelector(".action-activity")).toBeNull();
  });

  it("clears completed child rows and collapsed chips from a recovered snapshot without selecting them", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = child("nested", agent, true);
    const list = await mount([parent, agent, nested]);
    list.activities = {
      agent: { sessionId: agent.id, phase: "active", label: "Working", at: "now" },
      nested: { sessionId: nested.id, phase: "active", label: "Working", at: "now" },
    };
    list.sessionFlags = { agent: { "core:working": true }, nested: { "core:working": true } };
    await settle(list);
    expect(agentToggle(list, "parent").querySelector(".activity-indicator.session")).not.toBeNull();

    // Both completion events were missed while backgrounded; the complete
    // reconnect/resume projection is sufficient, even with stale chat caches.
    list.sessionFlags = {};
    await settle(list);
    expect(agentToggle(list, "parent").querySelector(".action-activity")).toBeNull();
    agentToggle(list, "parent").click();
    await settle(list);
    expect(row(list, "agent")?.querySelector(".activity-indicator.session")).toBeNull();
    expect(agentToggle(list, "agent").querySelector(".action-activity")).toBeNull();
    expect(list.selected).toBeUndefined();
  });

  it("does not roll parent, visible user-child, unrelated, or archived activity into a chip", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const user = child("user", agent, false);
    const userAgent = child("user-agent", user, true);
    const archived = { ...child("archived", parent, true), archived: true };
    const other = session("other");
    const list = await mount([parent, agent, user, userAgent, archived, other]);
    list.sending = { parent: true, user: true, "user-agent": true, archived: true, other: true };
    list.unreadSessionIds = new Set([parent.id, user.id, userAgent.id, archived.id, other.id]);
    await settle(list);
    expect(agentToggle(list, "parent").querySelector(".action-activity")).toBeNull();
    expect(agentToggle(list, "user").querySelector(".activity-indicator.sending")).not.toBeNull();
  });

  it("places expanded agent children immediately below the chip before user children", async () => {
    const parent = session("parent");
    const user = child("user", parent);
    const agent = child("agent", parent, true);
    const list = await mount([parent, user, agent]);
    const toggle = agentToggle(list, "parent");
    expect(toggle.nextElementSibling).toBe(row(list, "user"));
    toggle.click();
    await settle(list);
    expect(toggle.nextElementSibling).toBe(row(list, "agent"));
    expect(row(list, "agent")?.nextElementSibling).toBe(row(list, "user"));
  });

  it("offers independent direct-parent toggles, including beneath hidden agent ancestors", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = child("nested", agent, true);
    const user = child("user", agent);
    const userAgent = child("user-agent", user, true);
    const other = session("other");
    const otherAgent = child("other-agent", other, true);
    const list = await mount([parent, agent, nested, user, userAgent, other, otherAgent]);
    expect(row(list, "agent")).toBeNull();
    expect(row(list, "user")).not.toBeNull();
    expect(list.shadowRoot?.querySelector("h2 .section-count")?.textContent).toBe("7");
    const toggle = agentToggle(list, "parent");
    expect(row(list, "parent")?.querySelector(".agent-subsession-toggle")).toBeNull();
    expect(toggle.parentElement).toBe(row(list, "parent")?.parentElement);
    expect(toggle.textContent).toContain("Agent subsessions (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const select = vi.fn();
    list.onSelect = select;
    toggle.click();
    await settle(list);
    expect(select).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(row(list, "nested")).toBeNull();
    expect(row(list, "other-agent")).toBeNull();
    agentToggle(list, "user").click();
    await settle(list);
    expect(row(list, "user-agent")).not.toBeNull();
    agentToggle(list, "parent").click();
    await settle(list);
    expect(row(list, "agent")).toBeNull();
    expect(row(list, "user-agent")).not.toBeNull();
  });

  it("Select all includes collapsed descendants in counts and bulk actions without selecting archived sessions", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = child("nested", agent, true);
    const user = child("user", agent);
    const archived = session("archived", { archived: true });
    const list = await mount([parent, agent, nested, user, archived]);
    const archive = vi.fn();
    const markRead = vi.fn();
    list.onArchiveMany = archive;
    list.onMarkReadMany = markRead;
    list.unreadSessionIds = new Set([nested.id]);
    button(list.shadowRoot, "h2 .bulk-select-entry").click();
    await settle(list);
    toolbarButton(list, "Select all").click();
    await settle(list);
    expect(list.shadowRoot?.querySelectorAll(".session-checkbox:checked")).toHaveLength(2);
    expect(toolbarButton(list, "Clear selected (4)")).toBeDefined();
    toolbarButton(list, "Mark read").click();
    expect(markRead).toHaveBeenCalledWith([nested]);

    toolbarButton(list, "Clear selected (4)").click();
    await settle(list);
    agentToggle(list, "parent").click();
    await settle(list);
    expect(row(list, "agent")?.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
    toolbarButton(list, "Select all").click();
    await settle(list);
    agentToggle(list, "agent").click();
    await settle(list);
    expect(list.shadowRoot?.querySelectorAll(".session-checkbox:checked")).toHaveLength(4);
    toolbarButton(list, "Archive").click();
    expect(archive).toHaveBeenCalledWith([parent, agent, nested, user]);
  });

  it("toggles a collapsed parent's hidden descendants together but leaves visible children independent", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = child("nested", agent, true);
    const user = child("user", agent);
    const other = session("other");
    const list = await mount([parent, agent, nested, user, other]);
    button(list.shadowRoot, "h2 .bulk-select-entry").click();
    await settle(list);
    row(list, "parent")?.click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (3)")).toBeDefined();
    expect(row(list, "user")?.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
    expect(row(list, "other")?.querySelector<HTMLInputElement>("input")?.checked).toBe(false);

    agentToggle(list, "parent").click();
    await settle(list);
    expect(row(list, "agent")?.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
    agentToggle(list, "agent").click();
    await settle(list);
    const nestedCheckbox = row(list, "nested")?.querySelector<HTMLInputElement>("input");
    expect(nestedCheckbox?.checked).toBe(true);
    nestedCheckbox?.click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (2)")).toBeDefined();

    // Collapsing a selected parent includes its hidden descendants even when
    // a nested group was expanded and an individual child had been unchecked.
    agentToggle(list, "parent").click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (3)")).toBeDefined();
    row(list, "parent")?.querySelector<HTMLInputElement>("input")?.click();
    await settle(list);
    expect(toolbarButton(list, "Select all")).toBeDefined();
    row(list, "parent")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await settle(list);
    expect(toolbarButton(list, "Clear selected (3)")).toBeDefined();
  });

  it("selects expanded rows individually while a nested collapsed parent selects its own hidden children", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = child("nested", agent, true);
    const list = await mount([parent, agent, nested]);
    agentToggle(list, "parent").click();
    await settle(list);
    button(list.shadowRoot, "h2 .bulk-select-entry").click();
    await settle(list);
    row(list, "parent")?.querySelector<HTMLInputElement>("input")?.click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (1)")).toBeDefined();
    expect(row(list, "agent")?.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
    row(list, "agent")?.querySelector<HTMLInputElement>("input")?.click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (3)")).toBeDefined();
    row(list, "parent")?.querySelector<HTMLInputElement>("input")?.click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (2)")).toBeDefined();
    expect(row(list, "agent")?.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
  });

  it("includes collapsed children when auto-selecting the only visible row and when new children arrive", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const list = await mount([parent, agent]);
    button(list.shadowRoot, "h2 .bulk-select-entry").click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (2)")).toBeDefined();

    const nested = child("nested", agent, true);
    list.sessions = [parent, agent, nested];
    await settle(list);
    expect(toolbarButton(list, "Clear selected (3)")).toBeDefined();
    button(list.shadowRoot, "h2 .bulk-select-entry").click();
    await settle(list);
    agentToggle(list, "parent").click();
    await settle(list);
    button(list.shadowRoot, "h2 .bulk-select-entry").click();
    await settle(list);
    expect(toolbarButton(list, "Select all")).toBeDefined();
    expect(list.shadowRoot?.querySelectorAll(".session-checkbox:checked")).toHaveLength(0);
  });

  it("inherits current selection through a hidden archived ancestor without selecting that ancestor", async () => {
    const parent = session("parent");
    const archivedAgent = { ...child("archived-agent", parent, true), archived: true };
    const nested = child("nested", archivedAgent, true);
    const list = await mount([parent, archivedAgent, nested, session("other")]);
    const archive = vi.fn();
    list.onArchiveMany = archive;
    button(list.shadowRoot, "h2 .bulk-select-entry").click();
    await settle(list);
    row(list, "parent")?.querySelector<HTMLInputElement>("input")?.click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (2)")).toBeDefined();
    toolbarButton(list, "Archive").click();
    expect(archive).toHaveBeenCalledWith([parent, nested]);
  });

  it("offers current Select all when the only visible row is an archived ancestor", async () => {
    const parent = session("parent", { archived: true });
    const agent = child("agent", parent, true);
    const list = await mount([parent, agent]);
    const archive = vi.fn();
    list.onArchiveMany = archive;
    button(list.shadowRoot, "h2 .bulk-select-entry").click();
    await settle(list);
    expect(row(list, "parent")?.querySelector("input")).toBeNull();
    toolbarButton(list, "Select all").click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (1)")).toBeDefined();
    toolbarButton(list, "Archive").click();
    expect(archive).toHaveBeenCalledWith([agent]);
  });

  it("reveals a selected nested agent on navigation but not same-id refresh churn", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const nested = child("nested", agent, true);
    const list = await mount([parent, agent, nested], nested);
    expect(row(list, "nested")?.classList.contains("selected")).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    agentToggle(list, "parent").click();
    await settle(list);
    scroll.mockClear();
    const refreshed = { ...nested, messageCount: 2 };
    list.sessions = [parent, agent, refreshed];
    list.selected = refreshed;
    await settle(list);
    expect(row(list, "nested")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    list.selected = parent;
    await settle(list);
    list.selected = nested;
    await settle(list);
    expect(row(list, "nested")).not.toBeNull();
  });

  it("Select all includes hidden archived children but excludes archived ancestors shown in the current tree", async () => {
    const parent = session("parent", { archived: true });
    const agent = session("agent", { parentSessionPath: parent.path, agentSubsession: true, archived: true });
    const other = session("other", { archived: true });
    const currentParent = session("current-parent", { archived: true });
    const currentChild = child("current-child", currentParent, true);
    const list = await mount([currentParent, currentChild, parent, agent, other]);
    const deleteMany = vi.fn();
    const confirmDelete = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmDelete);
    list.onDeleteArchivedMany = deleteMany;
    button(list.shadowRoot, ".subheading .section-toggle").click();
    await settle(list);
    expect(list.shadowRoot?.querySelector(".subheading .section-count")?.textContent).toBe("3");
    expect(row(list, "agent")).toBeNull();
    button(list.shadowRoot, ".subheading .bulk-select-entry").click();
    await settle(list);
    toolbarButton(list, "Select all").click();
    await settle(list);
    expect(list.shadowRoot?.querySelectorAll(".session-checkbox:checked")).toHaveLength(2);
    expect(toolbarButton(list, "Clear selected (3)")).toBeDefined();
    toolbarButton(list, "Delete").click();
    expect(confirmDelete).toHaveBeenCalledWith("Permanently delete 3 selected archived sessions? This cannot be undone.");
    expect(deleteMany).toHaveBeenCalledWith([parent, agent, other]);
    await settle(list);
    agentToggle(list, "parent").click();
    await settle(list);
    expect(list.shadowRoot?.querySelectorAll(".session-checkbox:checked")).toHaveLength(0);
  });

  it("selects and deselects hidden archived children with their collapsed parent's checkbox", async () => {
    const parent = session("parent", { archived: true });
    const agent = { ...child("agent", parent, true), archived: true };
    const list = await mount([parent, agent, session("other", { archived: true })]);
    button(list.shadowRoot, ".subheading .section-toggle").click();
    await settle(list);
    button(list.shadowRoot, ".subheading .bulk-select-entry").click();
    await settle(list);
    row(list, "parent")?.querySelector<HTMLInputElement>("input")?.click();
    await settle(list);
    expect(toolbarButton(list, "Clear selected (2)")).toBeDefined();
    row(list, "parent")?.querySelector<HTMLInputElement>("input")?.click();
    await settle(list);
    expect(toolbarButton(list, "Select all")).toBeDefined();
    agentToggle(list, "parent").click();
    await settle(list);
    expect(row(list, "agent")?.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
  });

  it("renders unavailable-parent agents and restores conservative collapsing when a parent arrives", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const list = await mount([agent]);
    expect(row(list, "agent")?.querySelector(".orphan-marker")).not.toBeNull();
    list.sessions = [parent, agent];
    await settle(list);
    expect(row(list, "agent")).toBeNull();
    expect(agentToggle(list, "parent")).toBeDefined();
    list.sessions = [agent];
    await settle(list);
    expect(row(list, "agent")).not.toBeNull();
  });

  it("keeps native toggle focus, row keyboard activation, and cached hierarchy work", async () => {
    const parent = session("parent");
    const agent = child("agent", parent, true);
    const user = child("user", agent);
    const list = await mount([parent, agent, user]);
    const normalize = vi.spyOn(sessionPaths, "normalizeSessionPath");
    const parentRow = row(list, "parent");
    const select = vi.fn();
    list.onSelect = select;
    parentRow?.focus();
    parentRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(select).toHaveBeenCalledWith(parent);
    select.mockClear();
    const toggle = agentToggle(list, "parent");
    toggle.focus();
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(select).not.toHaveBeenCalled();
    // happy-dom does not synthesize the browser's keyboard activation click.
    toggle.click();
    await settle(list);
    expect(list.shadowRoot?.activeElement).toBe(toggle);
    list.statuses = {};
    list.activities = {};
    list.sending = { agent: true };
    await settle(list);
    expect(normalize).not.toHaveBeenCalled();
    expect(row(list, "agent")).not.toBeNull();
  });
});
