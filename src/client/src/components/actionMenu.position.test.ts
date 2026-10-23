// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();

import { trustApi } from "../api";
import { ProjectList } from "./ProjectList";
import { WorkspaceList } from "./WorkspaceList";
import { SessionList } from "./SessionList";

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let viewport: EventTarget;
const resizeCallbacks = new Set<() => void>();

beforeEach(() => {
  viewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: window.innerWidth, height: window.innerHeight });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    private readonly notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => { callback([], this); };
      resizeCallbacks.add(this.notify);
    }
    observe(): void { /* Layout is supplied by the test. */ }
    unobserve(): void { /* No per-element subscriptions needed in this fake. */ }
    disconnect(): void { resizeCallbacks.delete(this.notify); }
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.spyOn(trustApi, "workspaceTrust").mockResolvedValue({ path: "/repo/a", decision: true, trusted: true });
});

afterEach(() => {
  document.body.replaceChildren();
  frames.clear();
  resizeCallbacks.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function runFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

function makeList(kind: string): ProjectList | WorkspaceList | SessionList {
  if (kind === "project") {
    const list = new ProjectList();
    list.projects = ["a", "b"].map((id) => ({ id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04" }));
    list.onMove = () => { list.projects = [...list.projects].reverse(); };
    return list;
  }
  if (kind === "workspace") {
    const list = new WorkspaceList();
    list.workspaces = ["a", "b"].map((id) => ({ id, projectId: "project", path: `/repo/${id}`, label: id, isMain: true, effectiveConfig: {} }));
    list.onMove = () => { list.workspaces = [...list.workspaces].reverse(); };
    return list;
  }
  const list = new SessionList();
  list.sessions = ["a", "b"].map((id) => ({ id, path: `/sessions/${id}.jsonl`, cwd: "/repo", created: "2026-06-04", modified: "2026-06-04", messageCount: 1, firstMessage: id, persisted: true }));
  list.pinnedRootIds = ["a", "b"];
  list.onMovePin = () => { list.pinnedRootIds = [...list.pinnedRootIds].reverse(); };
  return list;
}

async function settle(list: ProjectList | WorkspaceList | SessionList): Promise<void> {
  await list.updateComplete;
  await list.updateComplete;
}

describe("open action menu positioning", () => {
  it.each(["project", "workspace", "session"])("tracks the %s button after moves and keyboard layout changes, then stops on close", async (kind) => {
    const list = makeList(kind);
    const shell = document.createElement("div");
    const scroller = document.createElement("div");
    shell.attachShadow({ mode: "open" }).append(scroller);
    scroller.append(list);
    document.body.append(shell);
    await settle(list);
    const toggle = list.shadowRoot?.querySelector<HTMLButtonElement>(".action-menu-toggle");
    if (!toggle) throw new Error("Missing action toggle");
    let bottom = 100;
    // Simulate layout at the browser boundary; happy-dom does not lay out rows.
    vi.spyOn(toggle, "getBoundingClientRect").mockImplementation(() => new DOMRect(20, bottom - 30, 30, 30));
    toggle.click();
    await settle(list);
    const menu = (): HTMLElement | null | undefined => list.shadowRoot?.querySelector<HTMLElement>(".action-menu-panel");
    expect(menu()?.style.top).toBe("100px");
    expect(frames.size).toBe(0);

    bottom = 150;
    const move = [...(menu()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent.trim() === "Move down");
    if (!move) throw new Error("Missing move action");
    move.click();
    await settle(list);
    expect(menu()?.style.top).toBe("150px");

    // Keyboard dismissal can move the trigger without a component update.
    bottom = 200;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    runFrame();
    await settle(list);
    expect(menu()?.style.top).toBe("200px");
    expect(frames.size).toBe(0);

    const requestUpdate = vi.spyOn(list, "requestUpdate");
    viewport.dispatchEvent(new Event("resize"));
    runFrame();
    await settle(list);
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);

    bottom = 220;
    toggle.parentElement?.dispatchEvent(new Event("scroll", { bubbles: false, composed: false }));
    expect(frames.size).toBe(1);
    runFrame();
    await settle(list);
    expect(menu()?.style.top).toBe("220px");

    bottom = 225;
    scroller.dispatchEvent(new Event("scroll", { bubbles: false, composed: false }));
    expect(frames.size).toBe(1);
    runFrame();
    await settle(list);
    expect(menu()?.style.top).toBe("225px");

    bottom = 230;
    for (const notify of resizeCallbacks) notify();
    expect(frames.size).toBe(1);
    runFrame();
    await settle(list);
    expect(menu()?.style.top).toBe("230px");
    expect(frames.size).toBe(0);

    const otherToggle = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-toggle") ?? [])].find((button) => button !== toggle);
    if (!otherToggle) throw new Error("Missing second action toggle");
    vi.spyOn(otherToggle, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 320, 30, 30));
    otherToggle.click();
    await settle(list);
    expect(menu()?.style.top).toBe("350px");
    expect(frames.size).toBe(0);
    toggle.click();
    await settle(list);
    expect(menu()?.style.top).toBe("230px");

    viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    document.body.click();
    await settle(list);
    expect(menu()).toBeNull();
    expect(frames.size).toBe(0);
    expect(resizeCallbacks.size).toBe(0);
    viewport.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);
    toggle.click();
    await settle(list);
    expect(frames.size).toBe(0);
    viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    list.remove();
    expect(frames.size).toBe(0);
    expect(resizeCallbacks.size).toBe(0);
    viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(0);

    bottom = 250;
    document.body.append(list);
    await settle(list);
    expect(menu()).toBeNull();
    toggle.click();
    await settle(list);
    expect(menu()?.style.top).toBe("250px");
    expect(frames.size).toBe(0);
    bottom = 300;
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    runFrame();
    await settle(list);
    expect(menu()?.style.top).toBe("300px");
  });
});
