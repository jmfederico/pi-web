import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { QueuedSessionMessage, SessionStatus, SessionWarning } from "../api";
import type { SelectedSessionNotificationView } from "../sessionNotifications";
import type { ChatLine } from "./shared";
import {
  ChatView,
  chatEventAnchorKey,
  chatGroupAnchorKey,
  chatGroupScrollMarkerId,
  chatMessageGroupClassName,
  chatMessageGroupLabel,
  chatMessageMetadataLabel,
  chatQueuedMessageSections,
  chatQueuedSectionShowsClearAction,
  chatSessionWarningRows,
} from "./ChatView";
import { templateEventHandlerAfterMarker, templateEventHandlerNearMarker } from "../templateInspection.testSupport";

describe("chatQueuedMessageSections", () => {
  it("labels client-side pending-start sends separately from server queued messages", () => {
    const sections = chatQueuedMessageSections(
      [{ kind: "followUp", text: "queued before start" }],
      [{ kind: "steer", text: "server queued" }],
    );

    expect(sections).toEqual([
      {
        source: "client",
        heading: "Queued until session starts",
        detail: "Will send once the backend session is ready",
        messages: [{ kind: "followUp", text: "queued before start" }],
      },
      {
        source: "server",
        heading: "Queued messages",
        detail: "1 pending",
        messages: [{ kind: "steer", text: "server queued" }],
      },
    ]);
  });
});

describe("chatQueuedSectionShowsClearAction", () => {
  // The show/hide decision for the server clear-queue button is content/layout,
  // so it lives in a pure exported seam instead of scraping rendered markup.
  const serverSection = requireSection(chatQueuedMessageSections([], [{ kind: "steer", text: "server queued" }])[0]);
  const clientSection = requireSection(chatQueuedMessageSections([{ kind: "followUp", text: "waiting" }], [])[0]);

  it("shows the action for the server queue when clearing is supported and wired", () => {
    expect(chatQueuedSectionShowsClearAction(serverSection, true, true)).toBe(true);
  });

  it("hides the action when the runtime does not support clearing", () => {
    expect(chatQueuedSectionShowsClearAction(serverSection, false, true)).toBe(false);
  });

  it("hides the action when no clear handler is wired", () => {
    expect(chatQueuedSectionShowsClearAction(serverSection, true, false)).toBe(false);
  });

  it("never shows the server action for the separate client pending-start queue", () => {
    expect(chatQueuedSectionShowsClearAction(clientSection, true, true)).toBe(false);
  });
});

describe("ChatView queued-message clear wiring", () => {
  // Escape hatch: this case verifies the Clear queue button's Lit event wiring,
  // whose only observable effect is invoking the injected callback. Vitest runs
  // with no DOM environment here, so a shadow-DOM click harness would add
  // disproportionate setup; handler extraction anchored to the user-facing
  // "Clear queue" button text is proportionate.
  it("invokes onClearServerQueue when the server-queue action is activated", () => {
    const view = new ChatView();
    const onClearServerQueue = vi.fn();
    view.status = queuedStatus([{ kind: "steer", text: "server queued" }]);
    view.canClearServerQueue = true;
    view.onClearServerQueue = onClearServerQueue;

    templateEventHandlerNearMarker(renderQueuedMessages(view), "Clear queue")(new Event("click"));

    expect(onClearServerQueue).toHaveBeenCalledOnce();
  });
});

