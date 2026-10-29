import { machineSessionKey } from "./machineKeys";

export interface ChatDisclosureSnapshot {
  open: string[];
  closedDefaultOpen: string[];
}

export interface ChatDisclosureStorage {
  read(sessionId: string): ChatDisclosureSnapshot | undefined;
  write(sessionId: string, snapshot: ChatDisclosureSnapshot): void;
}

const GROUP_STORAGE_PREFIX = "pi-web:chat-groups:";

const browserChatDisclosureStorage: ChatDisclosureStorage = {
  read(sessionId: string): ChatDisclosureSnapshot | undefined {
    try {
      if (typeof localStorage === "undefined") return undefined;
      const raw = localStorage.getItem(groupStorageKey(sessionId));
      if (raw === null || raw === "") return undefined;
      return parseDisclosureSnapshot(JSON.parse(raw));
    } catch {
      return undefined;
    }
  },

  write(sessionId: string, snapshot: ChatDisclosureSnapshot): void {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(groupStorageKey(sessionId), JSON.stringify(snapshot));
    } catch {
      // Ignore storage failures; group disclosure should still work for this render.
    }
  },
};

export class ChatDisclosureController {
  private sessionId = "";
  private openGroupKeys = new Set<string>();
  private closedDefaultOpenGroupKeys = new Set<string>();

  constructor(private readonly storage: ChatDisclosureStorage = browserChatDisclosureStorage) {}

  syncSession(sessionId: string, machineId = "local"): void {
    // Keep existing local bookmarks; remote machines get a distinct namespace.
    const scope = sessionId === "" || machineId === "local" ? sessionId : machineSessionKey(machineId, sessionId);
    if (this.sessionId === scope) return;
    this.sessionId = scope;
    const snapshot = scope === "" ? undefined : this.storage.read(scope);
    this.openGroupKeys = new Set(snapshot?.open ?? []);
    this.closedDefaultOpenGroupKeys = new Set(snapshot?.closedDefaultOpen ?? []);
  }

  isOpen(groupKey: string, defaultOpen: boolean): boolean {
    if (defaultOpen) return !this.closedDefaultOpenGroupKeys.has(groupKey);
    return this.openGroupKeys.has(groupKey);
  }

  applyToggle(groupKey: string, open: boolean, defaultOpen: boolean): boolean {
    const wasOpen = this.isOpen(groupKey, defaultOpen);
    const nextOpenKeys = new Set(this.openGroupKeys);
    const nextClosedDefaultOpenKeys = new Set(this.closedDefaultOpenGroupKeys);

    if (defaultOpen) {
      nextOpenKeys.delete(groupKey);
      if (open) nextClosedDefaultOpenKeys.delete(groupKey);
      else nextClosedDefaultOpenKeys.add(groupKey);
    } else {
      nextClosedDefaultOpenKeys.delete(groupKey);
      if (open) nextOpenKeys.add(groupKey);
      else nextOpenKeys.delete(groupKey);
    }

    const nextOpen = defaultOpen ? !nextClosedDefaultOpenKeys.has(groupKey) : nextOpenKeys.has(groupKey);
    if (nextOpen === wasOpen && setsEqual(nextOpenKeys, this.openGroupKeys) && setsEqual(nextClosedDefaultOpenKeys, this.closedDefaultOpenGroupKeys)) return false;

    this.openGroupKeys = nextOpenKeys;
    this.closedDefaultOpenGroupKeys = nextClosedDefaultOpenKeys;
    this.persist();
    return true;
  }

  hasChoice(key: string): boolean {
    return this.openGroupKeys.has(key) || this.closedDefaultOpenGroupKeys.has(key);
  }

  /** Move an explicit provisional choice to its committed address. */
  transferChoice(from: string, to: string): void {
    if (from === to) return;
    const open = this.openGroupKeys.delete(from);
    const closed = this.closedDefaultOpenGroupKeys.delete(from);
    if (!open && !closed) return;
    this.openGroupKeys.delete(to);
    this.closedDefaultOpenGroupKeys.delete(to);
    if (open) this.openGroupKeys.add(to);
    else this.closedDefaultOpenGroupKeys.add(to);
    this.persist();
  }

  snapshot(): ChatDisclosureSnapshot {
    return {
      open: [...this.openGroupKeys],
      closedDefaultOpen: [...this.closedDefaultOpenGroupKeys],
    };
  }

  private persist(): void {
    if (this.sessionId === "") return;
    this.storage.write(this.sessionId, this.snapshot());
  }
}

export function groupStorageKey(sessionId: string): string {
  return `${GROUP_STORAGE_PREFIX}${sessionId}`;
}

export function parseDisclosureSnapshot(value: unknown): ChatDisclosureSnapshot | undefined {
  if (Array.isArray(value)) {
    return { open: stringItems(value), closedDefaultOpen: [] };
  }
  if (!isRecord(value)) return undefined;
  return {
    open: Array.isArray(value["open"]) ? stringItems(value["open"]) : [],
    closedDefaultOpen: Array.isArray(value["closedDefaultOpen"]) ? stringItems(value["closedDefaultOpen"]) : [],
  };
}

function stringItems(items: unknown[]): string[] {
  return items.filter((item): item is string => typeof item === "string");
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
