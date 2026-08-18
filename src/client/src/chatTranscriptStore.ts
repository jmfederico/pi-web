import { normalizeMessages } from "./chatMessages";
import { applyTranscriptEvent, seedStreamingPartial } from "./chatTranscript";
import { mergeChatHistory, readChatHistoryCache, removeChatHistoryCache, writeChatHistoryCache, type RawMessagePage } from "./chatHistoryCache";
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

  constructor(private readonly cache: ChatHistoryCacheAdapter = browserChatHistoryCache) {}

  cachedView(sessionId: string): ChatTranscriptView {
    return transcriptViewFromHistory(this.rawHistoryPage(sessionId));
  }

  mergeHistory(sessionId: string, page: RawMessagePage): ChatTranscriptView {
    const history = mergeChatHistory(this.rawHistoryPage(sessionId), page);
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

  discard(sessionId: string): void {
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
