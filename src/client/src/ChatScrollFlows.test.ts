// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_BEHAVIORS, type ChatBehaviors } from "./chatBehaviors";
import { MANUAL_CHAT_BEHAVIORS } from "./chatBehaviors.testSupport";
import { ChatScrollFlows, type ChatScrollAfterRender, type ChatScrollFrameScheduler } from "./ChatScrollFlows";
import { chatScrollStorageKey, type ChatScrollPosition, type ChatScrollScheduler, type ChatScrollStorage } from "./chatScrollPosition";

class ManualScheduler implements ChatScrollFrameScheduler, ChatScrollScheduler {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();
  readonly request = vi.fn((callback: () => void): number => {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  });
  readonly cancel = vi.fn((id: number): void => { this.callbacks.delete(id); });
  readonly setTimeout = vi.fn((callback: () => void, delay: number): number => {
    void delay;
    return this.request(callback);
  });
  readonly clearTimeout = vi.fn((id: number): void => { this.cancel(id); });

  get pending(): number {
    return this.callbacks.size;
  }

  flush(): void {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id);
      callback();
    }
  }
}

class MemoryStorage implements ChatScrollStorage {
  readonly values = new Map<string, string>();
  readonly getItem = vi.fn((key: string): string | null => this.values.get(key) ?? null);
  readonly setItem = vi.fn((key: string, value: string): void => { this.values.set(key, value); });
  readonly removeItem = vi.fn((key: string): void => { this.values.delete(key); });

  seed(sessionId: string, position: ChatScrollPosition): void {
    this.values.set(chatScrollStorageKey(sessionId), JSON.stringify(position));
  }
}

interface ScrollFixtureState {
  behaviors: ChatBehaviors;
  sessionId: string;
  top: number;
  height: number;
  viewport: number;
  anchors: HTMLElement[];
  openForm: HTMLElement | undefined;
  hasMore: boolean;
  ready: boolean;
  loading: boolean;
  canRequest: boolean;
}

