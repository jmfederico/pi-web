import { planTranscriptMounts } from "./transcriptMountPlan";

export interface TranscriptMountRow {
  key: string;
  revision: unknown;
  layoutRevision: number;
  estimate: number;
  anchors: readonly string[];
  keepMounted: boolean;
  /** Stable individual cells when a visual row contains several gallery items. */
  members?: readonly string[];
}

interface MountWindowHost {
  getScroller(): HTMLElement | undefined;
  getOrigin(): HTMLElement | undefined;
  getRows(): HTMLElement[];
  getRequestedAnchor(): string | undefined;
  protectMountedRows?(): boolean;
  beforeChange(): void;
  requestRender(): void;
  geometryChanged(): void;
}

/** Mounting metadata belongs to retained presentation rows, not durable history.
 * The same planner/measurement boundary serves outer rows and compound child lists.
 * It schedules rendering/measurement only; the viewport owner remains the sole scroll writer.
 */
export class TranscriptMountWindow {
  private scope = "";
  private rows: readonly TranscriptMountRow[] = [];
  private readonly measurements = new Map<string, { width: number; revision: unknown; layoutRevision: number; height: number }>();
  private viewport = { top: 0, height: 600, width: 0 };
  private frame: number | undefined;
  private observer: ResizeObserver | undefined;
  private scroller: HTMLElement | undefined;
  private observed = new Set<HTMLElement>();
  private mounted = new Set<string>();
  private composing: string | undefined;
  private hasSelection = false;
  private signature = "";
  private disposed = false;

  constructor(private readonly host: MountWindowHost) {}

  plan(scope: string, rows: readonly TranscriptMountRow[]) {
    const scopeChanged = scope !== this.scope;
    if (scopeChanged) {
      this.scope = scope;
      this.measurements.clear();
      this.mounted.clear();
      this.composing = undefined;
      this.viewport = { top: 0, height: 600, width: 0 };
    }
    this.rows = rows;
    const retained = new Set(rows.map((row) => row.key));
    for (const key of this.measurements.keys()) if (!retained.has(key)) this.measurements.delete(key);
    const plan = this.computePlan();
    const signature = JSON.stringify(plan);
    if (!scopeChanged && signature !== this.signature) this.host.beforeChange();
    this.signature = signature;
    this.mounted = new Set(plan.flatMap((segment) => segment.kind === "rows"
      ? rows.slice(segment.start, segment.end).map((row) => row.key) : []));
    return plan;
  }

  requestAnchor(anchorId: string): boolean {
    const row = this.rows.find((candidate) => candidate.anchors.includes(anchorId));
    if (row === undefined || this.mounted.has(row.key)) return false;
    // Restoration supplies the protected address on the next render. No scrolling here.
    this.host.requestRender();
    return true;
  }

  afterRender(): void {
    const scroller = this.host.getScroller();
    if (scroller === undefined || this.disposed) return;
    if (this.scroller !== scroller) {
      this.detach();
      this.scroller = scroller;
      scroller.ownerDocument.addEventListener("selectionchange", this.onSelectionChange);
      this.onSelectionChange();
      scroller.addEventListener("compositionstart", this.startComposition);
      scroller.addEventListener("compositionend", this.endComposition);
      this.observer = new ResizeObserver(this.schedule);
      this.observer.observe(scroller);
    }
    const origin = this.host.getOrigin();
    const elements = new Set([...this.host.getRows(), ...(origin === undefined ? [] : [origin])]);
    for (const element of this.observed) if (!elements.has(element)) this.observer?.unobserve(element);
    for (const element of elements) if (!this.observed.has(element)) this.observer?.observe(element);
    this.observed = elements;
    this.schedule();
  }

