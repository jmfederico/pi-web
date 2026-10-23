import type { ReactiveController, ReactiveControllerHost } from "lit";
import { canOpenTransientPopup, registerTransientPopup } from "./popupScope";

export interface AnchoredPopupOptions {
  placement?: "below-end" | "below-start" | "above-start" | "left-end";
  gap?: number;
  padding?: number;
  width?: number | "anchor";
  maxHeight?: number;
  minWidth?: number;
  /** Completion panels must not move focus out of the editor. */
  preserveFocus?: boolean;
}

export interface AnchoredPopup {
  anchor: HTMLElement;
  panel: HTMLElement;
  onClose: () => void;
  options?: AnchoredPopupOptions;
}

const activePopups: AnchoredPopupController[] = [];

/** Native top-layer presentation without moving content out of its themed root. */
export class AnchoredPopupController implements ReactiveController {
  private current: AnchoredPopup | undefined;
  private frame: number | undefined;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly host: ReactiveControllerHost, private readonly getPopup: () => AnchoredPopup | undefined) {
    host.addController(this);
  }

  hostConnected(): void { this.host.requestUpdate(); }

  hostUpdated(): void {
    const next = this.getPopup();
    if (next?.panel !== this.current?.panel || next?.anchor !== this.current?.anchor) {
      this.stop();
      if (next?.anchor.isConnected === true && next.panel.isConnected) this.start(next);
    }
    this.refresh();
  }

  hostDisconnected(): void { this.close(); }

  close = (): void => {
    const popup = this.current;
    if (!popup) return;
    this.stop();
    popup.onClose();
  };

  private dismiss(): void {
    const popup = this.current;
    if (!popup) return;
    this.stop(false);
    popup.onClose();
  }

  private start(popup: AnchoredPopup): void {
    if (!canOpenTransientPopup(popup.anchor)) { popup.onClose(); return; }
    this.current = popup;
    const { panel, anchor, options } = popup;
    panel.setAttribute("popover", "auto");
    // Reset UA centering and legacy consumer positioning. No stacking numbers:
    // the native top layer owns ordering, including nested popovers.
    Object.assign(panel.style, { position: "fixed", inset: "auto", margin: "0", zIndex: "auto", boxSizing: "border-box", minWidth: "0" });
    const listen = (source: EventTarget, type: string, listener: EventListener, capture = false): void => {
      source.addEventListener(type, listener, capture);
      this.cleanups.push(() => { source.removeEventListener(type, listener, capture); });
    };
    const onToggle = (event: Event): void => {
      if ("newState" in event && event.newState === "closed") this.dismiss();
    };
    listen(panel, "beforetoggle", onToggle);
    listen(panel, "toggle", onToggle);
    // Handle Escape before modal and consumer shortcuts. Only the top popup
    // closes; nested parents remain open for the next Escape.
    listen(window, "keydown", (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== "Escape" || event.isComposing || activePopups.at(-1) !== this) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
      if (options?.preserveFocus !== true) anchor.focus();
    }, true);
    listen(window, "resize", this.scheduleRefresh);
    listen(window, "scroll", this.scheduleRefresh, true);
    if (window.visualViewport) {
      listen(window.visualViewport, "resize", this.scheduleRefresh);
      listen(window.visualViewport, "scroll", this.scheduleRefresh);
    }
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(this.scheduleRefresh);
    if (observer) {
      observer.observe(anchor);
      observer.observe(panel);
      this.cleanups.push(() => { observer.disconnect(); });
    }
    let ancestor: Element = anchor;
    for (;;) {
      const root = ancestor.getRootNode();
      if (!(root instanceof ShadowRoot)) break;
      listen(root, "scroll", this.scheduleRefresh, true);
      observer?.observe(root.host);
      ancestor = root.host;
    }
    this.cleanups.push(registerTransientPopup(anchor, this.close));
    activePopups.push(this);
    this.refresh();
    const focused = options?.preserveFocus === true ? anchor.getRootNode() : undefined;
    const previousFocus = focused instanceof ShadowRoot ? focused.activeElement : document.activeElement;
    panel.showPopover({ source: anchor });
    if (options?.preserveFocus === true && previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }

  private stop(hide = true): void {
    const popup = this.current;
    this.current = undefined;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    const index = activePopups.indexOf(this);
    if (index >= 0) activePopups.splice(index, 1);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (popup && hide) popup.panel.hidePopover();
  }

  private readonly scheduleRefresh = (): void => { this.frame ??= requestAnimationFrame(this.onFrame); };
  private readonly onFrame = (): void => { this.frame = undefined; this.refresh(); };

  private refresh(): void {
    const popup = this.current;
    if (!popup) return;
    if (!canOpenTransientPopup(popup.anchor) || !popup.panel.isConnected) { this.close(); return; }
    const style = anchoredPopupStyle(popup.anchor, popup.options, popup.panel);
    for (const [key, value] of Object.entries(style)) popup.panel.style.setProperty(key, value);
  }
}

