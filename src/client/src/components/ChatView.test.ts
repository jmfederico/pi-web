import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { QueuedSessionMessage, SessionStatus, SessionWarning } from "../api";
import type { ChatLine } from "./shared";
import { ChatView, chatMessageMetadataLabel, chatQueuedMessageSections } from "./ChatView";

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

describe("ChatView queued-message clear action", () => {
  // Direct handler extraction keeps this node-environment test focused on the
  // Clear queue template wiring without introducing a component-wide DOM shim.
  it("renders an accessible server-queue action and invokes its callback", () => {
    const view = new ChatView();
    const onClearServerQueue = vi.fn();
    view.status = queuedStatus([{ kind: "steer", text: "server queued" }]);
    view.canClearServerQueue = true;
    view.onClearServerQueue = onClearServerQueue;

    const rendered = renderQueuedMessages(view);
    const markup = templateStaticMarkup(rendered);

    expect(markup).toContain('type="button"');
    expect(markup).toContain('title="Clear queued messages without stopping active work"');
    expect(markup).toContain(">Clear queue</button>");
    templateEventHandler(rendered, "Clear queue")(new Event("click"));
    expect(onClearServerQueue).toHaveBeenCalledOnce();
  });

  it("hides the action when the selected runtime does not support clearing", () => {
    const view = new ChatView();
    view.status = queuedStatus([{ kind: "followUp", text: "server queued" }]);
    view.canClearServerQueue = false;
    view.onClearServerQueue = vi.fn();

    expect(templateStaticMarkup(renderQueuedMessages(view))).not.toContain("Clear queue");
  });

  it("does not expose the server action for the separate client pending-start queue", () => {
    const view = new ChatView();
    view.status = queuedStatus([]);
    view.clientQueuedMessages = [{ kind: "followUp", text: "waiting for session start" }];
    view.canClearServerQueue = true;
    view.onClearServerQueue = vi.fn();

    expect(templateStaticMarkup(renderQueuedMessages(view))).not.toContain("Clear queue");
  });
});

describe("ChatView session warnings banner", () => {
  it("renders one severity-tagged row per warning with optional path and source", () => {
    const view = new ChatView();
    view.status = warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill", path: "/skills/a.md" },
      { severity: "warning", message: "subscription auth is active" },
      { severity: "info", message: "heads up", source: "runtime" },
    ]);

    const rendered = renderWarnings(view);
    if (rendered === null) throw new Error("expected a warnings banner");
    const markup = templateStaticMarkup(rendered);
    const values = collectStringValues(rendered);

    expect(markup).toContain('class="session-warnings"');
    expect(markup).toContain('role="alert"');
    expect(values).toContain("skill failed to load");
    expect(values).toContain("/skills/a.md");
    expect(values).toContain("subscription auth is active");
    expect(values).toContain("heads up");
    expect(values).toContain("skill");
    const severityClasses = values.filter((value) => value.startsWith("session-warning "));
    expect(severityClasses).toEqual(["session-warning error", "session-warning warning", "session-warning info"]);
  });

  it("renders nothing when there are no warnings", () => {
    const view = new ChatView();
    view.status = warningStatus([]);
    expect(renderWarnings(view)).toBeNull();
  });

  it("renders nothing when status is unset", () => {
    expect(renderWarnings(new ChatView())).toBeNull();
  });

  it("renders a dismiss control only for warnings carrying a dismiss capability", () => {
    const view = new ChatView();
    view.status = warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill" },
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]);

    const rendered = renderWarnings(view);
    if (rendered === null) throw new Error("expected a warnings banner");
    const markup = templateStaticMarkup(rendered);
    // One dismiss button total: only the warning with a dismiss capability gets one.
    expect(markup.match(/session-warning-dismiss/g)?.length).toBe(1);
  });

  // Direct handler extraction keeps this node-environment test focused on the
  // dismiss button wiring without a component-wide DOM shim.
  it("invokes onDismissWarning with the warning's dismiss id", () => {
    const view = new ChatView();
    const onDismissWarning = vi.fn();
    view.onDismissWarning = onDismissWarning;
    view.status = warningStatus([
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]);

    const rendered = renderWarnings(view);
    if (rendered === null) throw new Error("expected a warnings banner");
    templateEventHandler(rendered, "session-warning-dismiss")(new Event("click"));

    expect(onDismissWarning).toHaveBeenCalledExactlyOnceWith("anthropicExtraUsage");
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

describe("ChatView technical-event groups", () => {
  const messages: ChatLine[] = [
    { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "inspect a file" }] },
    { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "inspect a file", status: "success", resultText: "large result" }] },
  ];

  it("defers a closed body while retaining native disclosure and group scroll anchors", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);

    const closed = renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([]);
    expect(templateStaticMarkup(closed)).toContain("<details");
    expect(templateStaticMarkup(closed)).toContain("<summary>");
    expect(templateStaticMarkup(closed)).toContain('aria-hidden="true"');
    expect(templateValuesAfterMarker(closed, "?open=")).toEqual([false]);
    expect(templateValuesAfterMarker(closed, "data-scroll-anchor-id=")).toEqual(["g:40"]);
    expect(templateValuesAfterMarker(closed, "data-marker-id=")).toEqual(["g:41"]);
  });

  // Direct handler extraction keeps this node-environment test focused on the
  // native details toggle wiring without introducing a component-wide DOM shim.
  it("renders an opened body with event anchors and removes it when closed again", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);
    const initiallyClosed = renderMessageGroup(view, messages, 40, 41, false);

    dispatchDetailsToggle(templateEventHandler(initiallyClosed, "@toggle="), true);
    const opened = renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([{ messages, startIndex: 40 }]);
    expect(templateValuesAfterMarker(opened, "?open=")).toEqual([true]);
    expect(templateValuesAfterMarker(opened, "data-scroll-anchor-id=")).toEqual(["g:40", "e:40", "e:41"]);

    bodyCalls.length = 0;
    dispatchDetailsToggle(templateEventHandler(opened, "@toggle="), false);
    const closedAgain = renderMessageGroup(view, messages, 40, 41, false);

    expect(bodyCalls).toEqual([]);
    expect(templateValuesAfterMarker(closedAgain, "?open=")).toEqual([false]);
    expect(templateValuesAfterMarker(closedAgain, "data-scroll-anchor-id=")).toEqual(["g:40"]);
  });

  it("renders a live tail body by default", () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const bodyCalls = observeGroupBodyRenders(view);

    const live = renderMessageGroup(view, messages, 40, 41, true);

    expect(bodyCalls).toEqual([{ messages, startIndex: 40 }]);
    expect(templateValuesAfterMarker(live, "?open=")).toEqual([true]);
    expect(templateValues(live)).toContain("msg event-group live");
    expect(templateValues(live)).toContain("live events");
  });
});

