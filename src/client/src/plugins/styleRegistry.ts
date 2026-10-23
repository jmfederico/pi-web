import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { StylesheetRootOptions } from "../../../plugin-api";

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
  private readonly roots = new Map<StyleRoot, { references: number; sharedUiReferences: number }>();
  private sharedUiSheet: CSSStyleSheet | undefined;
  private readonly files = new Map<string, LoadedFile>();
  private readonly listeners = new Set<() => void>();
  private sheets: readonly CSSStyleSheet[] = [];
  private revision = 0;

  constructor(private readonly load: PluginStylesheetLoader, private readonly createSharedUiSheet?: () => CSSStyleSheet) {}

  /** Subscribe to active sheet changes, after adoption in all registered roots. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Supply even a closed root by its retained reference. Release it on disconnection. */
  registerRoot(root: StyleRoot, options: StylesheetRootOptions = {}): () => void {
    const sharedUi = options.sharedUi === true;
    if (sharedUi && this.sharedUiSheet === undefined) {
      if (this.createSharedUiSheet === undefined) throw new Error("Shared UI styles are not configured");
      this.sharedUiSheet = this.createSharedUiSheet();
    }
    const registration = this.roots.get(root) ?? { references: 0, sharedUiReferences: 0 };
    registration.references++;
    if (sharedUi) registration.sharedUiReferences++;
    this.roots.set(root, registration);
    this.apply(root, [], this.sheets);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.roots.get(root) !== registration) return;
      registration.references--;
      if (sharedUi) registration.sharedUiReferences--;
      if (registration.references === 0) this.roots.delete(root);
      this.apply(root, this.sheets, registration.references === 0 ? [] : this.sheets);
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

    const publishLoadedSheets = () => {
      if (revision !== this.revision) return;
      // Publish every completed file in contribution order, without waiting for peers.
      const sheets = ordered.flatMap(({ url }) => {
        const sheet = this.files.get(url)?.sheet;
        return sheet === undefined ? [] : [sheet];
      });
      // Multiple contributions can intentionally reference the same file.
      this.replaceSheets([...new Set(sheets)]);
    };
    publishLoadedSheets();

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
        publishLoadedSheets();
        return sheet;
      } catch (cause) {
        if (this.files.get(contribution.url) === requestedFile) this.files.delete(contribution.url);
        throw new Error(`Failed to load stylesheet ${contribution.id} (${contribution.url})`, { cause });
      }
    }));
    if (revision !== this.revision) return;
    const errors: unknown[] = [];
    for (const result of loaded) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to load plugin stylesheets");
  }

  /** Release all roots and pending file loads. The registry can subsequently be reused. */
  clear(): void {
    this.revision++;
    // Remove both shared defaults and contributions, even when no files are active.
    for (const root of this.roots.keys()) this.apply(root, this.sheets, [], false);
    this.roots.clear();
    this.replaceSheets([]);
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

  private apply(root: StyleRoot, previous: readonly CSSStyleSheet[], next: readonly CSSStyleSheet[], sharedUi = (this.roots.get(root)?.sharedUiReferences ?? 0) > 0): void {
    const owned = new Set([...previous, ...next, ...(this.sharedUiSheet === undefined ? [] : [this.sharedUiSheet])]);
    const shared = sharedUi && this.sharedUiSheet !== undefined ? [this.sharedUiSheet] : [];
    root.adoptedStyleSheets = [...root.adoptedStyleSheets.filter((sheet) => !owned.has(sheet)), ...shared, ...next];
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type StyleControllerHost = ReactiveControllerHost & { readonly renderRoot?: HTMLElement | DocumentFragment };

/** Register after Lit creates the root, release on disconnect, and re-register on reconnect. */
export class PluginStylesController implements ReactiveController {
  private release: (() => void) | undefined;

  constructor(private readonly host: StyleControllerHost, private readonly styles: PluginStyleRegistry, private readonly options: StylesheetRootOptions = {}) {
    host.addController(this);
  }

  hostConnected(): void {
    this.release?.();
    const root = this.host.renderRoot;
    this.release = root instanceof ShadowRoot
      ? this.styles.registerRoot(root, this.options)
      : undefined;
  }

  hostDisconnected(): void {
    this.release?.();
    this.release = undefined;
  }
}
