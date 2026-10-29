import { LocalizationController, localization } from "../localization/browser";
import { chatTranscriptMessages } from "../chatTranscriptMessages";
import { chatChromeMessages as chrome } from "../chatChromeMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { keyed } from "lit/directives/keyed.js";
import { guard } from "lit/directives/guard.js";
import { ChatMessageActionController } from "./ChatMessageActionController";
import * as transcript from "./chatTranscriptTemplates";
import type { TranscriptRenderContext } from "./chatTranscriptTemplates";
import { ChatDisclosureController } from "../chatDisclosure";
import { ChatPresentationOwners } from "../chatPresentationOwners";
import { chatPartIdentity, chatLinePresentationIdentity } from "../chatPresentationIdentity";
import { TranscriptUiState } from "../transcriptUiState";
import { PendingFormState } from "../pendingFormState";
import { writeClipboardText } from "../clipboard";
import { type QueuedMessageAction, type QueuedMessageActionTarget } from "../queuedMessageActions";
import { chatQueuedMessageSections, renderQueuedMessageSection, type QueuedMessageSection } from "./chat/QueuedMessages";
export { chatQueuedMessageSections, chatQueuedSectionShowsClearAction, type QueuedMessageSection } from "./chat/QueuedMessages";
import type { DisplayedMessageActionAvailabilityContext, MessageActionAvailabilityContext, MessageActionResult } from "../../../plugin-api";
import type { RegisteredMessageAction } from "../plugins/messageActions";
import { machineSessionKey } from "../machineKeys";
import { canonicalEntryActionHeaders, type ChatDisplayGroup, type ChatGroup } from "../chatGroups";
import { ChatGroupProjection } from "../chatGroupProjection";
import { openTranscriptQuestion, transcriptQuestionOutcomes } from "../chatQuestions";
import { ChatScrollFlows } from "../ChatScrollFlows";
import { chatScrollScopeKey } from "../chatScrollPosition";
import { TranscriptMountWindow, type TranscriptMountRow } from "../transcriptMountWindow";
import { TranscriptMountLists } from "../transcriptMountLists";
import { transcriptRenderComplete } from "../transcriptRenderComplete";
import { hasRenderedModal } from "./modalLayerRegistry";
import { THUMBNAIL_HEIGHT } from "../thumbnailGeometry";
import { ChatRenderKeys, type ChatRenderItem } from "../chatRenderKeys";
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

type MountedTranscriptRow = { kind: "row"; key: string; index: number; group: ChatDisplayGroup }
  | { kind: "spacer"; key: string; height: number };

export type ChatImagePart = Extract<ChatPart, { type: "image" }>;

/** Derive the `<img>` source URL and alt text for a rendered image part. */
export function chatImagePartSource(part: ChatImagePart, session?: SessionRef, machineId = "local"): { src: string; alt: string } | undefined {
  return transcriptImageSource(part, session, machineId);
}

export { chatToolOutputLabel } from "./chat/transcriptLabels";

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
  return parts.length === 0 ? chatTranscriptMessages.t("noMetadata") : localization.list(parts);
}

