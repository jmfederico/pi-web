import { localization } from "../localization/browser";
import { describe, expect, it } from "vitest";
import type { QueuedSessionMessage, SessionStatus, SessionWarning } from "../api";
import {
  ChatView,
  chatEventAnchorKey,
  chatGroupAnchorKey,
  chatMessageAnchorKey,
  chatMessageGroupClassName,
  chatMessageGroupLabel,
  chatMessageMetadataLabel,
  chatQueuedMessageSections,
  chatQueuedSectionShowsClearAction,
  CHAT_CHROME_VISIBILITY_EVENT,
  type ChatChromeVisibilityDetail,
} from "./ChatView";
import { chatSessionWarningRows } from "./chat/SessionWarnings";
import type { ChatLine } from "./shared";

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

  it("shows the action for the server queue when a clear handler is wired", () => {
    expect(chatQueuedSectionShowsClearAction(serverSection, true)).toBe(true);
  });

  it("hides the action when no clear handler is wired", () => {
    expect(chatQueuedSectionShowsClearAction(serverSection, false)).toBe(false);
  });

  it("never shows the server action for the separate client pending-start queue", () => {
    expect(chatQueuedSectionShowsClearAction(clientSection, true)).toBe(false);
  });
});

describe("ChatView chrome scroll reporting", () => {
  interface FakeChatMetrics {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }

  /** Install a fake `.chat` scroller. `@query` defines `chat` as a getter-only
   *  accessor, so we shadow it with an own data property instead of assigning. */
  function installFakeChat(view: ChatView, metrics: FakeChatMetrics): void {
    Object.defineProperty(view, "chat", { value: metrics, configurable: true, writable: true });
  }

  function setChromeField(view: ChatView, name: string, value: unknown): void {
    Object.defineProperty(view, name, { value, configurable: true, writable: true });
  }

  function chromeField(view: ChatView, name: string): unknown {
    return Object.getOwnPropertyDescriptor(view, name)?.value;
  }

  function callChromeMethod(view: ChatView, name: string): void {
    let target: object | null = view;
    while (target !== null) {
      const value: unknown = Object.getOwnPropertyDescriptor(target, name)?.value;
      if (typeof value === "function") {
        value.call(view);
        return;
      }
      target = Reflect.getPrototypeOf(target);
    }
    throw new Error(`ChatView.${name} is not callable`);
  }

  function isChromeVisibilityEvent(event: Event): event is CustomEvent<ChatChromeVisibilityDetail> {
    return "detail" in event;
  }

  function captureChromeVisibility(view: ChatView): CustomEvent<ChatChromeVisibilityDetail>[] {
    const events: CustomEvent<ChatChromeVisibilityDetail>[] = [];
    view.addEventListener(CHAT_CHROME_VISIBILITY_EVENT, (event) => { if (isChromeVisibilityEvent(event)) events.push(event); });
    return events;
  }

  it("reveals the chrome when scrolling up past the threshold", () => {
    const view = new ChatView();
    installFakeChat(view, { scrollTop: 500, scrollHeight: 1000, clientHeight: 100 });
    setChromeField(view, "lastChromeScrollTop", 520);
    setChromeField(view, "chromeHidden", true);
    const events = captureChromeVisibility(view);

    callChromeMethod(view, "updateChromeVisibilityFromScroll");

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.detail).toEqual({ hidden: false });
    expect(event?.bubbles).toBe(true);
    expect(event?.composed).toBe(true);
  });

  it("hides the chrome when scrolling down past the threshold", () => {
    const view = new ChatView();
    installFakeChat(view, { scrollTop: 520, scrollHeight: 1000, clientHeight: 100 });
    setChromeField(view, "lastChromeScrollTop", 500);
    setChromeField(view, "chromeHidden", false);
    const events = captureChromeVisibility(view);

    callChromeMethod(view, "updateChromeVisibilityFromScroll");

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ hidden: true });
  });

  it("keeps a pinned chrome revealed while scrolling down", () => {
    const view = new ChatView();
    view.chromePinned = true;
    installFakeChat(view, { scrollTop: 520, scrollHeight: 1000, clientHeight: 100 });
    setChromeField(view, "lastChromeScrollTop", 500);
    setChromeField(view, "chromeHidden", false);
    const events = captureChromeVisibility(view);

    callChromeMethod(view, "updateChromeVisibilityFromScroll");

    expect(events).toEqual([]);
    expect(chromeField(view, "chromeHidden")).toBe(false);
  });

  it("hides the chrome again once the host unpins it", () => {
    const view = new ChatView();
    view.chromePinned = true;
    installFakeChat(view, { scrollTop: 520, scrollHeight: 1000, clientHeight: 100 });
    setChromeField(view, "lastChromeScrollTop", 500);
    setChromeField(view, "chromeHidden", false);
    view.chromePinned = false;
    const events = captureChromeVisibility(view);

    callChromeMethod(view, "updateChromeVisibilityFromScroll");

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ hidden: true });
  });

  it("always reveals the chrome when pinned to the bottom", () => {
    const view = new ChatView();
    installFakeChat(view, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
    setChromeField(view, "lastChromeScrollTop", 1000);
    setChromeField(view, "chromeHidden", true);
    const events = captureChromeVisibility(view);

    callChromeMethod(view, "updateChromeVisibilityFromScroll");

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ hidden: false });
  });

  it("reveals the chrome within the floating top bar's height of the start", () => {
    const view = new ChatView();
    view.chromeTopInset = 80;
    installFakeChat(view, { scrollTop: 40, scrollHeight: 1000, clientHeight: 100 });
    setChromeField(view, "lastChromeScrollTop", 0);
    setChromeField(view, "chromeHidden", true);
    const events = captureChromeVisibility(view);

    callChromeMethod(view, "updateChromeVisibilityFromScroll");

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ hidden: false });
  });

  it("does not toggle the chrome for sub-threshold scrolls", () => {
    const view = new ChatView();
    installFakeChat(view, { scrollTop: 505, scrollHeight: 1000, clientHeight: 100 });
    setChromeField(view, "lastChromeScrollTop", 500);
    setChromeField(view, "chromeHidden", false);
    const events = captureChromeVisibility(view);

    callChromeMethod(view, "updateChromeVisibilityFromScroll");

    expect(events).toHaveLength(0);
  });

  it("drops the scroll sample produced by a programmatic scroll", () => {
    const view = new ChatView();
    installFakeChat(view, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
    setChromeField(view, "lastChromeScrollTop", 100);
    setChromeField(view, "suppressChromeScroll", true);
    const events = captureChromeVisibility(view);

    callChromeMethod(view, "updateChromeVisibilityFromScroll");

    expect(events).toHaveLength(0);
    expect(chromeField(view, "lastChromeScrollTop")).toBe(900);
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

describe("chatMessageMetadataLabel", () => {
  it("uses one full date and model label without a model prefix", () => {
    const timestamp = "2026-07-10T19:15:30.000Z";
    const formattedTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));

    expect(chatMessageMetadataLabel({
      role: "assistant",
      parts: [],
      meta: { timestamp, model: { provider: "provider", id: "model" } },
    })).toBe(localization.list([formattedTimestamp, "provider/model"]));
  });

  it("appends the thinking level after the model when present", () => {
    const timestamp = "2026-07-10T19:15:30.000Z";
    const formattedTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));

    expect(chatMessageMetadataLabel({
      role: "assistant",
      parts: [],
      meta: { timestamp, model: { provider: "provider", id: "model" }, thinkingLevel: "high" },
    })).toBe(localization.list([formattedTimestamp, "provider/model", "high"]));
  });
});

