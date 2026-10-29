const CACHE_PREFIX = "pi-web:chat-history:v2:";
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PERSISTED_MESSAGES = 100;
const MAX_PERSISTED_BYTES = 256 * 1024;
const MAX_PERSISTED_SESSIONS = 8;

export interface RawMessagePage {
  messages: unknown[];
  start: number;
  total: number;
}

export interface CachedChatHistory extends RawMessagePage {
  savedAt: number;
}

export function readChatHistoryCache(sessionId: string): RawMessagePage | undefined {
  try {
    const raw = sessionStorage.getItem(cacheKey(sessionId));
    if (raw === null || raw === "") return undefined;
    // Retire oversized entries written by older clients as cache misses.
    if (raw.length * 2 > MAX_PERSISTED_BYTES) {
      sessionStorage.removeItem(cacheKey(sessionId));
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedHistory(parsed)) return undefined;
    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) {
      sessionStorage.removeItem(cacheKey(sessionId));
      return undefined;
    }
    return { messages: parsed.messages, start: parsed.start, total: parsed.total };
  } catch {
    return undefined;
  }
}

export function writeChatHistoryCache(sessionId: string, page: RawMessagePage): void {
  try {
    const key = cacheKey(sessionId);
    const payload = persistedHistoryPayload(page);
    if (payload === undefined) {
      sessionStorage.removeItem(key);
      return;
    }
    // Keep the most recently written sessions, leaving unrelated storage alone.
    const entries: { key: string; savedAt: number }[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const storedKey = sessionStorage.key(index);
      if (storedKey === null || storedKey === key || !storedKey.startsWith(CACHE_PREFIX)) continue;
      const raw = sessionStorage.getItem(storedKey);
      entries.push({ key: storedKey, savedAt: persistedSavedAt(raw) });
    }
    entries.sort((a, b) => b.savedAt - a.savedAt);
    for (const [index, entry] of entries.entries()) {
      if (index >= MAX_PERSISTED_SESSIONS - 1 || Date.now() - entry.savedAt > CACHE_TTL_MS) {
        sessionStorage.removeItem(entry.key);
      }
    }
    sessionStorage.setItem(key, payload);
  } catch {
    // Ignore quota/private-mode failures; history paging still works without cache.
  }
}

function persistedSavedAt(raw: string | null): number {
  if (raw === null || raw.length * 2 > MAX_PERSISTED_BYTES) return 0;
  try {
    const stored: unknown = JSON.parse(raw);
    return isCachedHistory(stored) ? stored.savedAt : 0;
  } catch {
    return 0;
  }
}

/** Persist only a contiguous recent suffix; the store keeps the full page. */
function persistedHistoryPayload(page: RawMessagePage): string | undefined {
  const savedAt = Date.now();
  const end = page.start + page.messages.length;
  // Using end for the header reserves enough digits for every possible start.
  let bytes = JSON.stringify({ messages: [], start: end, total: page.total, savedAt }).length * 2;
  let offset = page.messages.length;
  const earliest = Math.max(0, offset - MAX_PERSISTED_MESSAGES);
  while (offset > earliest) {
    // Array serialization preserves JSON's null representation of empty slots.
    const message = JSON.stringify([page.messages[offset - 1]]);
    const nextBytes = (message.length - 2) * 2 + (offset < page.messages.length ? 2 : 0);
    if (bytes + nextBytes > MAX_PERSISTED_BYTES) break;
    bytes += nextBytes;
    offset -= 1;
  }
  // A single oversized newest message is a cache miss, not a gapped page or a
  // stale previous cache entry. The network remains authoritative.
  if (offset === page.messages.length && page.messages.length > 0) return undefined;
  return JSON.stringify({ messages: page.messages.slice(offset), start: page.start + offset, total: page.total, savedAt });
}

export function removeChatHistoryCache(sessionId: string): void {
  try {
    sessionStorage.removeItem(cacheKey(sessionId));
  } catch {
    // Ignore storage access errors; cache may simply be unavailable.
  }
}