function fixture(behaviors: ChatBehaviors = DEFAULT_CHAT_BEHAVIORS) {
  const frames = new ManualScheduler();
  const saves = new ManualScheduler();
  const storage = new MemoryStorage();
  const state: ScrollFixtureState = {
    behaviors,
    sessionId: "s1",
    top: 700,
    height: 1000,
    viewport: 300,
    anchors: [],
    openForm: undefined,
    hasMore: false,
    ready: true,
    loading: false,
    canRequest: true,
  };
  const scroller = document.createElement("div");
  const readTop = vi.fn(() => state.top);
  const readHeight = vi.fn(() => state.height);
  const readViewport = vi.fn(() => state.viewport);
  const writeTop = vi.fn((top: number) => { state.top = Math.max(0, Math.min(top, state.height - state.viewport)); });
  Object.defineProperties(scroller, {
    scrollTop: { get: readTop, set: writeTop },
    scrollHeight: { get: readHeight },
    clientHeight: { get: readViewport },
  });
  scroller.getBoundingClientRect = vi.fn(() => new DOMRect(0, 100, 600, state.viewport));
  const host = {
    getScroller: vi.fn(() => scroller),
    getAnchors: vi.fn(() => state.anchors),
    getScopeKey: () => state.sessionId,
    getBehaviors: () => state.behaviors,
    hasMore: () => state.hasMore,
    isHistoryReady: () => state.ready,
    isLoadingMore: () => state.loading,
    canRequestEarlier: () => state.canRequest,
    requestEarlier: vi.fn(() => { state.loading = true; }),
    getOpenForm: vi.fn(() => state.openForm),
    onFollowingChange: vi.fn(),
  };
  const flows = new ChatScrollFlows(host, frames, { storage, saveScheduler: saves });
  function element(contentTop: number, anchorId?: string): HTMLElement {
    const element = document.createElement("article");
    if (anchorId !== undefined) element.dataset["scrollAnchorId"] = anchorId;
    element.getBoundingClientRect = vi.fn(() => new DOMRect(0, 100 + contentTop - state.top, 600, 100));
    return element;
  }
  function update(change: Partial<ChatScrollAfterRender> = {}): void {
    flows.afterRender({ sessionChanged: false, contentChanged: true, historyChanged: false, openedForm: false, ...change });
  }
  function start(): void {
    flows.beforeRender({ sessionChanged: true, prepend: false });
    update({ sessionChanged: true });
  }
  return { flows, frames, saves, storage, state, host, element, update, start, readTop, readHeight, readViewport, writeTop };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatScrollFlows composition", () => {
  it("does no geometry, storage, or scheduled work when all flows are disabled", () => {
    const f = fixture(MANUAL_CHAT_BEHAVIORS);
    f.start();
    f.flows.configure();
    f.flows.onScroll();
    f.flows.onUpIntent();
    f.flows.onContentLayoutChanged();
    f.flows.onViewportResize();
    f.flows.savePosition();
    f.flows.restorePosition();
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.update({ historyChanged: true, openedForm: true });
    f.flows.beforeRender({ sessionChanged: true, previousScopeKey: "s1", prepend: false });
    f.update({ sessionChanged: true });
    f.flows.dispose();
    f.frames.flush();
    f.saves.flush();

    expect(f.host.getScroller).not.toHaveBeenCalled();
    expect(f.host.getAnchors).not.toHaveBeenCalled();
    expect(f.host.getOpenForm).not.toHaveBeenCalled();
    expect(f.readTop).not.toHaveBeenCalled();
    expect(f.readHeight).not.toHaveBeenCalled();
    expect(f.readViewport).not.toHaveBeenCalled();
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.frames.request).not.toHaveBeenCalled();
    expect(f.saves.setTimeout).not.toHaveBeenCalled();
    expect(f.storage.getItem).not.toHaveBeenCalled();
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.host.requestEarlier).not.toHaveBeenCalled();
  });

  it("always permits explicit top/end jumps, even with all flows off", () => {
    const f = fixture(MANUAL_CHAT_BEHAVIORS);
    f.flows.jumpToTop();
    expect(f.state.top).toBe(0);
    f.flows.jumpToEnd();
    expect(f.state.top).toBe(700);
    expect(f.flows.followingLive).toBe(false);
    expect(f.host.onFollowingChange).not.toHaveBeenCalled();
    expect(f.frames.request).not.toHaveBeenCalled();
    expect(f.saves.setTimeout).not.toHaveBeenCalled();
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it("starts at the tail by default and follows updates until upward navigation", () => {
    const f = fixture();
    f.state.top = 150;
    f.start();
    f.frames.flush();
    expect(f.state.top).toBe(700);
    f.state.height = 1300;
    f.update();
    f.frames.flush();
    expect(f.state.top).toBe(1000);

    f.state.top = 200;
    f.flows.onScroll();
    expect(f.flows.followingLive).toBe(false);
    f.state.height = 1500;
    f.update();
    f.frames.flush();
    expect(f.state.top).toBe(200);

    f.state.top = 1200;
    f.flows.onScroll();
    f.state.height = 1600;
    f.update();
    f.frames.flush();
    expect(f.state.top).toBe(1300);
  });

  it("restores an anchor with the existing codec and does not replace it with a tail jump", () => {
    const f = fixture();
    f.state.top = 0;
    f.state.anchors = [f.element(400, "m:4")];
    f.storage.seed("s1", { mode: "anchor", anchorId: "m:4", offset: -20 });
    f.start();
    f.flows.onContentLayoutChanged();
    expect(f.frames.pending).toBe(1); // Only the selected position's restore frame.
    f.frames.flush();
    expect(f.state.top).toBe(420);
    expect(f.flows.followingLive).toBe(false);
    f.state.height += 200;
    f.update();
    f.frames.flush();
    expect(f.state.top).toBe(420);
    expect(f.storage.getItem).toHaveBeenCalledWith(chatScrollStorageKey("s1"));
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it("restores saved bottom mode and keeps following", () => {
    const f = fixture();
    f.state.top = 0;
    f.storage.seed("s1", { mode: "bottom" });
    f.start();
    f.frames.flush();
    f.state.height = 1800;
    f.update();
    f.frames.flush();
    expect(f.state.top).toBe(1500);
    expect(f.flows.followingLive).toBe(true);
  });

  it("does not choose a default position when memory is on but follow is off", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, rememberPosition: true });
    f.state.top = 180;
    f.start();
    expect(f.storage.getItem).toHaveBeenCalledOnce();
    expect(f.frames.request).not.toHaveBeenCalled();
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.state.top).toBe(180);
  });

  it("saves the previous route using old DOM, cancels old saves, and restores the new route", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, rememberPosition: true });
    f.state.top = 250;
    f.state.anchors = [f.element(240, "old")];
    f.flows.onScroll();
    f.storage.seed("s2", { mode: "anchor", anchorId: "new", offset: 10 });
    f.state.sessionId = "s2";
    f.flows.beforeRender({ sessionChanged: true, previousScopeKey: "s1", prepend: false });
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify({ mode: "anchor", anchorId: "old", offset: -10 }));
    expect(f.saves.pending).toBe(0);
    f.state.top = 0;
    f.state.anchors = [f.element(300, "new")];
    f.update({ sessionChanged: true });
    f.frames.flush();
    f.saves.flush();
    expect(f.state.top).toBe(290);
    expect(f.storage.setItem).toHaveBeenCalledOnce();
  });

  it("cancels the previous route's queued restoration without overwriting its selection", () => {
    const f = fixture();
    const previous: ChatScrollPosition = { mode: "anchor", anchorId: "previous", offset: 0 };
    f.storage.seed("s1", previous);
    f.storage.seed("s2", { mode: "anchor", anchorId: "next", offset: 0 });
    f.state.anchors = [f.element(100, "previous")];
    f.start();
    f.state.sessionId = "s2";
    f.flows.beforeRender({ sessionChanged: true, previousScopeKey: "s1", prepend: false });
    f.state.anchors = [f.element(300, "next")];
    f.update({ sessionChanged: true });
    f.frames.flush();
    expect(f.state.top).toBe(300);
    expect(f.writeTop).toHaveBeenCalledOnce();
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify(previous));
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it("enabling flows live initializes pinning without restoring, jumping, saving, or paging", () => {
    const f = fixture(MANUAL_CHAT_BEHAVIORS);
    f.state.top = 200;
    f.start();
    f.storage.seed("s1", { mode: "bottom" });
    f.state.behaviors = DEFAULT_CHAT_BEHAVIORS;
    f.state.hasMore = true;
    f.flows.configure();
    expect(f.flows.followingLive).toBe(false);
    expect(f.frames.request).not.toHaveBeenCalled();
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.storage.getItem).not.toHaveBeenCalled();
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.saves.setTimeout).not.toHaveBeenCalled();
    expect(f.host.requestEarlier).not.toHaveBeenCalled();
  });
});

