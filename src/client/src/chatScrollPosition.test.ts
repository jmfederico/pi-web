import { describe, expect, it } from "vitest";
import { ChatScrollController, captureScrollPosition, chatScrollStorageKey, findScrollAnchor, type ChatScrollElement, type ChatScrollScheduler, type ChatScrollStorage, type ChatScrollViewport } from "./chatScrollPosition";

class MemoryScrollStorage implements ChatScrollStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class ManualScheduler implements ChatScrollScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(id: number): void {
    this.callbacks.delete(id);
  }

  run(id: number): void {
    const callback = this.callbacks.get(id);
    if (callback === undefined) return;
    this.callbacks.delete(id);
    callback();
  }

  runAll(): void {
    const ids = [...this.callbacks.keys()];
    for (const id of ids) this.run(id);
  }
}

class FakeScroller implements ChatScrollViewport {
  constructor(
    public scrollTop: number,
    public scrollHeight: number,
    public clientHeight: number,
    private readonly top: number,
    private readonly bottom: number,
  ) {}

  getBoundingClientRect(): Pick<DOMRectReadOnly, "top" | "bottom"> {
    return { top: this.top, bottom: this.bottom };
  }
}

class FakeArticle implements ChatScrollElement {
  readonly dataset: { readonly scrollAnchorId?: string | undefined };

  constructor(
    private readonly top: number,
    private readonly bottom: number,
    anchorId?: string,
  ) {
    this.dataset = {
      ...(anchorId === undefined ? {} : { scrollAnchorId: anchorId }),
    };
  }

  getBoundingClientRect(): Pick<DOMRectReadOnly, "top" | "bottom"> {
    return { top: this.top, bottom: this.bottom };
  }
}

describe("ChatScrollController", () => {
  it("skips saving while the scroll viewport is hidden", () => {
    const storage = new MemoryScrollStorage();
    const controller = new ChatScrollController(storage, new ManualScheduler());
    const key = chatScrollStorageKey("s1");
    storage.setItem(key, "old");

    const result = controller.savePosition("s1", new FakeScroller(0, 0, 0, 0, 0), [new FakeArticle(0, 10, "m:0")]);

    expect(result).toBe("skipped");
    expect(storage.getItem(key)).toBe("old");
  });

  it("saves and restores the visible anchor nearest the viewport top", () => {
    const storage = new MemoryScrollStorage();
    const controller = new ChatScrollController(storage, new ManualScheduler());
    const scroller = new FakeScroller(200, 1000, 300, 100, 400);
    const anchors = [
      new FakeArticle(-600, 350, "g:1"),
      new FakeArticle(80, 170, "e:6"),
      new FakeArticle(220, 280, "m:7"),
    ];

    expect(controller.savePosition("s1", scroller, anchors)).toBe("saved");
    expect(JSON.parse(storage.getItem(chatScrollStorageKey("s1")) ?? "{}")).toEqual({ mode: "anchor", anchorId: "e:6", offset: -20 });

    scroller.scrollTop = 500;
    const rerenderedAnchors = [
      new FakeArticle(-500, 360, "g:1"),
      new FakeArticle(130, 210, "e:6"),
      new FakeArticle(250, 310, "m:7"),
    ];

    expect(controller.restorePosition("s1", scroller, rerenderedAnchors)).toEqual({ status: "restored" });
    expect(scroller.scrollTop).toBe(550);
  });

  it("leaves the viewport unchanged when a stored anchor is missing", () => {
    const storage = new MemoryScrollStorage();
    const controller = new ChatScrollController(storage, new ManualScheduler());
    const position = { mode: "anchor", anchorId: "m:4", offset: 20 };
    storage.setItem(chatScrollStorageKey("s1"), JSON.stringify(position));
    const scroller = new FakeScroller(100, 900, 300, 0, 300);

    expect(controller.restorePosition("s1", scroller, [new FakeArticle(10, 40, "m:9")])).toEqual({ status: "missing", position });
    expect(scroller.scrollTop).toBe(100);
  });

  it("saves and restores an offscreen anchor without requiring viewport intersection", () => {
    const storage = new MemoryScrollStorage();
    const controller = new ChatScrollController(storage, new ManualScheduler());
    const scroller = new FakeScroller(200, 1000, 300, 100, 400);
    expect(controller.savePosition("s1", scroller, [new FakeArticle(-100, -50, "m:durable")])).toBe("saved");
    expect(controller.readPosition("s1")).toEqual({ mode: "anchor", anchorId: "m:durable", offset: -200 });
    expect(controller.restorePosition("s1", scroller, [new FakeArticle(50, 80, "m:durable")])).toEqual({ status: "restored" });
    expect(scroller.scrollTop).toBe(350);
  });

  it("does not save or restore an unidentified position", () => {
    const storage = new MemoryScrollStorage();
    const controller = new ChatScrollController(storage, new ManualScheduler());
    const scroller = new FakeScroller(100, 900, 300, 0, 300);
    expect(controller.savePosition("s1", scroller, [new FakeArticle(10, 40)])).toBe("skipped");
    expect(controller.readPosition("s1")).toBeUndefined();
    expect(controller.restorePosition("s1", scroller, [])).toEqual({ status: "skipped" });
    expect(scroller.scrollTop).toBe(100);
  });

  it("saves explicit bottom mode when the user is at the bottom", () => {
    const storage = new MemoryScrollStorage();
    const controller = new ChatScrollController(storage, new ManualScheduler());
    const key = chatScrollStorageKey("s1");
    storage.setItem(key, "old");

    expect(controller.savePosition("s1", new FakeScroller(699, 1000, 300, 0, 300), [new FakeArticle(0, 30, "m:0")])).toBe("saved");
    expect(JSON.parse(storage.getItem(key) ?? "{}")).toEqual({ mode: "bottom" });
  });

  it("cancels the previous delayed save and passes the latest session id", () => {
    const scheduler = new ManualScheduler();
    const controller = new ChatScrollController(new MemoryScrollStorage(), scheduler);
    const saved: string[] = [];

    controller.scheduleSave("s1", (sessionId) => { saved.push(sessionId); });
    controller.scheduleSave("s2", (sessionId) => { saved.push(sessionId); });
    scheduler.runAll();

    expect(saved).toEqual(["s2"]);
  });
});

