const CACHE_PREFIX = "pi-web:chat-history:";
const CACHE_TTL_MS = 30 * 60 * 1000;

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
    sessionStorage.setItem(cacheKey(sessionId), JSON.stringify({ ...page, savedAt: Date.now() }));
  } catch {
    // Ignore quota/private-mode failures; history paging still works without cache.
  }
}

export function mergeChatHistory(existing: RawMessagePage | undefined, incoming: RawMessagePage): RawMessagePage {
  if (!existing || existing.total !== incoming.total) return incoming;

  const start = Math.min(existing.start, incoming.start);
  const end = Math.max(existing.start + existing.messages.length, incoming.start + incoming.messages.length);
  const messages = new Array<unknown>(end - start);
  copyInto(messages, start, existing);
  copyInto(messages, start, incoming);

  return { start, total: incoming.total, messages: messages.filter((message) => message !== undefined) };
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
  return typeof value === "object"
    && value !== null
    && "messages" in value
    && "start" in value
    && "total" in value
    && "savedAt" in value
    && Array.isArray(value.messages)
    && typeof value.start === "number"
    && typeof value.total === "number"
    && typeof value.savedAt === "number";
}