interface GroupBodyRenderCall {
  messages: ChatLine[];
  startIndex: number;
}

type RenderQueuedMessages = (this: ChatView) => TemplateResult;
type RenderMessageGroup = (this: ChatView, messages: ChatLine[], startIndex: number, endIndex: number, defaultOpen: boolean) => TemplateResult;
type RenderMessageGroupBody = (this: ChatView, messages: ChatLine[], startIndex: number) => TemplateResult;
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

function templateEventHandler(template: TemplateResult, marker: string): TemplateEventHandler {
  let handler: TemplateEventHandler | undefined;
  visit(template);
  if (handler === undefined) throw new Error(`Expected template event handler near ${marker}`);
  return handler;

  function visit(value: unknown): void {
    if (handler !== undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isTemplateResult(value)) return;
    const strings = templateStrings(value);
    const values = templateValues(value);
    for (let index = 0; index < values.length; index += 1) {
      const candidate = values[index];
      const isNearMarker = strings[index]?.includes(marker) === true || strings[index + 1]?.includes(marker) === true;
      if (isNearMarker && isTemplateEventHandler(candidate)) {
        handler = candidate;
        return;
      }
      visit(candidate);
    }
  }
}

function isTemplateEventHandler(value: unknown): value is TemplateEventHandler {
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

function templateStaticMarkup(template: TemplateResult): string {
  const chunks: string[] = [];
  visit(template);
  return chunks.join("");

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isTemplateResult(value)) return;
    chunks.push(...templateStrings(value));
    for (const child of templateValues(value)) visit(child);
  }
}

function templateValuesAfterMarker(template: TemplateResult, marker: string): unknown[] {
  const matches: unknown[] = [];
  visit(template);
  return matches;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isTemplateResult(value)) return;
    const strings = templateStrings(value);
    const values = templateValues(value);
    for (let index = 0; index < values.length; index += 1) {
      if (strings[index]?.includes(marker) === true) matches.push(values[index]);
      visit(values[index]);
    }
  }
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function collectStringValues(template: TemplateResult): string[] {
  const found: string[] = [];
  visit(template);
  return found;

  function visit(value: unknown): void {
    if (typeof value === "string") {
      found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isTemplateResult(value)) return;
    for (const child of templateValues(value)) visit(child);
  }
}

type RenderWarnings = (this: ChatView) => TemplateResult | null;

function isRenderWarnings(value: unknown): value is RenderWarnings {
  return typeof value === "function";
}

function renderWarnings(view: ChatView): TemplateResult | null {
  const method: unknown = Reflect.get(view, "renderWarnings");
  if (!isRenderWarnings(method)) throw new Error("ChatView.renderWarnings is not callable");
  return method.call(view);
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
