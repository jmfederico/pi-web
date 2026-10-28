// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { render } from "lit";
import { ChatView } from "./ChatView";
import { localization } from "../localization/browser";
import { chatChromeMessages as messages } from "../chatChromeMessages";
import definitions from "./chatChrome.messages";
import { parseSessionStatus } from "../api/parsers";
import { sessionWarningSetSignature } from "../sessionWarningVisibility";
import { chatSessionWarningRows, renderSessionWarnings } from "./chat/SessionWarnings";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(false) }));
let release: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren(); release?.(); release = undefined;
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear(); vi.clearAllMocks();
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected chat chrome control");
  return value;
}
async function fixture() {
  const view = new ChatView();
  view.sessionId = "raw-session";
  view.behaviors = { ...view.behaviors, followTail: false, rememberPosition: false, automaticHistory: false };
  view.messages = [{ role: "user", entryId: "raw-entry", parts: [{ type: "text", text: "Raw message" }] }];
  view.messageStart = 1000; view.messageEnd = 1001; view.messageTotal = 12345; view.hasMore = true;
  view.isCompacting = true; view.pendingMessageCount = 1234;
  view.pendingDialogs = ["one", "two", "three"].map((dialogId) => ({ dialogId, kind: "input", title: "Raw extension title", askedAt: "2026-10-15T20:10:00Z", runScoped: false }));
  view.clientQueuedMessages = [{ kind: "followUp", text: "Raw local <tag>" }];
  view.status = { sessionId: view.sessionId, isStreaming: false, isCompacting: true, isBashRunning: false,
    pendingMessageCount: 2, queuedMessages: [{ kind: "steer", text: "Raw queue <tag> العربية", attachmentCount: 1234 }, { kind: "followUp", text: "Raw next", hasAttachments: true }],
    warnings: [{ severity: "warning", message: "Raw diagnostic <tag> العربية", source: "Raw source", path: "/raw/path", dismiss: { id: "raw-dismiss" } }],
    cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  view.onQueuedMessageAction = vi.fn().mockResolvedValue(undefined); view.onClearServerQueue = vi.fn();
  view.onLoadMore = vi.fn();
  const navigation = document.createElement("div");
  view.onNavigationChange = (controls) => { render(controls, navigation); };
  document.body.append(view, navigation); await view.updateComplete;
  return { view, root: required(view.shadowRoot), navigation };
}

it("keeps queue controls, raw content and externally rendered navigation live without resetting pending work or focus", async () => {
  release = localization.registerCatalog({ id: "chrome-test", namespace: "core.chatChrome", locale: "de", load: () => Promise.resolve({
    serverHeading: "Wartende Nachrichten", jumpTop: "Zum Anfang", minimise: "Verkleinern",
  }) });
  const { view, root, navigation } = await fixture();
  const button = required(root.querySelector<HTMLButtonElement>('[aria-label="Copy queued message"]'));
  button.click(); await vi.waitFor(() => { expect(root.textContent).toContain("Could not copy message"); });
  const field = root.querySelector(".queued-message formatted-text");
  const external = required(navigation.querySelector<HTMLButtonElement>("button")); external.focus();
  const load = required(root.querySelector<HTMLButtonElement>(".history-load-button"));
  load.click(); await view.updateComplete; expect(view.onLoadMore).toHaveBeenCalledOnce();
  for (const language of ["de", "en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "ar-EG" }); await view.updateComplete;
    expect(navigation.querySelector("button")).toBe(external); expect(document.activeElement).toBe(external);
    expect(external.title).toBe(messages.t("jumpTop"));
    expect(navigation.querySelector("nav")?.getAttribute("aria-label")).toBe(messages.t("navigation"));
    expect(navigation.querySelector(".chat-follow-state")?.textContent).toBe(messages.t("followState", { state: "disabled" }));
    expect(root.querySelector(".queued-action")).toBe(button); expect(root.querySelector(".queued-message formatted-text")).toBe(field);
    expect(button.title).toBe(messages.t("copyTitle")); expect(root.textContent).toContain(messages.t("copyFailed"));
    expect(root.textContent).toContain(messages.t("serverHeading"));
    expect(root.textContent).toContain(messages.t("attachments", { count: 1234 }));
    expect(root.textContent).toContain(messages.t("attachments", { count: 0 }));
    expect(root.textContent).toContain(messages.t("queueKind", { kind: "steer", index: 1 }));
    expect(root.textContent).toContain(messages.t("range", { from: 1001, to: 1001, total: 12345 }));
    expect(root.textContent).toContain(messages.t("queuedCount", { count: 1234 }));
    expect(root.querySelector(".queued-dialogs")?.textContent).toBe(messages.t("queuedDialogs", { count: 2 }));
    expect(root.querySelector(".queued-message formatted-text")).toHaveProperty("text", "Raw local <tag>");
    expect(root.querySelector("tag")).toBeNull(); expect(load.disabled).toBe(true);
  }
  expect(view.onQueuedMessageAction).not.toHaveBeenCalled(); expect(view.onLoadMore).toHaveBeenCalledOnce();
  view.pendingDialogs = view.pendingDialogs.slice(0, 2); await view.updateComplete;
  expect(root.querySelector(".queued-dialogs")?.textContent).toBe(messages.t("queuedDialogs", { count: 1 }));
  required(root.querySelector<HTMLButtonElement>(".queued-clear-button")).click(); expect(view.onClearServerQueue).toHaveBeenCalledOnce();
});

it("translates the owned billing warning live without changing status identity, diagnostics or dismissal", async () => {
  const usageUrl = "https://claude.ai/settings/usage";
  release = localization.registerCatalog({ id: "billing-warning-test", namespace: "core.chatChrome", locale: "de", load: () => Promise.resolve({
    ...Object.fromEntries(Object.entries(definitions).map(([key, descriptor]) => [key, descriptor.message])),
    anthropicSubscriptionAuth: "Anthropic-Abonnement aktiv. Zusätzliche Nutzung wird pro Token berechnet. Nutzung verwalten: {usageUrl}.",
  }) });
  const { view } = await fixture();
  const status = parseSessionStatus({
    ...required(view.status),
    warnings: [
      { severity: "warning", message: "Wire fallback", source: "anthropic", dismiss: { id: "anthropicExtraUsage" }, presentation: { kind: "anthropicSubscriptionAuth" } },
      { severity: "error", message: "Raw diagnostic <tag> العربية", source: "runtime", path: "/raw/path" },
      { severity: "warning", message: "Wire fallback", source: "anthropic", dismiss: { id: "legacy-dismiss" } },
    ],
  });
  view.status = status; await view.updateComplete;
  const signature = sessionWarningSetSignature(status.warnings);
  const onDismiss = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const renderWarnings = () => { render(renderSessionWarnings(chatSessionWarningRows(status), vi.fn(), onDismiss), container); };
  renderWarnings();
  const button = required(container.querySelector<HTMLButtonElement>(".session-warning-dismiss"));
  button.focus();
  const billing = required(container.querySelector(".session-warning-message"));
  for (const language of ["de", "en-XA", "ar-XB", "en"]) {
    await localization.setPreferences({ language, formatLocale: "en" }); renderWarnings();
    expect(view.status).toBe(status);
    expect(sessionWarningSetSignature(status.warnings)).toBe(signature);
    expect(container.querySelector(".session-warning-message")).toBe(billing);
    expect(billing.textContent).toBe(messages.t("anthropicSubscriptionAuth", { usageUrl }));
    expect(billing.textContent).toContain(usageUrl);
    expect(billing.textContent).not.toBe("Wire fallback");
    expect(container.querySelectorAll(".session-warning-message")[1]?.textContent).toBe("Raw diagnostic <tag> العربية");
    expect(container.querySelectorAll(".session-warning-message")[2]?.textContent).toBe("Wire fallback");
    expect(container.querySelector("tag")).toBeNull();
    expect(container.querySelector(".session-warning-dismiss")).toBe(button);
    expect(document.activeElement).toBe(button);
  }
  button.click();
  expect(onDismiss).toHaveBeenCalledWith("anthropicExtraUsage");
});

it("localizes runtime fallback but preserves diagnostic reasons, queue disablement and recall action identity", async () => {
  const { view, root } = await fixture();
  for (const reason of ["", "Raw runtime diagnostic <tag>"]) {
    view.status = { ...required(view.status), queueMessageActionsUnavailable: reason };
    await localization.setPreferences({ language: "ar-XB", formatLocale: "ar-EG" }); await view.updateComplete;
    const queue = required(root.querySelectorAll(".queued-messages")[1]);
    expect(queue.textContent).toContain(reason === "" ? messages.t("unavailable") : reason);
    const recall = required(queue.querySelector<HTMLButtonElement>(`[aria-label="${messages.t("recall")}"]`));
    expect(recall.disabled).toBe(true); expect(recall.title).toBe(reason === "" ? messages.t("unavailable") : reason);
  }
  const status = { ...required(view.status) }; delete status.queueMessageActionsUnavailable;
  view.status = status; await view.updateComplete;
  const recall = required(root.querySelector<HTMLButtonElement>(`[aria-label="${messages.t("recall")}"]`));
  recall.click(); expect(view.onQueuedMessageAction).toHaveBeenCalledWith(expect.objectContaining({ action: "edit", index: 0, sessionId: "raw-session" }));
  view.loadingMore = true; await view.updateComplete; expect(root.querySelector(".history-boundary")?.textContent).toContain(messages.t("loadingHistory"));
  view.loadingMore = false; view.hasMore = false; await view.updateComplete;
  expect(root.querySelector(".history-boundary")?.textContent).toContain(messages.t("beginning"));
});