describe("chat event-group content seams", () => {
  // Content/structure decisions have pure seams; native disclosure behavior is
  // covered through the DOM in ChatView.behaviors.test.ts.
  it("never derives scroll-anchor keys from display indexes or empty entry IDs", () => {
    for (const key of [chatMessageAnchorKey, chatEventAnchorKey, chatGroupAnchorKey]) {
      expect(key(40)).toBeUndefined();
      expect(key(41, { role: "assistant", parts: [] })).toBeUndefined();
      expect(key(42, { entryId: "", role: "assistant", parts: [] })).toBeUndefined();
    }
  });

  it("keeps durable entry keys independent of normalized indexes and separates entry slices", () => {
    const reply: ChatLine = { entryId: "entry-1", role: "user", parts: [{ type: "text", text: "Question" }] };
    const invocation: ChatLine = { ...reply, parts: [{ type: "skillInvocation", name: "testing", location: "SKILL.md", content: "Instructions" }] };
    for (const key of [chatMessageAnchorKey, chatEventAnchorKey, chatGroupAnchorKey]) {
      expect(key(495, reply)).toBe(key(453, reply));
      expect(key(495, reply)).not.toBe(key(495, invocation));
      expect(key(495, reply)).not.toBe(key(495, { ...reply, entryId: "entry-2" }));
    }
    expect(chatMessageAnchorKey(495, reply)).not.toBe(chatEventAnchorKey(495, reply));
  });

  it("distinguishes the live tail group by class and disclosure label", () => {
    expect(chatMessageGroupClassName(true)).toBe("msg event-group live");
    expect(chatMessageGroupClassName(false)).toBe("msg event-group");
    expect(chatMessageGroupLabel(true)).toBe("live events");
    expect(chatMessageGroupLabel(false)).toBe("events");
  });
});


function requireSection(section: ReturnType<typeof chatQueuedMessageSections>[number] | undefined): ReturnType<typeof chatQueuedMessageSections>[number] {
  if (section === undefined) throw new Error("expected a queued-message section");
  return section;
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
