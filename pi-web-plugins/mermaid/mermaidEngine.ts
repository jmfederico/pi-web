export interface MermaidDrawing {
  /** Sanitized standalone SVG markup with explicit intrinsic dimensions. */
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

export interface MermaidDrawRequest {
  readonly text: string;
  /** Layout width for diagrams that size themselves to their container. */
  readonly width: number;
  readonly signal: AbortSignal;
}

export interface MermaidRenderer {
  render(request: MermaidDrawRequest): Promise<MermaidDrawing>;
}

export function mermaidFrameDocument(engine: string): string {
  // Source is sent by postMessage, never interpolated into this HTML. Only the
  // trusted bundled engine executes, in an opaque origin with no network access.
  const script = engine.replace(/<\/script/giu, "<\\/script");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:0}</style></head><body><script>${script}</script></body></html>`;
}

interface Job extends MermaidDrawRequest {
  readonly resolve: (drawing: MermaidDrawing) => void;
  readonly reject: (error: Error) => void;
}

interface Options {
  readonly document?: Document;
  /** Bounds loading plus one diagram, so a stuck engine cannot block later diagrams. */
  readonly timeoutMs?: number;
  /** Releases the engine's memory once no diagram has needed it for this long. */
  readonly idleMs?: number;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function drawing(data: object): MermaidDrawing | undefined {
  if (!("svg" in data) || typeof data.svg !== "string" || !("width" in data) || !("height" in data)) return undefined;
  const { width, height } = data;
  if (typeof width !== "number" || typeof height !== "number" || !(width > 0) || !(height > 0)
    || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { svg: data.svg, width, height };
}

/**
 * Runs one sandboxed Mermaid engine for every diagram, one diagram at a time.
 * Previews keep only static SVG output, never a copy of the engine.
 */
export class MermaidEngine implements MermaidRenderer {
  private readonly document: Document;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly queue: Job[] = [];
  private running = false;
  private frame: HTMLIFrameElement | undefined;
  private ready: Promise<Window> | undefined;
  private release: (() => void) | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopActive: ((error: Error) => void) | undefined;
  private nextId = 0;
  private generation = 0;
  private disposed = false;

  constructor(private readonly loadEngine: () => Promise<string>, options: Options = {}) {
    this.document = options.document ?? globalThis.document;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.idleMs = options.idleMs ?? 60_000;
  }

  render(request: MermaidDrawRequest): Promise<MermaidDrawing> {
    const { signal } = request;
    if (this.disposed) return Promise.reject(new Error("Mermaid engine is no longer available"));
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<MermaidDrawing>((resolve, reject) => {
      const onAbort = () => {
        const queued = this.queue.indexOf(job);
        if (queued >= 0) this.queue.splice(queued, 1);
        reject(abortError(signal));
      };
      const settle = <Value>(finish: (value: Value) => void) => (value: Value) => {
        signal.removeEventListener("abort", onAbort);
        finish(value);
      };
      const job: Job = { ...request, resolve: settle(resolve), reject: settle(reject) };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      void this.pump();
    });
  }

  /** Remove the engine frame and reject waiting diagrams; the engine cannot be reused. */
  dispose(): void {
    this.disposed = true;
    this.teardown();
    const unavailable = () => new Error("Mermaid engine is no longer available");
    this.stopActive?.(unavailable());
    for (const job of this.queue.splice(0)) job.reject(unavailable());
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    try {
      for (let job = this.queue.shift(); job !== undefined; job = this.queue.shift()) {
        try {
          job.resolve(await this.draw(job));
        } catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.running = false;
      if (!this.disposed && this.frame !== undefined) {
        this.idleTimer = setTimeout(() => { this.teardown(); }, this.idleMs);
      }
    }
  }

  private draw(job: Job): Promise<MermaidDrawing> {
    return new Promise<MermaidDrawing>((resolve, reject) => {
      const id = ++this.nextId;
      let settled = false;
      const finish = (result: () => void) => {
        if (settled) return;
        settled = true;
        this.stopActive = undefined;
        clearTimeout(timeout);
        this.document.defaultView?.removeEventListener("message", onMessage);
        result();
      };
      const timeout = setTimeout(() => {
        // A stuck engine would block every later diagram; replace it.
        this.teardown();
        finish(() => { reject(new Error("Mermaid preview timed out")); });
      }, this.timeoutMs);
      const onMessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (event.source === null || event.source !== this.frame?.contentWindow) return;
        if (typeof data !== "object" || data === null || !("type" in data) || !("id" in data) || data.id !== id) return;
        if (data.type === "mermaid-error") finish(() => { reject(new Error("Mermaid could not render this source")); });
        if (data.type !== "mermaid-rendered") return;
        const result = drawing(data);
        finish(() => { if (result === undefined) reject(new Error("Mermaid returned an invalid diagram")); else resolve(result); });
      };
      this.stopActive = (error) => { finish(() => { reject(error); }); };
      this.document.defaultView?.addEventListener("message", onMessage);
      // render() releases an aborted caller at once. This draw still owns the engine until
      // it settles, so the next diagram never queues behind it unbounded and an engine
      // that finished loading after the abort still gets its idle unload.
      this.engineWindow().then((engine) => {
        if (settled) return;
        if (job.signal.aborted) finish(() => { reject(abortError(job.signal)); });
        else engine.postMessage({ type: "mermaid-render", id, text: job.text, width: job.width }, "*");
      }, (error: unknown) => { finish(() => { reject(error instanceof Error ? error : new Error(String(error))); }); });
    });
  }

  private engineWindow(): Promise<Window> {
    this.ready ??= this.start();
    return this.ready;
  }

  private async start(): Promise<Window> {
    const generation = this.generation;
    let engine: string;
    try {
      engine = await this.loadEngine();
    } catch (error) {
      if (generation === this.generation) this.ready = undefined;
      throw error;
    }
    // A teardown during loading owns cleanup; never attach a frame nobody tracks.
    if (generation !== this.generation) throw new Error("Mermaid engine was stopped while loading");
    const frame = this.document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.inert = true;
    // Kept in layout so text measurement works; invisible and inert to input.
    frame.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
    const view = this.document.defaultView;
    const ready = new Promise<Window>((resolve) => {
      const onMessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (event.source !== frame.contentWindow || typeof data !== "object" || data === null
          || !("type" in data) || data.type !== "mermaid-ready" || frame.contentWindow === null) return;
        view?.removeEventListener("message", onMessage);
        resolve(frame.contentWindow);
      };
      view?.addEventListener("message", onMessage);
      this.release = () => { view?.removeEventListener("message", onMessage); };
    });
    frame.srcdoc = mermaidFrameDocument(engine);
    this.frame = frame;
    this.document.body.append(frame);
    return ready;
  }

  private teardown(): void {
    this.generation += 1;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.release?.();
    this.release = undefined;
    this.frame?.remove();
    this.frame = undefined;
    this.ready = undefined;
  }
}

let shared: Promise<string> | undefined;
export function loadMermaidEngine(): Promise<string> {
  // The package build emits this self-contained script beside the browser entry.
  shared ??= fetch(new URL(/* @vite-ignore */ "./mermaid-engine.js", import.meta.url), { signal: AbortSignal.timeout(30_000) }).then(async (response) => {
    if (!response.ok) throw new Error(`Mermaid engine unavailable (${String(response.status)})`);
    return response.text();
  }).catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}