export function anchoredPopupStyle(anchor: HTMLElement, options: AnchoredPopupOptions = {}, panel?: HTMLElement): Record<string, string> {
  const trigger = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const padding = options.padding ?? 0;
  const left = (viewport?.offsetLeft ?? 0) + padding;
  const top = (viewport?.offsetTop ?? 0) + padding;
  const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - padding;
  const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - padding;
  const gap = options.gap ?? 0;
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const px = (value: number): string => `${String(Math.round(Math.max(0, value)))}px`;
  const anchorTop = clamp(trigger.top, top, bottom);
  const anchorBottom = clamp(trigger.bottom, top, bottom);
  const anchorRight = clamp(trigger.right, left, right);
  const anchorLeft = clamp(trigger.left, left, right);
  const style: Record<string, string> = { top: "auto", bottom: "auto", left: "auto", right: "auto", width: "max-content" };
  if (options.placement === "left-end") {
    const maxWidth = Math.max(0, anchorLeft - left - gap);
    style["max-width"] = px(maxWidth);
    style["min-width"] = px(Math.min(options.minWidth ?? 0, maxWidth));
    style["max-height"] = px(bottom - top);
    style["right"] = px(window.innerWidth - anchorLeft + gap);
    style["top"] = px(clamp(trigger.bottom - (panel?.getBoundingClientRect().height ?? 0), top, bottom - (panel?.getBoundingClientRect().height ?? 0)));
    return style;
  }
  const below = Math.max(0, bottom - anchorBottom - gap);
  const above = Math.max(0, anchorTop - top - gap);
  const preferAbove = options.placement === "above-start";
  const contentHeight = panel?.scrollHeight ?? 0;
  const needed = Math.min(options.maxHeight ?? 120, contentHeight > 0 ? contentHeight : 120);
  const useAbove = preferAbove ? !(above < needed && below > above) : below < needed && above > below;
  style[useAbove ? "bottom" : "top"] = px(useAbove ? window.innerHeight - anchorTop + gap : anchorBottom + gap);
  style["max-height"] = px(Math.min(options.maxHeight ?? Infinity, useAbove ? above : below));
  const start = options.placement === "below-start" || preferAbove;
  const width = options.width === "anchor" ? trigger.width : options.width;
  if (start) {
    const x = clamp(anchorLeft, left, width === undefined ? right : Math.max(left, right - width));
    style["left"] = px(x);
    style["max-width"] = px(right - x);
    style["min-width"] = px(Math.min(options.minWidth ?? 0, right - x));
  } else {
    style["right"] = px(window.innerWidth - anchorRight);
    style["max-width"] = px(anchorRight - left);
    style["min-width"] = px(Math.min(options.minWidth ?? 0, anchorRight - left));
  }
  if (width !== undefined) style["width"] = px(Math.min(width, right - left));
  return style;
}
