import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { keyed } from "lit/directives/keyed.js";
import { ChatMessageActionController } from "./ChatMessageActionController";
import * as transcript from "./chatTranscriptTemplates";
import type { TranscriptRenderContext } from "./chatTranscriptTemplates";
import { ChatDisclosureController } from "../chatDisclosure";
import { writeClipboardText } from "../clipboard";
import { chatSessionWarningRows, renderSessionWarnings } from "./chat/SessionWarnings";
export { chatSessionWarningRows } from "./chat/SessionWarnings";
import { type QueuedMessageAction, type QueuedMessageActionTarget } from "../queuedMessageActions";
import { chatQueuedMessageSections, renderQueuedMessageSection, type QueuedMessageSection } from "./chat/QueuedMessages";
export { chatQueuedMessageSections, chatQueuedSectionShowsClearAction, type QueuedMessageSection } from "./chat/QueuedMessages";
import type { DisplayedMessageActionAvailabilityContext, MessageActionAvailabilityContext, MessageActionResult } from "../../../plugin-api";
import type { RegisteredMessageAction } from "../plugins/messageActions";
import { machineSessionKey } from "../machineKeys";
import { canonicalEntryActionHeaders, groupChatMessages, groupConsecutiveImageOutputs, type ChatDisplayGroup, type ChatGroup } from "../chatGroups";
import { openTranscriptQuestion, transcriptQuestionOutcomes } from "../chatQuestions";
import { ChatScrollFlows } from "../ChatScrollFlows";
import { ChatRenderKeys } from "../chatRenderKeys";
import { DEFAULT_CHAT_BEHAVIORS, type ChatBehaviors } from "../chatBehaviors";
import type { AskUserSubmission, PendingExtensionDialog, QueuedSessionMessage, SessionActivity, SessionRef, SessionStatus } from "../api";
import type { ClosedExtensionDialog } from "../appState";
import type { SelectedSessionNotificationView } from "../sessionNotifications";
import "./SessionNotificationTray";
import type { ChatLine, ChatPart } from "../chatTypes";
import { chatStyles } from "./chat/chatStyles";
import "./AskUserCard";
import "./ExtensionDialogCard";
import type { ExtensionDialogAnswerCallback, ExtensionDialogCancelCallback, ExtensionDialogDismissCallback } from "./ExtensionDialogCard";
import "./ImageGalleryDialog";
import type { ImageGalleryDialog } from "./ImageGalleryDialog";
import "./FormattedText";
import type { MarkdownWorkspaceContext } from "../formatting/workspaceLinks";
import "./ToolExecutionView";
import { transcriptImageSource } from "./TranscriptImage";
import type { ImageOpenDetail } from "./ImagePresentation";

const messageTimestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export type ChatImagePart = Extract<ChatPart, { type: "image" }>;

/** Derive the `<img>` source URL and alt text for a rendered image part. */
export function chatImagePartSource(part: ChatImagePart, session?: SessionRef, machineId = "local"): { src: string; alt: string } | undefined {
  return transcriptImageSource(part, session, machineId);
}

export { chatToolOutputLabel, chatMessageGroupClassName, chatMessageGroupLabel } from "./chat/transcriptLabels";

function chatLineIdentity(index: number, message?: ChatLine): string {
  return chatLineScrollIdentity(message) ?? String(index);
}

function chatLineScrollIdentity(message?: ChatLine): string | undefined {
  if (message?.entryId === undefined || message.entryId === "") return undefined;
  // Page offsets count raw entries, whereas display indexes count normalized
  // lines. Only durable entry identity survives coalescing during a prepend.
  // Skill invocations can also produce a user-text line from the same entry.
  const slice = message.parts.some((part) => part.type === "skillInvocation") ? "skill-invocation" : "message";
  return JSON.stringify([message.entryId, message.role, slice]);
}

/** Scroll identities never fall back to normalized display indexes. */
export function chatMessageAnchorKey(_index: number, message?: ChatLine): string | undefined {
  const identity = chatLineScrollIdentity(message);
  return identity === undefined ? undefined : `m:${identity}`;
}

