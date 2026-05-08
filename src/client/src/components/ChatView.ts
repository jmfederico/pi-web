import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { groupChatMessages, summarizeChatGroup } from "../chatGroups";
import type { SessionActivity, SessionStatus } from "../api";
import type { ChatLine, ChatPart } from "./shared";
import { chatStyles } from "./shared";
import "./FormattedText";

interface PrependScrollAnchor {
  scrollTop: number;
  scrollHeight: number;
}

function isScrollPosition(value: unknown): value is { index: number; offset: number } {
  return typeof value === "object"
    && value !== null
    && "index" in value
    && "offset" in value
    && typeof value.index === "number"
    && typeof value.offset === "number";
}

@customElement("chat-view")
export class ChatView extends LitElement {
  @property({ attribute: false }) messages: ChatLine[] = [];
  @property() sessionId = "";
  @property({ type: Number }) messageStart = 0;
  @property({ type: Number }) messageTotal = 0;
  @property({ type: Boolean }) hasMore = false;
  @property({ type: Boolean }) loadingMore = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Number }) pendingMessageCount = 0;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) activity?: SessionActivity;
  @property({ attribute: false }) onLoadMore?: () => void;
  @query(".chat") private chat?: HTMLDivElement;
  @state() private pinnedToBottom = true;
  @state() private openGroupKeys = new Set<string>();
  @state() private loadedScrollPercent = 100;
  private suppressScrollSave = false;
  private saveScrollTimer?: number;

  override disconnectedCallback(): void {
    window.clearTimeout(this.saveScrollTimer);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("sessionId")) this.openGroupKeys = this.readOpenGroupKeys();
    this.pinnedToBottom = this.isNearBottom();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("sessionId")) return;
    if (changed.has("messages") && this.pinnedToBottom) this.scrollToBottom();
    this.updateLoadedScrollPercent();
  }

  override render() {
    return html`
      <div class="chat-wrap">
        ${this.renderHistoryIndicator()}
        <div class="chat" @scroll=${() => { this.onScroll(); }}>
          ${this.renderHistoryBoundary()}
          ${groupChatMessages(this.messages, this.messageStart).map((group) => group.kind === "message"
            ? this.renderMessage(group.message, group.index)
            : this.renderMessageGroup(group.messages, group.startIndex))}
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

  private renderSessionActivity() {
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
    if (this.hasMore) return html`<div class="history-boundary"><span>Scroll up to load earlier messages</span>${range}</div>`;
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
      <article class="msg ${message.role}" data-index=${index}>
        <b class="label">${message.role}</b>
        ${message.parts.map((part) => this.renderPart(part, message))}
      </article>
    `;
  }

  private renderMessageGroup(messages: ChatLine[], startIndex: number) {
    const key = this.groupKey(startIndex);
    return html`
      <details class="msg event-group" data-index=${startIndex} ?open=${this.openGroupKeys.has(key)} @toggle=${(event: Event) => { this.onGroupToggle(key, event); }}>
        <summary>
          <b class="label">events</b>
          <span>${summarizeChatGroup(messages)}</span>
        </summary>
        <div class="group-body">
          ${messages.map((message) => html`
            <section class="group-msg ${message.role}">
              <b class="label">${message.role}</b>
              ${message.parts.map((part) => this.renderPart(part, message))}
            </section>
          `)}
        </div>
      </details>
    `;
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
    if (this.chat && this.chat.scrollTop < 64 && this.hasMore && !this.loadingMore) this.onLoadMore?.();
    this.pinnedToBottom = this.isNearBottom();
    if (!this.suppressScrollSave) this.scheduleScrollPositionSave();
  }

  private updateLoadedScrollPercent(): void {
    const chat = this.chat;
    if (!chat) return;
    const maxScroll = chat.scrollHeight - chat.clientHeight;
    const percent = maxScroll <= 0 ? 100 : Math.round((chat.scrollTop / maxScroll) * 100);
    this.loadedScrollPercent = Math.max(0, Math.min(100, percent));
  }

  private isNearBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      const chat = this.chat;
      if (!chat) return;
      this.withSuppressedScrollSave(() => {
        chat.scrollTop = chat.scrollHeight;
      });
    });
  }

  restoreScrollPosition() {
    requestAnimationFrame(() => {
      const chat = this.chat;
      const stored = this.readStoredScrollPosition();
      if (!chat || !stored) {
        this.withSuppressedScrollSave(() => {
          if (chat) chat.scrollTop = chat.scrollHeight;
        });
        return;
      }

      const article = this.articleAt(stored.index);
      if (!article) {
        this.withSuppressedScrollSave(() => {
          chat.scrollTop = chat.scrollHeight;
        });
        return;
      }
      this.withSuppressedScrollSave(() => {
        const chatTop = chat.getBoundingClientRect().top;
        const currentOffset = article.getBoundingClientRect().top - chatTop;
        chat.scrollTop += currentOffset - stored.offset;
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
    });
    this.updateLoadedScrollPercent();
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

  private readStoredScrollPosition(): { index: number; offset: number } | undefined {
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

  private articleAt(index: number): HTMLElement | undefined {
    return this.articles().find((article) => Number(article.dataset["index"]) === index);
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
