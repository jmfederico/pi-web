import { browserSessionStorage, type KeyValueStorage } from "./sessionStorageMemory";

export interface RecentSessionEntry {
  sessionId: string;
  accessedAt: number;
}

const STORAGE_KEY = "pi-web:recent-sessions:v1";
const DEFAULT_MAX_ENTRIES = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStoredRecentEntries(value: unknown): RecentSessionEntry[] | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value["entries"])) return undefined;
  const entries: RecentSessionEntry[] = [];
  for (const entry of value["entries"]) {
    if (!isRecord(entry)) continue;
    if (typeof entry["sessionId"] !== "string" || entry["sessionId"] === "") continue;
    if (typeof entry["accessedAt"] !== "number") continue;
    entries.push({ sessionId: entry["sessionId"], accessedAt: entry["accessedAt"] });
  }
  return entries;
}

function loadRecentEntries(storage: KeyValueStorage | undefined): Map<string, RecentSessionEntry[]> {
  const map = new Map<string, RecentSessionEntry[]>();
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === undefined || raw === null || raw === "") return map;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value["version"] !== 1) return map;
    if (!Array.isArray(value["entries"])) return map;
    for (const entry of value["entries"]) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0] === "") continue;
      const parsed = parseStoredRecentEntries(entry[1]);
      if (parsed !== undefined && parsed.length > 0) map.set(entry[0], parsed);
    }
  } catch {
    // Ignore corrupt storage.
  }
  return map;
}

function serializeRecentEntries(entries: Map<string, RecentSessionEntry[]>): string {
  const envelope = {
    version: 1,
    entries: [...entries.entries()].filter(([, list]) => list.length > 0).map(([cwd, list]) => [cwd, { entries: list }] as const),
  };
  return JSON.stringify(envelope);
}

function saveRecentEntries(storage: KeyValueStorage | undefined, entries: Map<string, RecentSessionEntry[]>): void {
  try {
    if (entries.size === 0) {
      storage?.removeItem(STORAGE_KEY);
      return;
    }
    storage?.setItem(STORAGE_KEY, serializeRecentEntries(entries));
  } catch {
    // Keep in-memory copy even if storage is unavailable.
  }
}

export class RecentSessionsStore {
  private readonly entries: Map<string, RecentSessionEntry[]>;
  private readonly maxEntries: number;

  constructor(
    maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly storage: KeyValueStorage | undefined = browserSessionStorage(),
  ) {
    this.maxEntries = maxEntries;
    this.entries = loadRecentEntries(storage);
  }

  recordAccess(cwd: string, sessionId: string): void {
    const current = this.entries.get(cwd) ?? [];
    const filtered = current.filter((entry) => entry.sessionId !== sessionId);
    filtered.unshift({ sessionId, accessedAt: Date.now() });
    this.entries.set(cwd, filtered.slice(0, this.maxEntries));
    saveRecentEntries(this.storage, this.entries);
  }

  getRecent(cwd: string): RecentSessionEntry[] {
    return this.entries.get(cwd) ?? [];
  }

  removeSession(cwd: string, sessionId: string): void {
    const current = this.entries.get(cwd);
    if (current === undefined) return;
    const filtered = current.filter((entry) => entry.sessionId !== sessionId);
    if (filtered.length === current.length) return;
    if (filtered.length === 0) {
      this.entries.delete(cwd);
    } else {
      this.entries.set(cwd, filtered);
    }
    saveRecentEntries(this.storage, this.entries);
  }

  forgetWorkspace(cwd: string): void {
    if (!this.entries.has(cwd)) return;
    this.entries.delete(cwd);
    saveRecentEntries(this.storage, this.entries);
  }
}
