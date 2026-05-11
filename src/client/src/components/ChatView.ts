import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { groupChatMessages, summarizeChatGroup } from "../chatGroups";
import { shouldRequestEarlierMessages } from "../chatHistoryLoading";
import type { SessionActivity, SessionStatus } from "../api";
import type { ChatLine, ChatPart } from "./shared";
import { chatStyles } from "./shared";
import "./FormattedText";

interface PrependScrollAnchor {
  scrollTop: number;
  scrollHeight: number;
}

function isScrollPosition(value: unknown): value is { index?: number; key?: string; offset: number } {
  return typeof value === "object"
    && value !== null
    && "offset" in value
    && typeof value.offset === "number"
    && (("key" in value && typeof value.key === "string") || ("index" in value && typeof value.index === "number"));
}

@customElement("chat-view")
export class ChatView extends LitElement {
  @property({ attribute: false }) messages: ChatLine[] = [];
  @property() sessionId = "";
  @property({ type: Number }) messageStart = 0;
  @property({ type: Number }) messageTotal = 0;
  @property({ type: Boolean }) hasMore = false;
  @property({ type: Boolean }) loadingMore = false;
  @property({ type: Boolean }) isReceivingPartialStream = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Number }) pendingMessageCount = 0;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) activity?: SessionActivity;
  @property({ attribute: false }) onLoadMore?: () => void;
  @query(".chat") private chat?: HTMLDivElement;
  @state() private pinnedToBottom = true;
  @state() private openGroupKeys = new Set<string>();
  @state() private loadedScrollPercent = 100;
  @state() private expandedMetaKey: string | undefined;
  @state() private copiedMessageKey: string | undefined;
  private suppressScrollSave = false;
  private saveScrollTimer?: number;
  private lastScrollTop = 0;
  private lastClientHeight = 0;
  private touchStartY: number | undefined;
  private loadMoreRequested = false;
  private readonly onViewportResize = () => {
    if (this.pinnedToBottom) this.scrollToBottom();
    else this.lastClientHeight = this.chat?.clientHeight ?? 0;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
  }

  protected override firstUpdated(): void {
    this.lastClientHeight = this.chat?.clientHeight ?? 0;
  }

  override disconnectedCallback(): void {
    window.clearTimeout(this.saveScrollTimer);
    window.removeEventListener("resize", this.onViewportResize);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("sessionId")) this.openGroupKeys = this.readOpenGroupKeys();
    if (changed.has("messages")) this.pinnedToBottom = this.pinnedToBottom && (this.didChatHeightChange() || this.isNearBottom());
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("loadingMore") && !this.loadingMore) this.loadMoreRequested = false;
    if (changed.has("hasMore") && !this.hasMore) this.loadMoreRequested = false;
    if (!changed.has("sessionId") && changed.has("messages") && this.pinnedToBottom) this.scrollToBottom();
    this.updateLoadedScrollPercent();
    if (changed.has("messages") || changed.has("hasMore") || changed.has("loadingMore")) this.requestLoadMoreIfNeeded();
  }

  override render() {
    return html`
      <div class="chat-wrap">
        ${this.renderHistoryIndicator()}
        <div class="chat" @scroll=${() => { this.onScroll(); }} @wheel=${(event: WheelEvent) => { this.onWheel(event); }} @touchstart=${(event: TouchEvent) => { this.onTouchStart(event); }} @touchmove=${(event: TouchEvent) => { this.onTouchMove(event); }}>
          ${this.renderHistoryBoundary()}
          ${groupChatMessages(this.messages, this.messageStart).map((group) => group.kind === "message"
            ? this.renderMessage(group.message, group.index)
            : this.renderMessageGroup(group.messages, group.startIndex))}
          ${this.renderQueuedMessages()}
          ${this.renderSessionActivity()}
        </div>
        ${this.renderActivityDock()}
      </div>
    `;
  }

  private renderActivityDock() {
    const state = this.activityState();
    if (state === undefined) return null;
    const active = state !== "idle" || this.activity?.phase === "active";
    return html`
      <div class=${active ? "activity-dock active" : "activity-dock"} aria-live="polite">
        <span class="dot"></span>
        <span class="activity-text">${this.activityText(state)}</span>
      </div>
    `;
  }

  private renderQueuedMessages() {
    const queued = this.status?.queuedMessages ?? [];
    if (queued.length === 0) return null;
    return html`
      <aside class="queued-messages" aria-live="polite">
        <div class="queued-header">
          <strong>Queued messages</strong>
          <small>${queued.length} pending · Stop clears the queue</small>
        </div>
        ${queued.map((message, index) => html`
          <div class="queued-message">
            <span class="queued-kind">${message.kind === "steer" ? "Steer" : "Follow-up"} ${String(index + 1)}</span>
            <formatted-text .text=${message.text}></formatted-text>
          </div>
        `)}
      </aside>
    `;
  }

  private renderSessionActivity() {
    if (this.isReceivingPartialStream) return html`
      <aside class="session-activity receiving" aria-live="polite">
        <strong>Receiving answer…</strong>
        <span>This session was reconnected mid-response. The answer will appear when complete.</span>
      </aside>
    `;
    if (!this.isCompacting) return null;
    return html`
      <aside class="session-activity compacting" aria-live="polite">
        <strong>Compacting history…</strong>
        <span>The agent is summarizing earlier context. New prompts will be queued until compaction finishes.</span>
        ${this.pendingMessageCount > 0 ? html`<small>${this.pendingMessageCount} queued ${this.pendingMessageCount === 1 ? "message" : "messages"}</small>` : null}
      </aside>
    `;
  }

  private activityState(): string | undefined {
    const status = this.status;
    if (status === undefined) return this.activity?.label;
    if (status.isCompacting) return "compacting";
    if (status.isBashRunning) return "bash";
    if (status.isStreaming) return "running";
    if (status.pendingMessageCount > 0) return "queued";
    return "idle";
  }

  private activityText(state: string): string {
    const activity = this.activity;
    if (activity === undefined) return state;
    if (state !== "idle" && activity.phase === "idle") return state;
    return activity.detail !== undefined && activity.detail !== "" ? `${activity.label}: ${activity.detail}` : activity.label;
  }

  private renderHistoryIndicator() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const loadedCount = this.messages.length;
    const loadedPercent = Math.min(100, Math.round((loadedCount / this.messageTotal) * 100));
    const olderCount = this.messageStart;
    const fullHistory = olderCount <= 0
      ? "full history loaded"
      : `${String(olderCount)} older not loaded · ${String(loadedPercent)}% loaded`;
    return html`
      <div class="history-indicator">
        <div>${fullHistory}</div>
        <div>loaded scroll: ${String(this.loadedScrollPercent)}% from top</div>
      </div>
    `;
  }

  private renderHistoryBoundary() {
    const range = this.historyRangeLabel();
    if (this.loadingMore) return html`<div class="history-boundary"><span>Loading earlier messages…</span>${range}</div>`;
    if (this.hasMore) return html`
      <div class="history-boundary">
        <button type="button" class="history-load-button" @click=${() => { this.requestLoadMore(true); }}>Load earlier messages</button>
        <span>Scroll up to load earlier messages</span>
        ${range}
      </div>
    `;
    if (this.messages.length) return html`<div class="history-boundary"><span>Beginning of session</span>${range}</div>`;
    return null;
  }

  private historyRangeLabel() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const from = this.messageStart + 1;
    const to = this.messageStart + this.messages.length;
    return html`<small>Showing messages ${from}–${to} of ${this.messageTotal}</small>`;
  }

  private renderMessage(message: ChatLine, index: number) {
    return html`
      <article class="msg ${message.role}" data-index=${index} data-anchor-key=${this.messageAnchorKey(index)}>
        ${this.renderMessageHeader(message, String(index))}
        ${message.parts.map((part) => this.renderPart(part, message))}
      </article>
    `;
  }

  private renderMessageGroup(messages: ChatLine[], startIndex: number) {
    const key = this.groupKey(startIndex);
    return html`
      <details class="msg event-group" data-index=${startIndex} data-anchor-key=${this.groupAnchorKey(startIndex)} ?open=${this.openGroupKeys.has(key)} @toggle=${(event: Event) => { this.onGroupToggle(key, event); }}>
        <summary>
          <b class="label">events</b>
          <span>${summarizeChatGroup(messages)}</span>
        </summary>
        <div class="group-body">
          ${messages.map((message, offset) => html`
            <section class="group-msg ${message.role}">
              ${this.renderMessageHeader(message, `${String(startIndex)}:${String(offset)}`)}
              ${message.parts.map((part) => this.renderPart(part, message))}
            </section>
          `)}
        </div>
      </details>
    `;
  }

  private renderMessageHeader(message: ChatLine, key: string) {
    const meta = this.messageMetaLabel(message);
    const expanded = this.expandedMetaKey === key;
    return html`
      <div class="msg-header">
        <b class="label">${message.role}</b>
        <div class="msg-header-trailing">
          ${this.renderMessageActions(message, key)}
          <span class=${expanded ? "msg-meta expanded" : "msg-meta"} role="button" tabindex="0" title=${meta.full} aria-label=${meta.full} aria-expanded=${String(expanded)} @click=${() => { this.expandedMetaKey = expanded ? undefined : key; }} @keydown=${(event: KeyboardEvent) => { this.onMetaKeydown(event, key, expanded); }}>${meta.short}</span>
        </div>
      </div>
    `;
  }

  private renderMessageActions(message: ChatLine, key: string) {
    if (!this.isCopyableMessage(message)) return null;
    const copied = this.copiedMessageKey === key;
    return html`
      <div class="msg-actions" aria-label="Message actions">
        <button type="button" class="msg-action" title=${copied ? "Copied" : "Copy message"} aria-label=${`${copied ? "Copied" : "Copy"} ${message.role} message`} @click=${(event: MouseEvent) => { void this.copyMessage(message, key, event); }}>
          <span aria-hidden="true">${copied ? "✓" : "⧉"}</span>
        </button>
      </div>
    `;
  }

  private onMetaKeydown(event: KeyboardEvent, key: string, expanded: boolean) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.expandedMetaKey = expanded ? undefined : key;
  }

  private isCopyableMessage(message: ChatLine): boolean {
    return (message.role === "user" || message.role === "assistant") && this.messageCopyText(message) !== "";
  }

  private messageCopyText(message: ChatLine): string {
    return message.parts
      .filter((part): part is Extract<ChatPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text.trim())
      .filter((text) => text !== "")
      .join("\n\n");
  }

  private async copyMessage(message: ChatLine, key: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const ok = await this.writeClipboard(this.messageCopyText(message));
    if (!ok) return;
    this.copiedMessageKey = key;
    window.setTimeout(() => {
      if (this.copiedMessageKey === key) this.copiedMessageKey = undefined;
    }, 1200);
  }

  private async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private messageMetaLabel(message: ChatLine): { short: string; full: string } {
    const timestamp = message.meta?.timestamp;
    const model = this.modelLabel(message);
    if (timestamp === undefined && model === undefined) return { short: "no info", full: "No Pi message metadata available" };
    const time = timestamp === undefined ? undefined : this.formatTimestamp(timestamp);
    const parts = [time?.short, model].filter((part): part is string => part !== undefined && part !== "");
    const fullParts = [time?.full, model === undefined ? undefined : `Model: ${model}`].filter((part): part is string => part !== undefined && part !== "");
    return { short: parts.join(" · "), full: fullParts.join(" · ") };
  }

  private formatTimestamp(timestamp: string): { short: string; full: string } | undefined {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return undefined;
    return {
      short: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date),
      full: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date),
    };
  }

  private modelLabel(message: ChatLine): string | undefined {
    const model = message.meta?.model;
    if (model === undefined) return undefined;
    const id = model.responseId ?? model.id;
    if (id === undefined || id === "") return model.provider;
    return model.provider !== undefined && model.provider !== "" ? `${model.provider}/${id}` : id;
  }

  private renderPart(part: ChatPart, message?: ChatLine) {
    if (part.type === "text" && message?.role === "bash") return html`<pre class="part shell-output">${part.text}</pre>`;
    if (part.type === "text") return html`<formatted-text class="part" .text=${part.text}></formatted-text>`;
    if (part.type === "thinking") return html`<details class="part"><summary>thinking</summary><formatted-text .text=${part.text}></formatted-text></details>`;
    if (part.type === "skillInvocation") return html`
      <details class="part skill-invocation">
        <summary><b>[skill]</b> ${part.name}</summary>
        <small>${part.location}</small>
        <formatted-text .text=${part.content}></formatted-text>
      </details>
    `;
    if (part.type === "toolCall") return html`<div class="part tool-line">▶ ${part.toolName}<span class="summary">${part.summary}</span></div>`;
    if (part.type === "toolResult") return html`
      <details class="part" ?open=${part.isError}>
        <summary>${part.isError ? "✖" : "✓"} ${part.toolName} result</summary>
        <formatted-text .text=${part.text}></formatted-text>
      </details>
    `;
    return null;
  }

  private onGroupToggle(key: string, event: Event) {
    const details = event.currentTarget;
    if (!(details instanceof HTMLDetailsElement)) return;
    const openGroupKeys = new Set(this.openGroupKeys);
    if (details.open) openGroupKeys.add(key);
    else openGroupKeys.delete(key);
    this.openGroupKeys = openGroupKeys;
    this.saveOpenGroupKeys();
  }

  private onScroll() {
    this.updateLoadedScrollPercent();
    this.requestLoadMoreIfNeeded();
    this.updatePinnedToBottomFromScroll();
    if (!this.suppressScrollSave) this.scheduleScrollPositionSave();
  }

  private onWheel(event: WheelEvent) {
    if (event.deltaY < 0 && this.canScrollUp()) this.pinnedToBottom = false;
  }

  private onTouchStart(event: TouchEvent) {
    this.touchStartY = event.touches[0]?.clientY;
  }

  private onTouchMove(event: TouchEvent) {
    const y = event.touches[0]?.clientY;
    if (this.touchStartY !== undefined && y !== undefined && y > this.touchStartY && this.canScrollUp()) this.pinnedToBottom = false;
  }

  private updatePinnedToBottomFromScroll() {
    const chat = this.chat;
    if (!chat) return;
    const heightChanged = this.didChatHeightChange();
    const wasPinnedToBottom = this.pinnedToBottom;
    const scrollingUp = chat.scrollTop < this.lastScrollTop;
    if (heightChanged && wasPinnedToBottom) {
      this.lastClientHeight = chat.clientHeight;
      this.scrollToBottom();
      return;
    }
    if (this.isAtBottom()) this.pinnedToBottom = true;
    else if (scrollingUp) this.pinnedToBottom = false;
    else this.pinnedToBottom = this.isNearBottom();
    this.lastScrollTop = chat.scrollTop;
    this.lastClientHeight = chat.clientHeight;
  }

  private didChatHeightChange(): boolean {
    const chat = this.chat;
    return chat !== undefined && this.lastClientHeight !== 0 && chat.clientHeight !== this.lastClientHeight;
  }

  private updateLoadedScrollPercent(): void {
    const chat = this.chat;
    if (!chat) return;
    const maxScroll = chat.scrollHeight - chat.clientHeight;
    const percent = maxScroll <= 0 ? 100 : Math.round((chat.scrollTop / maxScroll) * 100);
    this.loadedScrollPercent = Math.max(0, Math.min(100, percent));
  }

  private requestLoadMoreIfNeeded(): void {
    requestAnimationFrame(() => {
      const chat = this.chat;
      if (!chat) return;
      if (shouldRequestEarlierMessages({
        hasMore: this.hasMore,
        loadingMore: this.loadingMore || this.loadMoreRequested,
        canRequest: this.onLoadMore !== undefined,
        scrollTop: chat.scrollTop,
        scrollHeight: chat.scrollHeight,
        clientHeight: chat.clientHeight,
      })) this.requestLoadMore();
    });
  }

  private requestLoadMore(force = false): void {
    if (!force && this.loadMoreRequested) return;
    if (!this.hasMore || this.loadingMore || this.onLoadMore === undefined) return;
    this.loadMoreRequested = true;
    this.onLoadMore();
  }

  private isNearBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return this.distanceFromBottom(chat) < 48;
  }

  private isAtBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return this.distanceFromBottom(chat) < 2;
  }

  private canScrollUp(): boolean {
    const chat = this.chat;
    return chat !== undefined && chat.scrollTop > 0;
  }

  private distanceFromBottom(chat: HTMLDivElement): number {
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      const chat = this.chat;
      if (!chat) return;
      this.withSuppressedScrollSave(() => {
        chat.scrollTop = chat.scrollHeight;
        this.lastScrollTop = chat.scrollTop;
        this.lastClientHeight = chat.clientHeight;
      });
    });
  }

  restoreScrollPosition() {
    requestAnimationFrame(() => {
      const chat = this.chat;
      const stored = this.readStoredScrollPosition();
      if (!chat || !stored) {
        this.withSuppressedScrollSave(() => {
          if (chat) {
            chat.scrollTop = chat.scrollHeight;
            this.lastScrollTop = chat.scrollTop;
          }
        });
        return;
      }

      const article = this.articleAt(stored);
      if (!article) {
        this.withSuppressedScrollSave(() => {
          chat.scrollTop = chat.scrollHeight;
          this.lastScrollTop = chat.scrollTop;
        });
        return;
      }
      this.withSuppressedScrollSave(() => {
        const chatTop = chat.getBoundingClientRect().top;
        const currentOffset = article.getBoundingClientRect().top - chatTop;
        chat.scrollTop += currentOffset - stored.offset;
        this.lastScrollTop = chat.scrollTop;
      });
    });
  }

  capturePrependScrollAnchor(): PrependScrollAnchor | undefined {
    const chat = this.chat;
    if (!chat) return undefined;
    return { scrollTop: chat.scrollTop, scrollHeight: chat.scrollHeight };
  }

  restorePrependScrollAnchor(anchor: PrependScrollAnchor | undefined): void {
    const chat = this.chat;
    if (!chat || !anchor) return;
    this.withSuppressedScrollSave(() => {
      chat.scrollTop = anchor.scrollTop + (chat.scrollHeight - anchor.scrollHeight);
      this.lastScrollTop = chat.scrollTop;
    });
    this.updateLoadedScrollPercent();
    this.requestLoadMoreIfNeeded();
  }

  saveScrollPosition(sessionId = this.sessionId) {
    const chat = this.chat;
    if (!chat || !sessionId) return;
    try {
      if (this.isNearBottom()) {
        localStorage.removeItem(this.storageKey(sessionId));
        return;
      }
      const firstVisible = this.firstVisibleArticle();
      if (!firstVisible) {
        localStorage.removeItem(this.storageKey(sessionId));
        return;
      }
      const chatTop = chat.getBoundingClientRect().top;
      const position = {
        key: firstVisible.dataset["anchorKey"],
        index: Number(firstVisible.dataset["index"] ?? 0),
        offset: firstVisible.getBoundingClientRect().top - chatTop,
      };
      localStorage.setItem(this.storageKey(sessionId), JSON.stringify(position));
    } catch {
      // Ignore storage failures; scrolling should keep working without persistence.
    }
  }

  private scheduleScrollPositionSave() {
    window.clearTimeout(this.saveScrollTimer);
    this.saveScrollTimer = window.setTimeout(() => { this.saveScrollPosition(); }, 180);
  }

  private readStoredScrollPosition(): { index?: number; key?: string; offset: number } | undefined {
    if (this.sessionId === "") return undefined;
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (raw === null || raw === "") return undefined;
      const value: unknown = JSON.parse(raw);
      if (!isScrollPosition(value)) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private firstVisibleArticle(): HTMLElement | undefined {
    const chat = this.chat;
    if (!chat) return undefined;
    const chatRect = chat.getBoundingClientRect();
    return this.articles().find((article) => {
      const rect = article.getBoundingClientRect();
      return rect.bottom >= chatRect.top && rect.top <= chatRect.bottom;
    });
  }

  private articleAt(position: { index?: number; key?: string }): HTMLElement | undefined {
    const articles = this.articles();
    const keyed = position.key === undefined ? undefined : articles.find((article) => article.dataset["anchorKey"] === position.key);
    if (keyed !== undefined) return keyed;
    return articles.find((article) => Number(article.dataset["index"]) === position.index);
  }

  private articles(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("article.msg, details.msg"));
  }

  private withSuppressedScrollSave(callback: () => void) {
    this.suppressScrollSave = true;
    callback();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.suppressScrollSave = false;
      });
    });
  }

  private storageKey(sessionId = this.sessionId): string {
    return `pi-web:chat-scroll:${sessionId}`;
  }

  private groupStorageKey(sessionId = this.sessionId): string {
    return `pi-web:chat-groups:${sessionId}`;
  }

  private groupKey(startIndex: number): string {
    return `${this.sessionId}:${String(startIndex)}`;
  }

  private messageAnchorKey(index: number): string {
    return `m:${String(index)}`;
  }

  private groupAnchorKey(startIndex: number): string {
    return `g:${String(startIndex)}`;
  }

  private readOpenGroupKeys(): Set<string> {
    if (this.sessionId === "") return new Set();
    try {
      const raw = localStorage.getItem(this.groupStorageKey());
      const value: unknown = raw !== null && raw !== "" ? JSON.parse(raw) : [];
      return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
    } catch {
      return new Set();
    }
  }

  private saveOpenGroupKeys(): void {
    if (this.sessionId === "") return;
    try {
      localStorage.setItem(this.groupStorageKey(), JSON.stringify([...this.openGroupKeys]));
    } catch {
      // Ignore storage failures; group expansion should still work for this render.
    }
  }

  static override styles = chatStyles;
}