describe("chatSessionWarningRows", () => {
  // Warning-row content (severity class, message, path, source, dismiss
  // capability, ordering) is derived by a pure exported seam rather than scraped
  // from rendered `TemplateResult` markup, per the testing-guide rule that
  // TemplateResult inspection is not for general content assertions.
  it("derives one severity-tagged row per warning with optional path and source", () => {
    const rows = chatSessionWarningRows(warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill", path: "/skills/a.md" },
      { severity: "warning", message: "subscription auth is active" },
      { severity: "info", message: "heads up", source: "runtime" },
    ]));

    expect(rows).toEqual([
      { severity: "error", severityClass: "session-warning error", message: "skill failed to load", source: "skill", path: "/skills/a.md", dismissId: undefined },
      { severity: "warning", severityClass: "session-warning warning", message: "subscription auth is active", source: undefined, path: undefined, dismissId: undefined },
      { severity: "info", severityClass: "session-warning info", message: "heads up", source: "runtime", path: undefined, dismissId: undefined },
    ]);
  });

  it("exposes a dismiss id only for warnings carrying a dismiss capability", () => {
    const rows = chatSessionWarningRows(warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill" },
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]));

    expect(rows.map((row) => row.dismissId)).toEqual([undefined, "anthropicExtraUsage"]);
  });

  it("derives no rows when there are no warnings or status is unset", () => {
    expect(chatSessionWarningRows(warningStatus([]))).toEqual([]);
    expect(chatSessionWarningRows(undefined)).toEqual([]);
  });
});

describe("ChatView session-warning dismiss wiring", () => {
  // Escape hatch: this case verifies the dismiss button's Lit event wiring,
  // whose observable effect is invoking onDismissWarning with the warning's
  // dismiss id. No DOM environment is available, so handler extraction anchored
  // to the stable `session-warning-dismiss` class marker is proportionate.
  it("invokes onDismissWarning with the warning's dismiss id", () => {
    const view = new ChatView();
    const onDismissWarning = vi.fn();
    view.onDismissWarning = onDismissWarning;
    view.status = warningStatus([
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]);

    const rendered = renderWarnings(view);
    if (rendered === null) throw new Error("expected a warnings banner");
    templateEventHandlerAfterMarker(rendered, "session-warning-dismiss")(new Event("click"));

    expect(onDismissWarning).toHaveBeenCalledExactlyOnceWith("anthropicExtraUsage");
  });

  it("renders nothing when there are no warnings", () => {
    expect(renderWarnings(withStatus(new ChatView(), warningStatus([])))).toBeNull();
  });
});

describe("ChatView notification tray wiring", () => {
  // Escape hatch: these cases verify only the tray buttons' Lit callback wiring.
  // Notification content, ordering, severity, collapse, and focus decisions are
  // covered through pure seams; the node test environment has no shadow-DOM
  // harness, so semantic class markers keep direct handler extraction narrow.
  it("wires individual and dismiss-all actions to their injected callbacks", () => {
    const view = withNotificationInbox(new ChatView());
    const onDismissNotification = vi.fn();
    const onDismissAllNotifications = vi.fn();
    view.onDismissNotification = onDismissNotification;
    view.onDismissAllNotifications = onDismissAllNotifications;

    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");
    templateEventHandlerAfterMarker(rendered, "notification-card-dismiss")(new Event("click"));
    templateEventHandlerAfterMarker(rendered, "notification-dismiss-all")(new Event("click"));

    expect(onDismissNotification).toHaveBeenCalledExactlyOnceWith("daemon-a:1");
    expect(onDismissAllNotifications).toHaveBeenCalledOnce();
  });

  it("wires the real expand/collapse button to component-local collapse state", () => {
    const view = withNotificationInbox(new ChatView());
    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");

    templateEventHandlerAfterMarker(rendered, "notification-toggle")(new Event("click"));

    const collapsedSessionIds: unknown = Reflect.get(view, "collapsedNotificationSessionIds");
    if (!(collapsedSessionIds instanceof Set)) throw new Error("Expected collapsed notification session ids");
    expect(collapsedSessionIds.has("session-1")).toBe(true);
  });
});

describe("chatMessageMetadataLabel", () => {
  it("uses one full date and model label without a model prefix", () => {
    const timestamp = "2026-07-10T19:15:30.000Z";
    const formattedTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));

    expect(chatMessageMetadataLabel({
      role: "assistant",
      parts: [],
      meta: { timestamp, model: { provider: "provider", id: "model" } },
    })).toBe(`${formattedTimestamp} · provider/model`);
  });
});