describe("position flow", () => {
  it("debounces saves and cancels them when memory is disabled", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, rememberPosition: true });
    f.state.top = 200;
    f.state.anchors = [f.element(200, "m:2")];
    f.flows.onScroll();
    f.state.top = 250;
    f.flows.onScroll();
    expect(f.saves.pending).toBe(1);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.saves.flush();
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify({ mode: "anchor", anchorId: "m:2", offset: -50 }));

    f.flows.onScroll();
    f.state.behaviors = MANUAL_CHAT_BEHAVIORS;
    f.flows.configure();
    f.saves.flush();
    f.flows.savePosition();
    f.flows.dispose();
    expect(f.storage.setItem).toHaveBeenCalledOnce();
    expect(f.saves.pending).toBe(0);
  });

  it("requests one page for a missing saved anchor, then retries after history updates", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, rememberPosition: true });
    const saved: ChatScrollPosition = { mode: "anchor", anchorId: "old", offset: -10 };
    f.storage.seed("s1", saved);
    f.state.hasMore = true;
    f.state.top = 400;
    f.start();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
    expect(f.state.top).toBe(400);
    f.flows.onScroll();
    f.flows.savePosition();
    f.saves.flush();
    f.update();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
    expect(f.storage.setItem).not.toHaveBeenCalled();

    f.state.loading = false;
    f.update({ historyChanged: true });
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledTimes(2);
    f.state.loading = false;
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height += 200;
    f.state.anchors = [f.element(100, "old")];
    f.update({ historyChanged: true });
    f.frames.flush();
    expect(f.state.top).toBe(110);
    expect(f.writeTop).toHaveBeenCalledOnce();
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify(saved));
    expect(f.host.requestEarlier).toHaveBeenCalledTimes(2);
  });

  it("waits for initial history before treating a remembered anchor as gone", () => {
    const f = fixture(); f.state.ready = false; f.state.top = 200;
    f.storage.seed("s1", { mode: "anchor", anchorId: "old", offset: -10 });
    f.start(); f.frames.flush();
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.host.requestEarlier).not.toHaveBeenCalled();
    f.state.ready = true; f.state.anchors = [f.element(100, "old")];
    f.update({ historyChanged: true }); f.frames.flush();
    expect(f.state.top).toBe(110);
    expect(f.writeTop).toHaveBeenCalledOnce();
  });

  it("ends restoration without moving when the remembered anchor is absent from complete history", () => {
    const f = fixture();
    f.state.top = 200;
    const saved: ChatScrollPosition = { mode: "anchor", anchorId: "removed", offset: 12 };
    f.storage.seed("s1", saved);
    f.start(); f.frames.flush();
    expect(f.state.top).toBe(200);
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.host.requestEarlier).not.toHaveBeenCalled();
    f.flows.savePosition();
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify(saved));
    f.state.height = 1300; f.update(); f.frames.flush();
    expect(f.state.top).toBe(200);
    // Restoration has ended: a subsequent valid reading position can be saved.
    f.state.anchors = [f.element(200, "current")];
    f.flows.savePosition();
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify({ mode: "anchor", anchorId: "current", offset: 0 }));
    // Missing restoration does not prevent one manual return to bottom from
    // entering the separate tail-follow mode.
    f.state.top = 1000; f.flows.onScroll();
    expect(f.flows.followingLive).toBe(true);
  });

  it.each([false, true])("user intent cancels delayed restoration independently of followTail=%s", (followTail) => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, rememberPosition: true, followTail });
    f.state.hasMore = true;
    f.storage.seed("s1", { mode: "anchor", anchorId: "old", offset: 12 });
    f.start(); f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
    f.flows.onInteraction();
    f.state.top = 350; f.flows.onScroll();
    f.state.loading = false; f.state.anchors = [f.element(100, "old")];
    f.update({ historyChanged: true }); f.frames.flush();
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.state.top).toBe(350);
  });

  it("resumes following when one manual scroll reaches bottom after canceling restoration", () => {
    const f = fixture();
    f.state.top = 200;
    f.state.anchors = [f.element(100, "saved")];
    f.storage.seed("s1", { mode: "anchor", anchorId: "saved", offset: 0 });
    f.start();
    f.flows.onInteraction();
    f.state.top = 700; f.flows.onScroll();
    expect(f.flows.followingLive).toBe(true);
    expect(f.host.onFollowingChange.mock.calls).toEqual([[true]]);
    f.state.height += 100;
    f.update(); f.frames.flush();
    expect(f.state.top).toBe(800);
    expect(f.writeTop).toHaveBeenCalledOnce();
  });

  it("retains an unavailable user-selected position while earlier history is still available", () => {
    const f = fixture();
    const saved: ChatScrollPosition = { mode: "anchor", anchorId: "unavailable", offset: 12 };
    f.state.hasMore = true;
    f.storage.seed("s1", saved);
    f.start();
    f.frames.flush();
    f.flows.onScroll();
    f.saves.flush();
    f.flows.dispose();
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify(saved));
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.writeTop).not.toHaveBeenCalled();

    const route = fixture();
    route.state.hasMore = true;
    route.storage.seed("s1", saved);
    route.start();
    route.frames.flush();
    route.state.sessionId = "s2";
    route.flows.beforeRender({ sessionChanged: true, previousScopeKey: "s1", prepend: false });
    expect(route.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify(saved));
    expect(route.storage.setItem).not.toHaveBeenCalled();
  });

  it("an explicit jump supersedes queued restoration and saves the selected destination", () => {
    const f = fixture();
    f.storage.seed("s1", { mode: "anchor", anchorId: "old", offset: 0 });
    f.state.anchors = [f.element(200, "old")];
    f.start();
    f.flows.jumpToEnd();
    f.frames.flush();
    f.saves.flush();
    expect(f.state.top).toBe(700);
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify({ mode: "bottom" }));
  });
});

