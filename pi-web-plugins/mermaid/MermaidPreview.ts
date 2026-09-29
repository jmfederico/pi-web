import type { ContentRendererInput } from "@jmfederico/pi-web/plugin-api";
import { LitElement, css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

let enginePromise: Promise<string> | undefined;
export function loadMermaidEngine(): Promise<string> {
  // The package build emits this self-contained script beside the browser entry.
  enginePromise ??= fetch(new URL(/* @vite-ignore */ "./mermaid-engine.js", import.meta.url), { signal: AbortSignal.timeout(30_000) }).then(async (response) => {
    if (!response.ok) throw new Error(`Mermaid engine unavailable (${String(response.status)})`);
    return response.text();
  }).catch((error: unknown) => {
    enginePromise = undefined;
    throw error;
  });
  return enginePromise;
}

export function mermaidFrameDocument(engine: string): string {
  // Source is sent by postMessage, never interpolated into this HTML. Only the
  // trusted bundled engine executes, in an opaque origin with no network access.
  const script = engine.replace(/<\/script/giu, "<\\/script");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:0}svg{max-width:100%;height:auto;display:block;margin:auto}</style></head><body><script>${script}</script></body></html>`;
}

export class MermaidPreview extends LitElement {
  @property({ attribute: false }) input: ContentRendererInput | undefined;
  /** The active package supplies its own module-relative asset loader. */
  @property({ attribute: false }) loadEngine: () => Promise<string> = loadMermaidEngine;
  @state() private document: string | undefined;
  @state() private height = 300;
  private generation = 0;
  private cleanup: (() => void) | undefined;

  protected override updated(changes: PropertyValues<this>): void {
    if (changes.has("input") || changes.has("loadEngine")) void this.draw();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) void this.draw();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.generation += 1;
    this.cleanup?.();
    this.document = undefined;
  }

  private async draw(): Promise<void> {
    this.cleanup?.();
    this.document = undefined;
    const input = this.input;
    const generation = ++this.generation;
    if (input === undefined || input.signal.aborted) return;
    const current = () => this.isConnected && !input.signal.aborted && generation === this.generation;
    const onMessage = (event: MessageEvent<unknown>): void => {
      const frame = this.renderRoot.querySelector("iframe");
      if (!current() || event.source !== frame?.contentWindow) return;
      const data = event.data;
      if (typeof data !== "object" || data === null || !("type" in data)) return;
      if (data.type === "mermaid-ready") {
        frame.contentWindow?.postMessage({ type: "mermaid-render", text: input.text }, "*");
      } else if (data.type === "mermaid-error") {
        input.fail(new Error("Mermaid could not render this source"));
        window.clearTimeout(timeout);
      } else if (data.type === "mermaid-rendered" && "height" in data && typeof data.height === "number" && Number.isFinite(data.height)) {
        window.clearTimeout(timeout);
        this.height = Math.min(1600, Math.max(120, data.height + 24));
      }
    };
    const onAbort = () => {
      this.document = undefined;
      cleanup();
    };
    const timeout = window.setTimeout(() => {
      if (current()) {
        this.generation += 1;
        this.document = undefined;
        input.fail(new Error("Mermaid preview timed out"));
      }
      cleanup();
    }, 30_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      input.signal.removeEventListener("abort", onAbort);
    };
    this.cleanup = cleanup;
    window.addEventListener("message", onMessage);
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const engine = await this.loadEngine();
      if (current()) this.document = mermaidFrameDocument(engine);
    } catch (error) {
      if (current()) input.fail(error);
      cleanup();
    }
  }

  override render() {
    return this.document === undefined
      ? html`<p role="status">Rendering diagram…</p>`
      : html`<iframe title="Mermaid diagram" sandbox="allow-scripts" referrerpolicy="no-referrer" .srcdoc=${this.document} style=${`height:${String(this.height)}px`}></iframe>`;
  }

  static override styles = css`
    :host { display: block; }
    iframe { display: block; width: 100%; border: 0; background: white; }
    p { color: var(--pi-muted); }
  `;
}