describe("chat event-group content seams", () => {
  // Group scroll-anchor keys, marker ids, class list, and disclosure label are
  // content/structure derived from pure exported seams rather than scraped from
  // rendered markup.
  it("derives stable group and event scroll-anchor keys and marker ids", () => {
    expect(chatGroupAnchorKey(40)).toBe("g:40");
    expect(chatEventAnchorKey(40)).toBe("e:40");
    expect(chatEventAnchorKey(41)).toBe("e:41");
    expect(chatGroupScrollMarkerId(41)).toBe("g:41");
  });

  it("distinguishes the live tail group by class and disclosure label", () => {
    expect(chatMessageGroupClassName(true)).toBe("msg event-group live");
    expect(chatMessageGroupClassName(false)).toBe("msg event-group");
    expect(chatMessageGroupLabel(true)).toBe("live events");
    expect(chatMessageGroupLabel(false)).toBe("events");
  });
});

describe("ChatView event-group disclosure wiring", () => {
  const messages: ChatLine[] = [
    { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "inspect a file" }] },
    { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "inspect a file", status: "success", resultText: "large result" }] },
  ];

  it("defers a closed group body until it is opened", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);

    renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([]);
  });

  it("renders a live tail body by default", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);

    renderMessageGroup(view, messages, 40, 41, true);

    expect(bodyCalls).toEqual([{ messages, startIndex: 40 }]);
  });

  // Escape hatch: this case verifies the native `<details>` `@toggle` wiring,
  // whose observable effect is that a re-render renders (or defers) the group
  // body. No DOM environment is available for a real disclosure interaction, so
  // handler extraction anchored to the stable `@toggle=` attribute marker plus
  // an injected details-toggle event is proportionate.
  it("renders the body after a toggle-open and removes it when closed again", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);
    const initiallyClosed = renderMessageGroup(view, messages, 40, 41, false);

    dispatchDetailsToggle(templateEventHandlerAfterMarker(initiallyClosed, "@toggle="), true);
    renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([{ messages, startIndex: 40 }]);

    bodyCalls.length = 0;
    dispatchDetailsToggle(templateEventHandlerAfterMarker(initiallyClosed, "@toggle="), false);
    renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([]);
  });
});

interface GroupBodyRenderCall {
  messages: ChatLine[];
  startIndex: number;
}

type RenderQueuedMessages = (this: ChatView) => TemplateResult;
type RenderMessageGroup = (this: ChatView, messages: ChatLine[], startIndex: number, endIndex: number, defaultOpen: boolean) => TemplateResult;
type RenderMessageGroupBody = (this: ChatView, messages: ChatLine[], startIndex: number) => TemplateResult;
type RenderWarnings = (this: ChatView) => TemplateResult | null;
type RenderNotificationTray = (this: ChatView) => TemplateResult | null;
type TemplateEventHandler = (event: Event) => void;

function renderQueuedMessages(view: ChatView): TemplateResult {
  const method: unknown = Reflect.get(view, "renderQueuedMessages");
  if (!isRenderQueuedMessages(method)) throw new Error("ChatView.renderQueuedMessages is not callable");
  return method.call(view);
}

function renderMessageGroup(view: ChatView, messages: ChatLine[], startIndex: number, endIndex: number, defaultOpen: boolean): TemplateResult {
  const method: unknown = Reflect.get(view, "renderMessageGroup");
  if (!isRenderMessageGroup(method)) throw new Error("ChatView.renderMessageGroup is not callable");
  return method.call(view, messages, startIndex, endIndex, defaultOpen);
}

function renderWarnings(view: ChatView): TemplateResult | null {
  const method: unknown = Reflect.get(view, "renderWarnings");
  if (!isRenderWarnings(method)) throw new Error("ChatView.renderWarnings is not callable");
  return method.call(view);
}