describe("tail and forms", () => {
  it.each([false, true])("keeps following through bottom rebound (content grows during bounce: %s)", (growsDuringBounce) => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start(); f.frames.flush();
    f.state.top = 720; f.flows.onScroll();
    if (growsDuringBounce) {
      f.state.height += 100; f.update();
    }
    for (const top of [710, 700]) {
      f.state.top = top;
      f.flows.onScroll();
      expect(f.flows.followingLive).toBe(true);
    }
    if (!growsDuringBounce) {
      f.state.height += 100; f.update();
    }
    f.frames.flush();
    expect(f.state.top).toBe(800);
    expect(f.host.onFollowingChange.mock.calls).toEqual([[true]]);
  });

  it("does not cancel a queued follow-scroll when content growth emits a stationary scroll", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start(); f.frames.flush();
    f.state.height += 150;
    f.update();
    f.flows.onScroll();
    expect(f.flows.followingLive).toBe(true);
    expect(f.frames.pending).toBe(1);
    f.frames.flush();
    expect(f.state.top).toBe(850);
  });

  it("coalesces layout-change notifications into one cancellable follow-scroll", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start(); f.frames.flush();
    f.writeTop.mockClear();
    f.state.height += 500;
    f.flows.onContentLayoutChanged();
    f.flows.onContentLayoutChanged();
    expect(f.frames.pending).toBe(1);
    expect(f.writeTop).not.toHaveBeenCalled();
    f.frames.flush();
    expect(f.state.top).toBe(1200);
    expect(f.writeTop).toHaveBeenCalledOnce();
    expect(f.flows.followingLive).toBe(true);

    f.state.height += 100;
    f.flows.onContentLayoutChanged();
    f.flows.onUpIntent(); f.frames.flush();
    expect(f.state.top).toBe(1200);
    expect(f.writeTop).toHaveBeenCalledOnce();
    expect(f.flows.followingLive).toBe(false);
  });

  it("leaves a paused reading viewport alone after a layout-change notification", () => {
    const f = fixture();
    f.start(); f.frames.flush();
    f.flows.onUpIntent();
    f.state.top = 200; f.flows.onScroll();
    f.writeTop.mockClear(); f.host.requestEarlier.mockClear();
    f.state.height += 500;
    f.flows.onContentLayoutChanged(); f.frames.flush();
    expect(f.state.top).toBe(200);
    expect(f.flows.followingLive).toBe(false);
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.host.requestEarlier).not.toHaveBeenCalled();
    expect(f.frames.pending).toBe(0);
  });

  it("does not change modes because layout changed the scroll range or anchored position", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start(); f.frames.flush();
    f.state.height = 1200;
    f.state.top = 600;
    f.flows.onScroll();
    expect(f.flows.followingLive).toBe(true);
    f.update(); f.frames.flush();
    expect(f.state.top).toBe(900);

    f.flows.onUpIntent();
    f.state.top = 200; f.flows.onScroll();
    f.state.height = 1500;
    f.state.top = 1200; f.flows.onScroll(); // Layout anchoring, not a manual bottom return.
    f.update(); f.frames.flush();
    expect(f.flows.followingLive).toBe(false);
    expect(f.state.top).toBe(1200);
  });

  it("resumes only after scrolling down to the actual bottom, not a nearby or stationary event", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start(); f.frames.flush();
    f.flows.onUpIntent();
    f.flows.onScroll();
    expect(f.flows.followingLive).toBe(false);
    for (const top of [650, 670, 698]) {
      f.state.top = top; f.flows.onScroll();
      expect(f.flows.followingLive).toBe(false);
    }
    f.state.top = 699; f.flows.onScroll();
    expect(f.flows.followingLive).toBe(true);
    f.state.height += 100;
    f.update(); f.frames.flush();
    expect(f.state.top).toBe(800);
  });

  it("reports mode transitions only and never treats the end arrow as an off switch", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start(); f.frames.flush();
    f.flows.onScroll(); f.flows.jumpToEnd();
    f.flows.onUpIntent(); f.flows.onUpIntent();
    f.state.top = 600; f.flows.onScroll();
    f.state.top = 500; f.flows.onScroll();
    f.flows.jumpToEnd(); f.flows.jumpToEnd();
    expect(f.flows.followingLive).toBe(true);
    expect(f.host.onFollowingChange.mock.calls).toEqual([[true], [false], [true]]);
    f.state.behaviors = MANUAL_CHAT_BEHAVIORS;
    f.flows.configure(); f.flows.jumpToEnd();
    expect(f.flows.followingLive).toBe(false);
    expect(f.host.onFollowingChange.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it.each(["intent", "native"])("cancels a queued tail jump on upward %s, even close to the bottom", (input) => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start();
    f.frames.flush();
    f.state.height += 10;
    f.update();
    const writes = f.writeTop.mock.calls.length;
    if (input === "intent") f.flows.onUpIntent();
    else {
      f.state.top -= 1;
      f.flows.onScroll();
    }
    expect(f.flows.followingLive).toBe(false);
    f.frames.flush();
    expect(f.writeTop).toHaveBeenCalledTimes(writes);
    expect(f.frames.pending).toBe(0);
  });

  it("aligns the oldest open form at startup or on opening, not on ordinary content updates", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.state.openForm = f.element(400);
    f.start();
    f.frames.flush();
    expect(f.state.top).toBe(400);
    expect(f.flows.followingLive).toBe(false);
    f.update({ openedForm: true });
    f.frames.flush();
    expect(f.state.top).toBe(400);

    f.flows.jumpToEnd();
    f.state.openForm = f.element(500);
    f.update({ openedForm: true });
    f.frames.flush();
    expect(f.state.top).toBe(500);
    expect(f.host.getOpenForm).toHaveBeenCalledTimes(2);

    f.flows.jumpToEnd();
    f.state.height += 100;
    f.update();
    f.frames.flush();
    expect(f.state.top).toBe(800);
    expect(f.host.getOpenForm).toHaveBeenCalledTimes(2);
  });

  it("keeps form alignment as the single destination through coalesced stream and resize notifications", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start(); f.frames.flush();
    f.writeTop.mockClear();
    f.state.openForm = f.element(500);
    f.update({ openedForm: "dialog" });
    f.state.height += 300;
    f.update();
    f.flows.onViewportResize();
    f.flows.onContentLayoutChanged();
    f.frames.flush();
    expect(f.state.top).toBe(500);
    expect(f.writeTop).toHaveBeenCalledOnce();
    expect(f.host.getOpenForm).toHaveBeenLastCalledWith("dialog");
    expect(f.flows.followingLive).toBe(false);
  });

  it("a remembered position takes priority over an already open form", () => {
    const f = fixture();
    f.storage.seed("s1", { mode: "anchor", anchorId: "selected", offset: 0 });
    f.state.anchors = [f.element(200, "selected")];
    f.state.openForm = f.element(500);
    f.start();
    f.frames.flush();
    expect(f.state.top).toBe(200);
    expect(f.host.getOpenForm).not.toHaveBeenCalled();
  });

  it("follows viewport resizing only while following live", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true });
    f.start();
    f.frames.flush();
    f.state.viewport = 200;
    f.flows.onViewportResize();
    f.frames.flush();
    expect(f.state.top).toBe(800);
    f.flows.onUpIntent();
    f.state.viewport = 100;
    f.flows.onViewportResize();
    f.frames.flush();
    expect(f.state.top).toBe(800);
  });
});