export function mergeChatHistory(existing: RawMessagePage | undefined, incoming: RawMessagePage): RawMessagePage {
  if (existing === undefined || !isValidMessagePage(existing)) return incoming;
  if (!isValidMessagePage(incoming)) return existing;
  if (isCompleteReplacement(existing, incoming)) return incoming;

  const start = Math.min(existing.start, incoming.start);
  const end = Math.max(existing.start + existing.messages.length, incoming.start + incoming.messages.length);
  const messages = new Array<unknown>(end - start);
  copyInto(messages, start, existing);
  copyInto(messages, start, incoming);

  if (hasSparseEntries(messages)) return incoming;
  return { start, total: Math.max(existing.total, incoming.total), messages };
}

/**
 * An authoritative snapshot can retain cached pages only when their overlap
 * proves continuity. Counts alone cannot distinguish branches after a missed
 * invalidation; without overlap, fetch older history again rather than guess.
 * Pagination still uses mergeChatHistory's tolerant out-of-order semantics.
 */
export function canMergeHistorySnapshot(history: RawMessagePage, snapshot: RawMessagePage): boolean {
  if (!isValidMessagePage(history) || !isValidMessagePage(snapshot)) return false;
  // Pagination may have observed a newer append than this snapshot. Its total
  // is only a hint; reject cached messages beyond the authoritative range.
  const historyEnd = history.start + history.messages.length;
  if (historyEnd > snapshot.total) return false;
  if (history.total === 0) return true;
  const start = Math.max(history.start, snapshot.start);
  const end = Math.min(historyEnd, snapshot.start + snapshot.messages.length);
  return start < end && JSON.stringify(history.messages.slice(start - history.start, end - history.start))
    === JSON.stringify(snapshot.messages.slice(start - snapshot.start, end - snapshot.start));
}

/**
 * True when `page` is exactly the already-held tail of `history`, so merging it
 * would reproduce `history` unchanged. Poll responses arrive as fresh JSON
 * objects, so identity never holds; the messages are compared by JSON text,
 * which is exact for values that crossed the wire as JSON. The selected-session
 * poll uses this to skip a redundant merge, storage rewrite, and render when a
 * tick returns what is already shown.
 */
export function isHistoryTailSlice(history: RawMessagePage | undefined, page: RawMessagePage): boolean {
  if (history === undefined || !isValidMessagePage(page)) return false;
  if (page.total !== history.total) return false;
  const offset = page.start - history.start;
  if (offset < 0 || offset + page.messages.length !== history.messages.length) return false;
  return JSON.stringify(page.messages) === JSON.stringify(history.messages.slice(offset));
}

function isCompleteReplacement(existing: RawMessagePage, incoming: RawMessagePage): boolean {
  return existing.total > incoming.total && existing.start === 0 && incoming.start === 0 && incoming.messages.length === incoming.total;
}

function hasSparseEntries(messages: unknown[]): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    if (!(index in messages) || messages[index] === undefined) return true;
  }
  return false;
}

function copyInto(target: unknown[], targetStart: number, page: RawMessagePage): void {
  page.messages.forEach((message, index) => {
    target[page.start - targetStart + index] = message;
  });
}

function cacheKey(sessionId: string): string {
  return `${CACHE_PREFIX}${sessionId}`;
}

function isCachedHistory(value: unknown): value is CachedChatHistory {
  if (typeof value !== "object" || value === null) return false;
  if (!("messages" in value) || !("start" in value) || !("total" in value) || !("savedAt" in value)) return false;
  const { messages, start, total, savedAt } = value;
  return Array.isArray(messages)
    && typeof start === "number"
    && typeof total === "number"
    && typeof savedAt === "number"
    && isValidMessagePage({ messages, start, total });
}

function isValidMessagePage(page: RawMessagePage): boolean {
  return Number.isInteger(page.start)
    && Number.isInteger(page.total)
    && page.start >= 0
    && page.total >= page.start
    && page.messages.length <= page.total - page.start
    && !page.messages.some(isNormalizedChatLine);
}

function isNormalizedChatLine(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "role" in value
    && "parts" in value
    && !("content" in value)
    && typeof value.role === "string"
    && Array.isArray(value.parts);
}
