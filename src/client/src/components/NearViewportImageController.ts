import type { ReactiveController, ReactiveControllerHost } from "lit";

type ImageHost = ReactiveControllerHost & HTMLElement;

/** Assign sources only near the transcript viewport, never inside closed disclosures. */
export class NearViewportImageController implements ReactiveController {
  ready = false;
  private source = "";
  private automatic = false;
  private watching = false;
  private observer: IntersectionObserver | undefined;
  private details: HTMLDetailsElement[] = [];
  private root: Element | null = null;

  constructor(private readonly host: ImageHost) {
    host.addController(this);
  }

  configure(source: string, automatic: boolean): void {
    if (source === this.source && automatic === this.automatic) return;
    this.cleanup();
    this.source = source;
    this.automatic = automatic;
    this.ready = false;
  }

  /** An explicit Show image action need not wait for an observer notification. */
  load(): void {
    if (this.source === "" || !this.host.isConnected) return;
    this.ready = true;
    this.cleanup();
    this.host.requestUpdate();
  }

  hostUpdate(): void {
    if (this.watching || this.ready || !this.automatic || this.source === "" || !this.host.isConnected) return;
    this.watching = true;
    const ancestors = composedAncestors(this.host);
    this.root = ancestors.find((element) => element.hasAttribute("data-image-scroll-root")) ?? null;
    this.details = ancestors.filter((element): element is HTMLDetailsElement => element instanceof HTMLDetailsElement);
    for (const details of this.details) details.addEventListener("toggle", this.onToggle);
    this.observe();
  }

  hostConnected(): void {
    this.host.requestUpdate();
  }

  hostDisconnected(): void {
    this.cleanup();
  }

  private readonly onToggle = (): void => { this.observe(); };

  private observe(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.details.some((details) => !details.open)) return;
    // Older browsers still load visible disclosures; manual-only images never enter here.
    if (typeof IntersectionObserver === "undefined") {
      this.load();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (this.observer !== observer || !this.host.isConnected || this.details.some((details) => !details.open)) return;
      if (entries.some((entry) => entry.isIntersecting)) this.load();
    }, { root: this.root, rootMargin: "300px 0px", threshold: 0 });
    this.observer = observer;
    observer.observe(this.host);
  }

  private cleanup(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    for (const details of this.details) details.removeEventListener("toggle", this.onToggle);
    this.details = [];
    this.root = null;
    this.watching = false;
  }
}

function composedAncestors(element: HTMLElement): HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  let current: HTMLElement | null = element;
  while (current !== null) {
    const root = current.getRootNode();
    current = current.parentElement ?? (root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null);
    if (current !== null) ancestors.push(current);
  }
  return ancestors;
}
