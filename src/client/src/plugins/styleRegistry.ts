import type { ReactiveController, ReactiveControllerHost } from "lit";

/** One active file contribution. Owners select plugin/theme eligibility before publishing. */
export interface ActivePluginStylesheet {
  readonly id: string;
  readonly url: string;
  readonly order?: number;
}

export type PluginStylesheetLoader = (url: string, signal: AbortSignal) => Promise<CSSStyleSheet>;
type StyleRoot = Document | ShadowRoot;

interface LoadedFile {
  readonly controller: AbortController;
  readonly loaded: Promise<CSSStyleSheet>;
  sheet?: CSSStyleSheet;
}

/**
 * Owns shared sheets, not component styles. The loader owns file fetching, compilation,
 * asset URL resolution and import policy; this registry owns adoption and lifetime.
 */
export class PluginStyleRegistry {
  private readonly roots = new Map<StyleRoot, { references: number }>();
  private readonly files = new Map<string, LoadedFile>();
  private readonly listeners = new Set<() => void>();
  private sheets: readonly CSSStyleSheet[] = [];
  private revision = 0;

  constructor(private readonly load: PluginStylesheetLoader) {}

  /** Subscribe to active sheet changes, after adoption in all registered roots. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Supply even a closed root by its retained reference. Release it on disconnection. */
  registerRoot(root: StyleRoot): () => void {
    const registration = this.roots.get(root) ?? { references: 0 };
    registration.references++;
    this.roots.set(root, registration);
    this.apply(root, [], this.sheets);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.roots.get(root) !== registration) return;
      if (--registration.references > 0) return;
      this.roots.delete(root);
      this.apply(root, this.sheets, []);
    };
  }

  /**
   * Input URLs must be absolute browser URLs. Ordering is independent of load timing.
   * Rejections are attributed to the contribution; callers must report them at the UI
   * or plugin lifecycle boundary. Successful files are adopted even if others fail.
   */
  async setContributions(contributions: readonly ActivePluginStylesheet[]): Promise<void> {
    const ordered = [...contributions].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || compareIds(a.id, b.id));
    const ids = new Set<string>();
    for (const contribution of ordered) {
      if (ids.has(contribution.id)) throw new Error(`Duplicate stylesheet contribution: ${contribution.id}`);
      ids.add(contribution.id);
      const url = new URL(contribution.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Stylesheet ${contribution.id} must use an HTTP(S) file URL`);
      }
    }

    const revision = ++this.revision;
    const urls = new Set(ordered.map(({ url }) => url));
    // Remove inactive rules immediately, including while replacement files are loading.
    // Also release pending work and cached files when their last contribution unloads.
    const retainedSheets = new Set<CSSStyleSheet>();
    for (const [url, file] of this.files) {
      if (!urls.has(url)) {
        file.controller.abort();
        this.files.delete(url);
      } else {
        if (file.sheet !== undefined) retainedSheets.add(file.sheet);
      }
    }
    this.replaceSheets(this.sheets.filter((sheet) => retainedSheets.has(sheet)));

    const loaded = await Promise.allSettled(ordered.map(async (contribution) => {
      let file = this.files.get(contribution.url);
      if (file === undefined) {
        const controller = new AbortController();
        // Defer to a promise so a synchronous loader failure has the same cleanup path.
        const loaded = Promise.resolve().then(() => this.load(contribution.url, controller.signal));
        file = { controller, loaded };
        this.files.set(contribution.url, file);
      }
      const requestedFile = file;
      try {
        const sheet = await requestedFile.loaded;
        requestedFile.sheet = sheet;
        return sheet;
      } catch (cause) {
        if (this.files.get(contribution.url) === requestedFile) this.files.delete(contribution.url);
        throw new Error(`Failed to load stylesheet ${contribution.id} (${contribution.url})`, { cause });
      }
    }));
    if (revision !== this.revision) return;
    // Independent contributions must not block each other, especially theme files.
    // Keep the requested order regardless of completion order or failures.
    const sheets: CSSStyleSheet[] = [];
    const errors: unknown[] = [];
    for (const result of loaded) {
      if (result.status === "fulfilled") sheets.push(result.value);
      else errors.push(result.reason);
    }
    // Multiple contributions can intentionally reference the same file.
    this.replaceSheets([...new Set(sheets)]);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to load plugin stylesheets");
  }

  /** Release all roots and pending file loads. The registry can subsequently be reused. */
  clear(): void {
    this.revision++;
    this.replaceSheets([]);
    this.roots.clear();
    for (const file of this.files.values()) file.controller.abort();
    this.files.clear();
  }

  private replaceSheets(next: readonly CSSStyleSheet[]): void {
    const previous = this.sheets;
    if (previous.length === next.length && previous.every((sheet, index) => sheet === next[index])) return;
    this.sheets = next;
    for (const root of this.roots.keys()) this.apply(root, previous, next);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        // A consumer failure must not interrupt publication or other consumers.
        console.error("Stylesheet change listener failed", error);
      }
    }
  }

  private apply(root: StyleRoot, previous: readonly CSSStyleSheet[], next: readonly CSSStyleSheet[]): void {
    const owned = new Set([...previous, ...next]);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets.filter((sheet) => !owned.has(sheet)), ...next];
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type StyleControllerHost = ReactiveControllerHost & { readonly renderRoot?: HTMLElement | DocumentFragment };

/** Register after Lit creates the root, release on disconnect, and re-register on reconnect. */
export class PluginStylesController implements ReactiveController {
  private release: (() => void) | undefined;

  constructor(private readonly host: StyleControllerHost, private readonly styles: PluginStyleRegistry) {
    host.addController(this);
  }

  hostConnected(): void {
    this.release?.();
    const root = this.host.renderRoot;
    this.release = root instanceof ShadowRoot
      ? this.styles.registerRoot(root)
      : undefined;
  }

  hostDisconnected(): void {
    this.release?.();
    this.release = undefined;
  }
}
