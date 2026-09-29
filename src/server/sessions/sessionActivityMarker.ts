import { randomUUID } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";

interface Marker {
  owner: string;
  updatedAt: number;
}

interface Entry {
  pending: Promise<void>;
  activeElsewhere: boolean;
  refreshedAt?: number;
  busy?: boolean;
}

const markerPath = (sessionFile: string): string => `${sessionFile}.pi-web-activity.json`;
const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** Best-effort advisory presence, not a lock or an atomic ownership claim. */
export class SessionActivityMarker {
  private readonly owner: string;
  private readonly now: () => number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly entries = new Map<string, Entry>();
  private disposal?: Promise<void>;

  constructor(options: { owner?: string; now?: () => number; onError?: (error: unknown) => void } = {}) {
    this.owner = options.owner ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  async refresh(sessionFile: string | undefined, busy: boolean): Promise<void> {
    if (sessionFile === undefined || sessionFile === "" || this.disposal) return;
    let entry = this.entries.get(sessionFile);
    if (!entry) {
      entry = { pending: Promise.resolve(), activeElsewhere: false };
      this.entries.set(sessionFile, entry);
    }
    const state = entry;
    await this.enqueue(state, async () => {
      const now = this.now();
      if (state.busy === busy && state.refreshedAt !== undefined && now - state.refreshedAt < 2_000) return;
      state.busy = busy;
      state.refreshedAt = now;
      // Keep the last known activity visible until the filesystem read completes.
      // Never create directories or sidecars for transcripts that do not exist.
      await stat(sessionFile);
      const marker = await this.readMarker(sessionFile);
      state.activeElsewhere = marker !== undefined && marker.owner !== this.owner && now - marker.updatedAt <= 15_000;
      if (state.activeElsewhere) return;
      if (busy) {
        await writeFile(markerPath(sessionFile), JSON.stringify({ owner: this.owner, updatedAt: now }));
      } else if (marker?.owner === this.owner) {
        await unlink(markerPath(sessionFile));
      }
    });
  }

  isActiveElsewhere(sessionFile: string | undefined): boolean {
    return sessionFile === undefined ? false : this.entries.get(sessionFile)?.activeElsewhere ?? false;
  }

  async release(sessionFile: string | undefined): Promise<void> {
    if (sessionFile === undefined || sessionFile === "") return;
    const entry = this.entries.get(sessionFile);
    if (!entry) return;
    const pending = this.enqueue(entry, async () => {
      entry.activeElsewhere = false;
      delete entry.refreshedAt;
      delete entry.busy;
      if ((await this.readMarker(sessionFile))?.owner === this.owner) {
        await unlink(markerPath(sessionFile));
      }
    });
    await pending;
    if (entry.pending === pending) this.entries.delete(sessionFile);
  }

  async dispose(): Promise<void> {
    this.disposal ??= Promise.all([...this.entries.keys()].map((file) => this.release(file))).then(() => undefined);
    await this.disposal;
  }

  private enqueue(entry: Entry, operation: () => Promise<void>): Promise<void> {
    entry.pending = entry.pending.then(operation).catch((error: unknown) => {
      entry.activeElsewhere = false;
      if (!isMissing(error)) {
        // An error reporter must not turn advisory IO into a session failure.
        try { this.onError?.(error); } catch { /* Best effort only. */ }
      }
    });
    return entry.pending;
  }

  private async readMarker(sessionFile: string): Promise<Marker | undefined> {
    let text: string;
    try {
      text = await readFile(markerPath(sessionFile), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { return undefined; }
    if (typeof value !== "object" || value === null || !("owner" in value) || !("updatedAt" in value)) return undefined;
    if (typeof value.owner !== "string" || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
    return { owner: value.owner, updatedAt: value.updatedAt };
  }
}
