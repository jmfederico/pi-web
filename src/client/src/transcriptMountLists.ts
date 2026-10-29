import { TranscriptMountWindow, type TranscriptMountRow } from "./transcriptMountWindow";

interface TranscriptMountListsHost {
  getRoot(): ParentNode;
  getScroller(): HTMLElement | undefined;
  getRequestedAnchor(): string | undefined;
  protectMountedRows?(): boolean;
  beforeChange(): void;
  requestRender(): void;
  geometryChanged(): void;
}

/** Child lists share the transcript's viewport, planner and correction authority.
 * Controllers exist only while their list is mounted; closing/removing a body
 * releases its observers and measurements instead of caching detached DOM.
 */
export class TranscriptMountLists {
  private scope = "";
  private readonly lists = new Map<string, TranscriptMountWindow>();

  constructor(private readonly host: TranscriptMountListsHost) {}

  plan(scope: string, key: string, rows: readonly TranscriptMountRow[]) {
    if (scope !== this.scope) {
      this.clear();
      this.scope = scope;
    }
    let window = this.lists.get(key);
    if (window === undefined) {
      window = new TranscriptMountWindow({
        getScroller: () => this.host.getScroller(),
        getOrigin: () => this.origin(key),
        getRows: () => Array.from(this.origin(key)?.parentElement?.querySelectorAll<HTMLElement>("[data-mount-list]") ?? [])
          .filter((element) => element.dataset["mountList"] === key),
        getRequestedAnchor: () => this.host.getRequestedAnchor(),
        protectMountedRows: () => this.host.protectMountedRows?.() === true,
        beforeChange: () => { this.host.beforeChange(); },
        requestRender: () => { this.host.requestRender(); },
        geometryChanged: () => { this.host.geometryChanged(); },
      });
      this.lists.set(key, window);
    }
    return window.plan(JSON.stringify([scope, key]), rows);
  }

  width(key: string): number {
    return this.origin(key)?.getBoundingClientRect().width ?? 0;
  }

  requestAnchor(anchorId: string): boolean {
    for (const window of this.lists.values()) if (window.requestAnchor(anchorId)) return true;
    return false;
  }

  afterRender(): void {
    for (const [key, window] of this.lists) {
      if (this.origin(key) === undefined) {
        window.dispose();
        this.lists.delete(key);
      } else window.afterRender();
    }
  }

  schedule(): void {
    for (const window of this.lists.values()) window.schedule();
  }

  clear(): void {
    for (const window of this.lists.values()) window.dispose();
    this.lists.clear();
    this.scope = "";
  }

  private origin(key: string): HTMLElement | undefined {
    return Array.from(this.host.getRoot().querySelectorAll<HTMLElement>("[data-mount-origin]"))
      .find((element) => element.dataset["mountOrigin"] === key);
  }
}