export function chatGroupAnchorKey(_startIndex: number, message?: ChatLine): string | undefined {
  const identity = chatLineScrollIdentity(message);
  return identity === undefined ? undefined : `g:${identity}`;
}

/** Event identity is separate from the readable slice of the same entry. */
export function chatEventAnchorKey(_index: number, message?: ChatLine): string | undefined {
  const identity = chatLineScrollIdentity(message);
  return identity === undefined ? undefined : `e:${identity}`;
}

export function chatMessageMetadataLabel(message: ChatLine): string {
  const timestamp = message.meta?.timestamp;
  const time = timestamp === undefined ? undefined : formatMessageTimestamp(timestamp);
  const model = chatMessageModelLabel(message);
  const parts = [time, model, message.meta?.thinkingLevel].filter((part): part is string => part !== undefined && part !== "");
  return parts.length === 0 ? "No Pi message metadata available" : parts.join(" · ");
}

function formatMessageTimestamp(timestamp: string): string | undefined {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  return messageTimestampFormatter.format(date);
}

function chatMessageModelLabel(message: ChatLine): string | undefined {
  const model = message.meta?.model;
  if (model === undefined) return undefined;
  const id = model.responseId ?? model.id;
  if (id === undefined || id === "") return model.provider;
  return model.provider !== undefined && model.provider !== "" ? `${model.provider}/${id}` : id;
}

