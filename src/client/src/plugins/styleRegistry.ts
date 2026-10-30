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
 * Ordinary files publish independently. A theme is prepared separately, then committed
 * as a unit. Both channels share one cache and one globally ordered publication.
 */
export class PluginStyleRegistry {
  private readonly roots = new Map<StyleRoot, { references: number; sharedUiReferences: number }>();
  private sharedUiSheet: CSSStyleSheet | undefined;
  private readonly files = new Map<string, LoadedFile>();
  private readonly listeners = new Set<() => void>();
  private contributions: readonly ActivePluginStylesheet[] = [];
  private committedTheme: readonly ActivePluginStylesheet[] = [];
  private pendingTheme: readonly ActivePluginStylesheet[] = [];
  private sheets: readonly CSSStyleSheet[] = [];
  private revision = 0;
  private themeRevision = 0;

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
   * or plugin lifecycle boundary. Successful ordinary files publish independently.
   */
  async setContributions(contributions: readonly ActivePluginStylesheet[]): Promise<void> {
    const ordered = orderContributions(contributions);
    const revision = ++this.revision;
    this.contributions = ordered;
    this.pruneFiles();
    this.publishSheets();
    const loaded = await Promise.allSettled(ordered.map(async (contribution) => {
      await this.loadFile(contribution);
      if (revision === this.revision) this.publishSheets();
    }));
    if (revision !== this.revision) return;
    const errors: unknown[] = [];
    for (const result of loaded) if (result.status === "rejected") errors.push(result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to load plugin stylesheets");
  }

  /** Keep the committed palette until every replacement file is ready. */
  async setTheme(contributions: readonly ActivePluginStylesheet[], commit: () => void): Promise<void> {
    const ordered = orderContributions(contributions);
    const revision = ++this.themeRevision;
    this.pendingTheme = ordered;
    this.pruneFiles();
    await Promise.all(ordered.map((contribution) => this.loadFile(contribution)));
    if (revision !== this.themeRevision) return;
    this.committedTheme = ordered;
    this.pendingTheme = [];
    this.pruneFiles();
    this.publishSheets(commit);
  }

  /** Cancel preparation without removing or evicting the committed palette. */
  cancelTheme(): void {
    this.themeRevision++;
    this.pendingTheme = [];
    this.pruneFiles();
  }

  /** Remove an unavailable owner's palette and metadata before notifying consumers. */
  clearTheme(commit?: () => void): void {
    this.themeRevision++;
    this.pendingTheme = [];
    this.committedTheme = [];
    this.pruneFiles();
    this.publishSheets(commit);
  }

  /** Release all roots and pending file loads. The registry can subsequently be reused. */
  clear(commit?: () => void): void {
    this.revision++;
    this.themeRevision++;
    this.contributions = [];
    this.committedTheme = [];
    this.pendingTheme = [];
    for (const root of this.roots.keys()) this.apply(root, this.sheets, [], false);
    this.roots.clear();
    this.pruneFiles();
    this.publishSheets(commit);
  }

  private async loadFile(contribution: ActivePluginStylesheet): Promise<void> {
    let file = this.files.get(contribution.url);
    if (file === undefined) {
      const controller = new AbortController();
      // Synchronous loader failures follow the same cleanup path as fetch failures.
      file = { controller, loaded: Promise.resolve().then(() => this.load(contribution.url, controller.signal)) };
      this.files.set(contribution.url, file);
    }
    const requested = file;
    try {
      requested.sheet = await requested.loaded;
    } catch (cause) {
      if (this.files.get(contribution.url) === requested) this.files.delete(contribution.url);
      throw new Error(`Failed to load stylesheet ${contribution.id} (${contribution.url})`, { cause });
    }
  }

  private pruneFiles(): void {
    const urls = new Set([...this.contributions, ...this.committedTheme, ...this.pendingTheme].map(({ url }) => url));
    for (const [url, file] of this.files) {
      if (!urls.has(url)) {
        file.controller.abort();
        this.files.delete(url);
      }
    }
  }

  private publishSheets(commit?: () => void): void {
    // Sort descriptors before deduplication: one URL can have multiple owners/orders.
    // Preparation is deliberately absent; new roots receive only committed themes.
    const ordered = [...this.contributions, ...this.committedTheme].sort(compareContributions);
    const next = [...new Set(ordered.flatMap(({ url }) => {
      const sheet = this.files.get(url)?.sheet;
      return sheet === undefined ? [] : [sheet];
    }))];
    const previous = this.sheets;
    const changed = previous.length !== next.length || previous.some((sheet, index) => sheet !== next[index]);
    this.sheets = next;
    if (changed) for (const root of this.roots.keys()) this.apply(root, previous, next);
    commit?.();
    if (changed) for (const listener of [...this.listeners]) {
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

function orderContributions(contributions: readonly ActivePluginStylesheet[]): ActivePluginStylesheet[] {
  const ids = new Set<string>();
  for (const contribution of contributions) {
    if (ids.has(contribution.id)) throw new Error(`Duplicate stylesheet contribution: ${contribution.id}`);
    ids.add(contribution.id);
    const url = new URL(contribution.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Stylesheet ${contribution.id} must use an HTTP(S) file URL`);
  }
  return [...contributions].sort(compareContributions);
}

function compareContributions(a: ActivePluginStylesheet, b: ActivePluginStylesheet): number {
  return (a.order ?? 1000) - (b.order ?? 1000) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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