function renderNotificationTray(view: ChatView): TemplateResult | null {
  const method: unknown = Reflect.get(view, "renderNotificationTray");
  if (!isRenderNotificationTray(method)) throw new Error("ChatView.renderNotificationTray is not callable");
  return method.call(view);
}

function observeGroupBodyRenders(view: ChatView): GroupBodyRenderCall[] {
  const method: unknown = Reflect.get(view, "renderMessageGroupBody");
  if (!isRenderMessageGroupBody(method)) throw new Error("ChatView.renderMessageGroupBody is not callable");
  const calls: GroupBodyRenderCall[] = [];
  const observed: RenderMessageGroupBody = function (messages, startIndex) {
    calls.push({ messages, startIndex });
    return method.call(this, messages, startIndex);
  };
  if (!Reflect.set(view, "renderMessageGroupBody", observed)) throw new Error("Could not observe ChatView.renderMessageGroupBody");
  return calls;
}

function isRenderQueuedMessages(value: unknown): value is RenderQueuedMessages {
  return typeof value === "function";
}

function isRenderMessageGroup(value: unknown): value is RenderMessageGroup {
  return typeof value === "function";
}

function isRenderMessageGroupBody(value: unknown): value is RenderMessageGroupBody {
  return typeof value === "function";
}

function isRenderWarnings(value: unknown): value is RenderWarnings {
  return typeof value === "function";
}

function isRenderNotificationTray(value: unknown): value is RenderNotificationTray {
  return typeof value === "function";
}

function dispatchDetailsToggle(handler: TemplateEventHandler, open: boolean): void {
  const hadDetailsElement = Reflect.has(globalThis, "HTMLDetailsElement");
  const previousDetailsElement = Reflect.get(globalThis, "HTMLDetailsElement");
  class StubDetailsElement extends EventTarget {
    constructor(readonly open: boolean) {
      super();
    }
  }
  Reflect.set(globalThis, "HTMLDetailsElement", StubDetailsElement);
  try {
    const details = new StubDetailsElement(open);
    details.addEventListener("toggle", (event) => { handler(event); });
    details.dispatchEvent(new Event("toggle"));
  } finally {
    if (hadDetailsElement) Reflect.set(globalThis, "HTMLDetailsElement", previousDetailsElement);
    else Reflect.deleteProperty(globalThis, "HTMLDetailsElement");
  }
}

function requireSection(section: ReturnType<typeof chatQueuedMessageSections>[number] | undefined): ReturnType<typeof chatQueuedMessageSections>[number] {
  if (section === undefined) throw new Error("expected a queued-message section");
  return section;
}

function withStatus(view: ChatView, status: SessionStatus): ChatView {
  view.status = status;
  return view;
}

function withNotificationInbox(view: ChatView): ChatView {
  const notificationInbox: SelectedSessionNotificationView = {
    machineId: "local",
    sessionId: "session-1",
    cwd: "/repo",
    daemonInstanceId: "daemon-a",
    notifications: [{
      id: "daemon-a:1",
      message: "plain <strong>text</strong>\nsecond line",
      truncated: false,
      severity: "warning",
      receivedAt: "2026-07-18T00:00:00.000Z",
      order: 1,
    }],
    retainedCount: 1,
    discardedCount: 0,
    highestSeverity: "warning",
    dismissThrough: { order: 1, overflowWatermark: 0 },
    pendingDismissedIds: new Set(),
    dismissAllPending: false,
    announcements: [],
  };
  view.sessionId = notificationInbox.sessionId;
  view.notificationInbox = notificationInbox;
  return view;
}

function warningStatus(warnings: SessionWarning[]): SessionStatus {
  return {
    ...queuedStatus([]),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

function queuedStatus(queuedMessages: QueuedSessionMessage[]): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: queuedMessages.length,
    queuedMessages,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}