describe("automatic history", () => {
  it("does not schedule frames during scrolling far from the top, even with earlier history", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, automaticHistory: true });
    f.state.hasMore = true;
    for (const top of [700, 650, 600]) { f.state.top = top; f.flows.onScroll(); }
    expect(f.frames.request).not.toHaveBeenCalled();
    expect(f.readHeight).not.toHaveBeenCalled();
    expect(f.readViewport).not.toHaveBeenCalled();
  });

  it.each([
    { top: 64, hasMore: true, loading: false, canRequest: true, calls: 1 },
    { top: 65, hasMore: true, loading: false, canRequest: true, calls: 0 },
    { top: 0, hasMore: false, loading: false, canRequest: true, calls: 0 },
    { top: 0, hasMore: true, loading: true, canRequest: true, calls: 0 },
    { top: 0, hasMore: true, loading: false, canRequest: false, calls: 0 },
  ])("uses only the top threshold and request guards: %j", (scenario) => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, automaticHistory: true });
    f.state.top = scenario.top;
    f.state.hasMore = scenario.hasMore;
    f.state.loading = scenario.loading;
    f.state.canRequest = scenario.canRequest;
    f.flows.onScroll();
    f.flows.onScroll();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledTimes(scenario.calls);
    expect(f.readHeight).not.toHaveBeenCalled();
    expect(f.readViewport).not.toHaveBeenCalled();
    expect(f.writeTop).not.toHaveBeenCalled();
  });

  it("loads once per visit to the top, even when a page adds no visible height", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, automaticHistory: true });
    f.state.hasMore = true;
    f.state.top = 0;
    f.flows.onScroll();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
    f.state.loading = false;
    f.update({ historyChanged: true });
    f.flows.onScroll();
    f.flows.onViewportResize();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
    f.state.top = 100;
    f.flows.onScroll();
    f.state.top = 0;
    f.flows.onScroll();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledTimes(2);
  });

  it("allows automatic loading again after switching sessions", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, automaticHistory: true });
    f.state.hasMore = true;
    f.state.top = 0;
    f.start();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
    f.state.sessionId = "s2";
    f.state.loading = false;
    f.flows.beforeRender({ sessionChanged: true, previousScopeKey: "s1", prepend: false });
    f.update({ sessionChanged: true });
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledTimes(2);
  });

  it("leaves the in-flight guard to the host and never prefetches for viewport size", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, automaticHistory: true });
    f.state.hasMore = true;
    f.state.top = 0;
    f.flows.onScroll();
    f.frames.flush();
    f.update({ historyChanged: true });
    f.flows.onViewportResize();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
    f.state.loading = false;
    f.state.top = 65;
    f.state.height = 250;
    f.state.viewport = 300;
    f.update({ historyChanged: true });
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
  });
});

