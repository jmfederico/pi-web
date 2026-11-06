// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationGroup, NotificationItem } from "../notificationArea";
import { NotificationArea } from "./NotificationArea";
import { localization } from "../localization/browser";
import { sessionNotificationMessages as messages } from "../sessionNotificationMessages";

const notification: NotificationItem = {
  id: "session:1", message: "plain <strong>text</strong>\nsecond line", severity: "warning", source: "session",
  receivedAt: "2026-07-18T00:00:00.000Z",
};
function group(items: readonly NotificationItem[] = [notification], overrides: Partial<NotificationGroup> = {}): NotificationGroup {
  return { id: "session", items, clear: vi.fn(), ...overrides };
}
function required(view: NotificationArea, selector: string): HTMLElement {
  const element = view.renderRoot.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Expected ${selector}`);
  return element;
}
async function mount(groups = [group()]) {
  const view = new NotificationArea();
  view.contextKey = "local/project/workspace/session";
  view.groups = groups;
  view.onActionError = vi.fn();
  document.body.append(view);
  await settle(view);
  return view;
}
async function settle(view: NotificationArea) {
  await view.updateComplete;
  await view.updateComplete;
}
function deferred() {
  let resolve: () => void = () => { throw new Error("Deferred promise not initialized"); };
  let reject: (error: Error) => void = () => { throw new Error("Deferred promise not initialized"); };
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(async () => {
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks();
  await localization.setPreferences({ language: "en", formatLocale: "en" });
});

describe("NotificationArea", () => {
  it("combines localized counts across sources without a session, excluding discarded messages", async () => {
    const groups = [
      group([{ ...notification, id: "browser:error", source: "browser", severity: "error" }], { id: "browser" }),
      group([{ ...notification, id: "server:warning", source: "server" }], { id: "server" }),
      group([notification, { ...notification, id: "session:info", severity: "info" }], { discardedCount: 7 }),
    ];
    const view = await mount(groups);
    view.contextKey = "local/no-session"; await settle(view);
    required(view, ".notification-toggle").click(); await settle(view);
    for (const language of ["en", "en-XA", "ar-XB"]) {
      await localization.setPreferences({ language, formatLocale: "en" }); await settle(view);
      for (const [severity, count] of [["error", 1], ["warning", 2], ["info", 1]] as const) {
        const indicator = required(view, `.notification-count.${severity}`);
        expect(indicator.getAttribute("role")).toBe("img");
        expect(indicator.getAttribute("aria-label")).toBe(messages.t("severityCount", { severity, count }));
        expect(required(view, `.notification-count.${severity} .notification-count-value`).textContent).toBe(localization.number(count));
      }
      expect(required(view, ".notification-list").hidden).toBe(true);
      expect(required(view, ".notification-heading").textContent).toBe(messages.t("heading", { count: 11 }));
    }
    view.groups = [group([{ ...notification, severity: "info" }])]; await settle(view);
    expect(view.renderRoot.querySelector(".notification-count.error")).toBeNull();
    expect(view.renderRoot.querySelector(".notification-count.warning")).toBeNull();
  });

  it.each(["browser", "server", "session"] as const)("a new %s error reopens without moving focus, but other severities do not", async (source) => {
    const view = await mount();
    required(view, ".notification-toggle").click(); await settle(view);
    const input = document.createElement("input"); document.body.append(input); input.focus();
    for (const severity of ["info", "warning", "error"] as const) {
      view.groups = [group([{ ...notification, id: `${source}:${severity}`, severity, source }])]; await settle(view);
      expect(required(view, ".notification-list").hidden).toBe(severity !== "error");
      expect(document.activeElement).toBe(input);
    }
    required(view, ".notification-toggle").click(); await settle(view);
    view.groups = [...view.groups]; await settle(view);
    expect(required(view, ".notification-list").hidden).toBe(true);
    view.groups = [group([{ ...notification, id: `${source}:next-error`, severity: "error", source }])]; await settle(view);
    expect(required(view, ".notification-list").hidden).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("does not reopen restored errors after optimistic dismissal or refresh gaps", async () => {
    const groups = [group([{ ...notification, severity: "error" }])];
    const view = await mount(groups);
    required(view, ".notification-toggle").click(); await settle(view);
    view.groups = [group([], { pending: true })]; await settle(view);
    view.groups = groups; await settle(view);
    expect(required(view, ".notification-list").hidden).toBe(true);
    view.groups = []; await settle(view);
    view.groups = groups; await settle(view);
    expect(required(view, ".notification-list").hidden).toBe(true);
  });

  it("remembers collapse per context and recognizes new daemon/source-qualified occurrences", async () => {
    const view = await mount([group([{ ...notification, id: "local:daemon-a:1", severity: "error" }])]);
    required(view, ".notification-toggle").click(); await settle(view);
    view.contextKey = "remote/project";
    view.groups = [group([{ ...notification, id: "remote:daemon-a:1", severity: "error" }])]; await settle(view);
    expect(required(view, ".notification-list").hidden).toBe(false);
    view.contextKey = "local/project/workspace/session";
    view.groups = [group([{ ...notification, id: "local:daemon-a:1", severity: "error" }])]; await settle(view);
    expect(required(view, ".notification-list").hidden).toBe(true);
    view.groups = [group([{ ...notification, id: "local:daemon-b:1", severity: "error" }])]; await settle(view);
    expect(required(view, ".notification-list").hidden).toBe(false);
  });

  it.each([".notification-row-dismiss", ".notification-clear"])("recovers header focus when %s empties the area, then releases it on exit", async (selector) => {
    const view = await mount();
    const dismiss = vi.fn(() => { view.groups = []; });
    view.groups = [group([{ ...notification, dismiss }], { clear: dismiss })]; await settle(view);
    const button = required(view, selector); button.focus(); button.click(); await settle(view);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(view.shadowRoot?.activeElement).toBe(required(view, "[data-notification-focus='header']"));
    expect(view.hasAttribute("empty")).toBe(false);
    const outside = document.createElement("button"); document.body.append(outside); outside.focus(); await settle(view);
    expect(view.hasAttribute("empty")).toBe(true);
  });

  it("focuses an adjacent surviving row after dismissal", async () => {
    const next = { ...notification, id: "session:2" };
    const view = await mount();
    view.groups = [group([{ ...notification, dismiss: () => { view.groups = [group([next])]; } }, next])]; await settle(view);
    const button = required(view, ".notification-row-dismiss"); button.focus(); button.click(); await settle(view);
    expect(view.shadowRoot?.activeElement).toBe(required(view, '[data-notification-id="session:2"]'));
  });

  it("does not steal focus back after the user leaves during a pending action", async () => {
    const pending = deferred();
    const view = await mount([group([{ ...notification, dismiss: () => pending.promise }])]);
    const button = required(view, ".notification-row-dismiss"); button.focus(); button.click();
    // Native disabling can blur before the user picks another focus target.
    button.blur();
    const input = document.createElement("input"); document.body.append(input); input.focus();
    view.groups = []; pending.resolve(); await settle(view);
    expect(document.activeElement).toBe(input);
  });

  it("does not recover old action focus into another context", async () => {
    const pending = deferred();
    const view = await mount([group([{ ...notification, dismiss: () => pending.promise }])]);
    const button = required(view, ".notification-row-dismiss"); button.focus(); button.click();
    view.contextKey = "other"; view.groups = [group([{ ...notification, id: "other:1" }])]; await settle(view);
    pending.resolve(); await settle(view);
    expect(view.shadowRoot?.activeElement).toBeNull();
  });

  it("runs captured clears independently, retaining failed items and later arrivals", async () => {
    const pending = deferred();
    const browser = { ...notification, id: "browser:1", source: "browser" as const };
    const server = { ...notification, id: "server:1", source: "server" as const, severity: "error" as const };
    const later = { ...notification, id: "session:later" };
    const view = await mount();
    const clearBrowser = vi.fn(() => { view.groups = view.groups.filter((value) => value.id !== "browser"); });
    const clearServer = vi.fn(() => pending.promise);
    const clearSession = vi.fn(() => { view.groups = view.groups.filter((value) => value.id !== "session"); });
    view.groups = [group([browser], { id: "browser", clear: clearBrowser }), group([server], { id: "server", clear: clearServer }), group([notification], { clear: clearSession })];
    await settle(view);
    required(view, ".notification-clear").click(); await settle(view);
    expect(clearBrowser).toHaveBeenCalledOnce(); expect(clearServer).toHaveBeenCalledOnce(); expect(clearSession).toHaveBeenCalledOnce();
    expect(required(view, ".notification-clear").hasAttribute("disabled")).toBe(true);
    view.groups = [...view.groups, group([later])];
    const error = new Error("Server unavailable"); pending.reject(error);
    await vi.waitFor(() => { expect(view.onActionError).toHaveBeenCalledWith(error); }); await settle(view);
    expect(Array.from(view.renderRoot.querySelectorAll<HTMLElement>("[data-notification-id]"), (row) => row.dataset["notificationId"])).toEqual([server.id, later.id]);
    expect(required(view, ".notification-clear").hasAttribute("disabled")).toBe(false);
  });

  it("routes retry and dismiss separately and reports action failures without removing the item", async () => {
    const error = new Error("Retry failed");
    const retry = vi.fn(() => Promise.reject(error)); const dismiss = vi.fn();
    const view = await mount([group([{ ...notification, source: "browser", retry, dismiss }])]);
    required(view, ".notification-retry").click();
    await vi.waitFor(() => { expect(view.onActionError).toHaveBeenCalledWith(error); }); await settle(view);
    expect(dismiss).not.toHaveBeenCalled();
    expect(view.renderRoot.querySelectorAll(".notification-row")).toHaveLength(1);
    required(view, ".notification-row-dismiss").click(); await settle(view);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each(["success", "replacement", "rejection"] as const)("recovers keyboard focus after asynchronous Retry %s", async (outcome) => {
    const pending = deferred();
    const view = await mount([group([{ ...notification, retry: () => pending.promise }])]);
    const button = required(view, ".notification-retry"); button.focus(); button.click(); await settle(view);
    expect(button.hasAttribute("disabled")).toBe(true);
    if (outcome === "success") view.groups = [];
    if (outcome === "replacement") view.groups = [group([{ ...notification, id: "browser:retry-failure", severity: "error" }])];
    if (outcome === "rejection") pending.reject(new Error("Retry failed"));
    else pending.resolve();
    await vi.waitFor(() => {
      const target = outcome === "rejection" ? button : required(view, "[data-notification-focus='header']");
      expect(view.shadowRoot?.activeElement).toBe(target);
      if (outcome === "rejection") expect(button.hasAttribute("disabled")).toBe(false);
    });
  });

  it("preserves non-dismissible items when Clear only targets dismissible groups", async () => {
    const view = await mount([{ id: "condition", items: [notification] }]);
    expect(view.renderRoot.querySelector(".notification-row-dismiss")).toBeNull();
    expect(required(view, ".notification-clear").hasAttribute("disabled")).toBe(true);
  });

  it("keeps stable live regions and deduplicates restored occurrences without reading message URLs", async () => {
    const message = "Authorize at https://example.com/auth?state=secret";
    const first = { ...notification, message };
    const view = await mount([group([first])]);
    const polite = required(view, '[aria-live="polite"]');
    const announcement = required(view, '[data-announcement-id="session:1"]');
    view.groups = [group([first, { ...notification, id: "browser:error", source: "browser", severity: "error" }])]; await settle(view);
    expect(required(view, '[aria-live="polite"]')).toBe(polite);
    expect(required(view, '[data-announcement-id="session:1"]')).toBe(announcement);
    expect(required(view, '[aria-live="assertive"]').textContent).toBe(messages.t("announcement", { severity: "error" }));
    view.groups = []; await settle(view);
    view.groups = [group([first])]; await settle(view);
    expect(view.renderRoot.querySelectorAll('[data-announcement-id="session:1"]')).toHaveLength(1);
    for (const region of view.renderRoot.querySelectorAll("[aria-live]")) {
      expect(region.querySelector("a")).toBeNull(); expect(region.textContent).not.toContain("https://");
    }
  });

  it("renders plain text, overflow, truncation and pending actions", async () => {
    const view = await mount([group([{ ...notification, truncated: true, pending: true, dismiss: vi.fn() }], { discardedCount: 3 })]);
    expect(required(view, ".notification-message").textContent).toBe(notification.message);
    expect(view.renderRoot.querySelector(".notification-message strong")).toBeNull();
    expect(required(view, ".notification-overflow").textContent).toContain("3");
    expect(required(view, ".notification-truncated").textContent).not.toBe("");
    expect(required(view, ".notification-row-dismiss").hasAttribute("disabled")).toBe(true);
    const toggle = required(view, ".notification-toggle");
    expect(required(view, `#${String(toggle.getAttribute("aria-controls"))}`)).toBe(required(view, ".notification-list"));
  });

  it("links OAuth URLs without changing their query or interpreting surrounding HTML", async () => {
    const url = "https://auth.example.com/authorize?response_type=code&client_id=pi&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&scope=mcp%3Aread+offline_access&state=a%2Bb%26c&code_challenge=abc-_123&code_challenge_method=S256";
    const message = `<img src=x onerror="alert(1)"> Authorize: ${url}\n<strong>not markup</strong>`;
    const view = await mount([group([{ ...notification, message }])]);
    const content = required(view, ".notification-message"); const link = required(view, ".notification-message a");
    expect(content.textContent).toBe(message); expect(content.querySelector("img, strong, script")).toBeNull();
    expect(link.getAttribute("href")).toBe(url); expect(link.textContent).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank"); expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("leaves unsafe schemes and malformed URLs as escaped text", async () => {
    const message = 'javascript:alert(1) data:text/html,<script>alert(1)</script> file:///tmp/auth javascript:https://evil.example https://[invalid] https://safe.example/" onclick="alert(1)';
    const view = await mount([group([{ ...notification, message }])]);
    const content = required(view, ".notification-message"); expect(content.textContent).toBe(message); expect(content.querySelector("script")).toBeNull();
    const links = content.querySelectorAll("a"); expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://safe.example/"); expect(links[0]?.hasAttribute("onclick")).toBe(false);
  });

  it("keeps prose punctuation outside links and balanced URL parentheses inside", async () => {
    const message = 'Open (https://example.com/auth?state=abc), then "http://localhost:1234/callback". See https://example.com/wiki/Topic_(detail).';
    const view = await mount([group([{ ...notification, message }])]);
    const content = required(view, ".notification-message"); expect(content.textContent).toBe(message);
    expect(Array.from(content.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual([
      "https://example.com/auth?state=abc", "http://localhost:1234/callback", "https://example.com/wiki/Topic_(detail)",
    ]);
  });

  it.each(["https://example.com/auth?state=partial", "https://example.com/auth?state=partial."])("does not link truncated tail %s but keeps earlier complete URLs", async (tail) => {
    const message = `Open https://example.com/complete then ${tail}`;
    const view = await mount([group([{ ...notification, message, truncated: true }])]);
    const content = required(view, ".notification-message"); expect(content.textContent).toBe(message);
    expect(Array.from(content.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual(["https://example.com/complete"]);
    view.groups = [group([{ ...notification, message: `${message}\n`, truncated: true }])]; await settle(view);
    expect(required(view, ".notification-message").querySelectorAll("a")).toHaveLength(2);
  });
});