describe("chat scroll helpers", () => {
  it("does not restore to a zero-height anchor retained inside a closed disclosure", () => {
    const controller = new ChatScrollController(new MemoryScrollStorage(), new ManualScheduler());
    const scroller = new FakeScroller(200, 1000, 100, 100, 200);
    const hidden = new FakeArticle(0, 0, "e:4");
    const position = { mode: "anchor" as const, anchorId: "e:4", offset: -20 };
    expect(controller.restoreExplicitPosition(position, scroller, [hidden])).toEqual({ status: "missing", position });
    expect(scroller.scrollTop).toBe(200);
  });

  it("finds the visible scroll anchor nearest the viewport top", () => {
    const scroller = new FakeScroller(0, 1000, 100, 100, 200);
    const wrapper = new FakeArticle(-500, 180, "g:0");
    const firstChild = new FakeArticle(90, 130, "e:0");
    const secondChild = new FakeArticle(140, 180, "e:1");

    expect(findScrollAnchor(scroller, [wrapper, firstChild, secondChild])).toBe(firstChild);
  });

  it("uses the nearest offscreen anchor when no durable anchor is visible", () => {
    const scroller = new FakeScroller(200, 1000, 100, 100, 200);
    const above = new FakeArticle(20, 50, "m:above");
    const below = new FakeArticle(220, 250, "m:below");
    const transient = new FakeArticle(100, 180);
    const hidden = new FakeArticle(0, 0, "m:hidden");

    expect(findScrollAnchor(scroller, [hidden, transient, above, below])).toBe(above);
    expect(findScrollAnchor(scroller, [hidden, transient])).toBeUndefined();
    // Equal distance is resolved by DOM order, independent of array sorting.
    const tiedBelow = new FakeArticle(180, 200, "m:tied");
    const shortViewport = new FakeScroller(200, 1000, 50, 100, 150);
    expect(findScrollAnchor(shortViewport, [above, tiedBelow])).toBe(above);
  });

  it("prefers a visible anchor over a closer offscreen anchor", () => {
    const scroller = new FakeScroller(200, 1000, 100, 100, 200);
    const above = new FakeArticle(80, 90, "m:above");
    const visible = new FakeArticle(180, 200, "m:visible");
    expect(findScrollAnchor(scroller, [above, visible])).toBe(visible);
  });

  it("captures an anchor-relative scroll position", () => {
    expect(captureScrollPosition(new FakeScroller(0, 1000, 100, 100, 200), new FakeArticle(140, 180, "m:3"))).toEqual({ mode: "anchor", anchorId: "m:3", offset: 40 });
  });
});