describe("prepend and cleanup", () => {
  it("preserves position against an offscreen durable anchor", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    f.start();
    f.state.top = 400;
    f.state.anchors = [f.element(100, "durable"), f.element(400)];
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height += 300;
    f.state.anchors = [f.element(400, "durable"), f.element(700)];
    f.update({ historyChanged: true });
    f.frames.flush();
    expect(f.state.top).toBe(700);
    expect(f.writeTop).toHaveBeenCalledOnce();
  });

  it("does not correct a prepend when no durable anchor exists", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    f.start(); f.state.top = 200;
    f.state.anchors = [f.element(180)];
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height += 300;
    f.update({ historyChanged: true });
    f.frames.flush();
    expect(f.state.top).toBe(200);
    expect(f.writeTop).not.toHaveBeenCalled();
  });

  it("preserves the visible message through child rendering, independently of tail growth", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    f.start();
    f.state.top = 200;
    f.state.anchors = [f.element(180, "reading")];
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height = 1300;
    f.state.anchors = [f.element(480, "reading")];
    f.update({ historyChanged: true });
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.frames.pending).toBe(1);
    // Prepending child content adds another 50px before the frame; a live
    // response adds 100px below the message. Only the former moves our anchor.
    f.state.height += 150;
    f.state.anchors = [f.element(530, "reading")];
    f.frames.flush();
    expect(f.state.top).toBe(550);
    expect(f.state.anchors[0]?.getBoundingClientRect().top).toBe(80);
    expect(f.writeTop).toHaveBeenCalledOnce();
    expect(f.frames.pending).toBe(0);
    f.state.height += 100;
    f.flows.onContentLayoutChanged();
    f.frames.flush();
    expect(f.writeTop).toHaveBeenCalledOnce();
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it("finishes prepend correction before considering another automatic history request", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true, automaticHistory: true });
    f.state.top = 0;
    f.state.hasMore = true;
    f.state.loading = true;
    f.state.anchors = [f.element(10, "reading")];
    f.start();
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.loading = false;
    f.state.height += 300;
    f.state.anchors = [f.element(310, "reading")];
    f.update({ historyChanged: true });
    f.flows.onScroll();
    f.flows.onViewportResize();
    expect(f.frames.pending).toBe(1);
    f.frames.flush();
    expect(f.state.top).toBe(300);
    expect(f.host.requestEarlier).not.toHaveBeenCalled();
    expect(f.frames.pending).toBe(0);
  });

  it("preserves the first reading anchor across multiple prepends before one viewport commit", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    f.state.top = 200;
    f.state.anchors = [f.element(200, "reading")];
    f.start();
    f.frames.flush();

    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height += 100;
    f.state.anchors = [f.element(300, "reading")];
    f.update({ historyChanged: true });
    // Another render arrives before children/layout settle. Its visible offset
    // is not a new reading choice and must not replace the original snapshot.
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height += 1150; // 150 above the reader; 1000 at the live tail.
    f.state.anchors = [f.element(450, "reading")];
    f.update({ historyChanged: true, openedForm: true });
    f.flows.onViewportResize();
    f.frames.flush();

    expect(f.state.top).toBe(450);
    expect(f.writeTop).toHaveBeenCalledOnce();
    expect(f.frames.pending).toBe(0);
  });

  it("does not double-adjust a viewport already anchored by the browser", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    f.start();
    f.state.top = 200;
    f.state.anchors = [f.element(180, "reading")];
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height += 300;
    f.state.anchors = [f.element(480, "reading")];
    f.update({ historyChanged: true });
    f.state.top = 500;
    f.frames.flush();
    expect(f.state.top).toBe(500);
  });

  it("does not reclaim the viewport after user interaction", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    f.start(); f.state.top = 200;
    f.state.anchors = [f.element(180, "reading")];
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height = 1300;
    f.state.anchors = [f.element(480, "reading")];
    f.update({ historyChanged: true });
    f.flows.onInteraction();
    f.state.top = 160; f.frames.flush();
    expect(f.writeTop).not.toHaveBeenCalled();
  });

  it("does not jump elsewhere when the captured message disappears", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, anchorPrepends: true });
    f.start(); f.state.top = 200;
    f.state.anchors = [f.element(180, "reading")];
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height += 300;
    f.state.anchors = [];
    f.update({ historyChanged: true });
    f.frames.flush();
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.frames.pending).toBe(0);
  });

  type Feature = "rememberPosition" | "followTail" | "automaticHistory" | "anchorPrepends";
  const features: Feature[] = ["rememberPosition", "followTail", "automaticHistory", "anchorPrepends"];
  it.each(features)("cancels queued %s work independently when disabled", (feature) => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, [feature]: true });
    f.state.top = 0;
    f.state.hasMore = true;
    if (feature === "rememberPosition") f.storage.seed("s1", { mode: "bottom" });
    f.start();
    if (feature === "anchorPrepends") {
      f.state.anchors = [f.element(0, "reading")];
      f.flows.beforeRender({ sessionChanged: false, prepend: true });
      f.state.height += 200;
      f.update({ historyChanged: true });
    }
    expect(f.frames.pending).toBe(1);
    f.state.behaviors = MANUAL_CHAT_BEHAVIORS;
    f.flows.configure();
    f.frames.flush();
    expect(f.frames.pending).toBe(0);
    expect(f.writeTop).not.toHaveBeenCalled();
    expect(f.host.requestEarlier).not.toHaveBeenCalled();
  });

  it("disabling one flow leaves another flow's queued work intact", () => {
    const f = fixture({ ...MANUAL_CHAT_BEHAVIORS, followTail: true, automaticHistory: true });
    f.state.top = 0;
    f.state.hasMore = true;
    f.start();
    f.state.behaviors = { ...f.state.behaviors, followTail: false };
    f.flows.configure();
    f.frames.flush();
    expect(f.host.requestEarlier).toHaveBeenCalledOnce();
    expect(f.writeTop).not.toHaveBeenCalled();
  });

  it("disposes all queued work, flushes current memory once, and ignores later delegates", () => {
    const f = fixture();
    f.start();
    f.frames.flush();
    f.state.hasMore = true;
    f.state.top = 0;
    f.state.anchors = [f.element(0, "current")];
    f.flows.onScroll();
    f.flows.beforeRender({ sessionChanged: false, prepend: true });
    f.state.height += 200;
    f.update({ historyChanged: true });
    const writes = f.writeTop.mock.calls.length;
    f.flows.dispose();
    f.flows.dispose();
    f.flows.onScroll();
    f.flows.onUpIntent();
    f.flows.onContentLayoutChanged();
    f.flows.onViewportResize();
    f.flows.configure();
    f.flows.restorePosition();
    f.flows.savePosition();
    f.flows.jumpToEnd();
    f.flows.jumpToTop();
    f.update();
    f.frames.flush();
    f.saves.flush();
    expect(f.frames.pending).toBe(0);
    expect(f.saves.pending).toBe(0);
    expect(f.storage.setItem).toHaveBeenCalledOnce();
    expect(f.storage.values.get(chatScrollStorageKey("s1"))).toBe(JSON.stringify({ mode: "anchor", anchorId: "current", offset: 0 }));
    expect(f.writeTop).toHaveBeenCalledTimes(writes);
    expect(f.host.requestEarlier).not.toHaveBeenCalled();
  });
});
