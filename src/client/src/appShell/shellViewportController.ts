import type { ReactiveController, ReactiveControllerHost } from "lit";
import { ViewportPanGuard } from "./viewportPanGuard";
import { ViewportPositionRepairer } from "./viewportPositionRepair";

// Safari exposes no Shortcuts-bar or hardware-keyboard state. A small occlusion
// with an editable field focused is only a heuristic; full keyboards must retain
// native viewport panning. These CSS-pixel bounds need physical iPad validation.
const MIN_SHORTCUTS_INSET = 24;
const MAX_SHORTCUTS_INSET = 120;
// A software keyboard can animate through the Shortcuts-bar range; only learn
// an occlusion that stays put after the keyboard animation would have settled.
export const SHORTCUTS_RESERVE_SETTLE_MS = 400;
const SETTLE_TOLERANCE = 2;
export const SHORTCUTS_RESERVE_PROPERTY = "--pi-app-shortcuts-bar-reserve";
/** Root marker for CSS that keeps the page still once space is reserved. */
export const SHORTCUTS_RESERVED_ATTRIBUTE = "data-pi-web-shortcuts-reserved";
const SHORTCUTS_RESERVE_STORAGE_KEY = "pi-web:ipad-shortcuts-bar-reserve";

export interface ShortcutsReserveStore {
  load(): number | undefined;
  save(height: number): void;
  clear(): void;
}

/**
 * Keep the iPad Shortcuts bar from covering the shell or moving the page. The
 * first stable bar occlusion is remembered and kept reserved at the shell
 * bottom, so later bars appear over reserved space instead of resizing layout.
 * Once a reserve exists, live scroll repair stops so it cannot fight user
 * scrolling. While the bar is up, a touch guard stops drags that no panel would
 * scroll from panning the page; it prevents movement instead of undoing it.
 */
