import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
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
  chatSessionWarningRows,
} from "./ChatView";
import { templateEventHandlerAfterMarker, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
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

  // Escape hatch: this verifies the minimise chevron's Lit callback wiring in
  // the node test environment, anchored to its stable semantic class marker.
  // The chevron is wired to the unified onToggleWarnings (toggle ≡ collapse in
  // the expanded state), so this also proves the single visibility mutation.
  it("invokes onToggleWarnings from the visible warning area", () => {
    const view = withStatus(new ChatView(), warningStatus([
      { severity: "warning", message: "subscription auth is active" },
    ]));
    const onToggleWarnings = vi.fn();
    view.onToggleWarnings = onToggleWarnings;

    const rendered = renderWarnings(view);
    if (rendered === null) throw new Error("expected a warnings banner");
    templateEventHandlerAfterMarker(rendered, "session-warnings-collapse")(new Event("click"));

    expect(onToggleWarnings).toHaveBeenCalledOnce();
  });

  it("removes the warning area while presentation is collapsed or there are no warnings", () => {
    const view = withStatus(new ChatView(), warningStatus([
      { severity: "warning", message: "subscription auth is active" },
    ]));
    view.warningsVisible = false;

    expect(renderWarnings(view)).toBeNull();
    expect(renderWarnings(withStatus(new ChatView(), warningStatus([])))).toBeNull();
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

  it("appends the thinking level after the model when present", () => {
    const timestamp = "2026-07-10T19:15:30.000Z";
    const formattedTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));

    expect(chatMessageMetadataLabel({
      role: "assistant",
      parts: [],
      meta: { timestamp, model: { provider: "provider", id: "model" }, thinkingLevel: "high" },
    })).toBe(`${formattedTimestamp} · provider/model · high`);
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

type RenderQueuedMessages = (this: ChatView) => TemplateResult;
type RenderWarnings = (this: ChatView) => TemplateResult | null;

function renderQueuedMessages(view: ChatView): TemplateResult {
  const method: unknown = Reflect.get(view, "renderQueuedMessages");
  if (!isRenderQueuedMessages(method)) throw new Error("ChatView.renderQueuedMessages is not callable");
  return method.call(view);
}

function renderWarnings(view: ChatView): TemplateResult | null {
  const method: unknown = Reflect.get(view, "renderWarnings");
  if (!isRenderWarnings(method)) throw new Error("ChatView.renderWarnings is not callable");
  return method.call(view);
}

function isRenderQueuedMessages(value: unknown): value is RenderQueuedMessages {
  return typeof value === "function";
}

function isRenderWarnings(value: unknown): value is RenderWarnings {
  return typeof value === "function";
}

function requireSection(section: ReturnType<typeof chatQueuedMessageSections>[number] | undefined): ReturnType<typeof chatQueuedMessageSections>[number] {
  if (section === undefined) throw new Error("expected a queued-message section");
  return section;
}

function withStatus(view: ChatView, status: SessionStatus): ChatView {
  view.status = status;
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
