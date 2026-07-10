export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredMapEnvelope {
  version: 1;
  entries: readonly (readonly [string, unknown])[];
}

export type StorageValueParser<T> = (value: unknown) => T | undefined;

export function browserSessionStorage(): KeyValueStorage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

// Backs state that must survive the OS killing a backgrounded/closed PWA
// process (unlike sessionStorage, which is scoped to the tab's lifetime) —
// e.g. "which session was I last on" for shortcuts and launch_handler.
export function browserLocalStorage(): KeyValueStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export class PersistentValueMap<T> {
  private readonly values = new Map<string, T>();

  constructor(private readonly storageKey: string, parseValue: StorageValueParser<T>, private readonly storage = browserSessionStorage()) {
    for (const [key, value] of loadEntries(storageKey, parseValue, storage)) this.values.set(key, value);
  }

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  set(key: string, value: T): void {
    this.values.set(key, value);
    this.save();
  }

  delete(key: string): void {
    this.values.delete(key);
    this.save();
  }

  entries(): [string, T][] {
    return [...this.values.entries()];
  }

  private save(): void {
    try {
      if (this.values.size === 0) {
        this.storage?.removeItem(this.storageKey);
        return;
      }
      const envelope: StoredMapEnvelope = { version: 1, entries: [...this.values.entries()] };
      this.storage?.setItem(this.storageKey, JSON.stringify(envelope));
    } catch {
      // Keep the in-memory copy even if sessionStorage is unavailable or full.
    }
  }
}

export function parseStoredString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function loadEntries<T>(storageKey: string, parseValue: StorageValueParser<T>, storage: KeyValueStorage | undefined): [string, T][] {
  try {
    const raw = storage?.getItem(storageKey);
    if (raw === undefined || raw === null || raw === "") return [];
    const value: unknown = JSON.parse(raw);
    if (!isStoredMapEnvelope(value)) return [];
    const entries: [string, T][] = [];
    for (const entry of value.entries) {
      const key = entry[0];
      const parsed = parseValue(entry[1]);
      if (parsed !== undefined) entries.push([key, parsed]);
    }
    return entries;
  } catch {
    return [];
  }
}

function isStoredMapEnvelope(value: unknown): value is StoredMapEnvelope {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["entries"])) return false;
  return value["entries"].every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[0] !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
