import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Keeps the app shell aligned with the visual viewport while the on-screen
 * keyboard is open.
 *
 * The shell is `position: fixed` with `height: 100dvh`, so on browsers where
 * the keyboard overlays the viewport (notably iOS Safari, which ignores
 * `interactive-widget=resizes-content`) the composer stays buried behind the
 * keyboard. While a keyboard is detected, the controller pins the shell to the
 * visible region through the `--pi-app-viewport-top` / `--pi-app-viewport-height`
 * custom properties consumed by the app shell's `:host` rule; when the keyboard
 * closes the properties are removed and the CSS `100dvh` sizing takes over
 * again.
 */
export class KeyboardViewportController implements ReactiveController {
  private readonly viewport: KeyboardViewport | undefined;
  private readonly windowViewport: WindowViewport | undefined;
  private readonly style: StyleProperties | undefined;
  private readonly minKeyboardInsetPx: number;
  private fitted = false;

  constructor(
    host: ReactiveControllerHost & StyleHost,
    options: KeyboardViewportControllerOptions = {},
  ) {
    host.addController(this);
    this.viewport = options.viewport ?? currentKeyboardViewport();
    this.windowViewport = options.windowViewport ?? (typeof window === "undefined" ? undefined : window);
    this.style = options.style ?? host.style;
    this.minKeyboardInsetPx = options.minKeyboardInsetPx ?? DEFAULT_MIN_KEYBOARD_INSET_PX;
  }

  hostConnected(): void {
    this.viewport?.addEventListener("resize", this.fit);
    this.viewport?.addEventListener("scroll", this.fit);
    this.fit();
  }

  hostDisconnected(): void {
    this.viewport?.removeEventListener("resize", this.fit);
    this.viewport?.removeEventListener("scroll", this.fit);
    this.clearFit();
  }

  private readonly fit = (): void => {
    const viewport = this.viewport;
    const windowViewport = this.windowViewport;
    if (viewport === undefined || windowViewport === undefined || this.style === undefined) return;
    if (viewport.scale > 1) {
      this.clearFit();
      return;
    }
    const keyboardInset = windowViewport.innerHeight - viewport.height;
    if (keyboardInset < this.minKeyboardInsetPx) {
      this.clearFit();
      return;
    }
    this.style.setProperty("--pi-app-viewport-top", `${String(Math.round(viewport.offsetTop))}px`);
    this.style.setProperty("--pi-app-viewport-height", `${String(Math.round(viewport.height))}px`);
    this.fitted = true;
  };

  private clearFit(): void {
    if (!this.fitted) return;
    this.style?.removeProperty("--pi-app-viewport-top");
    this.style?.removeProperty("--pi-app-viewport-height");
    this.fitted = false;
  }
}

/** Minimum visual-viewport shrink before the gap is treated as an open keyboard. */
const DEFAULT_MIN_KEYBOARD_INSET_PX = 24;

export interface KeyboardViewport {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

export interface WindowViewport {
  readonly innerHeight: number;
}

export interface StyleProperties {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

/** A controller host whose element exposes inline custom properties, e.g. a LitElement. */
export interface StyleHost {
  style: StyleProperties;
}

export interface KeyboardViewportControllerOptions {
  viewport?: KeyboardViewport | undefined;
  windowViewport?: WindowViewport | undefined;
  style?: StyleProperties | undefined;
  minKeyboardInsetPx?: number;
}

function currentKeyboardViewport(): KeyboardViewport | undefined {
  if (typeof window === "undefined") return undefined;
  return window.visualViewport ?? undefined;
}
