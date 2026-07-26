/**
 * TEMPORARY on-device scroll diagnostics (remove after the touch-scroll stall
 * investigation). Enabled with `?scrolldiag=1` in the URL. Renders a small
 * read-only overlay on top of the app showing a timeline of every event that
 * could interrupt a touch scroll, and flags abrupt scroll stops, so an iPad
 * user can reproduce the stall and screenshot the overlay.
 */

interface DiagEvent {
  t: number;
  kind: string;
  detail: string;
}

const MAX_EVENTS = 200;
const STALL_GAP_MS = 450;
const FAST_SCROLL_DELTA_PX = 80;

function findChatView(): Element | undefined {
  return document.querySelector("pi-web-app")?.shadowRoot?.querySelector("chat-view") ?? undefined;
}

interface ScrollTopAccessors {
  get: (this: Element) => number;
  set: (this: Element, value: number) => void;
}

function isScrollTopDescriptor(desc: PropertyDescriptor | undefined): desc is PropertyDescriptor & ScrollTopAccessors {
  return desc?.get !== undefined && desc.set !== undefined;
}

function pinnedState(chatView: Element): string {
  return "pinnedToBottom" in chatView && typeof chatView.pinnedToBottom === "boolean" ? String(chatView.pinnedToBottom) : "?";
}

function shadowChat(chatView: Element): HTMLElement | undefined {
  const chat = chatView.shadowRoot?.querySelector(".chat");
  return chat instanceof HTMLElement ? chat : undefined;
}

export function installScrollDiagnostics(): void {
  const events: DiagEvent[] = [];
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;max-width:92vw;max-height:45vh;overflow:hidden;background:#000c;color:#0f6;font:10px/1.35 ui-monospace,monospace;padding:8px;border-radius:8px;pointer-events:none;white-space:pre-wrap;";
  document.body.appendChild(overlay);

  let scrollTopAtLastEvent = -1;
  let lastScrollEventT = 0;
  let lastScrollDelta = 0;
  let touchActive = false;
  let stallCount = 0;

  const render = () => {
    const lines = events.slice(-16).map((event) => `${String(event.t).padStart(7)} ${event.kind.padEnd(14)} ${event.detail}`);
    overlay.textContent = `stalls: ${String(stallCount)}\n${lines.join("\n")}`;
  };

  const log = (kind: string, detail: string) => {
    events.push({ t: Math.round(performance.now()), kind, detail });
    if (events.length > MAX_EVENTS) events.splice(0, 50);
    render();
  };

  const watchChat = (chatView: Element): void => {
    const chat = shadowChat(chatView);
    if (chat === undefined) return;

    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (isScrollTopDescriptor(desc)) {
      Object.defineProperty(chat, "scrollTop", {
        configurable: true,
        get: function (this: Element) { return desc.get.call(this); },
        set: function (this: Element, value: number) {
          const stack = new Error("scrollTop").stack?.split("\n").slice(2, 5).join(" <= ") ?? "";
          log("WRITE scrollTop", `${String(Math.round(desc.get.call(this)))} -> ${String(Math.round(value))} :: ${stack.slice(0, 140)}`);
          desc.set.call(this, value);
        },
      });
    }

    chat.addEventListener("scroll", () => {
      const top = Math.round(chat.scrollTop);
      const now = performance.now();
      if (scrollTopAtLastEvent >= 0) lastScrollDelta = Math.abs(top - scrollTopAtLastEvent);
      scrollTopAtLastEvent = top;
      lastScrollEventT = now;
      log("scroll", `top=${String(top)} pinned=${pinnedState(chatView)}`);
    }, { passive: true });
    chat.addEventListener("touchstart", () => { touchActive = true; lastScrollDelta = 0; log("touchstart", ""); }, { passive: true });
    chat.addEventListener("touchend", () => { touchActive = false; log("touchend", ""); }, { passive: true });
    chat.addEventListener("touchcancel", () => { touchActive = false; log("touchcancel", ""); }, { passive: true });

    new MutationObserver((mutations) => {
      const kinds = new Map<string, number>();
      for (const m of mutations) {
        const key = `${m.type}:${m.attributeName ?? ""}:${m.target instanceof Element ? m.target.className : "text"}`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
      log("chat-dom", Array.from(kinds.entries()).map(([k, n]) => `${k} x${String(n)}`).join(" ").slice(0, 120));
    }).observe(chat, { attributes: true, childList: true, subtree: true, characterData: true });

    const meter = chatView.shadowRoot?.querySelector("conversation-meter");
    if (meter?.shadowRoot !== undefined && meter.shadowRoot !== null) {
      new MutationObserver(() => { log("meter-dom", "style/aria update"); })
        .observe(meter.shadowRoot, { attributes: true, subtree: true });
    }
  };

  const vv = window.visualViewport;
  vv?.addEventListener("resize", () => {
    log("vv-resize", `${String(Math.round(vv.width))}x${String(Math.round(vv.height))} offsetTop=${String(Math.round(vv.offsetTop))}`);
  });
  window.addEventListener("resize", () => { log("win-resize", ""); });
  document.addEventListener("focusin", (event) => { log("focusin", event.target instanceof Element ? event.target.tagName : "?"); }, true);

  if ("PerformanceObserver" in window) {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) log("longtask", `${String(Math.round(entry.duration))}ms`);
      }).observe({ entryTypes: ["longtask"] });
    } catch { /* longtask unsupported */ }
  }

  // Abrupt-stop detector: scroll events stop mid-flight (high last velocity,
  // no touchend yet or momentum expected). Flag it so the timeline around the
  // stall is easy to spot in a screenshot.
  window.setInterval(() => {
    if (lastScrollEventT === 0) return;
    const since = performance.now() - lastScrollEventT;
    const momentumStop = since > STALL_GAP_MS && since < STALL_GAP_MS + 300 && lastScrollDelta > FAST_SCROLL_DELTA_PX;
    const dragFreeze = touchActive && since > STALL_GAP_MS && since < STALL_GAP_MS + 300 && lastScrollDelta > 3;
    if (momentumStop || dragFreeze) {
      stallCount += 1;
      log("STALL?", `${dragFreeze ? "drag-freeze" : "momentum"} last delta ${String(lastScrollDelta)}px`);
    }
  }, 150);

  const poll = window.setInterval(() => {
    const chatView = findChatView();
    if (chatView === undefined || shadowChat(chatView) === undefined) return;
    window.clearInterval(poll);
    watchChat(chatView);
    log("ready", "chat instrumented");
  }, 500);
}

export function scrollDiagnosticsRequested(): boolean {
  return new URLSearchParams(window.location.search).get("scrolldiag") === "1";
}
