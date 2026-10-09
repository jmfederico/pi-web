// @vitest-environment happy-dom

import { html } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { initialAppState } from "../appState";
import { publicPluginSession } from "../plugins/publicContext";
import { PluginRegistry } from "../plugins/registry";
import type { SessionLabelContext, SessionLabelItem } from "../plugins/types";
import { SessionList } from "./SessionList";

const session: SessionInfo = {
  id: "row", name: "Conversation", path: "/private/session.jsonl", cwd: "/workspace",
  created: "2026-01-01", modified: "2026-01-01", messageCount: 2, firstMessage: "Private message",
};

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("renders text, safe links, and custom controls without activating the row", async () => {
  const clicked = vi.fn();
  const selected = vi.fn();
  const list = new SessionList();
  list.sessions = [session];
  list.onSelect = selected;
  list.sessionLabelItems = () => [
    { type: "text", text: "Leg 2", title: "Workflow membership" },
    { type: "link", text: "Saved packet", href: "https://example.com/packet" },
    { type: "render", render: () => html`<button @click=${clicked}>Open workflow</button>` },
  ];
  document.body.append(list);
  await list.updateComplete;
  const secondary = list.shadowRoot?.querySelector(".session-secondary");
  const labels = secondary?.querySelector(".session-labels");
  expect(secondary?.querySelector(".session-meta")?.textContent).toBe("2 messages");
  expect(secondary?.querySelectorAll(".session-label-separator")).toHaveLength(3);
  expect(list.shadowRoot?.querySelector(".action-name")?.getAttribute("title")).toBe("Conversation");
  expect(labels?.textContent).toContain("Leg 2");
  expect(labels?.querySelector("span.session-label-item")?.getAttribute("title")).toBe("Workflow membership");
  const link = labels?.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://example.com/packet");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  link?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
  const button = labels?.querySelector("button");
  button?.click();
  button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
  expect(clicked).toHaveBeenCalledOnce();
  expect(selected).not.toHaveBeenCalled();
  list.shadowRoot?.querySelector<HTMLElement>(".action-row")?.click();
  expect(selected).toHaveBeenCalledWith(session);
});

it.each(["javascript:alert(1)", "  JAVASCRIPT:alert(1)", "java\nscript:alert(1)", "data:text/html,unsafe", "file:///private", ""]) (
  "renders an unsafe link as plain text: %j", async (href) => {
    const list = new SessionList();
    list.sessions = [session];
    list.sessionLabelItems = () => [{ type: "link", text: "Untrusted value", href }];
    document.body.append(list);
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".session-labels a")).toBeNull();
    expect(list.shadowRoot?.querySelector(".session-labels")?.textContent).toContain("Untrusted value");
  },
);

it.each(["visible", "items", "render"] as const)("keeps rows and selection usable when a plugin's %s callback throws", async (phase) => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const registry = new PluginRegistry();
  const failure = new Error("Broken plugin label");
  const fail = (): never => { throw failure; };
  const selected = vi.fn();
  const list = new SessionList();
  list.sessions = [session, { ...session, id: "other", name: "Other conversation" }];
  list.onSelect = selected;
  list.sessionLabelItems = (row) => registry.getSessionLabelItems({
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace", projectId: "project", path: row.cwd, label: "main", isMain: true, effectiveConfig: {} },
    state: initialAppState(),
    session: publicPluginSession(row),
    files: {
      readFile: vi.fn<SessionLabelContext["files"]["readFile"]>(),
      listFiles: vi.fn<SessionLabelContext["files"]["listFiles"]>(),
      writeFile: vi.fn<SessionLabelContext["files"]["writeFile"]>(),
      deleteFile: vi.fn<SessionLabelContext["files"]["deleteFile"]>(),
      moveFile: vi.fn<SessionLabelContext["files"]["moveFile"]>(),
    },
    navigate: vi.fn<() => Promise<void>>(),
    host: { requestRender: vi.fn() },
  });
  try {
    await registry.register({
      id: "labels",
      plugin: {
        apiVersion: 4, name: "Labels",
        activate: () => ({ contributions: { sessionLabels: [
          {
            id: "broken", order: 1,
            ...(phase === "visible" ? { visible: fail } : {}),
            items: phase === "items" ? fail : () => [{ type: "render", render: fail }],
          },
          { id: "healthy", order: 2, items: () => [{ type: "text", text: "Healthy indicator" }] },
        ] } }),
      },
    });
    document.body.append(list);
    await list.updateComplete;
    const rows = list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row");
    expect(rows).toHaveLength(2);
    for (const row of rows ?? []) {
      expect(row.querySelector(".session-labels")?.textContent).toBe("Healthy indicator");
      expect(row.querySelectorAll(".session-label-separator")).toHaveLength(1);
      expect(row.querySelector(".action-menu-toggle")).not.toBeNull();
    }
    rows?.[0]?.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith(session);
    expect(warning).toHaveBeenCalledWith(
      `PI WEB plugin session label labels:broken ${phase} failed for session row on machine local`, failure,
    );
  } finally {
    await registry.dispose();
  }
});

it("refreshes row-owned labels for archived rows and when the provider is replaced", async () => {
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  const archived = { ...session, id: "archived", archived: true };
  const list = new SessionList();
  list.sessions = [session, archived];
  list.selected = archived;
  const items = vi.fn((row: SessionInfo): SessionLabelItem[] => [{ type: "text", text: row.id }]);
  list.sessionLabelItems = items;
  document.body.append(list);
  await list.updateComplete;
  await list.updateComplete;
  expect(list.shadowRoot?.querySelector(".action-row.archived .session-labels")?.textContent).toContain("archived");
  expect(list.shadowRoot?.querySelector(".action-row:not(.archived) .session-labels")?.textContent).toContain("row");
  expect(items).toHaveBeenCalledWith(archived);

  list.sessionLabelItems = () => [{ type: "link", text: "Updated", href: "https://example.com/updated", target: "_self" }];
  await list.updateComplete;
  const link = list.shadowRoot?.querySelector(".session-labels a");
  expect(link?.textContent).toBe("Updated");
  expect(link?.getAttribute("target")).toBe("_self");
  expect(link?.hasAttribute("rel")).toBe(false);

  list.sessionLabelItems = () => [];
  await list.updateComplete;
  expect(list.shadowRoot?.querySelector(".session-labels")).toBeNull();
  expect(list.shadowRoot?.querySelector(".action-row:not(.archived) .session-secondary")?.textContent.trim()).toBe("2 messages");
  expect(list.shadowRoot?.querySelector(".action-row.archived .session-secondary")?.textContent.trim()).toBe("read-only · 2 messages");
  expect(list.shadowRoot?.querySelector(".session-label-separator")).toBeNull();
});