function formatMessageTimestamp(timestamp: string): string | undefined {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  return localization.date(date, { dateStyle: "medium", timeStyle: "medium" });
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
    new LocalizationController(this, localization, () => {
      this.messageMetaCache = new WeakMap();
      this.messageActionController.localizationChanged();
      this.navigationLocalizationChanged = true;
      this.transcriptPresentationRevision++;
    });
  }

  @property({ attribute: false }) messages: ChatLine[] = [];
  @property({ attribute: false }) presentationOwners = new ChatPresentationOwners();
  @property({ attribute: false }) uiState = new TranscriptUiState();
  @property({ attribute: false }) formState = new PendingFormState();
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
  }), () => { this.transcriptPresentationRevision++; this.requestUpdate(); });
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
  @state() private queuedCopyFailed = false;
  @property({ attribute: false }) onDismissNotification?: (notificationId: string) => void;
  @property({ attribute: false }) onDismissAllNotifications?: () => void;
  @property({ attribute: false }) onLoadMore?: () => void;
  @property({ attribute: false }) behaviors: ChatBehaviors = DEFAULT_CHAT_BEHAVIORS;
  /**
   * Start every event group collapsed, including the growing live group. The
   * groups stay in the transcript and remain expandable; only their default
   * disclosure changes.
   */
  @property({ type: Boolean }) quietMode = false;
  @query(".chat") private chat?: HTMLDivElement;
  @query("pi-web-image-gallery-dialog") private imageGalleryDialog?: ImageGalleryDialog;
  @state() private followingLive = false;
  @state() private expandedMetaKey: string | undefined;
  private readonly disclosures = new ChatDisclosureController();
  private readonly transientDisclosures = new Map<string, boolean>();
  private readonly pendingDisclosureAliases = new Map<string, string>();
  @state() private mountRevision = 0;
  private mountLayoutRevision = 0;
  private mountPresentationInputs: readonly unknown[] = [];
  private readonly childMounts: TranscriptMountLists = new TranscriptMountLists({
    getRoot: () => this.renderRoot,
    getScroller: () => this.chat ?? undefined,
    getRequestedAnchor: () => this.scrollFlows.requiredAnchor,
    protectMountedRows: () => hasRenderedModal(this.ownerDocument),
    beforeChange: () => { this.scrollFlows.beforeMountChange(); },
    requestRender: () => { this.mountRevision++; },
    geometryChanged: () => { this.scrollFlows.onViewportResize(); },
  });
  private readonly mountWindow: TranscriptMountWindow = new TranscriptMountWindow({
    getScroller: () => this.chat ?? undefined,
    getOrigin: () => this.renderRoot.querySelector<HTMLElement>("[data-transcript-origin]") ?? undefined,
    getRows: () => Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".chat > [data-transcript-row]")),
    getRequestedAnchor: () => this.scrollFlows.requiredAnchor,
    protectMountedRows: () => hasRenderedModal(this.ownerDocument),
    beforeChange: () => { this.scrollFlows.beforeMountChange(); },
    requestRender: () => { this.mountRevision++; },
    geometryChanged: () => { this.scrollFlows.onViewportResize(); },
  });
  private readonly scrollFlows: ChatScrollFlows = new ChatScrollFlows({
    getScroller: () => this.chat ?? undefined,
    onFollowingChange: (following) => { this.followingLive = following; },
    getAnchors: () => this.scrollAnchorElements(),
    getScopeKey: () => chatScrollScopeKey(this.machineId, this.sessionId),
    requestAnchorMount: (anchorId) => this.behaviors.mountingWindow && (this.mountWindow.requestAnchor(anchorId) || this.childMounts.requestAnchor(anchorId)),
    resolveHiddenAnchor: (anchorId) => this.behaviors.mountingWindow ? this.hiddenAnchorOwner(anchorId) : undefined,
    whenRendered: () => this.behaviors.mountingWindow
      ? this.updateComplete.then(() => transcriptRenderComplete(this.renderRoot)) : undefined,
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
  private questionPresentationRevision = 0;
  private groupProjection = new ChatGroupProjection();
  private sourceLines = new WeakMap<ChatPart, ChatLine>();
  private messageMetaCache = new WeakMap<ChatLine, string>();
  private navigationLocalizationChanged = false;
  private transcriptPresentationRevision = 0;
  private imageSession: SessionRef | undefined;
  private touchY: number | undefined;
  private loadMoreRequested = false;
  private readonly onViewportResize = () => {
    this.scrollFlows.onViewportResize();
    this.scheduleMounts();
  };
  // Formatting completes independently of message updates. Reuse the existing
  // layout/restore flow without making content loading wait for enhancement.
  private readonly onContentLayoutChanged = () => { this.onViewportResize(); };
  private readonly handleScroll = () => {
    this.scrollFlows.onScroll();
    this.scheduleMounts();
  };
  private scheduleMounts(): void {
    if (!this.behaviors.mountingWindow) return;
    this.mountWindow.schedule();
    this.childMounts.schedule();
  }
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
  private readonly handlePointerDown = () => { this.scrollFlows.onInteraction(); };
  private readonly handleScrollKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const space = event.key === " ";
    const upward = ["ArrowUp", "PageUp", "Home"].includes(event.key) || (space && event.shiftKey);
    if (!upward && !space && !["ArrowDown", "PageDown", "End"].includes(event.key)) return;
    // Let editors and native controls own caret/selection and activation keys.
    if (event.composedPath().some((node) => node instanceof HTMLElement && (
      node.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)
      || (space && (node.matches("button, a, summary, [role=button]")))
    ))) return;
    if (upward) this.scrollFlows.onUpIntent();
    else this.scrollFlows.onInteraction();
  };
  private readonly handleJumpTop = () => { this.scrollFlows.jumpToTop(); };
  private readonly handleJumpEnd = () => { this.scrollFlows.jumpToEnd(); };
  private readonly openImageZoom = (image: ImageOpenDetail): void => {
    if (this.behaviors.loadImages) this.imageGalleryDialog?.show([image]);
  };
  private openToolImageGallery(images: readonly { part: ChatImagePart; description: () => string }[], selectedIndex: number): void {
    if (!this.behaviors.loadImages) return;
    const entries = images.flatMap((image, index) => {
      const source = transcriptImageSource(image.part, this.transcriptSession(), this.machineId);
      return source === undefined ? [] : [{ src: source.src, get alt() { return image.description(); }, partIndex: index }];
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
  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
    window.addEventListener("pagehide", this.onPageHide);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
  }

  override disconnectedCallback(): void {
    this.scrollFlows.dispose();
    this.mountWindow.dispose();
    this.childMounts.clear();
    this.messageActionController.reset();
    window.removeEventListener("resize", this.onViewportResize);
    window.removeEventListener("pagehide", this.onPageHide);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    super.disconnectedCallback();
  }

  private prepareSessionUiState(): void {
    if (this.behaviors.rememberDisclosures) this.disclosures.syncSession(this.sessionId, this.machineId);
    this.loadMoreRequested = false;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("messages")) {
      this.sourceLines = new WeakMap();
      for (const line of this.messages) for (const part of line.parts) this.sourceLines.set(part, line);
      const outcomes = transcriptQuestionOutcomes(this.messages);
      if (outcomes.size !== this.questionOutcomes.size || [...outcomes].some(([id, values]) => {
        const previous = this.questionOutcomes.get(id);
        return previous?.length !== values.length || values.some((value, index) => value !== previous[index]);
      })) {
        this.questionOutcomes = outcomes;
        this.questionPresentationRevision++;
      }
      const ids = new Set(this.messages.flatMap((line) => line.parts.flatMap((part) => part.type === "askUserQuestion" ? [part.ask.askId] : [])));
      if (ids.size !== this.questionIds.size || [...ids].some((id) => !this.questionIds.has(id))) {
        this.questionIds = ids;
        this.questionPresentationRevision++;
      }
    }
    if (changed.has("sessionId") || changed.has("machineId") || (changed.has("behaviors") && !this.behaviors.loadImages)) this.imageGalleryDialog?.close();
    if (changed.has("sessionId") || changed.has("machineId")) {
      this.groupProjection = new ChatGroupProjection();
      this.childMounts.clear();
      this.eventRenderKeys.clear();
      this.transientDisclosures.clear();
      this.pendingDisclosureAliases.clear();
      this.lastOpenQuestionId = undefined;
      this.queuedCopyFailed = false;
    }
    if (changed.has("sessionId") || changed.has("machineId")) {
      this.messageActionController.reset();
    }
    if (changed.has("sessionId") || changed.has("machineId")) {
      this.prepareSessionUiState();
    }
    if (changed.has("behaviors")) {
      this.scrollFlows.configure();
      if (!this.behaviors.mountingWindow) {
        this.mountWindow.suspend();
        this.childMounts.clear();
        this.mountPresentationInputs = [];
      }
      if (this.behaviors.rememberDisclosures) this.disclosures.syncSession(this.sessionId, this.machineId);
    }
  }

  protected override update(changed: Map<string, unknown>): void {
    const sessionChanged = changed.has("sessionId") || changed.has("machineId");
    const previousStart = changed.get("messageStart");
    const previousSessionId = changed.has("sessionId") ? changed.get("sessionId") : this.sessionId;
    const previousMachineId = changed.has("machineId") ? changed.get("machineId") : this.machineId;
    this.scrollFlows.beforeRender({
      sessionChanged,
      previousScopeKey: typeof previousSessionId === "string" && typeof previousMachineId === "string"
        ? chatScrollScopeKey(previousMachineId, previousSessionId) : undefined,
      prepend: typeof previousStart === "number" && this.messageStart < previousStart,
    });
    super.update(changed);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("loadingMore") && !this.loadingMore) this.loadMoreRequested = false;
    if (changed.has("hasMore") && !this.hasMore) this.loadMoreRequested = false;
    for (const [target, source] of this.pendingDisclosureAliases) {
      if (this.behaviors.rememberDisclosures) this.disclosures.transferChoice(source, target);
      else if (this.transientDisclosures.has(source)) {
        this.transientDisclosures.set(target, this.transientDisclosures.get(source) ?? false);
        this.transientDisclosures.delete(source);
      }
    }
    this.pendingDisclosureAliases.clear();
    for (const owner of this.eventRenderKeys.values()) {
      if (owner.pendingChoice === undefined) continue;
      if (this.behaviors.rememberDisclosures) this.disclosures.applyToggle(owner.disclosureKey, owner.pendingChoice, owner.defaultOpen);
      else this.transientDisclosures.set(owner.disclosureKey, owner.pendingChoice);
      delete owner.pendingChoice;
    }
    const openQuestionId = this.openQuestion()?.askId;
    if (this.behaviors.mountingWindow) {
      this.mountWindow.afterRender();
      this.childMounts.afterRender();
    }
    this.scrollFlows.afterRender({
      sessionChanged: changed.has("sessionId") || changed.has("machineId"),
      contentChanged: this.scrollContentChanged(changed),
      historyChanged: changed.has("messages") || changed.has("messageStart") || changed.has("hasMore") || changed.has("loadingMore") || changed.has("historyReady"),
      openedForm: changed.has("pendingDialogs") && this.isNewOpenDialog(changed.get("pendingDialogs")) ? "dialog"
        : openQuestionId !== undefined && openQuestionId !== this.lastOpenQuestionId ? "ask" : false,
    });
    this.lastOpenQuestionId = openQuestionId;
    if (this.navigationLocalizationChanged || changed.has("followingLive") || changed.has("behaviors") || changed.has("onNavigationChange")) {
      this.navigationLocalizationChanged = false;
      this.onNavigationChange?.(this.renderNavigation());
    }
  }

  private readonly renderKeys = new ChatRenderKeys();
  private readonly eventRenderKeys = new Map<string, { keys: ChatRenderKeys; disclosureKey: string; defaultOpen: boolean; pendingChoice?: boolean }>();
  private readonly renderItems = new WeakMap<ChatDisplayGroup, ChatRenderItem>();
  private renderKeyGroups?: ChatDisplayGroup[];
  private renderKeyTranscript = "";
  private currentRenderKeys: string[] = [];
  private actionHeaderGroups?: ChatGroup[];
  private entryActionHeaders: ReadonlySet<ChatLine> = new Set();

  override render() {
    const sourceGroups = this.groupProjection.update(this.messages, this.messageStart);
    if (sourceGroups !== this.actionHeaderGroups) {
      this.actionHeaderGroups = sourceGroups;
      this.entryActionHeaders = canonicalEntryActionHeaders(sourceGroups);
    }
    const entryActionHeaders = this.entryActionHeaders;
    const groups = this.groupProjection.getDisplayGroups();
    // Keep incremental updates within one transcript, but dispose the whole
    // repeat part when the transcript changes. Besides preventing cross-session
    // DOM reuse, clearing the part reclaims the end markers that the current Lit
    // build retains when repeat items are removed.
    const transcriptIdentity = machineSessionKey(this.machineId, this.sessionId);
    if (groups !== this.renderKeyGroups || transcriptIdentity !== this.renderKeyTranscript) {
      this.renderKeyGroups = groups;
      this.renderKeyTranscript = transcriptIdentity;
      this.currentRenderKeys = this.renderKeys.reconcile(transcriptIdentity, groups.map((group) => this.renderItem(group)));
    }
    const keys = this.currentRenderKeys;
    const retainedKeys = new Set(keys);
    for (const key of this.eventRenderKeys.keys()) {
      if (!retainedKeys.has(key)) this.eventRenderKeys.delete(key);
    }
    const presentationInputs = this.transcriptPresentationInputs();
    const mounted = this.mountedRows(groups, keys, transcriptIdentity, presentationInputs);
    return html`
      ${this.renderTopNotices()}
      <div class=${this.behaviors.visualEffects ? "chat-wrap" : "chat-wrap plain"}>
        <div class="chat" @image-open=${(event: CustomEvent<ImageOpenDetail>) => { this.openImageZoom(event.detail); }}
          @scroll=${this.behaviors.rememberPosition || this.behaviors.followTail || this.behaviors.automaticHistory || this.behaviors.mountingWindow ? this.handleScroll : undefined}
          @toggle=${this.behaviors.followTail ? this.handleDisclosureToggle : undefined}
          @content-layout-changed=${this.onContentLayoutChanged}
          @wheel=${this.handlesScrollIntent ? this.handleWheel : undefined}
          @pointerdown=${this.handlesScrollIntent ? this.handlePointerDown : undefined}
          @keydown=${this.handlesScrollIntent ? this.handleScrollKeyDown : undefined}
          @touchstart=${this.handlesScrollIntent ? this.handleTouchStart : undefined}
          @touchmove=${this.handlesScrollIntent ? this.handleTouchMove : undefined}
          @touchend=${this.handlesScrollIntent ? this.handleTouchEnd : undefined}
          @touchcancel=${this.handlesScrollIntent ? this.handleTouchEnd : undefined}>
          ${this.renderHistoryBoundary()}
          <div data-transcript-origin style="height:0" aria-hidden="true"></div>
          ${keyed(transcriptIdentity, repeat(
            mounted,
            (row) => row.key,
            (row) => {
              if (row.kind === "spacer") return html`<div aria-hidden="true" style=${`height:${String(row.height)}px`}></div>`;
              const index = row.index;
              const group = row.group;
              const messages = group.kind === "group" ? group.messages.map((event) => event.message)
                : group.kind === "tool-images" ? group.outputs.map((output) => output.message) : [group.message];
              const live = this.isLiveTailGroup(groups, index);
              // Historical templates do not depend on the growing transcript array.
              // Canonical header ownership can change when another slice arrives.
              return guard([group, live, this.behaviors.mountingWindow ? this.mountRevision : 0, ...presentationInputs, ...messages.map((message) => entryActionHeaders.has(message))], () => {
                // Cached group bodies must not retain a historical whole-transcript set.
                const headers = new Set(messages.filter((message) => entryActionHeaders.has(message)));
                if (group.kind === "group") return this.renderMessageGroup(group, live, headers, keys[index] ?? String(index));
                if (group.kind === "tool-images") return this.renderToolImageOutputs(group, headers, row.key);
                return this.renderMessage(group.message, group.index, headers, row.key);
              });
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

  private mountedRows(groups: ChatDisplayGroup[], keys: string[], scope: string, presentationInputs: readonly unknown[]): MountedTranscriptRow[] {
    const rows = groups.map((group, index) => ({ kind: "row" as const, group, index, key: keys[index] ?? String(index) }));
    if (!this.behaviors.mountingWindow) return rows;
    if (presentationInputs.length !== this.mountPresentationInputs.length || presentationInputs.some((input, index) => input !== this.mountPresentationInputs[index])) {
      this.mountPresentationInputs = presentationInputs;
      this.mountLayoutRevision++;
    }
    const openAsk = this.openQuestion()?.askId;
    const plan = this.mountWindow.plan(scope, groups.map((group, index) => {
      const key = keys[index] ?? String(index);
      let estimate = 160;
      let anchors: (string | undefined)[];
      if (group.kind === "group") {
        const live = this.isLiveTailGroup(groups, index);
        const { open } = this.groupDisclosureState(group, live, key);
        estimate = 32 + (open ? group.messages.length * 160 : 0);
        anchors = [this.groupAnchorKey(group, live), ...group.messages.map((entry) => chatEventAnchorKey(entry.index, entry.message))];
      } else if (group.kind === "tool-images") {
        const sourcesOpen = this.isDisclosureOpen(transcript.toolImageSourcesKey(this.machineId, this.sessionId, group), false);
        estimate = 64 + group.outputs.reduce((count, output) => count + output.message.parts.filter((part) => part.type === "image").length, 0) * THUMBNAIL_HEIGHT
          + (sourcesOpen ? group.outputs.length * 64 : 0);
        anchors = group.outputs.map((output) => chatMessageAnchorKey(output.index, output.message));
      } else anchors = [chatMessageAnchorKey(group.index, group.message)];
      return {
        key, revision: group, layoutRevision: this.mountLayoutRevision, estimate,
        anchors: anchors.filter((id): id is string => id !== undefined),
        keepMounted: group.kind === "message" && group.message.parts.some((part) => part.type === "askUserQuestion" && part.ask.askId === openAsk),
      };
    }));
    return plan.flatMap<MountedTranscriptRow>((segment) => segment.kind === "rows" ? rows.slice(segment.start, segment.end)
      : [{ kind: "spacer" as const, key: `spacer:${segment.key}`, height: segment.height }]);
  }

  private renderItem(group: ChatDisplayGroup): ChatRenderItem {
    const cached = this.renderItems.get(group);
    if (cached !== undefined) return cached;
    const source = group.kind === "tool-images" ? group.outputs[0] : group;
    const index = source.kind === "group" ? source.startIndex : source.index;
    const messages = group.kind === "group" ? group.messages.map((event) => event.message)
      : group.kind === "tool-images" ? group.outputs.map((output) => output.message) : [group.message];
    const identities = messages.flatMap((message) => {
      return this.linePresentationIdentities(message).map((identity) => JSON.stringify([group.kind, identity]));
    });
    const item = {
      slot: JSON.stringify([group.kind, index, messages[0]?.role]),
      ...(identities[0] === undefined ? {} : { identity: identities[0], identities }),
    };
    this.renderItems.set(group, item);
    return item;
  }

  private renderNavigation() {
    const following = this.behaviors.followTail && this.followingLive;
    const state = !this.behaviors.followTail ? "disabled" : following ? "following" : "paused";
    return html`<nav class="chat-jumps" aria-label=${chrome.t("navigation")}>
      <button type="button" title=${chrome.t("jumpTop")} aria-label=${chrome.t("jumpTop")} @click=${this.handleJumpTop}>↑</button>
      <button type="button" class=${following ? "following" : ""}
        title=${chrome.t("endTitle", { state })}
        aria-label=${chrome.t("jumpEnd")} aria-describedby="chat-follow-state" @click=${this.handleJumpEnd}>↓</button>
      <span id="chat-follow-state" class="chat-follow-state">${chrome.t("followState", { state })}</span>
    </nav>`;
  }

  private renderTopNotices() {
    return html`<div class="top-notices">
      <session-notification-tray
        .sessionId=${this.sessionId}
        .notificationInbox=${this.notificationInbox}
        .onDismissNotification=${this.onDismissNotification}
        .onDismissAllNotifications=${this.onDismissAllNotifications}
      ></session-notification-tray>
    </div>`;
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
    return html`${chatQueuedMessageSections(this.clientQueuedMessages, serverQueued, (source, count) => ({
      heading: chrome.t(source === "client" ? "clientHeading" : "serverHeading"),
      detail: source === "client" ? chrome.t("clientDetail") : chrome.t("pending", { count }),
    })).map((section) => this.renderQueuedMessageList(section))}
      ${this.queuedCopyFailed ? html`<small role="status">${chrome.t("copyFailed")}</small>` : nothing}`;
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
      this.queuedCopyFailed = !copied;
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
            .formState=${this.formState}
            .formScope=${machineSessionKey(this.machineId, this.sessionId)}
            .outcome=${closed}
            .onDismiss=${this.onDismissClosedDialog}
          ></extension-dialog-card>
        `,
      )}
      ${open === undefined ? null : html`
        <extension-dialog-card
          class="open-dialog-card"
          .formState=${this.formState}
          .formScope=${machineSessionKey(this.machineId, this.sessionId)}
          .dialog=${open}
          .onAnswer=${this.onAnswerDialog}
          .onCancel=${this.onCancelDialog}
        ></extension-dialog-card>
        ${queuedCount > 0
          ? html`<p class="queued-dialogs" role="status">${chrome.t("queuedDialogs", { count: queuedCount })}</p>`
          : null}
      `}
    `;
  }

  private renderSessionActivity() {
    if (!this.isCompacting) return null;
    return html`
      <aside class="session-activity compacting ui-transcript-surface" aria-live="polite">
        <strong>${chrome.t("compacting")}</strong>
        <span>${chrome.t("compactionDetail")}</span>
        ${this.pendingMessageCount > 0 ? html`<small>${chrome.t("queuedCount", { count: this.pendingMessageCount })}</small>` : null}
      </aside>
    `;
  }

  private renderHistoryBoundary() {
    const range = this.historyRangeLabel();
    if (this.loadingMore) return html`<div class="history-boundary"><span>${chrome.t("loadingHistory")}</span>${range}</div>`;
    if (this.hasMore) return html`
      <div class="history-boundary">
        <button type="button" class="history-load-button ui-button ui-button--compact" ?disabled=${this.loadMoreRequested} @click=${() => { this.requestLoadMore(); }}>${chrome.t("loadHistory")}</button>
        ${this.behaviors.automaticHistory ? html`<span>${chrome.t("scrollHistory")}</span>` : null}
        ${range}
      </div>
    `;
    if (this.messages.length) return html`<div class="history-boundary"><span>${chrome.t("beginning")}</span>${range}</div>`;
    return null;
  }

  private historyRangeLabel() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const from = this.messageStart + 1;
    const to = this.loadedRawMessageEnd();
    const total = Math.max(this.messageTotal, to);
    return html`<small>${chrome.t("range", { from, to, total })}</small>`;
  }

  private loadedRawMessageEnd(): number {
    return Math.max(this.messageEnd, this.messageStart + this.messages.length);
  }

  private transcriptPresentationInputs(): unknown[] {
    return [
      this.transcriptPresentationRevision, this.presentationOwners, this.uiState, this.formState, this.behaviors, this.quietMode, this.sessionCwd, this.workspaceContext,
      this.contentRendering, this.messageActions, this.messageActionContext, this.onMessageAction, this.onDisplayedMessageAction,
      this.expandedMetaKey, this.questionPresentationRevision, this.askDraftSessionId, this.onSubmitAsk, this.openQuestion()?.askId,
    ];
  }

  private transcriptRenderContext(): TranscriptRenderContext {
    return {
      renderInputs: this.transcriptPresentationInputs(),
      ...(this.behaviors.mountingWindow ? { mounting: {
        layoutRevision: this.mountLayoutRevision,
        width: (key: string) => this.childMounts.width(key),
        plan: (key: string, rows: readonly TranscriptMountRow[]) => this.childMounts.plan(machineSessionKey(this.machineId, this.sessionId), key, rows),
      } } : {}),
      machineId: this.machineId,
      sessionId: this.sessionId,
      session: this.transcriptSession(),
      // Retained handlers must not pin the transcript array from their render.
      sourceMessage: (message, index) => {
        const first = message.parts[0];
        return (first === undefined ? undefined : this.sourceLines.get(first)) ?? this.messages[index - this.messageStart];
      },
      partKeys: (message, part, index, partIndex) => this.partPresentationKeys(message, part, index, partIndex),
      rowIdentities: (message) => this.linePresentationIdentities(message),
      rowKey: (message, index) => {
        const first = message.parts[0];
        return first === undefined || chatPartIdentity(message, first) === undefined
          ? JSON.stringify(["legacy-row", index, message.role, first?.type])
          : JSON.stringify(["row", message.role, this.partPresentationKeys(message, first, index, 0).owner]);
      },
      uiState: this.uiState,
      formState: this.formState,
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
      questionOutcomes: (id) => this.questionOutcomes.get(id) ?? [],
      hasQuestion: (id) => this.questionIds.has(id),
      askDraftSessionId: this.askDraftSessionId,
      onSubmitAsk: this.onSubmitAsk,
      openImageGallery: (images, index) => { this.openToolImageGallery(images, index); },
    };
  }

  private linePresentationIdentities(message: ChatLine): string[] {
    // Older delta protocols cannot address original parts. Keep their existing
    // provisional slot reconciliation instead of declaring a false durable key.
    if ((message.entryId ?? "") === "" && message.parts[0]?.sourcePart?.startsWith("delta:") === true) return [];
    const primary = chatLinePresentationIdentity(message) ?? chatLineScrollIdentity(message);
    if (primary === undefined) return [];
    const provisional = message.streamId === undefined ? undefined
      : chatLinePresentationIdentity({ ...message, entryId: "" });
    return provisional === undefined || provisional === primary ? [primary] : [primary, provisional];
  }

  private partPresentationKeys(message: ChatLine, part: ChatPart, index: number, partIndex: number): { owner: string; canonical: string } {
    const identity = chatPartIdentity(message, part);
    if (identity === undefined) {
      // Legacy/manual content has no reloadable provenance; retain its local slot.
      const slot = JSON.stringify([this.machineId, this.sessionId, message.entryId ?? index, partIndex]);
      return { owner: slot, canonical: slot };
    }
    const provisional = message.streamId === undefined ? undefined : chatPartIdentity({ ...message, entryId: "" }, part);
    const keys = this.presentationOwners.resolve(machineSessionKey(this.machineId, this.sessionId), identity, provisional);
    if (keys.owner !== keys.canonical) {
      for (const prefix of ["thinking", "skill", "tool-result"]) {
        this.pendingDisclosureAliases.set(`${prefix}:${keys.canonical}`, `${prefix}:${keys.owner}`);
      }
    }
    return keys;
  }

  private renderMessage(message: ChatLine, index: number, entryActionHeaders: ReadonlySet<ChatLine>, mountKey?: string) {
    return transcript.renderMessage(this.transcriptRenderContext(), message, index, entryActionHeaders, mountKey);
  }

  private renderToolImageOutputs(group: Extract<ChatDisplayGroup, { kind: "tool-images" }>, entryActionHeaders: ReadonlySet<ChatLine>, mountKey?: string) {
    return transcript.renderToolImageOutputs(this.transcriptRenderContext(), group, entryActionHeaders, mountKey);
  }

  private groupDisclosureState(group: Extract<ChatGroup, { kind: "group" }>, liveTail: boolean, renderKey: string) {
    // Quiet mode keeps the live group expanded-on-demand: it is the one group a
    // reader opens while work is running, so its identity must not change as it grows.
    const defaultOpen = liveTail && !this.quietMode;
    const disclosureKey = this.groupDisclosureKey(group, liveTail);
    let owner = this.eventRenderKeys.get(renderKey);
    if (owner === undefined) {
      owner = { keys: new ChatRenderKeys(), disclosureKey, defaultOpen };
      this.eventRenderKeys.set(renderKey, owner);
    } else if (owner.disclosureKey !== disclosureKey) {
      // A committed identity or changed group boundary must not discard an
      // explicit disclosure choice. Untouched live defaults still become history.
      const previousOpen = this.isDisclosureOpen(owner.disclosureKey, owner.defaultOpen);
      if (previousOpen !== owner.defaultOpen) owner.pendingChoice = previousOpen;
    }
    owner.disclosureKey = disclosureKey;
    owner.defaultOpen = defaultOpen;
    const open = owner.pendingChoice ?? this.isDisclosureOpen(disclosureKey, defaultOpen);
    return { owner, open, disclosureKey, defaultOpen };
  }

  private renderMessageGroup(group: Extract<ChatGroup, { kind: "group" }>, liveTail: boolean, entryActionHeaders: ReadonlySet<ChatLine>, renderKey: string) {
    const { owner, open, disclosureKey, defaultOpen } = this.groupDisclosureState(group, liveTail, renderKey);
    return transcript.renderMessageGroup(this.transcriptRenderContext(), group, liveTail, entryActionHeaders, {
      open,
      anchor: this.groupAnchorKey(group, liveTail),
      toggle: (event) => { this.onDisclosureToggle(disclosureKey, event, defaultOpen); },
    }, owner.keys, renderKey);
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
    const source = this.pendingDisclosureAliases.get(key);
    if (source !== undefined && (this.behaviors.rememberDisclosures ? this.disclosures.hasChoice(source) : this.transientDisclosures.has(source))) {
      return this.behaviors.rememberDisclosures ? this.disclosures.isOpen(source, defaultOpen) : this.transientDisclosures.get(source) ?? defaultOpen;
    }
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
    if (changed) {
      this.transcriptPresentationRevision++;
      this.requestUpdate();
    }
  }

  private get handlesScrollIntent(): boolean {
    return this.behaviors.followTail || this.behaviors.rememberPosition || this.behaviors.anchorPrepends;
  }

  private scrollContentChanged(changed: Map<string, unknown>): boolean {
    return changed.has("mountRevision") || changed.has("messages") || changed.has("historyReady") || changed.has("messageEnd") || changed.has("messageTotal") || changed.has("onSubmitAsk") || changed.has("pendingDialogs") || changed.has("closedDialogs");
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

  /** Public navigation hooks delegate to the viewport owner. */
  restoreScrollPosition(): void {
    this.scrollFlows.restorePosition();
  }

  saveScrollPosition(sessionId = this.sessionId): void {
    this.scrollFlows.savePosition(chatScrollScopeKey(this.machineId, sessionId));
  }

  private scrollAnchorElements(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"));
  }

  private groupDisclosureKey(group: Extract<ChatGroup, { kind: "group" }>, liveTail: boolean): string {
    return liveTail
      ? `${this.sessionId}:live:${chatLineIdentity(group.startIndex, group.messages[0]?.message)}`
      : `${this.sessionId}:${chatLineIdentity(group.endIndex, group.messages.at(-1)?.message)}`;
  }


  private hiddenAnchorOwner(anchorId: string): string | undefined {
    const groups = this.renderKeyGroups ?? [];
    for (const [index, group] of groups.entries()) {
      if (group.kind !== "group" || !group.messages.some((entry) => chatEventAnchorKey(entry.index, entry.message) === anchorId)) continue;
      const owner = Array.from(this.renderRoot.querySelectorAll<HTMLDetailsElement>(".chat > details[data-transcript-row]"))
        .find((element) => element.dataset["transcriptRow"] === this.currentRenderKeys[index]);
      return owner?.open === false ? owner.dataset["scrollAnchorId"] : undefined;
    }
    return undefined;
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
