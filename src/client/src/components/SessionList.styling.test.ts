// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { SessionList } from "./SessionList";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

function session(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, path: `/sessions/${id}.jsonl`, cwd: "/repo", created: "2026-10-01", modified: "2026-10-01", messageCount: 2, firstMessage: id, persisted: true, ...extra };
}

function row(list: SessionList, id: string): HTMLElement {
  const found = [...list.renderRoot.querySelectorAll<HTMLElement>(".ui-nav-row")].find((row) => row.dataset["sessionId"] === id);
  if (!found) throw new Error(`Missing session row: ${id}`);
  return found;
}

function button(root: ParentNode, selector: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(selector);
  if (!found) throw new Error(`Missing button: ${selector}`);
  return found;
}

it("exposes shared anatomy and separates current navigation, activity, unread, and bulk selection", async () => {
  const first = session("first");
  const second = session("second");
  const list = new SessionList();
  list.sessions = [first, second];
  list.selected = first;
  list.sessionFlags = { first: { "core:working": true } };
  list.unreadSessionIds = new Set([first.id]);
  list.onSelect = vi.fn();
  document.body.append(list);
  await list.updateComplete;
  expect(list.renderRoot.querySelector('[data-ui-context="sessions"]')?.getAttribute("data-collapsed")).toBe("false");
  expect(list.renderRoot.querySelector(".ui-nav-list")?.contains(row(list, first.id))).toBe(true);
  const firstRow = row(list, first.id);
  expect(firstRow.getAttribute("aria-current")).toBe("true");
  expect(firstRow.dataset).toMatchObject({ current: "true", activity: "session", busy: "true", unread: "true", selected: "false", selecting: "false", archived: "false" });
  const main = firstRow.querySelector(":scope > .ui-nav-row-main");
  expect(main).not.toBeNull();
  for (const hook of [".ui-nav-row-label", ".ui-nav-row-meta", ".ui-nav-row-leading"]) expect(main?.querySelector(hook)).not.toBeNull();
  expect(firstRow.querySelector(":scope > .ui-nav-row-actions > .ui-nav-row-action")).not.toBeNull();

  list.sessionFlags = {};
  await list.updateComplete;
  expect(firstRow.dataset).toMatchObject({ activity: "idle", busy: "false", unread: "true" });
  list.unreadSessionIds = new Set();
  await list.updateComplete;
  expect(firstRow.dataset["unread"]).toBe("false");
  list.sending = { first: true };
  await list.updateComplete;
  expect(firstRow.dataset).toMatchObject({ activity: "sending", busy: "true" });
  list.sending = {};
  list.selected = second;
  await list.updateComplete;
  expect(firstRow.dataset["current"]).toBe("false");
  expect(firstRow.hasAttribute("aria-current")).toBe(false);
  expect(row(list, second.id).getAttribute("aria-current")).toBe("true");

  const select = button(list.renderRoot, 'button[aria-label="Select current sessions"]');
  select.click();
  await list.updateComplete;
  firstRow.click();
  await list.updateComplete;
  expect(firstRow.dataset).toMatchObject({ selected: "true", selecting: "true", current: "false" });
  expect(firstRow.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(row(list, second.id).dataset["current"]).toBe("true");
  expect(list.onSelect).not.toHaveBeenCalled();
  select.click();
  await list.updateComplete;
  expect(firstRow.dataset).toMatchObject({ selected: "false", selecting: "false" });
});

it("exposes disclosure, archive, and collapsed states without inventing disabled rows", async () => {
  const parent = session("parent");
  const agent = session("agent", { parentSessionPath: parent.path, agentSubsession: true });
  const archived = session("archived", { archived: true });
  const list = new SessionList();
  list.sessions = [parent, agent, archived];
  list.collapsible = true;
  document.body.append(list);
  await list.updateComplete;
  const parentRow = row(list, parent.id);
  const disclosure = parentRow.nextElementSibling;
  expect(disclosure).toBeInstanceOf(HTMLButtonElement);
  if (!(disclosure instanceof HTMLButtonElement)) throw new Error("Missing agent disclosure");
  expect(disclosure.matches(".ui-nav-row-disclosure")).toBe(true);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(parentRow.dataset["expanded"]).toBe("false");
  disclosure.click();
  await list.updateComplete;
  expect(parentRow.dataset["expanded"]).toBe("true");
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(row(list, agent.id).hasAttribute("data-expanded")).toBe(false);
  button(list.renderRoot, ".subheading .ui-nav-section-toggle").click();
  await list.updateComplete;
  expect(row(list, archived.id).dataset).toMatchObject({ archived: "true", activity: "idle", busy: "false" });
  expect(row(list, archived.id).hasAttribute("aria-disabled")).toBe(false);
  list.collapsed = true;
  await list.updateComplete;
  expect(list.renderRoot.querySelector('[data-ui-context="sessions"]')?.getAttribute("data-collapsed")).toBe("true");
  expect(list.renderRoot.querySelectorAll(".ui-nav-row")).toHaveLength(0);
  expect(button(list.renderRoot, ".ui-nav-section-toggle").getAttribute("aria-expanded")).toBe("false");
});

it("associates the action popup with its own row without navigating", async () => {
  const list = new SessionList();
  const first = session("first");
  const second = session("second / id");
  list.sessions = [first, second];
  list.selected = first;
  list.onSelect = vi.fn();
  document.body.append(list);
  await list.updateComplete;
  const action = button(row(list, second.id), ".ui-nav-row-action");
  expect(action.getAttribute("aria-expanded")).toBe("false");
  action.click();
  await list.updateComplete;
  const panel = list.renderRoot.querySelector(".ui-nav-row-menu");
  expect(panel).not.toBeNull();
  expect(panel?.id).toBe(action.getAttribute("aria-controls"));
  expect(action.classList.contains("ui-popup-trigger")).toBe(true);
  expect(panel?.classList.contains("ui-popup-panel")).toBe(true);
  expect(panel?.getAttribute("data-ui-context")).toBe("session-actions");
  expect(action.getAttribute("aria-expanded")).toBe("true");
  expect(list.onSelect).not.toHaveBeenCalled();
  expect(row(list, first.id).dataset["current"]).toBe("true");
  action.click();
  await list.updateComplete;
  expect(action.getAttribute("aria-expanded")).toBe("false");
  expect(list.renderRoot.querySelector(".ui-nav-row-menu")).toBeNull();
});