@customElement("chat-view")
export class ChatView extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) messages: ChatLine[] = [];
  @property() sessionId = "";
  @property({ attribute: false }) onNavigationChange?: (controls: TemplateResult) => void;
  @property() sessionCwd = "";
  @property({ attribute: false }) workspaceContext: MarkdownWorkspaceContext | undefined;
  @property({ attribute: false }) contentRendering: import("../formatting/contentRendering").ChatContentRendering | undefined;
  @property() machineId = "local";
  @property({ attribute: false }) messageActions: readonly RegisteredMessageAction[] = [];
  @property({ attribute: false }) messageActionContext?: Omit<MessageActionAvailabilityContext, "message">;
  @property({ attribute: false }) onMessageAction?: (input: MessageActionAvailabilityContext, actionId: string) => Promise<MessageActionResult>;
  @property({ attribute: false }) onDisplayedMessageAction?: (input: DisplayedMessageActionAvailabilityContext, actionId: string) => Promise<MessageActionResult>;
  private readonly messageActionController = new ChatMessageActionController(() => ({
    machineId: this.machineId,
    sessionId: this.sessionId,
    connected: this.isConnected,
    actions: this.messageActions,
    availability: this.messageActionContext,
    onEntry: this.onMessageAction,
    onDisplay: this.onDisplayedMessageAction,
  }), () => { this.requestUpdate(); });
  @property({ type: Number }) messageStart = 0;
  @property({ type: Number }) messageEnd = 0;
  @property({ type: Number }) messageTotal = 0;
  @property({ type: Boolean }) hasMore = false;
  @property({ type: Boolean }) historyReady = true;
  @property({ type: Boolean }) loadingMore = false;
  @property({ type: Boolean }) isSendingPrompt = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Number }) pendingMessageCount = 0;
  @property({ attribute: false }) clientQueuedMessages: QueuedSessionMessage[] = [];
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) activity?: SessionActivity;
  @property({ attribute: false }) askDraftSessionId = "";
  @property({ attribute: false }) onSubmitAsk: ((askId: string, submission: AskUserSubmission) => void | Promise<void>) | undefined;
  @property({ attribute: false }) pendingDialogs: PendingExtensionDialog[] = [];
  @property({ attribute: false }) closedDialogs: ClosedExtensionDialog[] = [];
  @property({ attribute: false }) onAnswerDialog?: ExtensionDialogAnswerCallback;
  @property({ attribute: false }) onCancelDialog?: ExtensionDialogCancelCallback;
  @property({ attribute: false }) onDismissClosedDialog?: ExtensionDialogDismissCallback;
  @property({ attribute: false }) notificationInbox?: SelectedSessionNotificationView;
  @property({ attribute: false }) onClearServerQueue?: () => void;
  @property({ attribute: false }) onQueuedMessageAction?: (target: QueuedMessageActionTarget) => Promise<void>;
  @property({ type: Boolean }) queuedMessageActionPending = false;
  @state() private queuedCopyFeedback = "";
  @property({ attribute: false }) onDismissWarning?: (dismissId: string) => void;
  @property({ attribute: false }) onDismissNotification?: (notificationId: string) => void;
  @property({ attribute: false }) onDismissAllNotifications?: () => void;
  @property({ type: Boolean }) warningsVisible = true;
  @property({ attribute: false }) onToggleWarnings?: () => void;
  @property({ attribute: false }) onLoadMore?: () => void;
  @property({ attribute: false }) behaviors: ChatBehaviors = DEFAULT_CHAT_BEHAVIORS;
  @query(".chat") private chat?: HTMLDivElement;
  @query("pi-web-image-gallery-dialog") private imageGalleryDialog?: ImageGalleryDialog;
  @state() private followingLive = false;
  @state() private expandedMetaKey: string | undefined;
  private readonly disclosures = new ChatDisclosureController();
  private readonly transientDisclosures = new Map<string, boolean>();
  private readonly scrollFlows = new ChatScrollFlows({
    getScroller: () => this.chat ?? undefined,
    onFollowingChange: (following) => { this.followingLive = following; },
    getAnchors: () => this.scrollAnchorElements(),
    getSessionId: () => this.sessionId,
    getBehaviors: () => this.behaviors,
    hasMore: () => this.hasMore,
    isHistoryReady: () => this.historyReady,
    isLoadingMore: () => this.loadingMore || this.loadMoreRequested,
    canRequestEarlier: () => this.onLoadMore !== undefined,
    requestEarlier: () => { this.requestLoadMore(); },
    getOpenForm: (kind) => this.renderRoot.querySelector<HTMLElement>(kind === "dialog"
      ? ".chat > extension-dialog-card.open-dialog-card"
      : kind === "ask" ? ".chat ask-user-card.open-question-card"
      : ".chat ask-user-card.open-question-card, .chat > extension-dialog-card.open-dialog-card") ?? undefined,
  });
  private lastOpenQuestionId: string | undefined;
  private questionOutcomes = transcriptQuestionOutcomes([]);
  private questionIds: ReadonlySet<string> = new Set();
  private groupedMessagesInput?: ChatLine[];
  private groupedMessagesStart = 0;
  private groupedMessagesCache: ChatGroup[] = [];
  private readonly messageMetaCache = new WeakMap<ChatLine, string>();
  private imageSession: SessionRef | undefined;
  private touchY: number | undefined;
  private loadMoreRequested = false;
  private readonly onViewportResize = () => { this.scrollFlows.onViewportResize(); };
  // Formatting completes independently of message updates. Reuse the existing
  // layout/restore flow without making content loading wait for enhancement.
  private readonly onContentLayoutChanged = () => { this.scrollFlows.onViewportResize(); };
  private readonly handleScroll = () => { this.scrollFlows.onScroll(); };
  // Native details toggles do not bubble; capture layout changes independently
  // of the listener that remembers a group's disclosure choice.
  private readonly handleDisclosureToggle = {
    capture: true,
    handleEvent: (event: Event): void => {
      if (event.target instanceof HTMLDetailsElement) this.scrollFlows.onContentLayoutChanged();
    },
  };
  private readonly handleWheel = (event: WheelEvent) => {
    if (event.deltaY !== 0) this.scrollFlows.onInteraction();
    if (event.deltaY < 0) this.scrollFlows.onUpIntent();
  };
  private readonly handleTouchStart = (event: TouchEvent) => {
    this.touchY = event.touches[0]?.clientY;
    this.scrollFlows.onInteraction();
  };
  private readonly handleTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (this.touchY !== undefined && y !== undefined && y > this.touchY) this.scrollFlows.onUpIntent();
    this.touchY = y;
  };
  private readonly handleTouchEnd = () => { this.touchY = undefined; };
  private readonly handleJumpTop = () => { this.scrollFlows.jumpToTop(); };
  private readonly handleJumpEnd = () => { this.scrollFlows.jumpToEnd(); };
  private readonly openImageZoom = (src: string, alt: string): void => {
    if (this.behaviors.loadImages) this.imageGalleryDialog?.show([{ src, alt }]);
  };
  private openToolImageGallery(images: readonly { part: ChatImagePart; description: string }[], selectedIndex: number): void {
    if (!this.behaviors.loadImages) return;
    const entries = images.flatMap((image, index) => {
      const source = transcriptImageSource(image.part, this.transcriptSession(), this.machineId);
      return source === undefined ? [] : [{ src: source.src, alt: image.description, partIndex: index }];
    });
    const index = entries.findIndex((entry) => entry.partIndex === selectedIndex);
    if (index >= 0) this.imageGalleryDialog?.show(entries, index);
  }
  private readonly onPageHide = () => {
    this.saveScrollPosition();
  };
  private readonly handleClearServerQueue = (): void => {
    this.onClearServerQueue?.();
  };
  private readonly handleToggleWarnings = (): void => {
    this.onToggleWarnings?.();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
    window.addEventListener("pagehide", this.onPageHide);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
  }

  override disconnectedCallback(): void {
    this.scrollFlows.dispose();
    this.messageActionController.reset();
    window.removeEventListener("resize", this.onViewportResize);
    window.removeEventListener("pagehide", this.onPageHide);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    super.disconnectedCallback();
  }

  private prepareSessionUiState(): void {
    if (this.behaviors.rememberDisclosures) this.disclosures.syncSession(this.sessionId);
    this.loadMoreRequested = false;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("messages")) {
      this.questionOutcomes = transcriptQuestionOutcomes(this.messages);
      this.questionIds = new Set(this.messages.flatMap((line) => line.parts.flatMap((part) => part.type === "askUserQuestion" ? [part.ask.askId] : [])));
    }
    if (changed.has("sessionId") || changed.has("machineId") || (changed.has("behaviors") && !this.behaviors.loadImages)) this.imageGalleryDialog?.close();
    if (changed.has("sessionId") || changed.has("machineId")) {
      this.transientDisclosures.clear();
      this.lastOpenQuestionId = undefined;
      this.queuedCopyFeedback = "";
    }
    if (changed.has("sessionId") || changed.has("machineId")) {
      this.messageActionController.reset();
    }
    if (changed.has("sessionId")) {
      this.prepareSessionUiState();
    }
    if (changed.has("behaviors")) {
      this.scrollFlows.configure();
      if (this.behaviors.rememberDisclosures) this.disclosures.syncSession(this.sessionId);
    }
  }

  protected override update(changed: Map<string, unknown>): void {
    const previousStart = changed.get("messageStart");
    this.scrollFlows.beforeRender({
      sessionChanged: changed.has("sessionId") || changed.has("machineId"),
      previousSessionId: changed.get("sessionId"),
      prepend: typeof previousStart === "number" && this.messageStart < previousStart,
    });
    super.update(changed);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("loadingMore") && !this.loadingMore) this.loadMoreRequested = false;
    if (changed.has("hasMore") && !this.hasMore) this.loadMoreRequested = false;
    const openQuestionId = this.openQuestion()?.askId;
    this.scrollFlows.afterRender({
      sessionChanged: changed.has("sessionId") || changed.has("machineId"),
      contentChanged: this.scrollContentChanged(changed),
      historyChanged: changed.has("messages") || changed.has("messageStart") || changed.has("hasMore") || changed.has("loadingMore") || changed.has("historyReady"),
      openedForm: changed.has("pendingDialogs") && this.isNewOpenDialog(changed.get("pendingDialogs")) ? "dialog"
        : openQuestionId !== undefined && openQuestionId !== this.lastOpenQuestionId ? "ask" : false,
    });
    this.lastOpenQuestionId = openQuestionId;
    if (changed.has("followingLive") || changed.has("behaviors") || changed.has("onNavigationChange")) {
      this.onNavigationChange?.(this.renderNavigation());
    }
  }

  private readonly renderKeys = new ChatRenderKeys();

  override render() {
    const sourceGroups = this.groupedMessages();
    const entryActionHeaders = canonicalEntryActionHeaders(sourceGroups);
    const groups = groupConsecutiveImageOutputs(sourceGroups);
    // Keep incremental updates within one transcript, but dispose the whole
    // repeat part when the transcript changes. Besides preventing cross-session
    // DOM reuse, clearing the part reclaims the end markers that the current Lit
    // build retains when repeat items are removed.
    const transcriptIdentity = machineSessionKey(this.machineId, this.sessionId);
    const keys = this.renderKeys.reconcile(transcriptIdentity, groups.map((group) => {
      const source = group.kind === "tool-images" ? group.outputs[0] : group;
      const index = source.kind === "group" ? source.startIndex : source.index;
      const message = source.kind === "group" ? source.messages[0]?.message : source.message;
      const identity = chatLineScrollIdentity(message);
      return {
        slot: JSON.stringify([group.kind, index, message?.role]),
        ...(identity === undefined ? {} : { identity: JSON.stringify([group.kind, identity]) }),
      };
    }));
    return html`
      ${this.renderTopNotices()}
      <div class=${this.behaviors.visualEffects ? "chat-wrap" : "chat-wrap plain"}>
        <div class="chat" @image-open=${(event: CustomEvent<ImageOpenDetail>) => { this.openImageZoom(event.detail.src, event.detail.alt); }}
          @scroll=${this.behaviors.rememberPosition || this.behaviors.followTail || this.behaviors.automaticHistory ? this.handleScroll : undefined}
          @toggle=${this.behaviors.followTail ? this.handleDisclosureToggle : undefined}
          @content-layout-changed=${this.onContentLayoutChanged}
          @wheel=${this.handlesScrollIntent ? this.handleWheel : undefined}
          @touchstart=${this.handlesScrollIntent ? this.handleTouchStart : undefined}
          @touchmove=${this.handlesScrollIntent ? this.handleTouchMove : undefined}
          @touchend=${this.handlesScrollIntent ? this.handleTouchEnd : undefined}
          @touchcancel=${this.handlesScrollIntent ? this.handleTouchEnd : undefined}>
          ${this.renderHistoryBoundary()}
          ${keyed(transcriptIdentity, repeat(
            groups,
            (_group, index) => keys[index],
            (group, index) => {
              if (group.kind === "group") return this.renderMessageGroup(group, this.isLiveTailGroup(groups, index), entryActionHeaders);
              if (group.kind === "tool-images") return this.renderToolImageOutputs(group, entryActionHeaders);
              return this.renderMessage(group.message, group.index, entryActionHeaders);
            },
          ))}
          ${this.renderQueuedMessages()}
          ${this.renderSessionActivity()}
          ${this.renderExtensionDialogs()}
        </div>
        ${this.onNavigationChange === undefined ? this.renderNavigation() : nothing}
      </div>
      <pi-web-image-gallery-dialog></pi-web-image-gallery-dialog>
    `;
  }

  private renderNavigation() {
    const following = this.behaviors.followTail && this.followingLive;
    return html`<nav class="chat-jumps" aria-label="Chat navigation">
      <button type="button" title="Jump to top" aria-label="Jump to top" @click=${this.handleJumpTop}>↑</button>
      <button type="button" class=${following ? "following" : ""}
        title=${!this.behaviors.followTail ? "Jump to end" : following ? "Following live — jump to end" : "Jump to end and follow live"}
        aria-label="Jump to end" aria-describedby="chat-follow-state" @click=${this.handleJumpEnd}>↓</button>
      <span id="chat-follow-state" class="chat-follow-state">${!this.behaviors.followTail ? "Automatic following disabled" : following ? "Following live" : "Live following paused"}</span>
    </nav>`;
  }

  private renderTopNotices() {
    return html`<div class="top-notices">
      ${this.renderWarnings()}
      <session-notification-tray
        .sessionId=${this.sessionId}
        .notificationInbox=${this.notificationInbox}
        .onDismissNotification=${this.onDismissNotification}
        .onDismissAllNotifications=${this.onDismissAllNotifications}
      ></session-notification-tray>
    </div>`;
  }

  private renderWarnings() {
    const rows = chatSessionWarningRows(this.status);
    if (!this.warningsVisible || rows.length === 0) return null;
    return renderSessionWarnings(rows,
      this.onToggleWarnings === undefined ? undefined : this.handleToggleWarnings,
      this.onDismissWarning,
    );
  }

  private groupedMessages(): ChatGroup[] {
    if (this.groupedMessagesInput === this.messages && this.groupedMessagesStart === this.messageStart) return this.groupedMessagesCache;
    this.groupedMessagesInput = this.messages;
    this.groupedMessagesStart = this.messageStart;
    this.groupedMessagesCache = groupChatMessages(this.messages, this.messageStart);
    return this.groupedMessagesCache;
  }

  private isLiveTailGroup(groups: readonly ChatDisplayGroup[], index: number): boolean {
    return index === groups.length - 1 && this.isSessionLive();
  }

  private isSessionLive(): boolean {
    return this.isSendingPrompt
      || this.status?.isStreaming === true
      || this.status?.isCompacting === true
      || this.status?.isBashRunning === true
      || this.activity?.phase === "active";
  }

  private renderQueuedMessages() {
    const serverQueued = this.status?.queuedMessages ?? [];
    return html`${chatQueuedMessageSections(this.clientQueuedMessages, serverQueued).map((section) => this.renderQueuedMessageList(section))}
      ${this.queuedCopyFeedback === "" ? nothing : html`<small role="status">${this.queuedCopyFeedback}</small>`}`;
  }

  private renderQueuedMessageList(section: QueuedMessageSection) {
    return renderQueuedMessageSection(section, {
      machineId: this.machineId,
      sessionId: this.sessionId,
      behaviors: this.behaviors,
      contentRendering: this.contentRendering,
      workspaceContext: this.workspaceContext,
      pending: this.queuedMessageActionPending,
      unavailable: this.status?.queueMessageActionsUnavailable,
      onClear: this.onClearServerQueue === undefined ? undefined : this.handleClearServerQueue,
      onCopy: (text) => { void this.copyQueuedMessage(text); },
      onAction: this.onQueuedMessageAction === undefined ? undefined : (action, index, messages) => { this.actOnQueuedMessage(action, index, messages); },
    });
  }

  private async copyQueuedMessage(text: string): Promise<void> {
    const identity = machineSessionKey(this.machineId, this.sessionId);
    const copied = await writeClipboardText(text);
    if (this.isConnected && identity === machineSessionKey(this.machineId, this.sessionId)) {
      this.queuedCopyFeedback = copied ? "" : "Could not copy message";
    }
  }

  private actOnQueuedMessage(action: QueuedMessageAction, index: number, messages: QueuedSessionMessage[]): void {
    if (this.queuedMessageActionPending || this.status?.queueMessageActionsUnavailable !== undefined) return;
    void this.onQueuedMessageAction?.({ machineId: this.machineId, sessionId: this.sessionId, action, index, expectedQueue: messages.map((message) => ({ ...message })) });
  }

  private renderExtensionDialogs() {
    const open = this.pendingDialogs[0];
    if (open === undefined && this.closedDialogs.length === 0) return null;
    const queuedCount = this.pendingDialogs.length - 1;
    return html`
      ${repeat(
        this.closedDialogs,
        (closed) => closed.dialog.dialogId,
        (closed) => html`
          <extension-dialog-card
            class="closed-dialog-card"
            .outcome=${closed}
            .onDismiss=${this.onDismissClosedDialog}
          ></extension-dialog-card>
        `,
      )}
      ${open === undefined ? null : html`
        <extension-dialog-card
          class="open-dialog-card"
          .dialog=${open}
          .onAnswer=${this.onAnswerDialog}
          .onCancel=${this.onCancelDialog}
        ></extension-dialog-card>
        ${queuedCount > 0
          ? html`<p class="queued-dialogs" role="status">${String(queuedCount)} more extension ${queuedCount === 1 ? "dialog" : "dialogs"} queued</p>`
          : null}
      `}
    `;
  }

  private renderSessionActivity() {
    if (!this.isCompacting) return null;
    return html`
      <aside class="session-activity compacting ui-transcript-surface" aria-live="polite">
        <strong>Compacting history…</strong>
        <span>The agent is summarizing earlier context. New prompts will be queued until compaction finishes.</span>
        ${this.pendingMessageCount > 0 ? html`<small>${this.pendingMessageCount} queued ${this.pendingMessageCount === 1 ? "message" : "messages"}</small>` : null}
      </aside>
    `;
  }

  private renderHistoryBoundary() {
    const range = this.historyRangeLabel();
    if (this.loadingMore) return html`<div class="history-boundary"><span>Loading earlier messages…</span>${range}</div>`;
    if (this.hasMore) return html`
      <div class="history-boundary">
        <button type="button" class="history-load-button ui-button ui-button--compact" ?disabled=${this.loadMoreRequested} @click=${() => { this.requestLoadMore(); }}>Load earlier messages</button>
        ${this.behaviors.automaticHistory ? html`<span>Scroll up to load earlier messages</span>` : null}
        ${range}
      </div>
    `;
    if (this.messages.length) return html`<div class="history-boundary"><span>Beginning of session</span>${range}</div>`;
    return null;
  }

  private historyRangeLabel() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const from = this.messageStart + 1;
    const to = this.loadedRawMessageEnd();
    const total = Math.max(this.messageTotal, to);
    return html`<small>Showing messages ${from}–${to} of ${total}</small>`;
  }

  private loadedRawMessageEnd(): number {
    return Math.max(this.messageEnd, this.messageStart + this.messages.length);
  }

  private transcriptRenderContext(): TranscriptRenderContext {
    return {
      machineId: this.machineId,
      sessionId: this.sessionId,
      session: this.transcriptSession(),
      messages: this.messages,
      messageStart: this.messageStart,
      behaviors: this.behaviors,
      contentRendering: this.contentRendering,
      workspaceContext: this.workspaceContext,
      anchors: { message: chatMessageAnchorKey, event: chatEventAnchorKey },
      disclosure: {
        isOpen: (key, defaultOpen) => this.isDisclosureOpen(key, defaultOpen),
        toggle: (key, event, defaultOpen) => { this.onDisclosureToggle(key, event, defaultOpen); },
      },
      metadata: {
        expandedKey: this.expandedMetaKey,
        label: (message) => this.messageMetaLabel(message),
        expand: (key) => { this.expandedMetaKey = key; },
      },
      actions: this.messageActionController,
      openQuestionId: () => this.openQuestion()?.askId,
      questionOutcomes: this.questionOutcomes,
      questionIds: this.questionIds,
      askDraftSessionId: this.askDraftSessionId,
      onSubmitAsk: this.onSubmitAsk,
      openImageGallery: (images, index) => { this.openToolImageGallery(images, index); },
    };
  }

  private renderMessage(message: ChatLine, index: number, entryActionHeaders: ReadonlySet<ChatLine>) {
    return transcript.renderMessage(this.transcriptRenderContext(), message, index, entryActionHeaders);
  }

  private renderToolImageOutputs(group: Extract<ChatDisplayGroup, { kind: "tool-images" }>, entryActionHeaders: ReadonlySet<ChatLine>) {
    return transcript.renderToolImageOutputs(this.transcriptRenderContext(), group, entryActionHeaders);
  }

  private renderMessageGroup(group: Extract<ChatGroup, { kind: "group" }>, defaultOpen: boolean, entryActionHeaders: ReadonlySet<ChatLine> = new Set()) {
    const disclosureKey = this.groupDisclosureKey(group, defaultOpen);
    const open = this.isDisclosureOpen(disclosureKey, defaultOpen);
    return transcript.renderMessageGroup(this.transcriptRenderContext(), group, defaultOpen, entryActionHeaders, {
      open,
      anchor: this.groupAnchorKey(group, defaultOpen),
      toggle: (event) => { this.onDisclosureToggle(disclosureKey, event, defaultOpen); },
    });
  }

  private messageMetaLabel(message: ChatLine): string {
    const cached = this.messageMetaCache.get(message);
    if (cached !== undefined) return cached;
    const label = chatMessageMetadataLabel(message);
    this.messageMetaCache.set(message, label);
    return label;
  }

  private transcriptSession(): SessionRef {
    if (this.imageSession?.id !== this.sessionId || this.imageSession.cwd !== this.sessionCwd) {
      this.imageSession = { id: this.sessionId, cwd: this.sessionCwd };
    }
    return this.imageSession;
  }

  private isDisclosureOpen(key: string, defaultOpen: boolean): boolean {
    return this.behaviors.rememberDisclosures
      ? this.disclosures.isOpen(key, defaultOpen)
      : this.transientDisclosures.get(key) ?? defaultOpen;
  }

  private onDisclosureToggle(key: string, event: Event, defaultOpen: boolean) {
    const details = event.currentTarget;
    if (!(details instanceof HTMLDetailsElement)) return;
    const changed = this.isDisclosureOpen(key, defaultOpen) !== details.open;
    if (this.behaviors.rememberDisclosures) this.disclosures.applyToggle(key, details.open, defaultOpen);
    else this.transientDisclosures.set(key, details.open);
    if (changed) this.requestUpdate();
  }

  private get handlesScrollIntent(): boolean {
    return this.behaviors.followTail || this.behaviors.rememberPosition;
  }

  private scrollContentChanged(changed: Map<string, unknown>): boolean {
    return changed.has("messages") || changed.has("historyReady") || changed.has("messageEnd") || changed.has("messageTotal") || changed.has("onSubmitAsk") || changed.has("pendingDialogs") || changed.has("closedDialogs");
  }

  private requestLoadMore(): void {
    if (this.loadMoreRequested || !this.hasMore || this.loadingMore || this.onLoadMore === undefined) return;
    this.loadMoreRequested = true;
    this.onLoadMore();
  }

  private openQuestion() {
    return openTranscriptQuestion(this.messages, {
      historyReady: this.historyReady,
      messageEnd: this.messageEnd,
      messageTotal: this.messageTotal,
      writable: this.onSubmitAsk !== undefined,
    });
  }

  private isNewOpenDialog(previous: unknown): boolean {
    const oldest = this.pendingDialogs[0];
    if (oldest === undefined) return false;
    if (!Array.isArray(previous)) return true;
    const previousOldest: unknown = previous[0];
    return typeof previousOldest !== "object" || previousOldest === null || Reflect.get(previousOldest, "dialogId") !== oldest.dialogId;
  }

  /** Public navigation hooks; the position-memory flow owns their effects. */
  restoreScrollPosition(): void {
    this.scrollFlows.restorePosition();
  }

  saveScrollPosition(sessionId = this.sessionId): void {
    this.scrollFlows.savePosition(sessionId);
  }

  private scrollAnchorElements(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"));
  }

  private groupDisclosureKey(group: Extract<ChatGroup, { kind: "group" }>, defaultOpen: boolean): string {
    return defaultOpen
      ? `${this.sessionId}:live:${chatLineIdentity(group.startIndex, group.messages[0]?.message)}`
      : `${this.sessionId}:${chatLineIdentity(group.endIndex, group.messages.at(-1)?.message)}`;
  }


  private groupAnchorKey(group: Extract<ChatGroup, { kind: "group" }>, live: boolean): string | undefined {
    // Historical groups can absorb earlier events; live groups grow at the end.
    // Skip transient members rather than persisting their display indexes.
    const durableIdentities = group.messages
      .map(({ message }) => chatLineScrollIdentity(message))
      .filter((identity): identity is string => identity !== undefined);
    const identity = live ? durableIdentities[0] : durableIdentities.at(-1);
    if (identity === undefined) return undefined;
    return live ? `g:${identity}` : `g-end:${identity}`;
  }

  static override styles = chatStyles;
}
