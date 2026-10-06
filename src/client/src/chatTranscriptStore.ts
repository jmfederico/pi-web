import { normalizeMessages } from "./chatMessages";
import { applyTranscriptEvent, seedStreamingPartial } from "./chatTranscript";
import { canMergeHistorySnapshot, mergeChatHistory, readChatHistoryCache, removeChatHistoryCache, writeChatHistoryCache, type RawMessagePage } from "./chatHistoryCache";
import type { ChatLine } from "./components/shared";
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

export class ChatTranscriptStore {
  private readonly rawHistoryPages = new Map<string, RawMessagePage>();
  private readonly historyRevisions = new Map<string, number>();

  constructor(private readonly cache: ChatHistoryCacheAdapter = browserChatHistoryCache) {}

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
    this.rawHistoryPages.set(sessionId, history);
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
    this.rawHistoryPages.delete(sessionId);
    this.cache.remove?.(sessionId);
  }

  rawHistoryPage(sessionId: string): RawMessagePage | undefined {
    const cached = this.rawHistoryPages.get(sessionId) ?? this.cache.read(sessionId);
    if (cached !== undefined) this.rawHistoryPages.set(sessionId, cached);
    return cached;
  }
}

export function transcriptViewFromHistory(history: RawMessagePage | undefined): ChatTranscriptView {
  const start = history?.start ?? 0;
  return {
    messages: normalizeMessages(history?.messages ?? []),
    messagePageStart: start,
    messagePageEnd: start + (history?.messages.length ?? 0),
    messagePageTotal: history?.total ?? 0,
  };
}
