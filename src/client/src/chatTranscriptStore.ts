import { normalizeMessages } from "./chatMessages";
import { applyTranscriptEvent, seedStreamingPartial } from "./chatTranscript";
import { canMergeHistorySnapshot, mergeChatHistory, readChatHistoryCache, removeChatHistoryCache, writeChatHistoryCache, type RawMessagePage } from "./chatHistoryCache";
import type { ChatLine } from "./chatTypes";
import type { SessionUiEvent } from "./sessionSocket";

export interface ChatTranscriptView {
  messages: ChatLine[];
  messagePageStart: number;
  // End offset in the raw transcript. Normalization may coalesce multiple raw
  // entries into one displayed chat message, especially tool calls/results.
  messagePageEnd: number;
  messagePageTotal: number;
}

export interface ChatHistoryCacheAdapter {
  read(sessionId: string): RawMessagePage | undefined;
  write(sessionId: string, page: RawMessagePage): void;
  remove?(sessionId: string): void;
}

const browserChatHistoryCache: ChatHistoryCacheAdapter = {
  read: readChatHistoryCache,
  write: writeChatHistoryCache,
  remove: removeChatHistoryCache,
};

export interface ChatHistoryMemoryLimits {
  maxSessions: number;
  maxBytes: number;
}

const DEFAULT_MEMORY_LIMITS: ChatHistoryMemoryLimits = { maxSessions: 8, maxBytes: 16 * 1024 * 1024 };

export class ChatTranscriptStore {
  private readonly rawHistoryPages = new Map<string, { page: RawMessagePage; bytes: number }>();
  private readonly historyRevisions = new Map<string, number>();
  private retainedBytes = 0;

  constructor(
    private readonly cache: ChatHistoryCacheAdapter = browserChatHistoryCache,
    private readonly memoryLimits: ChatHistoryMemoryLimits = DEFAULT_MEMORY_LIMITS,
  ) {}

  cachedView(sessionId: string): ChatTranscriptView {
    return transcriptViewFromHistory(this.rawHistoryPage(sessionId));
  }

  mergeHistory(sessionId: string, page: RawMessagePage): ChatTranscriptView {
    return this.storeHistory(sessionId, mergeChatHistory(this.rawHistoryPage(sessionId), page));
  }

  /** Recover current history by reads even when the branch-change event was missed. */
  mergeSnapshot(sessionId: string, page: RawMessagePage): ChatTranscriptView {
    const history = this.rawHistoryPage(sessionId);
    if (history !== undefined && !canMergeHistorySnapshot(history, page)) {
      // Also retire outstanding pagination reads from the abandoned projection.
      this.discard(sessionId);
      return this.storeHistory(sessionId, page);
    }
    const merged = mergeChatHistory(history, page);
    // Unlike pagination's hints, the snapshot owns this projection's count.
    return this.storeHistory(sessionId, { ...merged, total: page.total });
  }

  private storeHistory(sessionId: string, history: RawMessagePage): ChatTranscriptView {
    this.retainHistory(sessionId, history);
    this.cache.write(sessionId, history);
    return transcriptViewFromHistory(history);
  }

  applyLiveEvent(messages: ChatLine[], event: SessionUiEvent): ChatLine[] | undefined {
    return applyTranscriptEvent(messages, event);
  }

  /**
   * Seed the join-time in-flight partial assistant message on top of the
   * committed history view. Returns a new in-memory message list; the raw
   * history cache is deliberately untouched so the partial never persists.
   */
  seedStreamingPartial(messages: ChatLine[], partial: unknown): ChatLine[] {
    return seedStreamingPartial(messages, partial);
  }

  /** Reads started before a branch invalidation must not repopulate its cache. */
  historyRevision(sessionId: string): number {
    return this.historyRevisions.get(sessionId) ?? 0;
  }

  discard(sessionId: string): void {
    this.historyRevisions.set(sessionId, this.historyRevision(sessionId) + 1);
    this.releaseHistory(sessionId);
    this.cache.remove?.(sessionId);
  }

  rawHistoryPage(sessionId: string): RawMessagePage | undefined {
    const cached = this.rawHistoryPages.get(sessionId)?.page ?? this.cache.read(sessionId);
    if (cached !== undefined) this.retainHistory(sessionId, cached);
    return cached;
  }

  private retainHistory(sessionId: string, page: RawMessagePage): void {
    const previous = this.rawHistoryPages.get(sessionId);
    const bytes = previous?.page === page ? previous.bytes : estimateHistoryBytes(page);
    this.releaseHistory(sessionId);
    this.rawHistoryPages.set(sessionId, { page, bytes });
    this.retainedBytes += bytes;
    // Keep the most recently used page whole, even if it alone exceeds the
    // budget. Trimming it would lose the reader's loaded older-history range.
    while (this.rawHistoryPages.size > 1 && (
      this.rawHistoryPages.size > this.memoryLimits.maxSessions || this.retainedBytes > this.memoryLimits.maxBytes
    )) {
      const oldest = this.rawHistoryPages.keys().next().value;
      if (oldest !== undefined) this.releaseHistory(oldest);
    }
  }

  private releaseHistory(sessionId: string): void {
    const entry = this.rawHistoryPages.get(sessionId);
    if (entry === undefined) return;
    this.retainedBytes -= entry.bytes;
    this.rawHistoryPages.delete(sessionId);
  }
}

// Estimate retained JSON data without allocating another full serialized copy.
// This is a retention budget, not a measurement of the engine's heap overhead.
function estimateHistoryBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2 + 16;
  if (Array.isArray(value)) return value.reduce<number>((bytes, item: unknown) => bytes + 8 + estimateHistoryBytes(item), 32);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).reduce((bytes, [key, item]) => bytes + key.length * 2 + 16 + estimateHistoryBytes(item), 32);
  }
  return 8;
}

// Weak keys let eviction release both raw and normalized history. Raw pages are
// immutable snapshots; live events produce separate display arrays.
const historyViews = new WeakMap<RawMessagePage, ChatTranscriptView>();

export function transcriptViewFromHistory(history: RawMessagePage | undefined): ChatTranscriptView {
  const cached = history === undefined ? undefined : historyViews.get(history);
  if (cached !== undefined) return cached;
  const start = history?.start ?? 0;
  const view = {
    messages: normalizeMessages(history?.messages ?? []),
    messagePageStart: start,
    messagePageEnd: start + (history?.messages.length ?? 0),
    messagePageTotal: history?.total ?? 0,
  };
  if (history !== undefined) historyViews.set(history, view);
  return view;
}