export class ShellViewportController implements ReactiveController {
  private frame: number | undefined;
  private settleTimer: number | undefined;
  private viewport: VisualViewport | null = null;
  private reservedHeight: number | undefined;
  private repairing = false;

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly repairer = new ViewportPositionRepairer(),
    private readonly reserveStore: ShortcutsReserveStore = createBrowserShortcutsReserveStore(),
    private readonly panGuard = new ViewportPanGuard(),
  ) {
    host.addController(this);
  }

  /** The height kept clear for the Shortcuts bar, if one has been learned. */
  get reserve(): number | undefined {
    return this.reservedHeight;
  }

  /**
   * Free the reserved strip and forget its height. The bar is learned again
   * the next time it appears, e.g. when a keyboard is reattached.
   */
  removeReserve(): void {
    if (this.reservedHeight === undefined) return;
    this.reservedHeight = undefined;
    this.reserveStore.clear();
    this.host.style.removeProperty(SHORTCUTS_RESERVE_PROPERTY);
    document.documentElement.removeAttribute(SHORTCUTS_RESERVED_ATTRIBUTE);
    if (this.viewport !== null) this.startRepair();
    this.host.requestUpdate();
  }

  hostConnected(): void {
    // iPadOS can identify as a desktop Mac; do not include iPhones, Android,
    // ordinary Macs, or touch-capable Windows devices in this workaround.
    const isIPad = navigator.userAgent.includes("iPad")
      || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
    if (!isIPad || !window.visualViewport) return;
    this.viewport = window.visualViewport;
    // Measurement only: these signals never move the page.
    this.viewport.addEventListener("resize", this.scheduleRefresh);
    document.addEventListener("focusin", this.scheduleRefresh);
    document.addEventListener("focusout", this.scheduleRefresh);
    this.applyReserve(this.reserveStore.load());
    if (this.reservedHeight === undefined) this.startRepair();
    this.scheduleRefresh();
  }

  hostDisconnected(): void {
    if (this.viewport === null) return;
    this.stopRepair();
    this.viewport.removeEventListener("resize", this.scheduleRefresh);
    document.removeEventListener("focusin", this.scheduleRefresh);
    document.removeEventListener("focusout", this.scheduleRefresh);
    this.viewport = null;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.cancelSettle();
    this.panGuard.setActive(false);
    document.documentElement.removeAttribute(SHORTCUTS_RESERVED_ATTRIBUTE);
  }

  /** Undo Safari's page panning until the bar has reserved space of its own. */
  private startRepair(): void {
    if (this.repairing) return;
    this.repairing = true;
    window.addEventListener("resize", this.scheduleRefresh);
    window.addEventListener("scroll", this.scheduleRefresh, { passive: true });
    window.addEventListener("focus", this.scheduleRefresh);
    window.addEventListener("pageshow", this.scheduleRefresh);
    this.viewport?.addEventListener("scroll", this.scheduleRefresh);
  }

  private stopRepair(): void {
    if (!this.repairing) return;
    this.repairing = false;
    window.removeEventListener("resize", this.scheduleRefresh);
    window.removeEventListener("scroll", this.scheduleRefresh);
    window.removeEventListener("focus", this.scheduleRefresh);
    window.removeEventListener("pageshow", this.scheduleRefresh);
    this.viewport?.removeEventListener("scroll", this.scheduleRefresh);
    this.repairer.clear();
  }

  private readonly scheduleRefresh = (): void => {
    if (this.frame !== undefined) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = undefined;
      this.refresh();
    });
  };

  private refresh(): void {
    const viewport = this.viewport;
    const inset = this.shortcutsInset();
    this.panGuard.setActive(inset !== undefined);
    if (viewport === null || inset === undefined) {
      this.cancelSettle();
      return;
    }
    this.scheduleLearn(inset);
    if (!this.repairing) return;

    // Only undo outer-page displacement, never panel scrolling. WebKit can pan
    // the visual viewport even while the DOM root reports zero.
    if (window.scrollX !== 0 || window.scrollY !== 0
      || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0
      || viewport.offsetTop !== 0 || viewport.offsetLeft !== 0) {
      this.repairer.repairNow();
    }
  }

  /** The current occlusion if it looks like the Shortcuts bar over a text field. */
  private shortcutsInset(): number | undefined {
    const viewport = this.viewport;
    if (viewport?.scale !== 1 || viewport.height <= 0) return undefined;
    const inset = document.documentElement.clientHeight - viewport.height;
    if (inset < MIN_SHORTCUTS_INSET || inset > MAX_SHORTCUTS_INSET || !hasFocusedTextInput()) return undefined;
    return inset;
  }

  private scheduleLearn(inset: number): void {
    const reserved = this.reservedHeight ?? 0;
    if (inset <= reserved) return;
    this.cancelSettle();
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = undefined;
      const settled = this.shortcutsInset();
      if (settled === undefined || Math.abs(settled - inset) > SETTLE_TOLERANCE) return;
      const height = Math.ceil(settled);
      if (height <= (this.reservedHeight ?? 0)) return;
      this.applyReserve(height);
      this.reserveStore.save(height);
    }, SHORTCUTS_RESERVE_SETTLE_MS);
  }

  private cancelSettle(): void {
    if (this.settleTimer !== undefined) window.clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  private applyReserve(height: number | undefined): void {
    if (height === undefined) return;
    this.reservedHeight = height;
    this.host.style.setProperty(SHORTCUTS_RESERVE_PROPERTY, `${String(height)}px`);
    document.documentElement.setAttribute(SHORTCUTS_RESERVED_ATTRIBUTE, "");
    this.stopRepair();
    this.host.requestUpdate();
  }
}

export function createBrowserShortcutsReserveStore(): ShortcutsReserveStore {
  return {
    load(): number | undefined {
      try {
        const height = Number(localStorage.getItem(SHORTCUTS_RESERVE_STORAGE_KEY));
        return Number.isFinite(height) && height >= MIN_SHORTCUTS_INSET && height <= MAX_SHORTCUTS_INSET ? height : undefined;
      } catch {
        return undefined;
      }
    },
    save(height: number): void {
      try {
        localStorage.setItem(SHORTCUTS_RESERVE_STORAGE_KEY, String(height));
      } catch {
        // The reserve is relearned when storage is unavailable.
      }
    },
    clear(): void {
      try {
        localStorage.removeItem(SHORTCUTS_RESERVE_STORAGE_KEY);
      } catch {
        // Nothing persisted when storage is unavailable.
      }
    },
  };
}

function hasFocusedTextInput(): boolean {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active instanceof HTMLTextAreaElement) return !active.readOnly && !active.disabled;
  if (active instanceof HTMLInputElement) {
    return !active.readOnly && !active.disabled
      && ["text", "search", "email", "url", "tel", "password", "number"].includes(active.type);
  }
  return active instanceof HTMLElement && active.isContentEditable;
}
