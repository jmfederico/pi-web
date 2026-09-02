import type { ReviewComment } from "./reviewTypes";

const storagePrefix = "pi-web:review-comments:";
const STORAGE_VERSION = 1;

function storageKey(sessionKey: string): string {
  return `${storagePrefix}${sessionKey}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseComment(value: unknown): ReviewComment[] {
  if (!isRecord(value)) return [];
  const id = value["id"];
  const body = value["body"];
  const sourceHash = value["sourceHash"];
  const createdAt = value["createdAt"];
  const updatedAt = value["updatedAt"];
  const anchor = value["anchor"];
  if (typeof id !== "string" || typeof body !== "string" || typeof sourceHash !== "string") return [];
  if (typeof createdAt !== "number" || typeof updatedAt !== "number") return [];
  if (!isRecord(anchor)) return [];
  const filePath = anchor["filePath"];
  const range = anchor["range"];
  if (typeof filePath !== "string" || !isRecord(range)) return [];
  const side = range["side"];
  const start = range["start"];
  const end = range["end"];
  if (side !== "new" && side !== "old") return [];
  if (typeof start !== "number" || typeof end !== "number") return [];
  return [{
    id,
    body,
    sourceHash,
    createdAt,
    updatedAt,
    anchor: { filePath, range: { side, start, end } },
  }];
}

export function loadComments(sessionKey: string, storage = browserStorage()): ReviewComment[] {
  try {
    const raw = storage?.getItem(storageKey(sessionKey));
    if (raw === null || raw === undefined || raw === "") return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed["version"] !== STORAGE_VERSION || !Array.isArray(parsed["comments"])) return [];
    return parsed["comments"].flatMap((candidate) => parseComment(candidate));
  } catch {
    return [];
  }
}

export function saveComments(sessionKey: string, comments: readonly ReviewComment[], storage = browserStorage()): void {
  try {
    if (comments.length === 0) {
      storage?.removeItem(storageKey(sessionKey));
      return;
    }
    storage?.setItem(storageKey(sessionKey), JSON.stringify({ version: STORAGE_VERSION, comments: [...comments] }));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function clearComments(sessionKey: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(storageKey(sessionKey));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function moveComments(fromSessionKey: string, toSessionKey: string, storage = browserStorage()): void {
  const comments = loadComments(fromSessionKey, storage);
  if (comments.length === 0) return;
  saveComments(toSessionKey, comments, storage);
  clearComments(fromSessionKey, storage);
}