  readonly schedule = (): void => {
    if (this.disposed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      const scroller = this.host.getScroller();
      if (scroller === undefined) return;
      const origin = this.host.getOrigin();
      if (origin === undefined) return;
      const width = origin.getBoundingClientRect().width;
      const widthChanged = width !== this.viewport.width;
      this.viewport = {
        top: scroller.getBoundingClientRect().top - origin.getBoundingClientRect().top,
        height: scroller.clientHeight,
        width,
      };
      const rows = new Map(this.rows.map((row) => [row.key, row]));
      let changed = false;
      const heights = new Map<string, number>();
      for (const element of this.host.getRows()) {
        const key = element.dataset["transcriptRow"];
        const height = element.getBoundingClientRect().height;
        if (key !== undefined && height > 0) heights.set(key, Math.max(heights.get(key) ?? 0, height));
      }
      for (const [key, height] of heights) {
        const row = rows.get(key);
        if (row === undefined) continue;
        const previous = this.measurements.get(key);
        if (previous?.height !== height || previous.width !== this.viewport.width || previous.revision !== row.revision || previous.layoutRevision !== row.layoutRevision) changed = true;
        this.measurements.set(key, { width: this.viewport.width, revision: row.revision, layoutRevision: row.layoutRevision, height });
      }
      const signature = JSON.stringify(this.computePlan());
      if (signature !== this.signature || widthChanged) this.host.requestRender();
      if (changed) this.host.geometryChanged();
    });
  };

  private computePlan() {
    const requested = this.host.getRequestedAnchor();
    const protectedKeys = new Set(this.rows.filter((row) => row.keepMounted || row.anchors.includes(requested ?? "")).map((row) => row.key));
    const document = this.scroller?.ownerDocument;
    // Opaque cross-shadow selections conservatively protect the mounted set.
    // Selection content is sampled only on selectionchange, not every scroll frame.
    const protectAll = this.hasSelection || this.host.protectMountedRows?.() === true;
    const members = new Map(this.rows.flatMap((row) => (row.members ?? []).map((member) => [member, row.key] as const)));
    let readerProtected = false;
    const viewport = this.scroller?.getBoundingClientRect();
    for (const element of this.host.getRows()) {
      const key = members.get(element.dataset["mountItem"] ?? "") ?? element.dataset["transcriptRow"];
      if (key === undefined) continue;
      const rect = element.getBoundingClientRect();
      if (!readerProtected && viewport !== undefined && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        // The current reader must survive estimated-range changes until the
        // viewport owner has committed its measured anchor correction.
        protectedKeys.add(key);
        readerProtected = true;
      }
      const popup = document?.defaultView?.CSS.supports("selector(:popover-open)") === true && element.querySelector(":popover-open") !== null;
      if (protectAll || element.matches(":focus-within") || popup || key === this.composing) protectedKeys.add(key);
    }
    const overscan = Math.max(600, this.viewport.height);
    const start = Math.max(0, this.viewport.top - overscan);
    const end = Math.max(0, this.viewport.top + this.viewport.height + overscan);
    return planTranscriptMounts(this.rows.map((row) => {
      const measured = this.measurements.get(row.key);
      return { key: row.key, height: measured?.width === this.viewport.width && measured.revision === row.revision && measured.layoutRevision === row.layoutRevision ? measured.height : row.estimate };
    }), { top: start, height: Math.max(0, end - start), overscan: 0 }, protectedKeys);
  }

  private readonly onSelectionChange = (): void => {
    const selection = this.scroller?.ownerDocument.getSelection();
    // WebKit can expose BODY/collapsed endpoints for real shadow-root selections.
    this.hasSelection = selection !== null && selection !== undefined && (!selection.isCollapsed || selection.toString() !== "");
    this.schedule();
  };

  private readonly startComposition = (event: Event): void => {
    const ownRows = new Set(this.host.getRows());
    const owner = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement && ownRows.has(node));
    this.composing = owner?.dataset["transcriptRow"];
  };
  private readonly endComposition = (): void => { this.composing = undefined; this.schedule(); };

  private detach(): void {
    this.observer?.disconnect();
    this.observed.clear();
    this.scroller?.ownerDocument.removeEventListener("selectionchange", this.onSelectionChange);
    this.hasSelection = false;
    this.scroller?.removeEventListener("compositionstart", this.startComposition);
    this.scroller?.removeEventListener("compositionend", this.endComposition);
    this.scroller = undefined;
  }

  suspend(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.detach();
    this.measurements.clear();
    this.rows = [];
    this.mounted.clear();
    this.scope = "";
    this.signature = "";
  }

  dispose(): void {
    this.suspend();
    this.disposed = true;
  }
}
