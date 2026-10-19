// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { DEFAULT_CHAT_BEHAVIORS, type ChatBehaviors } from "../chatBehaviors";
import { PLAIN_CODE_BLOCK_POLICY } from "../formatting/codeBlockPolicy";
import { MANUAL_CHAT_BEHAVIORS } from "../chatBehaviors.testSupport";
import { groupStorageKey } from "../chatDisclosure";
import { transcriptViewFromHistory } from "../chatTranscriptStore";
import { ChatView, CHAT_CHROME_VISIBILITY_EVENT, type ChatChromeVisibilityDetail } from "./ChatView";
import { controlledChatViewport } from "./chatScroll.testSupport";
import type { ChatLine } from "./shared";
import type { TranscriptImage } from "./TranscriptImage";
import type { FormattedText } from "./FormattedText";
import { nativeImage, settleImage } from "./imagePresentation.testSupport";

const messages: ChatLine[] = [
  { entryId: "thought-entry", role: "assistant", parts: [{ type: "thinking", text: "A technical body" }] },
  { entryId: "compaction-entry", role: "assistant", source: "compaction", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] },
  { entryId: "reply-entry", role: "assistant", parts: [{ type: "text", text: "A normal reply" }] },
];
let frames: Map<number, FrameRequestCallback>;
let frameId: number;

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map(); frameId = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frameId += 1; frames.set(frameId, callback); return frameId;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
});
afterEach(() => {
  document.body.replaceChildren(); localStorage.clear();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function mount(behaviors: ChatBehaviors = DEFAULT_CHAT_BEHAVIORS) {
  const view = new ChatView();
  view.behaviors = behaviors; view.sessionId = "behaviors-test";
  view.messageTotal = messages.length; view.messages = messages;
  document.body.append(view); await view.updateComplete;
  return view;
}
function isChromeVisibilityEvent(event: Event): event is CustomEvent<ChatChromeVisibilityDetail> {
  return "detail" in event;
}
function required(root: ParentNode, selector: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Expected ${selector}`);
  return node;
}
function flushFrames(): void {
  const batch = [...frames.values()]; frames.clear();
  for (const callback of batch) callback(0);
}

// Controlled collaborators prove effects; happy-dom provides no real geometry.
function scrollingViewport(view: ChatView, initialTop = 2445) {
  const chat = required(view.renderRoot, ".chat");
  let top = initialTop;
  const write = vi.fn((value: number) => { top = Math.max(0, Math.min(value, 5700)); });
  Object.defineProperties(chat, {
    clientHeight: { value: 300 }, scrollHeight: { value: 6000 },
    scrollTop: { get: () => top, set: write },
  });
  return { chat, write, move: (value: number) => { top = value; chat.dispatchEvent(new Event("scroll")); } };
}

describe("composable normal chat", () => {
  it("keeps default conveniences and explicit small navigation controls, without a meter", async () => {
    const view = await mount();
    expect(view.behaviors.rememberPosition).toBe(true);
    expect(view.behaviors.followTail).toBe(true);
    expect(view.behaviors.automaticHistory).toBe(true);
    expect(view.renderRoot.querySelector("conversation-meter, .scroll-marker")).toBeNull();
    expect(required(view.renderRoot, '.chat-jumps [aria-label="Jump to top"]').textContent).toBe("↑");
    expect(required(view.renderRoot, '.chat-jumps [aria-label="Jump to end"]').textContent).toBe("↓");
  });

  it("can render navigation in another surface while retaining scroll behavior and follow state", async () => {
    const view = await mount();
    const viewport = scrollingViewport(view);
    const controls = document.createElement("div");
    document.body.append(controls);
    view.onNavigationChange = (navigation) => { render(navigation, controls); };
    await view.updateComplete;
    expect(view.renderRoot.querySelector(".chat-jumps")).toBeNull();
    required(controls, '[aria-label="Jump to top"]').click();
    flushFrames();
    expect(viewport.write).toHaveBeenLastCalledWith(0);
    required(controls, '[aria-label="Jump to end"]').click();
    flushFrames();
    expect(viewport.write).toHaveBeenLastCalledWith(6000);
    await view.updateComplete;
    expect(required(controls, '[aria-label="Jump to end"]').classList.contains("following")).toBe(true);
    view.behaviors = { ...view.behaviors, followTail: false };
    await view.updateComplete;
    expect(required(controls, '[aria-label="Jump to end"]').title).toBe("Jump to end");
  });

  it("keeps closed disclosure bodies mounted and records toggles without rerendering", async () => {
    const view = await mount();
    const group = required(view.renderRoot, ".event-group");
    if (!(group instanceof HTMLDetailsElement)) throw new Error("Expected native details");
    const body = required(group, ".group-body");
    const image = required(group, "pi-web-transcript-image");
    expect(group.open).toBe(false);
    expect(required(body, ".thinking > summary").textContent).toContain("Thinking");
    const render = vi.spyOn(view, "render");
    group.open = true; group.dispatchEvent(new Event("toggle"));
    group.open = false; group.dispatchEvent(new Event("toggle"));
    await view.updateComplete;
    expect(required(group, ".group-body")).toBe(body);
    expect(required(group, "pi-web-transcript-image")).toBe(image);
    expect(render).not.toHaveBeenCalled();
    expect(localStorage.getItem(groupStorageKey(view.sessionId))).not.toBeNull();
  });

  it.each([false, true])("keeps skill loading in activity and opens only the live tail by default (streaming: %s)", async (streaming) => {
    const view = await mount({ ...DEFAULT_CHAT_BEHAVIORS, rememberDisclosures: false });
    view.isSendingPrompt = streaming;
    view.messages = [{ role: "skill", entryId: "load-skill", parts: [{ type: "skillRead", name: "ux-writing", path: "/skills/ux-writing/SKILL.md" }] }];
    await view.updateComplete;
    const group = required(view.renderRoot, ".event-group");
    expect(group.hasAttribute("open")).toBe(streaming);
    expect(required(group, ".skill-read").textContent).toContain("Loaded ux-writing");
    expect(view.renderRoot.querySelector("article.skill")).toBeNull();
    expect(group.querySelector(".conversation-message")).toBeNull();
  });

  it("identifies thinking and failed tool results inside an initially collapsed activity group", async () => {
    const view = await mount();
    view.messages = [
      { role: "assistant", parts: [{ type: "thinking", text: "Check the file first." }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "File not found", isError: true }] },
      { role: "assistant", parts: [{ type: "text", text: "The file was not found." }] },
    ];
    await view.updateComplete;
    const group = required(view.renderRoot, ".event-group");
    const thinking = required(group, ".thinking");
    const result = required(group, ".tool-result");
    expect(group).toBeInstanceOf(HTMLDetailsElement);
    expect(group.hasAttribute("open")).toBe(false);
    expect(required(thinking, "summary").textContent).toContain("Thinking");
    expect(thinking.hasAttribute("open")).toBe(true);
    expect(required(result, "summary").textContent).toContain("read result · Failed");
    expect(result.hasAttribute("open")).toBe(true);
  });

  it.each([false, true])("expands thinking by default while only opening the live outer group (live: %s)", async (live) => {
    const view = await mount();
    view.messages = [{ role: "assistant", entryId: "default-thinking", parts: [{ type: "thinking", text: "Plan the work." }] }];
    view.isSendingPrompt = live;
    await view.updateComplete;
    expect(required(view.renderRoot, ".event-group").hasAttribute("open")).toBe(live);
    expect(required(view.renderRoot, ".thinking").hasAttribute("open")).toBe(true);
  });

  it.each([true, false])("keeps thinking individually collapsible and remembers its choice only when enabled (%s)", async (rememberDisclosures) => {
    const behaviors = { ...DEFAULT_CHAT_BEHAVIORS, rememberDisclosures };
    const view = await mount(behaviors);
    const thinking = required(view.renderRoot, ".thinking");
    if (!(thinking instanceof HTMLDetailsElement)) throw new Error("Expected thinking disclosure");
    const render = vi.spyOn(view, "render");
    thinking.open = false;
    thinking.dispatchEvent(new Event("toggle"));
    expect(render).not.toHaveBeenCalled();
    view.messages = [...view.messages];
    await view.updateComplete;
    expect(required(view.renderRoot, ".thinking").hasAttribute("open")).toBe(false);
    view.remove();

    const restored = await mount(behaviors);
    expect(required(restored.renderRoot, ".thinking").hasAttribute("open")).toBe(!rememberDisclosures);
    restored.sessionId = "another-session";
    await restored.updateComplete;
    expect(required(restored.renderRoot, ".thinking").hasAttribute("open")).toBe(true);
  });

  it("keeps a remembered collapse scoped to its entry when earlier thinking is prepended", async () => {
    const view = await mount();
    const thinking = required(view.renderRoot, ".thinking");
    if (!(thinking instanceof HTMLDetailsElement)) throw new Error("Expected thinking disclosure");
    thinking.open = false;
    thinking.dispatchEvent(new Event("toggle"));
    view.messages = [{ role: "assistant", entryId: "earlier-thinking", parts: [{ type: "thinking", text: "Earlier plan." }] }, ...view.messages];
    await view.updateComplete;
    const entries = view.renderRoot.querySelectorAll<HTMLDetailsElement>(".thinking");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.open).toBe(true);
    expect(entries[1]?.open).toBe(false);
  });

  it("reveals a hidden chrome when the host pins it for a view a scroll cannot restore", async () => {
    const view = await mount();
    const viewport = scrollingViewport(view, 900);
    const events: ChatChromeVisibilityDetail[] = [];
    view.addEventListener(CHAT_CHROME_VISIBILITY_EVENT, (event) => { if (isChromeVisibilityEvent(event)) events.push(event.detail); });
    // The first scroll sample restores the session baseline instead of toggling.
    viewport.move(900);
    viewport.move(1500);
    expect(events.at(-1)).toEqual({ hidden: true });

    view.chromePinned = true;
    await view.updateComplete;
    expect(events.at(-1)).toEqual({ hidden: false });

    // The pinned chrome is the only route back to the view that pinned it, so
    // further scrolling must not slide it away again.
    viewport.move(2000);
    expect(events.at(-1)).toEqual({ hidden: false });
  });

  it.each([true, false])("follows native group and nested toggles without rerendering (remember choices: %s)", async (rememberDisclosures) => {
    const view = await mount({ ...DEFAULT_CHAT_BEHAVIORS, rememberDisclosures });
    const { metrics, write } = controlledChatViewport(view);
    flushFrames(); await view.updateComplete;
    write.mockClear();
    const render = vi.spyOn(view, "render");
    const group = required(view.renderRoot, ".event-group");
    const nested = required(group, ".group-body details.part");
    if (!(group instanceof HTMLDetailsElement) || !(nested instanceof HTMLDetailsElement)) throw new Error("Expected native disclosures");

    group.open = true; metrics.height = 2500;
    group.dispatchEvent(new Event("toggle", { bubbles: false }));
    expect(write).not.toHaveBeenCalled();
    flushFrames();
    expect(write).toHaveBeenNthCalledWith(1, 2500);

    nested.open = true; metrics.height = 3000;
    nested.dispatchEvent(new Event("toggle", { bubbles: false }));
    flushFrames();
    expect(write).toHaveBeenNthCalledWith(2, 3000);

    group.open = false; metrics.height = 2000;
    metrics.top = Math.min(metrics.top, metrics.height - 300); // Native collapse can clamp the viewport.
    group.dispatchEvent(new Event("toggle", { bubbles: false }));
    flushFrames(); await view.updateComplete;
    expect(write).toHaveBeenNthCalledWith(3, 2000);
    expect(write).toHaveBeenCalledTimes(3);
    expect(required(view.renderRoot, '[aria-label="Jump to end"]').classList.contains("following")).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });

  it("follows a height change from a block expanded inside a nested shadow root", async () => {
    // Tool cards and rendered markdown expand a disclosure inside their own
    // shadow root, so the native toggle never reaches the transcript. The
    // ResizeObserver over the transcript's blocks is what keeps follow-scroll
    // aware of that height change.
    const triggers: (() => void)[] = [];
    class FakeResizeObserver {
      readonly observed = new Set<Element>();
      constructor(private readonly callback: ResizeObserverCallback) {
        triggers.push(() => { this.callback([], this); });
      }
      observe(target: Element): void { this.observed.add(target); }
      unobserve(target: Element): void { this.observed.delete(target); }
      disconnect(): void { this.observed.clear(); }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const view = await mount();
    const { metrics, write } = controlledChatViewport(view);
    flushFrames(); await view.updateComplete;
    write.mockClear();
    const trigger = triggers.at(-1);
    if (trigger === undefined) throw new Error("Expected a transcript ResizeObserver");

    metrics.height = 2600;
    trigger();
    flushFrames();

    expect(write).toHaveBeenCalledWith(2600);
  });

  it.each(["paused", "disabled"])("leaves disclosure layout alone when following is %s", async (mode) => {
    const view = await mount({ ...DEFAULT_CHAT_BEHAVIORS, followTail: mode !== "disabled" });
    const { metrics, write } = controlledChatViewport(view);
    flushFrames();
    if (mode === "paused") required(view.renderRoot, ".chat").dispatchEvent(new WheelEvent("wheel", { deltaY: -10 }));
    await view.updateComplete;
    metrics.top = 400; write.mockClear();
    const group = required(view.renderRoot, ".event-group");
    if (!(group instanceof HTMLDetailsElement)) throw new Error("Expected native disclosure");
    group.open = true; metrics.height += 500;
    group.dispatchEvent(new Event("toggle", { bubbles: false }));
    flushFrames(); await view.updateComplete;
    expect(write).not.toHaveBeenCalled();
    expect(metrics.top).toBe(400);
    expect(frames.size).toBe(0);
    expect(required(view.renderRoot, '[aria-label="Jump to end"]').classList.contains("following")).toBe(false);
  });

  it("anchors an actual history prepend to the message being read", async () => {
    const view = await mount({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    view.messageStart = 100;
    await view.updateComplete;
    const { chat, write } = scrollingViewport(view, 10);
    chat.getBoundingClientRect = () => new DOMRect(0, 100, 600, 300);
    const reading = required(view.renderRoot, 'article[data-index="102"]');
    let messageTop = 0;
    // Controlled geometry at the DOM boundary; happy-dom does not lay out text.
    reading.getBoundingClientRect = () => new DOMRect(0, 100 + messageTop - chat.scrollTop, 600, 100);

    view.messages = [{ role: "user", parts: [{ type: "text", text: "Earlier message" }] }, ...messages];
    view.messageStart = 99;
    await view.updateComplete;
    expect(required(view.renderRoot, 'article[data-index="102"]')).toBe(reading);
    expect(write).not.toHaveBeenCalled();
    messageTop = 300;
    flushFrames();
    expect(write).toHaveBeenCalledExactlyOnceWith(310);
    expect(reading.getBoundingClientRect().top).toBe(90);
  });

  it("preserves entry identity when raw pages normalize to fewer displayed messages", async () => {
    const raw = [
      { entryId: "reading-entry", role: "user", content: "The message being read" },
      { entryId: "empty-entry", role: "assistant", content: "" },
    ];
    const initial = transcriptViewFromHistory({ messages: raw, start: 100, total: 102 });
    const view = await mount({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    view.messages = initial.messages;
    view.messageStart = initial.messagePageStart;
    await view.updateComplete;
    const { chat, write } = scrollingViewport(view, 10);
    chat.getBoundingClientRect = () => new DOMRect(0, 100, 600, 300);
    const reading = required(view.renderRoot, 'article[data-index="100"]');
    const anchorId = reading.dataset["scrollAnchorId"];
    let messageTop = 0;
    reading.getBoundingClientRect = () => new DOMRect(0, 100 + messageTop - chat.scrollTop, 600, 100);

    const prepended = transcriptViewFromHistory({
      start: 97, total: 102,
      messages: [
        { entryId: "call-entry", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } }] },
        { entryId: "result-entry", role: "toolResult", toolCallId: "call-1", toolName: "read", content: "File contents" },
        { entryId: "older-entry", role: "user", content: "Earlier question" },
        ...raw,
      ],
    });
    // Three raw entries become only two extra displayed messages.
    expect(prepended.messages.length - initial.messages.length).toBe(2);
    view.messages = prepended.messages;
    view.messageStart = prepended.messagePageStart;
    await view.updateComplete;
    expect(required(view.renderRoot, 'article[data-index="99"]')).toBe(reading);
    expect(reading.dataset["scrollAnchorId"]).toBe(anchorId);
    messageTop = 300;
    flushFrames();
    expect(write).toHaveBeenCalledExactlyOnceWith(310);
    expect(reading.getBoundingClientRect().top).toBe(90);
  });

  it("preserves a collapsed first group when earlier events merge into it", async () => {
    const view = await mount({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    view.messageStart = 100;
    await view.updateComplete;
    const { chat, write } = scrollingViewport(view, 20);
    chat.getBoundingClientRect = () => new DOMRect(0, 100, 600, 300);
    const oldGroup = required(view.renderRoot, ".event-group");
    oldGroup.getBoundingClientRect = () => new DOMRect(0, 110, 600, 50);
    // Older events merge with the two technical entries at indexes 100–101.
    view.messages = [
      { role: "user", parts: [{ type: "text", text: "Earlier question" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "Earlier thinking" }] },
      ...messages,
    ];
    view.messageStart = 98;
    await view.updateComplete;
    const mergedGroup = required(view.renderRoot, ".event-group");
    expect(mergedGroup).not.toBe(oldGroup);
    mergedGroup.getBoundingClientRect = () => new DOMRect(0, 430 - chat.scrollTop, 600, 50);
    flushFrames();
    expect(write).toHaveBeenCalledExactlyOnceWith(320);
    expect(mergedGroup.getBoundingClientRect().top).toBe(110);
  });

  it("can disable every scroll/disclosure effect while keeping manual navigation", async () => {
    const view = await mount(MANUAL_CHAT_BEHAVIORS);
    const { chat, write, move } = scrollingViewport(view);
    expect(frames.size).toBe(0);
    move(2300);
    required(view.renderRoot, ".event-group").dispatchEvent(new Event("toggle"));
    await vi.advanceTimersByTimeAsync(500);
    expect(frames.size).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    required(view.renderRoot, '[aria-label="Jump to top"]').click(); flushFrames();
    expect(chat.scrollTop).toBe(0);
    required(view.renderRoot, '[aria-label="Jump to end"]').click(); flushFrames();
    expect(chat.scrollTop).toBe(5700);
  });

  it("does not rerender or enqueue animation frames for steady-state scrolling", async () => {
    const view = await mount();
    const { move } = scrollingViewport(view);
    flushFrames();
    move(2400); await view.updateComplete;
    frames.clear();
    const render = vi.spyOn(view, "render");
    for (const top of [2350, 2300, 2250]) move(top);
    await view.updateComplete;
    expect(render).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("shows live-follow mode and resumes it through the end arrow or returning to the bottom", async () => {
    const view = await mount();
    const { chat, move } = scrollingViewport(view, 5700);
    flushFrames(); await view.updateComplete;
    const end = required(view.renderRoot, '[aria-label="Jump to end"]');
    expect(end.getAttribute("aria-describedby")).toBe("chat-follow-state");
    const state = required(view.renderRoot, "#chat-follow-state");
    expect(end.classList.contains("following")).toBe(true);
    expect(state.textContent).toBe("Following live");

    chat.dispatchEvent(new WheelEvent("wheel", { deltaY: -10 }));
    await view.updateComplete;
    expect(end.classList.contains("following")).toBe(false);
    expect(state.textContent).toBe("Live following paused");
    expect(end.title).toBe("Jump to end and follow live");
    move(5650); move(5670); await view.updateComplete;
    expect(end.classList.contains("following")).toBe(false);
    move(5700); await view.updateComplete;
    expect(end.classList.contains("following")).toBe(true);

    required(view.renderRoot, '[aria-label="Jump to top"]').click();
    await view.updateComplete;
    expect(chat.scrollTop).toBe(0);
    expect(end.classList.contains("following")).toBe(false);
    end.click(); await view.updateComplete;
    expect(chat.scrollTop).toBe(5700);
    expect(end.classList.contains("following")).toBe(true);
    end.click(); await view.updateComplete;
    expect(end.classList.contains("following")).toBe(true);

    view.behaviors = { ...view.behaviors, followTail: false };
    await view.updateComplete;
    end.click(); await view.updateComplete;
    expect(end.classList.contains("following")).toBe(false);
    expect(end.title).toBe("Jump to end");
    expect(state.textContent).toBe("Automatic following disabled");
  });

  it("pauses on an upward touch reversal even before the finger crosses its starting point", async () => {
    const view = await mount();
    const { chat } = scrollingViewport(view, 5700);
    flushFrames(); await view.updateComplete;
    const end = required(view.renderRoot, '[aria-label="Jump to end"]');
    const touch = (type: string, y: number) => {
      chat.dispatchEvent(new TouchEvent(type, { touches: [new Touch({ identifier: 1, target: chat, clientY: y })] }));
    };
    touch("touchstart", 100);
    touch("touchmove", 80);
    await view.updateComplete;
    expect(end.classList.contains("following")).toBe(true);
    touch("touchmove", 90);
    await view.updateComplete;
    expect(end.classList.contains("following")).toBe(false);
    chat.dispatchEvent(new TouchEvent("touchcancel"));
    end.click(); await view.updateComplete;
    touch("touchmove", 110);
    await view.updateComplete;
    expect(end.classList.contains("following")).toBe(true);
  });

  it("propagates the image switch into persistent normal-chat disclosure bodies", async () => {
    const view = await mount({ ...DEFAULT_CHAT_BEHAVIORS, loadImages: false });
    const image = view.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image");
    if (image === null) throw new Error("Expected transcript image");
    const presentation = await settleImage(image);
    const native = nativeImage(presentation);
    expect(native.hasAttribute("src")).toBe(false);
    view.behaviors = DEFAULT_CHAT_BEHAVIORS; await view.updateComplete; await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
    expect(native.src).toBe("data:image/png;base64,QUJD");
  });

  it("defaults to horizontally scrolling code with Copy in every Markdown surface and retains independent rollbacks, including closed groups", async () => {
    const view = await mount();
    const text = "```text\nfirst\n  second\n```";
    view.clientQueuedMessages = [{ kind: "followUp", text }];
    view.messages = [{ role: "assistant", parts: [
      { type: "text", text },
      { type: "thinking", text },
      { type: "skillInvocation", name: "skill", location: "/skill", content: text },
      { type: "toolResult", toolName: "read", text, isError: false },
    ] }];
    await view.updateComplete;
    expect(view.behaviors.codeBlocks).toEqual({ presentation: "code", overflow: "scroll", copy: true, previews: true });
    const formatted = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
    expect(formatted).toHaveLength(5);
    await Promise.all(formatted.map((element) => element.updateComplete));
    for (const element of formatted) {
      expect(element.codeBlocks).toBe(view.behaviors.codeBlocks);
      expect(element.renderRoot.querySelector("pre code")?.textContent).toBe("first\n  second\n");
      expect(element.renderRoot.querySelectorAll(".code-block-wrapper")).toHaveLength(1);
      expect(element.renderRoot.querySelectorAll(".code-copy-button")).toHaveLength(1);
      expect(element.renderRoot.querySelector(".plain-code-block, pi-web-content-renderer")).toBeNull();
      expect(element.renderRoot.querySelector(".formatted")?.classList.contains("code-blocks-scroll")).toBe(true);
    }

    const copyButtons = formatted.map((element) => element.renderRoot.querySelector(".code-copy-button"));
    view.behaviors = { ...view.behaviors, codeBlocks: { ...view.behaviors.codeBlocks, overflow: "wrap" } };
    await view.updateComplete;
    await Promise.all(formatted.map((element) => element.updateComplete));
    formatted.forEach((element, index) => {
      expect(element.codeBlocks).toBe(view.behaviors.codeBlocks);
      expect(element.renderRoot.querySelector(".code-blocks-scroll, pi-web-content-renderer")).toBeNull();
      expect(element.renderRoot.querySelector(".code-copy-button")).toBe(copyButtons[index]);
    });

    view.behaviors = { ...view.behaviors, codeBlocks: PLAIN_CODE_BLOCK_POLICY };
    await view.updateComplete;
    await Promise.all(formatted.map((element) => element.updateComplete));
    for (const element of formatted) {
      expect(element.codeBlocks).toBe(PLAIN_CODE_BLOCK_POLICY);
      expect(element.renderRoot.querySelector(".plain-code-block")?.textContent).toBe("first\n  second\n");
      expect(element.renderRoot.querySelector("pre, .code-block-wrapper, .code-copy-button, .code-blocks-scroll, pi-web-content-renderer")).toBeNull();
    }

    view.behaviors = { ...DEFAULT_CHAT_BEHAVIORS, codeBlocks: { ...DEFAULT_CHAT_BEHAVIORS.codeBlocks, overflow: "wrap", copy: false, previews: false } };
    await view.updateComplete;
    await Promise.all(formatted.map((element) => element.updateComplete));
    for (const element of formatted) {
      expect(element.codeBlocks).toBe(view.behaviors.codeBlocks);
      expect(element.renderRoot.querySelector("pre code")?.textContent).toBe("first\n  second\n");
      expect(element.renderRoot.querySelector(".code-block-label")?.textContent).toBe("text");
      expect(element.renderRoot.querySelector(".code-copy-button, .code-blocks-scroll, pi-web-content-renderer")).toBeNull();
    }

    view.behaviors = DEFAULT_CHAT_BEHAVIORS;
    await view.updateComplete;
    await Promise.all(formatted.map((element) => element.updateComplete));
    for (const element of formatted) {
      expect(element.codeBlocks).toBe(view.behaviors.codeBlocks);
      expect(element.renderRoot.querySelectorAll(".code-copy-button")).toHaveLength(1);
      expect(element.renderRoot.querySelector("pi-web-content-renderer")).toBeNull();
      expect(element.renderRoot.querySelector(".formatted")?.classList.contains("code-blocks-scroll")).toBe(true);
    }
  });

  it("applies CSS simplification independently of scrolling capabilities", async () => {
    const view = await mount({ ...DEFAULT_CHAT_BEHAVIORS, visualEffects: false });
    expect(required(view.renderRoot, ".chat-wrap").classList.contains("plain")).toBe(true);
    expect(view.behaviors.followTail).toBe(true);
    view.behaviors = DEFAULT_CHAT_BEHAVIORS; await view.updateComplete;
    expect(required(view.renderRoot, ".chat-wrap").classList.contains("plain")).toBe(false);
  });
});
