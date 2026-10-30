import type { ReactiveController, ReactiveControllerHost } from "lit";
import { ViewportPositionRepairer } from "./viewportPositionRepair";

const HEIGHT_PROPERTY = "--pi-app-viewport-height";

/** Keep the fixed shell inside the keyboard-reduced viewport, not the layout viewport. */
export class ShellViewportController implements ReactiveController {
  private frame: number | undefined;
  private viewport: VisualViewport | null = null;
  private enabled = false;

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly shouldManageViewport: () => boolean,
    private readonly repairer = new ViewportPositionRepairer(),
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.viewport = window.visualViewport;
    window.addEventListener("resize", this.scheduleRefresh);
    window.addEventListener("scroll", this.scheduleRefresh, { passive: true });
    this.viewport?.addEventListener("resize", this.scheduleRefresh);
    this.viewport?.addEventListener("scroll", this.scheduleRefresh);
    this.scheduleRefresh();
  }

  hostUpdated(): void {
    if (this.enabled !== this.shouldManageViewport()) this.scheduleRefresh();
  }

  hostDisconnected(): void {
    window.removeEventListener("resize", this.scheduleRefresh);
    window.removeEventListener("scroll", this.scheduleRefresh);
    this.viewport?.removeEventListener("resize", this.scheduleRefresh);
    this.viewport?.removeEventListener("scroll", this.scheduleRefresh);
    this.viewport = null;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.host.style.removeProperty(HEIGHT_PROPERTY);
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
    this.enabled = this.shouldManageViewport();
    const viewport = this.viewport;
    // Pinch zoom must retain native panning. Keep the pre-zoom shell size.
    if (this.enabled && viewport && viewport.scale !== 1) return;
    if (!this.enabled || !viewport || viewport.height <= 0) {
      this.host.style.removeProperty(HEIGHT_PROPERTY);
      return;
    }

    const height = `${String(viewport.height)}px`;
    if (this.host.style.getPropertyValue(HEIGHT_PROPERTY) !== height) {
      this.host.style.setProperty(HEIGHT_PROPERTY, height);
    }

    // WebKit can pan the visual viewport even while the DOM root reports zero.
    // Do not use capture: panel scroll events must not trigger root repair.
    if (window.scrollX !== 0 || window.scrollY !== 0
      || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0
      || viewport.offsetTop !== 0 || viewport.offsetLeft !== 0) {
      this.repairer.repairNow();
    }
  }
}
