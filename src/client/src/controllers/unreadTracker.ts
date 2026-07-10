import { browserSessionStorage, type KeyValueStorage } from "./sessionStorageMemory";

const STORAGE_KEY = "pi-web:unread:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class UnreadTracker {
  private readonly lastReadCounts = new Map<string, number>();

  constructor(private readonly storage: KeyValueStorage | undefined = browserSessionStorage()) {
    this.load();
  }

  markAsRead(sessionId: string, messageCount: number): void {
    if (messageCount < 0) return;
    this.lastReadCounts.set(sessionId, messageCount);
    this.save();
  }

  hasUnread(sessionId: string, currentMessageCount: number): boolean {
    const lastRead = this.lastReadCounts.get(sessionId);
    if (lastRead === undefined) return currentMessageCount > 0;
    return currentMessageCount > lastRead;
  }

  clearForSession(sessionId: string): void {
    this.lastReadCounts.delete(sessionId);
    this.save();
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw === undefined || raw === null || raw === "") return;
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) return;
      if (value["version"] !== 1 || !Array.isArray(value["entries"])) return;
      for (const entry of value["entries"]) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        if (typeof entry[0] !== "string" || entry[0] === "" || typeof entry[1] !== "number") continue;
        this.lastReadCounts.set(entry[0], entry[1]);
      }
    } catch {
      // Ignore corrupt storage.
    }
  }

  private save(): void {
    try {
      if (this.lastReadCounts.size === 0) {
        this.storage?.removeItem(STORAGE_KEY);
        return;
      }
      const envelope = {
        version: 1,
        entries: [...this.lastReadCounts.entries()],
      };
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // Keep in-memory copy even if storage is unavailable.
    }
  }
}