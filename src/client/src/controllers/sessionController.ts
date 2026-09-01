import { api as defaultApi, type AskUserCloseResponse, type AskUserSubmission, type CommandResult, type ExtensionDialogAnswer, type ExtensionDialogCloseReason, type ExtensionDialogCloseResponse, type ExtensionDialogOutcome, type MessagePage, type PendingAskUser, type PendingExtensionDialog, type PromptAttachment, type QueuedSessionMessage, type SessionActivity, type SessionBulkFailure, type SessionCleanupExecuteResponse, type SessionInfo, type SessionModelCatalogEntry, type SessionModelScopeMode, type SessionRef, type SessionStatus, type SessionStreamSnapshot, type SessionTreeForkResult, type SessionTreeNavigateResult, type SessionTreeSummaryChoice, type Workspace } from "../api";
import type { AppState, ClosedExtensionDialog } from "../appState";
import { forgetCachedNewSession, isCachedNewSessionInfo, markCachedNewSessionInfo, mergeCachedNewSessions, rememberCachedNewSession, stripCachedNewSessionMarker } from "../cachedNewSessions";
import { textMessage } from "../chatMessages";
import { machineSessionKey } from "../machineKeys";
import { clearDraft, moveDraft, saveDraft } from "../promptDraftStorage";
import { clearStagedAttachments, moveStagedAttachments } from "../promptAttachmentStaging";
import { clearAskDraft } from "../askDrafts";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { isHistoryTailSlice } from "../chatHistoryCache";
import { isShellInput } from "../inputModes";
import { fileCompletionInsertText } from "../promptCompletions";
import { SessionSocket, type GlobalSessionEvent, type SessionUiEvent } from "../sessionSocket";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../sessionPersistence";
import { isSessionActive } from "../../../shared/activity";
import type { PromptAttachmentDelivery, SessionNotificationInboxEvent, SessionStartupProgressEvent } from "../../../shared/apiTypes";
import { InMemorySessionSelectionMemory, markSessionArchived, markSessionsArchived, selectPreferredSession, selectionAfterArchivingSession, selectionAfterArchivingSessions, shouldDeselectAfterArchivedCollapse, type SessionSelectionMemory } from "./sessionSelection";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";
import { TrailingRefreshCoordinator } from "./trailingRefreshCoordinator";

const MESSAGE_PAGE_SIZE = 100;

export interface SessionEventSocket {
  connect(
    session: SessionRef,
    onEvent: (event: SessionUiEvent) => void,
    onReconnect?: () => void,
    machineId?: string,
    onInitialOpen?: () => void,
  ): void;
  setHandler(onEvent: (event: SessionUiEvent) => void): void;
  close(): void;
}

export interface SessionNotificationSessionBridge {
  prepareSelectedSession(session: SessionInfo, machineId: string): void;
  clearSelectedSession(): void;
  refreshSelectedSession(session: SessionRef, machineId: string): Promise<void>;
  applyInboxEvent(machineId: string, event: SessionNotificationInboxEvent): void;
}

export interface PromptEditorTextReplacement {
  machineId: string;
  sessionId: string;
  text: string;
}

export interface SelectedSessionReady {
  machineId: string;
  session: SessionInfo;
}

export interface SessionControllerDependencies {
  api?: typeof defaultApi;
  socket?: SessionEventSocket;
  transcripts?: ChatTranscriptStore;
  notifications?: SessionNotificationSessionBridge;
  replacePromptEditorText?: (replacement: PromptEditorTextReplacement) => void | Promise<void>;
  onSelectedSessionReady?: (selection: SelectedSessionReady) => void;
  onModelScopeChanged?: (revision: number) => void;
}

interface BulkSessionMutationResult {
  succeededIds: string[];
  failures: string[];
  generatedAt?: string;
}

type ClientPendingStartSessionInfo = SessionInfo & { clientPendingStart: true; machineId: string };

type QueuedPendingSessionSendInput =
  | { type: "prompt"; text: string; streamingBehavior?: "steer" | "followUp" | undefined; attachments?: PromptAttachment[] | undefined; delivery: PromptAttachmentDelivery; folder?: string | undefined }
  | { type: "shell"; text: string }
  | { type: "command"; text: string };

type QueuedPendingSessionSend = QueuedPendingSessionSendInput & { id: string };

interface PendingSessionStart {
  tempId: string;
  workspaceId: string;
  cwd: string;
  machineId: string;
  session: ClientPendingStartSessionInfo;
  queuedSends: QueuedPendingSessionSend[];
  discarded: boolean;
  /**
   * The real session id, learned from the daemon's `session.startup` events
   * long before the create request resolves. It is what lets the startup view
   * subscribe to the constructing session and answer its `session_start`
   * dialogs — the dialogs that gate the readiness the create request waits on.
   */
  backendSessionId?: string;
}

interface SuppressedCreatedSession {
  session: SessionInfo;
  machineId: string;
}

interface SelectedSessionRefreshTarget {
  session: SessionInfo;
  machineId: string;
  selectionSeq: number;
}

export class SessionController {
  private readonly socket: SessionEventSocket;
  private readonly api: typeof defaultApi;
  private readonly transcripts: ChatTranscriptStore;
  private readonly notifications: SessionNotificationSessionBridge | undefined;
  private readonly replacePromptEditorText: SessionControllerDependencies["replacePromptEditorText"];
  private readonly onSelectedSessionReady: SessionControllerDependencies["onSelectedSessionReady"];
  private readonly onModelScopeChanged: SessionControllerDependencies["onModelScopeChanged"];
  private selectionSeq = 0;
  private disposed = false;
  // Join-time stream watermark for the selected session. `seq` is the
  // `SessionEventHub` sequence captured together with the seeded partial by the
  // stream snapshot: buffered/live events with `seq <= seq` are already reflected
  // in the committed history + seeded partial and must be dropped, so every event
  // applies exactly once. Reset whenever the selection changes.
  private streamWatermark: { sessionId: string; seq: number } | undefined;
  // Fingerprint of the last applied selected-session refresh, bound to that
  // selection: a poll whose page, status, and partial all match what is already
  // held skips the redundant merge, sessionStorage rewrite, and render. The
  // `selectionSeq` check retires it on any (re)selection, so a join always runs
  // the full path — it must re-seed the partial and the stream watermark onto
  // the fresh state baseline.
  private lastAppliedSelectedRefresh: { selectionSeq: number; partialJson: string } | undefined;
  private pendingTranscriptEvents: SessionUiEvent[] = [];
  private pendingStatusBySession = new Map<string, SessionStatus>();
  private pendingActivityBySession = new Map<string, SessionActivity>();
  private pendingFrame: number | undefined;
  private pendingSessionStartSeq = 0;
  private pendingQueuedSendSeq = 0;
  private readonly pendingSessionStarts = new Map<string, PendingSessionStart>();
  private readonly suppressedCreatedSessions = new Map<string, SuppressedCreatedSession>();
  private readonly selectedSessionRefreshes = new TrailingRefreshCoordinator<string>();

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessionSelection: SessionSelectionMemory = new InMemorySessionSelectionMemory(),
    deps: SessionControllerDependencies = {},
  ) {
    this.socket = deps.socket ?? new SessionSocket();
    this.api = deps.api ?? defaultApi;
    this.transcripts = deps.transcripts ?? new ChatTranscriptStore();
    this.notifications = deps.notifications;
    this.replacePromptEditorText = deps.replacePromptEditorText;
    this.onSelectedSessionReady = deps.onSelectedSessionReady;
    this.onModelScopeChanged = deps.onModelScopeChanged;
  }

  applyGlobalEvent(event: GlobalSessionEvent): void {
    if (event.type === "status.update") this.queueStatusUpdate(event.status);
    else if (event.type === "activity.update") this.queueActivityUpdate(event.activity);
    else if (event.type === "session.created") this.applyCreatedSession(event.session);
    else if (event.type === "session.name") this.applySessionName(event.sessionId, event.name);
    else if (event.type === "models.changed") this.onModelScopeChanged?.(event.revision);
    else if (event.type === "session.startup") this.queueStartupProgress(event);
  }

  dispose() {
    this.disposed = true;
    this.selectionSeq += 1;
    this.socket.close();
    this.clearPendingUpdates();
  }

  clearActiveSession() {
    this.selectionSeq += 1;
    this.socket.close();
    this.notifications?.clearSelectedSession();
    this.streamWatermark = undefined;
    this.clearPendingUpdates();
    // Note: sendingPrompts is intentionally NOT cleared here. Deselecting a
    // session must not cancel the in-flight upload indicator of the session
    // that is still sending; the per-session entry is cleared by send()'s
    // finally block when the request settles.
    this.setState({ selectedSession: undefined, messages: [], messagePageStart: 0, messagePageEnd: 0, messagePageTotal: 0, isLoadingEarlierMessages: false, status: undefined, activity: undefined, pendingAsk: undefined, pendingDialogs: [], closedDialogs: [], availableThinkingLevels: [], treeDialog: undefined });
  }

  deselectSession(options?: { forgetRememberedSelection?: boolean | undefined; updateUrl?: boolean | undefined }) {
    const state = this.getState();
    const cwd = state.selectedSession?.cwd ?? state.selectedWorkspace?.path;
    if (options?.forgetRememberedSelection === true && cwd !== undefined) this.sessionSelection.forgetWorkspace(this.workspaceSelectionKey(cwd));
    this.clearActiveSession();
    if (options?.updateUrl !== false) this.updateUrl();
  }

  clearSelectionAfterArchivedCollapse(): void {
    const state = this.getState();
    if (!shouldDeselectAfterArchivedCollapse(state.sessions, state.selectedSession)) return;
    this.deselectSession({ forgetRememberedSelection: true });
  }

  async startSession() {
    const workspace = this.getState().selectedWorkspace;
    if (!workspace) return;
    const machineId = selectedMachineId(this.getState());
    const pending = this.createPendingSessionStart(workspace, machineId);
    this.pendingSessionStarts.set(pending.tempId, pending);
    this.insertAndSelectPendingSession(pending.session);
    try {
      const session = await this.api.startSession(workspace.path, machineId, pending.tempId);
      await this.resolvePendingSessionStart(pending.tempId, session);
    } catch (error) {
      this.failPendingSessionStart(pending.tempId, error);
    }
  }

  preferredSession(cwd: string, sessions: SessionInfo[], targetSessionId: string | undefined): SessionInfo | undefined {
    return selectPreferredSession(sessions, { targetSessionId, latestSessionId: this.sessionSelection.latestSessionId(this.workspaceSelectionKey(cwd)) });
  }

  async selectSession(session: SessionInfo, options?: { updateUrl?: boolean | undefined; preserveTreeDialog?: boolean | undefined; propagateRefreshError?: boolean | undefined }) {
    if (this.disposed) return;
    if (isClientPendingStartSessionInfo(session)) {
      this.selectClientPendingStartSession(session, options);
      return;
    }
    this.sessionSelection.rememberSession({ ...session, cwd: this.workspaceSelectionKey(session.cwd) });
    const seq = ++this.selectionSeq;
    this.socket.close();
    this.streamWatermark = undefined;
    this.clearPendingUpdates();
    const machineId = selectedMachineId(this.getState());
    this.notifications?.prepareSelectedSession(session, machineId);
    const transcriptKey = this.sessionCacheKey(session.id);
    const cached = this.transcripts.cachedView(transcriptKey);
    this.setState({
      selectedSession: session,
      ...cached,
      isLoadingEarlierMessages: false,
      ...(options?.preserveTreeDialog === true ? {} : { treeDialog: undefined }),
      status: session.archived === true ? undefined : this.getState().sessionStatuses[session.id],
      activity: session.archived === true ? undefined : this.getState().sessionActivities[session.id],
      pendingAsk: session.archived === true ? undefined : this.getState().sessionStatuses[session.id]?.pendingAsk,
      pendingDialogs: session.archived === true ? [] : (this.getState().sessionStatuses[session.id]?.pendingDialogs ?? []),
      closedDialogs: [],
      availableThinkingLevels: [],
    });
    let buffered: SessionUiEvent[] | undefined;
    try {
      if (session.archived === true) {
        const page = await this.api.messages(session, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
        if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
        const history = this.transcripts.mergeHistory(transcriptKey, page);
        this.setState({ ...history, isLoadingEarlierMessages: false, status: undefined, activity: undefined, pendingAsk: undefined, pendingDialogs: [], closedDialogs: [] });
        this.onSelectedSessionReady?.({ machineId, session });
        if (options?.updateUrl !== false) this.updateUrl();
        return;
      }
      const socketBuffer: SessionUiEvent[] = [];
      buffered = socketBuffer;
      this.socket.connect(
        session,
        (event) => socketBuffer.push(event),
        () => { void this.refreshSelectedSession(session.id); },
        machineId,
        () => { void this.notifications?.refreshSelectedSession(session, machineId); },
      );
      await this.requestSelectedSessionRefresh({ session, machineId, selectionSeq: seq });
      if (!this.isCurrentRefreshTarget({ session, machineId, selectionSeq: seq })) return;
      void this.refreshAvailableThinkingLevels();
      for (const event of socketBuffer) this.applyEvent(event);
      this.socket.setHandler((event) => { this.applyEvent(event); });
      this.onSelectedSessionReady?.({ machineId, session });
      if (options?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) {
        // Tree navigation still needs to know when a same-session reselection's
        // shared trailing refresh failed, even though this selection is stale.
        if (options?.propagateRefreshError === true && this.isSelectedSessionIdentity(session.id, machineId)) throw error;
        return;
      }
      if (isCachedNewSessionInfo(session) && isSessionNotFoundError(error)) {
        await this.recreateCachedNewSession(session, options);
        return;
      }
      // A failed join refresh must not strand the socket on its temporary
      // buffering callback. Apply what arrived and keep live events flowing so
      // reconnect/trailing refresh can recover authoritatively.
      if (buffered !== undefined) {
        for (const event of buffered) this.applyEvent(event);
        this.socket.setHandler((event) => { this.applyEvent(event); });
      }
      this.setState({ error: String(error) });
      if (options?.propagateRefreshError === true) throw error;
    }
  }

  async loadEarlierMessages() {
    const state = this.getState();
    const session = state.selectedSession;
    if (!session || state.isLoadingEarlierMessages || state.messagePageStart <= 0) return;
    this.setState({ isLoadingEarlierMessages: true });
    try {
      const page = await this.api.messages(session, { before: state.messagePageStart, limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
      if (this.getState().selectedSession?.id !== session.id) return;
      const history = this.transcripts.mergeHistory(this.sessionCacheKey(session.id), page);
      this.setState(history);
    } catch (error) {
      this.setState({ error: String(error) });
    } finally {
      if (this.getState().selectedSession?.id === session.id) this.setState({ isLoadingEarlierMessages: false });
    }
  }

  async send(text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery: PromptAttachmentDelivery = "inline", folder?: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;

    const trimmed = text.trim();
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (isClientPendingStartSessionInfo(session)) {
      if (!hasAttachments && trimmed.startsWith("/")) this.enqueuePendingSessionSend(session, { type: "command", text });
      else if (!hasAttachments && isShellInput(text)) this.enqueuePendingSessionSend(session, { type: "shell", text });
      else this.enqueuePendingSessionSend(session, { type: "prompt", text, streamingBehavior, attachments, delivery, folder });
      return;
    }
    if (!hasAttachments && trimmed.startsWith("/")) return this.runCommand(text);
    if (!hasAttachments && isShellInput(text)) return this.runShell(text);

    // Capture the originating session/machine before any await so the request
    // and its sending indicator stay bound to the right session even if the
    // user navigates elsewhere mid-upload.
    await this.deliverPromptToSession(session, text, streamingBehavior, attachments, delivery, folder, selectedMachineId(this.getState()), { markSending: hasAttachments });
  }

  private markSendingPrompt(sessionId: string, sending: boolean): void {
    const current = this.getState().sendingPrompts;
    if (sending) {
      if (current[sessionId] !== true) this.setState({ sendingPrompts: { ...current, [sessionId]: true } });
    } else if (sessionId in current) {
      this.setState({ sendingPrompts: omitKey(current, sessionId) });
    }
  }

  async runShell(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    if (isClientPendingStartSessionInfo(session)) {
      this.enqueuePendingSessionSend(session, { type: "shell", text });
      return;
    }
    await this.deliverShellToSession(session, text, selectedMachineId(this.getState()), { optimisticLine: true });
  }

  async runCommand(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    if (isClientPendingStartSessionInfo(session)) {
      this.enqueuePendingSessionSend(session, { type: "command", text });
      return;
    }
    await this.deliverCommandToSession(session, text, selectedMachineId(this.getState()), { applyResult: true });
  }

  private enqueuePendingSessionSend(session: ClientPendingStartSessionInfo, input: QueuedPendingSessionSendInput): void {
    const pending = this.pendingSessionStarts.get(session.id);
    if (pending === undefined || pending.discarded) {
      this.setState({ error: "The backend session is not ready for queued sends. Copy your message before discarding this failed start." });
      return;
    }
    const queued: QueuedPendingSessionSend = { ...input, id: `pending-send-${String(++this.pendingQueuedSendSeq)}` };
    pending.queuedSends.push(queued);
    const state = this.getState();
    const current = state.clientQueuedSessionMessages[session.id] ?? [];
    const activity = creatingPendingSessionActivity(session.id, pending.queuedSends.length);
    this.setState({
      clientQueuedSessionMessages: { ...state.clientQueuedSessionMessages, [session.id]: [...current, queuedSessionMessagePreview(queued)] },
      sessionActivities: { ...state.sessionActivities, [session.id]: activity },
      activity: state.selectedSession?.id === session.id ? activity : state.activity,
      error: "",
    });
  }

  private async flushQueuedPendingSends(session: SessionInfo, machineId: string, queuedSends: readonly QueuedPendingSessionSend[]): Promise<void> {
    for (const queued of queuedSends) {
      const delivered = await this.deliverQueuedPendingSend(session, machineId, queued);
      if (!delivered) return;
      this.dropNextQueuedSessionMessage(session.id);
    }
  }

  private async deliverQueuedPendingSend(session: SessionInfo, machineId: string, queued: QueuedPendingSessionSend): Promise<boolean> {
    if (queued.type === "prompt") return this.deliverPromptToSession(session, queued.text, queued.streamingBehavior, queued.attachments, queued.delivery, queued.folder, machineId, { markSending: true });
    if (queued.type === "shell") return this.deliverShellToSession(session, queued.text, machineId, { optimisticLine: true });
    return this.deliverCommandToSession(session, queued.text, machineId, { applyResult: true });
  }

  private async deliverPromptToSession(session: SessionInfo, text: string, streamingBehavior: "steer" | "followUp" | undefined, attachments: PromptAttachment[] | undefined, delivery: PromptAttachmentDelivery, folder: string | undefined, machineId: string, options: { markSending: boolean }): Promise<boolean> {
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (options.markSending) this.markSendingPrompt(session.id, true);
    try {
      if (hasAttachments && delivery === "folder") {
        // The composer passes the workspace-effective folder it displayed, so
        // the save destination matches the label for every workspace of the
        // project; the server only re-resolves config when folder is omitted.
        const saved = await this.api.saveAttachments(session, attachments, machineId, folder);
        const references = saved.map((file) => fileCompletionInsertText(file.path, false)).join(" ");
        const body = text === "" ? references : `${text}\n\n${references}`;
        await this.api.prompt(session, body, streamingBehavior, machineId);
      } else {
        await this.api.prompt(session, text, streamingBehavior, machineId, attachments);
      }
      this.markCachedNewSessionPersisted(session);
      return true;
    } catch (error) {
      this.setState({ error: String(error) });
      return false;
    } finally {
      if (options.markSending) this.markSendingPrompt(session.id, false);
    }
  }

  private async deliverShellToSession(session: SessionInfo, text: string, machineId: string, options: { optimisticLine: boolean }): Promise<boolean> {
    if (options.optimisticLine && this.getState().selectedSession?.id === session.id) {
      this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    }
    try {
      await this.api.shell(session, text, machineId);
      this.markCachedNewSessionPersisted(session);
      return true;
    } catch (error) {
      if (this.getState().selectedSession?.id === session.id) this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))] });
      this.setState({ error: String(error) });
      return false;
    }
  }

  private async deliverCommandToSession(session: SessionInfo, text: string, machineId: string, options: { applyResult: boolean }): Promise<boolean> {
    // Commands are not inserted into the transcript optimistically: a builtin
    // command produces its own result line, and a runtime/skill command is
    // forwarded to the agent, which streams back the canonical (expanded)
    // message. Inserting the raw text here would leave a line that doesn't
    // converge with server history and disappears on reload. Surface the same
    // per-session sending indicator that send() uses for the pre-receipt window.
    this.markSendingPrompt(session.id, true);
    try {
      const result = await this.api.runCommand(session, text, machineId);
      if (options.applyResult && this.isSelectedSessionIdentity(session.id, machineId)) this.applyCommandResult(result);
      else if (result.type === "select" || result.type === "tree") this.setState({ error: `Queued command “${text}” needs input; open the session and run it again.` });
      this.markCachedNewSessionPersisted(session);
      return true;
    } catch (error) {
      if (this.getState().selectedSession?.id === session.id) this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))] });
      this.setState({ error: String(error) });
      return false;
    } finally {
      this.markSendingPrompt(session.id, false);
    }
  }

  private dropNextQueuedSessionMessage(sessionId: string): void {
    const state = this.getState();
    const current = state.clientQueuedSessionMessages[sessionId] ?? [];
    if (current.length === 0) return;
    const remaining = current.slice(1);
    this.setState({ clientQueuedSessionMessages: remaining.length === 0 ? omitKey(state.clientQueuedSessionMessages, sessionId) : { ...state.clientQueuedSessionMessages, [sessionId]: remaining } });
  }

  async respondToCommand(requestId: string, value: string) {
    const session = this.getState().selectedSession;
    if (!session) return;
    this.setState({ commandDialog: undefined });
    try {
      this.applyCommandResult(await this.api.respondToCommand(session, requestId, value, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  cancelCommand() {
    this.setState({ commandDialog: undefined });
  }

  async navigateTree(targetId: string, summary: SessionTreeSummaryChoice): Promise<SessionTreeNavigateResult> {
    const state = this.getState();
    const session = state.selectedSession;
    const tree = state.treeDialog;
    if (session === undefined || tree === undefined || session.archived === true || isClientPendingStartSessionInfo(session)) {
      throw new Error("The session tree navigator is no longer available");
    }

    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    const cacheKey = machineSessionKey(machineId, session.id);
    let result: SessionTreeNavigateResult;
    try {
      result = await this.api.navigateTree(session, { targetId, expectedLeafId: tree.activeLeafId, summary }, machineId);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
      throw error;
    }

    if (result.cancelled) return result;

    const editorText = result.editorText ?? "";
    saveDraft(cacheKey, editorText);
    this.transcripts.discard(cacheKey);

    // A user can reselect the same session while the request is in flight. Its
    // sequence changes, but the server mutation still belongs to the selected
    // identity and requires a fresh authoritative branch read.
    if (!this.isSelectedSessionIdentity(session.id, machineId)) return result;
    this.clearPendingUpdates();
    let authoritativeRefreshFailure: { error: unknown } | undefined;
    try {
      await this.selectSession(session, { updateUrl: false, preserveTreeDialog: true, propagateRefreshError: true });
    } catch (error) {
      authoritativeRefreshFailure = { error };
    }
    if (!this.isSelectedSessionIdentity(session.id, machineId)) return result;

    try {
      await this.replacePromptEditorText?.({ machineId, sessionId: session.id, text: editorText });
    } catch (error) {
      if (this.isSelectedSessionIdentity(session.id, machineId)) this.setState({ error: String(error) });
      throw error;
    }
    if (authoritativeRefreshFailure !== undefined) {
      if (this.isSelectedSessionIdentity(session.id, machineId)) this.setState({ error: String(authoritativeRefreshFailure.error) });
      throw authoritativeRefreshFailure.error;
    }
    if (this.isSelectedSessionIdentity(session.id, machineId) && this.getState().treeDialog === tree) this.setState({ treeDialog: undefined });
    return result;
  }

  async forkFromTree(entryId: string): Promise<SessionTreeForkResult> {
    const state = this.getState();
    const session = state.selectedSession;
    const tree = state.treeDialog;
    if (session === undefined || tree === undefined || session.archived === true || isClientPendingStartSessionInfo(session)) {
      throw new Error("The session tree navigator is no longer available");
    }

    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    const originalCacheKey = machineSessionKey(machineId, session.id);
    let result: SessionTreeForkResult;
    try {
      result = await this.api.forkTree(session, { entryId, expectedLeafId: tree.activeLeafId }, machineId);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
      throw error;
    }

    if (result.cancelled) return result;

    const forked = result.session;
    // The draft belongs to the forked session file; the original keeps its own.
    if (result.promptDraft !== undefined) saveDraft(machineSessionKey(machineId, forked.id), result.promptDraft);
    // The daemon replaced the runtime behind the original session identity with
    // the fork while the request was in flight, so any cached projection of the
    // original transcript is suspect; drop it so a later reselection reads the
    // untouched original file authoritatively.
    this.transcripts.discard(originalCacheKey);

    // The fork happened regardless, but the list/selection update belongs to
    // whoever owns the selection now; a changed selection may already reflect it.
    if (!this.isSelectedSessionIdentity(session.id, machineId)) return result;
    const sessions = [forked, ...this.getState().sessions.filter((candidate) => candidate.id !== forked.id)];
    this.setState({ sessions, treeDialog: undefined });
    void this.selectSession(forked);
    return result;
  }

  async abortTreeNavigation(): Promise<void> {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || state.treeDialog === undefined || isClientPendingStartSessionInfo(session)) return;
    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    try {
      await this.api.abort(session, machineId);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
      throw error;
    }
  }

  closeTreeDialog(): void {
    this.setState({ treeDialog: undefined });
  }

  applySessionStatus(status: SessionStatus): void {
    this.applyStatus(status);
  }

  async archiveSession(session = this.getState().selectedSession) {
    if (!session) return;
    const status = this.statusForSession(session);
    if (isTransientNewSessionInfo(session, status)) {
      await this.deleteCachedNewSession(session);
      return;
    }
    if (!isArchivableSessionInfo(session, status)) return;
    try {
      await this.api.archive(session, selectedMachineId(this.getState()));
      const state = this.getState();
      const sessions = markSessionArchived(state.sessions, session.id, new Date().toISOString());
      const selectionChange = selectionAfterArchivingSession(sessions, state.selectedSession?.id, session.id);
      this.setState({ sessions });

      if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
      else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async archiveSessionWithDescendants(session = this.getState().selectedSession) {
    if (session === undefined || !isArchivableSessionInfo(session, this.statusForSession(session))) return;
    try {
      const response = await this.api.archiveWithDescendants(session, selectedMachineId(this.getState()));
      const archivedIds = response.sessionIds !== undefined && response.sessionIds.length > 0 ? response.sessionIds : [session.id];
      const state = this.getState();
      const sessions = markSessionsArchived(state.sessions, archivedIds, new Date().toISOString());
      const selectionChange = selectionAfterArchivingSessions(sessions, state.selectedSession?.id, archivedIds);
      this.setState({ sessions });

      if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
      else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async archiveSessions(sessions: readonly SessionInfo[]): Promise<void> {
    const candidates = uniqueSessionsById(sessions).filter((session) => isArchivableSessionInfo(session, this.statusForSession(session)));
    if (candidates.length === 0) return;

    try {
      const machineId = selectedMachineId(this.getState());
      const { succeededIds: archivedIds, failures, generatedAt } = await this.archiveSessionBatch(candidates, machineId);
      if (archivedIds.length > 0) {
        const state = this.getState();
        const nextSessions = markSessionsArchived(state.sessions, archivedIds, generatedAt ?? new Date().toISOString());
        const selectionChange = selectionAfterArchivingSessions(nextSessions, state.selectedSession?.id, archivedIds);
        this.setState({ sessions: nextSessions });

        if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
        else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
      }
      this.applyBulkSessionFailures("Archive", failures);
    } catch (error) {
      this.setState({ error: `Archive failed: ${errorMessage(error)}` });
    }
  }

  async deleteArchivedSessions(sessions: readonly SessionInfo[]): Promise<void> {
    const candidates = uniqueSessionsById(sessions).filter((session) => session.archived === true);
    if (candidates.length === 0) return;

    const machineId = selectedMachineId(this.getState());
    try {
      const { succeededIds: deletedIds, failures } = await this.deleteArchivedSessionBatch(candidates, machineId);
      if (deletedIds.length > 0) {
        const deletedIdSet = new Set(deletedIds);
        const state = this.getState();
        const nextSessions = state.sessions.filter((session) => !deletedIdSet.has(session.id));
        this.setState({ sessions: nextSessions });
        if (state.selectedSession !== undefined && deletedIdSet.has(state.selectedSession.id)) {
          const next = nextSessions.find((session) => session.archived !== true) ?? nextSessions[0];
          if (next !== undefined) await this.selectSession(next);
          else this.deselectSession({ forgetRememberedSelection: true });
        }
      }
      this.applyBulkSessionFailures("Delete", failures);
    } catch (error) {
      this.setState({ error: `Delete failed: ${errorMessage(error)}` });
    }
  }

  private async archiveSessionBatch(sessions: readonly SessionInfo[], machineId: string): Promise<BulkSessionMutationResult> {
    const response = await this.api.archiveMany(sessions, machineId);
    return { succeededIds: response.archivedSessionIds, failures: bulkFailureMessages(response.failures), generatedAt: response.generatedAt };
  }

  private async deleteArchivedSessionBatch(sessions: readonly SessionInfo[], machineId: string): Promise<BulkSessionMutationResult> {
    const response = await this.api.deleteArchivedMany(sessions, machineId);
    return { succeededIds: response.deletedSessionIds, failures: bulkFailureMessages(response.failures) };
  }

  async applySessionCleanupResult(result: SessionCleanupExecuteResponse, machineId = selectedMachineId(this.getState())): Promise<void> {
    if (selectedMachineId(this.getState()) !== machineId) return;
    const archivedIds = result.archivedSessionIds;
    const deletedIds = result.deletedSessionIds;
    if (archivedIds.length > 0 || deletedIds.length > 0) {
      const state = this.getState();
      const deletedIdSet = new Set(deletedIds);
      const affectedIds = [...archivedIds, ...deletedIds];
      const nextSessions = markSessionsArchived(state.sessions, archivedIds, result.generatedAt).filter((session) => !deletedIdSet.has(session.id));
      const selectedAffected = state.selectedSession !== undefined && affectedIds.includes(state.selectedSession.id);
      this.setState({
        sessions: nextSessions,
        sessionStatuses: omitKeys(state.sessionStatuses, affectedIds),
        sessionActivities: omitKeys(state.sessionActivities, affectedIds),
        ...(selectedAffected ? { status: undefined, activity: undefined, pendingAsk: undefined, pendingDialogs: [], closedDialogs: [] } : {}),
      });

      if (state.selectedSession !== undefined && deletedIdSet.has(state.selectedSession.id)) {
        const next = nextSessions.find((session) => session.archived !== true) ?? nextSessions[0];
        if (next !== undefined) await this.selectSession(next);
        else this.deselectSession({ forgetRememberedSelection: true });
      } else {
        const selectionChange = selectionAfterArchivingSessions(nextSessions, state.selectedSession?.id, archivedIds);
        if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
        else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
      }
    }
    await this.refreshCurrentWorkspaceSessions(machineId);
  }

  async refreshCurrentWorkspaceSessions(machineId = selectedMachineId(this.getState())): Promise<void> {
    const workspace = this.getState().selectedWorkspace;
    if (workspace === undefined) return;
    try {
      const listedSessions = mergeCachedNewSessions(workspace.path, await this.api.sessions(workspace.path, machineId), machineId)
        .filter((session) => !this.isSuppressedCreatedSession(session, machineId));
      if (selectedMachineId(this.getState()) !== machineId || this.getState().selectedWorkspace?.id !== workspace.id) return;
      const sessions = this.mergePendingStartSessions(workspace.path, listedSessions, machineId);
      const selectedSession = this.getState().selectedSession;
      this.setState({ sessions });
      if (selectedSession === undefined) return;
      const refreshedSelected = sessions.find((session) => session.id === selectedSession.id);
      if (refreshedSelected !== undefined) {
        if (refreshedSelected !== selectedSession) this.setState({ selectedSession: refreshedSelected });
        return;
      }
      const next = sessions.find((session) => session.archived !== true) ?? sessions[0];
      if (next !== undefined) await this.selectSession(next);
      else this.deselectSession({ forgetRememberedSelection: true });
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId && this.getState().selectedWorkspace?.id === workspace.id) this.setState({ error: String(error) });
    }
  }

  async deleteCachedNewSession(session = this.getState().selectedSession) {
    if (session === undefined || !isTransientNewSessionInfo(session, this.statusForSession(session))) return;
    const pendingStart = isClientPendingStartSessionInfo(session) ? this.pendingSessionStarts.get(session.id) : undefined;
    if (pendingStart !== undefined) {
      pendingStart.discarded = true;
      pendingStart.queuedSends = [];
    }
    else {
      void this.api.stop(session, selectedMachineId(this.getState())).catch(() => {
        // Best-effort cleanup for transient sessions that may not exist server-side anymore.
      });
    }
    forgetCachedNewSession(session.id, selectedMachineId(this.getState()));
    clearDraft(this.sessionCacheKey(session.id));
    clearStagedAttachments(this.sessionCacheKey(session.id));
    const state = this.getState();
    const sessions = state.sessions.filter((candidate) => candidate.id !== session.id);
    this.setState({
      sessions,
      sessionStatuses: omitKey(state.sessionStatuses, session.id),
      sessionActivities: omitSessionActivity(state.sessionActivities, session.id),
      sendingPrompts: omitKey(state.sendingPrompts, session.id),
      clientQueuedSessionMessages: omitKey(state.clientQueuedSessionMessages, session.id),
    });
    if (this.getState().selectedSession?.id !== session.id) return;
    const next = sessions.find((candidate) => candidate.archived !== true) ?? sessions[0];
    if (next !== undefined) await this.selectSession(next);
    else {
      this.clearActiveSession();
      this.updateUrl();
    }
  }

  async restoreSession(session = this.getState().selectedSession) {
    if (!session) return;
    try {
      await this.api.restore(session, selectedMachineId(this.getState()));
      const restored = { ...session };
      delete restored.archived;
      delete restored.archivedAt;
      this.replaceSession(restored);
      if (this.getState().selectedSession?.id === restored.id) await this.selectSession(restored);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async reloadSession(session = this.getState().selectedSession) {
    if (session === undefined || !isArchivableSessionInfo(session, this.statusForSession(session))) return;
    const machineId = selectedMachineId(this.getState());
    try {
      await this.api.reloadSession(session, machineId);
      this.transcripts.discard(this.sessionCacheKey(session.id));
      if (this.getState().selectedSession?.id === session.id) {
        await this.selectSession(session, { updateUrl: false });
      }
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async detachParent(session = this.getState().selectedSession) {
    if (session?.parentSessionPath === undefined) return;
    try {
      await this.api.detachParent(session, selectedMachineId(this.getState()));
      const detached = { ...session };
      delete detached.parentSessionPath;
      this.replaceSession(detached);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async listModels() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return [];
    try {
      return (await this.api.models(session, selectedMachineId(this.getState()))).models;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  async listModelCatalog() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return [];
    try {
      return (await this.api.modelCatalog(session, selectedMachineId(this.getState()))).models;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  /**
   * Toggle one model's membership in pi's enabled-models scope. Returns the
   * updated catalog on success and `undefined` on failure, so the caller can
   * leave (or revert) the row's control when the edit did not apply.
   */
  async setModelEnabled(provider: string, modelId: string, enabled: boolean): Promise<SessionModelCatalogEntry[] | undefined> {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return undefined;
    try {
      return (await this.api.setModelEnabled(session, provider, modelId, enabled, selectedMachineId(this.getState()))).models;
    } catch (error) {
      this.setState({ error: String(error) });
      return undefined;
    }
  }

  /** Atomically switch between an unrestricted catalog and the current model alone. */
  async setModelScope(mode: SessionModelScopeMode): Promise<SessionModelCatalogEntry[] | undefined> {
    const state = this.getState();
    const session = state.selectedSession;
    if (!session || session.archived === true) return undefined;
    try {
      return (await this.api.setModelScope(session, mode, selectedMachineId(state))).models;
    } catch (error) {
      this.setState({ error: String(error) });
      return undefined;
    }
  }

  async setModel(provider: string, modelId: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.setModel(session, provider, modelId, selectedMachineId(this.getState())));
      await this.refreshAvailableThinkingLevels();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async cycleModel(direction: "forward" | "backward") {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.cycleModel(session, direction, selectedMachineId(this.getState())));
      await this.refreshAvailableThinkingLevels();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async listThinkingLevels() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return [];
    try {
      return (await this.api.thinkingLevels(session, selectedMachineId(this.getState()))).levels;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  /** Refresh the available thinking levels for the selected session's model. */
  async refreshAvailableThinkingLevels() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) {
      if (this.getState().availableThinkingLevels.length > 0) this.setState({ availableThinkingLevels: [] });
      return;
    }
    const levels = await this.listThinkingLevels();
    if (this.getState().selectedSession?.id !== session.id) return;
    this.setState({ availableThinkingLevels: levels });
  }

  async setThinkingLevel(level: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.setThinkingLevel(session, level, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async cycleThinkingLevel() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.cycleThinkingLevel(session, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async clearServerQueue() {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || session.archived === true || isClientPendingStartSessionInfo(session)) return;
    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    try {
      const status = await this.api.clearQueue(session, machineId);
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.applyStatus(status);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
    }
  }

  async dismissWarning(dismissId: string) {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || isClientPendingStartSessionInfo(session)) return;
    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    try {
      const status = await this.api.dismissWarning(session, dismissId, machineId);
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.applyStatus(status);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
    }
  }

  /** Send the answers the user entered for the session's open ask. */
  submitAsk(askId: string, submission: AskUserSubmission): Promise<void> {
    return this.closeOpenAsk(askId, (session, machineId) => this.api.submitAsk(session, askId, submission, machineId));
  }

  /** Close the session's open ask without answering it. */
  cancelAsk(askId: string): Promise<void> {
    return this.closeOpenAsk(askId, (session, machineId) => this.api.cancelAsk(session, askId, machineId));
  }

  /** Send the value the user gave for one of the session's open extension dialogs. */
  answerDialog(dialogId: string, value: ExtensionDialogAnswer): Promise<void> {
    return this.closeOpenDialog(dialogId, (session, machineId) => this.api.answerDialog(session, dialogId, value, machineId));
  }

  /** Close one of the session's open extension dialogs without answering it. */
  cancelDialog(dialogId: string): Promise<void> {
    return this.closeOpenDialog(dialogId, (session, machineId) => this.api.cancelDialog(session, dialogId, machineId));
  }

  private async closeOpenDialog(dialogId: string, close: (session: SessionInfo, machineId: string) => Promise<ExtensionDialogCloseResponse>): Promise<void> {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || session.archived === true) return;
    if (isClientPendingStartSessionInfo(session)) {
      await this.closePendingStartDialog(session, dialogId, close);
      return;
    }
    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    try {
      const response = await close(session, machineId);
      if (!this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) return;
      // When this call closed the dialog, its outcome is recorded right away so
      // the card shows what the user gave; the daemon's dialog.closed event
      // then finds the dialog already closed here and stays a no-op.
      const outcome: ExtensionDialogOutcome | undefined = response.outcome;
      if (outcome !== undefined) {
        const dialog = this.getState().pendingDialogs.find((pending) => pending.dialogId === outcome.dialogId);
        if (dialog !== undefined) this.recordClosedDialog({ dialog, reason: outcome.reason, ...(outcome.answer === undefined ? {} : { answer: outcome.answer }) });
      }
      // Both outcomes carry the recomputed status, so no follow-up status
      // request is needed to learn what the session's open dialogs are now.
      this.applyStatus(response.sessionStatus);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
    }
  }

  /**
   * Answer or cancel a `session_start` dialog from the startup view. The row
   * is still the pending start, but the dialog belongs to the constructing
   * backend session the startup events named, so the close goes out under the
   * real id — the only route the daemon can serve before readiness.
   */
  private async closePendingStartDialog(session: ClientPendingStartSessionInfo, dialogId: string, close: (session: SessionInfo, machineId: string) => Promise<ExtensionDialogCloseResponse>): Promise<void> {
    const pending = this.pendingSessionStarts.get(session.id);
    const backendSessionId = pending?.backendSessionId;
    // Without the real id there is no route to answer through — and no way a
    // dialog card could be on screen yet either.
    if (pending === undefined || backendSessionId === undefined) return;
    const selectionSeq = this.selectionSeq;
    try {
      const response = await close({ ...session, id: backendSessionId }, pending.machineId);
      if (selectionSeq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
      // Same outcome-first ordering as the ready-session path: the card shows
      // what the user gave, and the daemon's dialog.closed frame then finds
      // the dialog already closed here and stays a no-op.
      const outcome: ExtensionDialogOutcome | undefined = response.outcome;
      if (outcome !== undefined) {
        const dialog = this.getState().pendingDialogs.find((candidate) => candidate.dialogId === outcome.dialogId);
        if (dialog !== undefined) this.recordClosedDialog({ dialog, reason: outcome.reason, ...(outcome.answer === undefined ? {} : { answer: outcome.answer }) });
      }
      this.applyPendingStartStatus(pending, response.sessionStatus);
    } catch (error) {
      if (selectionSeq === this.selectionSeq && this.getState().selectedSession?.id === session.id) this.setState({ error: String(error) });
    }
  }

  private async closeOpenAsk(askId: string, close: (session: SessionInfo, machineId: string) => Promise<AskUserCloseResponse>): Promise<void> {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || session.archived === true || isClientPendingStartSessionInfo(session)) return;
    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    try {
      const response = await close(session, machineId);
      // The ask is gone either way: this call closed it, or it was already
      // closed elsewhere. Its draft has nothing left to protect, and the answers
      // now live in the daemon-owned outcome.
      clearAskDraft(machineSessionKey(machineId, session.id), askId);
      // Both outcomes carry the recomputed status, so no follow-up status
      // request is needed to learn what the session's open ask is now.
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.applyStatus(response.sessionStatus);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
    }
  }

  async stopActiveWork() {
    const session = this.getState().selectedSession;
    if (!session) return;
    try {
      await this.api.abort(session, selectedMachineId(this.getState()));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  /**
   * Refresh the selected session's transcript, status, and in-flight partial.
   * `options.silent` marks a best-effort background trigger (the poll timer):
   * a failure is logged instead of churning the global error state every tick.
   * User- and selection-triggered refreshes keep reporting errors.
   */
  refreshSelectedSession(sessionId = this.getState().selectedSession?.id, options?: { silent?: boolean }): Promise<void> {
    const session = this.getState().selectedSession;
    if (sessionId === undefined || session?.id !== sessionId || session.archived === true || isClientPendingStartSessionInfo(session)) return Promise.resolve();
    const target: SelectedSessionRefreshTarget = {
      session,
      machineId: selectedMachineId(this.getState()),
      selectionSeq: this.selectionSeq,
    };
    return this.requestSelectedSessionRefresh(target).catch((error: unknown) => {
      if (options?.silent === true) {
        console.warn("Selected session background refresh failed", error);
        return;
      }
      if (this.isCurrentRefreshTarget(target)) this.setState({ error: String(error) });
    });
  }

  private requestSelectedSessionRefresh(target: SelectedSessionRefreshTarget): Promise<void> {
    const key = machineSessionKey(target.machineId, target.session.id);
    return this.selectedSessionRefreshes.request(key, async () => {
      if (!this.isCurrentRefreshTarget(target)) return;
      this.flushPendingUpdates();
      const [page, status, streamSnapshot] = await Promise.all([
        this.api.messages(target.session, { limit: MESSAGE_PAGE_SIZE }, target.machineId),
        this.api.status(target.session, target.machineId),
        this.api.streamSnapshot(target.session, target.machineId),
        this.notifications?.refreshSelectedSession(target.session, target.machineId) ?? Promise.resolve(),
      ]);
      if (!this.isCurrentRefreshTarget(target)) return;
      if (this.isUnchangedSelectedRefresh(target, key, page, status, streamSnapshot)) return;
      // Seed the in-flight partial assistant message on top of committed history
      // and record the snapshot's sequence as the watermark. Buffered/live events
      // with `seq <= watermark` are already reflected here and are dropped by
      // `applyEvent`; later events (`seq > watermark`) stream in on top. The
      // partial is seeded into the in-memory transcript only, never the raw
      // history cache, so it never persists.
      const history = this.transcripts.mergeHistory(key, page);
      const messages = this.transcripts.seedStreamingPartial(history.messages, streamSnapshot.partial);
      this.streamWatermark = { sessionId: target.session.id, seq: streamSnapshot.seq };
      this.setState({
        ...history,
        messages,
        status,
        activity: this.getState().sessionActivities[target.session.id],
      });
      this.applyStatus(status);
      this.lastAppliedSelectedRefresh = { selectionSeq: target.selectionSeq, partialJson: selectedRefreshPartialJson(streamSnapshot) };
    });
  }

  /**
   * A selected-session refresh is redundant when everything it would apply is
   * already held: the page is exactly the cached history tail, the status
   * matches the applied status, and the in-flight partial is unchanged since
   * the last applied refresh of this selection. The stream watermark is
   * deliberately not advanced on a skip: the gate says nothing about frames
   * outside page/status/partial (e.g. activity), so those events must remain
   * applicable, never droppable as "already reflected".
   */
  private isUnchangedSelectedRefresh(target: SelectedSessionRefreshTarget, key: string, page: MessagePage, status: SessionStatus, streamSnapshot: SessionStreamSnapshot): boolean {
    const last = this.lastAppliedSelectedRefresh;
    if (last?.selectionSeq !== target.selectionSeq) return false;
    if (selectedRefreshPartialJson(streamSnapshot) !== last.partialJson) return false;
    if (!isHistoryTailSlice(this.transcripts.rawHistoryPage(key), page)) return false;
    if (JSON.stringify(status) !== JSON.stringify(this.getState().status)) return false;
    // applyStatus has one effect even for identical input: it clears a stale
    // active activity. A tick that would clear is not redundant.
    return this.getState().sessionActivities[status.sessionId]?.phase !== "active" || isSessionActive(status);
  }

  private isCurrentRefreshTarget(target: SelectedSessionRefreshTarget): boolean {
    return this.isCurrentSessionSelection(target.session.id, target.machineId, target.selectionSeq);
  }

  private isCurrentSessionSelection(sessionId: string, machineId: string, selectionSeq: number): boolean {
    return selectionSeq === this.selectionSeq && this.isSelectedSessionIdentity(sessionId, machineId);
  }

  private isSelectedSessionIdentity(sessionId: string, machineId: string): boolean {
    if (this.disposed) return false;
    const state = this.getState();
    const selected = state.selectedSession;
    return selectedMachineId(state) === machineId
      && selected?.id === sessionId
      && selected.archived !== true
      && !isClientPendingStartSessionInfo(selected);
  }

  private applyBulkSessionFailures(action: string, failures: readonly string[]): void {
    if (failures.length === 0) return;
    this.setState({ error: `${action} failed for ${String(failures.length)} session${failures.length === 1 ? "" : "s"}: ${failures.join("; ")}` });
  }

  private sessionCacheKey(sessionId: string): string {
    return machineSessionKey(selectedMachineId(this.getState()), sessionId);
  }

  private statusForSession(session: SessionInfo | undefined): SessionStatus | undefined {
    if (session === undefined) return undefined;
    const state = this.getState();
    if (state.status?.sessionId === session.id && state.selectedSession?.id === session.id) return state.status;
    return state.sessionStatuses[session.id];
  }

  private workspaceSelectionKey(cwd: string): string {
    return `${selectedMachineId(this.getState())}:${cwd}`;
  }

  private replaceSession(session: SessionInfo) {
    const current = this.getState().selectedSession;
    this.setState({
      sessions: this.getState().sessions.map((candidate) => candidate.id === session.id ? session : candidate),
      selectedSession: current?.id === session.id ? session : current,
    });
  }

  private createPendingSessionStart(workspace: Workspace, machineId: string): PendingSessionStart {
    const tempId = `pending-session-${String(++this.pendingSessionStartSeq)}-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const session: ClientPendingStartSessionInfo = {
      id: tempId,
      path: `pi-web://pending-session/${tempId}`,
      cwd: workspace.path,
      persisted: false,
      name: "New session",
      created: now,
      modified: now,
      messageCount: 0,
      firstMessage: "",
      clientPendingStart: true,
      machineId,
    };
    return { tempId, workspaceId: workspace.id, cwd: workspace.path, machineId, session, queuedSends: [], discarded: false };
  }

  private insertAndSelectPendingSession(session: ClientPendingStartSessionInfo): void {
    const state = this.getState();
    this.selectClientPendingStartSession(session, {
      activity: creatingPendingSessionActivity(session.id),
      sessions: [session, ...state.sessions.filter((candidate) => candidate.id !== session.id)],
    });
  }

  private selectClientPendingStartSession(session: ClientPendingStartSessionInfo, options?: { updateUrl?: boolean | undefined; activity?: SessionActivity | undefined; sessions?: SessionInfo[] | undefined }): void {
    this.sessionSelection.rememberSession({ ...session, cwd: this.workspaceSelectionKey(session.cwd) });
    this.selectionSeq += 1;
    this.socket.close();
    this.notifications?.clearSelectedSession();
    this.streamWatermark = undefined;
    this.clearPendingUpdates();
    const state = this.getState();
    const pendingStart = this.pendingSessionStarts.get(session.id);
    const activity = options?.activity ?? state.sessionActivities[session.id] ?? (pendingStart !== undefined ? creatingPendingSessionActivity(session.id, pendingStart.queuedSends.length) : undefined);
    this.setState({
      ...(options?.sessions === undefined ? {} : { sessions: options.sessions }),
      selectedSession: session,
      messages: [],
      messagePageStart: 0,
      messagePageEnd: 0,
      messagePageTotal: 0,
      isLoadingEarlierMessages: false,
      status: undefined,
      activity,
      pendingAsk: undefined,
      pendingDialogs: [],
      closedDialogs: [],
      availableThinkingLevels: [],
      treeDialog: undefined,
      ...(activity === undefined ? {} : { sessionActivities: { ...state.sessionActivities, [session.id]: activity } }),
      error: "",
    });
    // Re-selecting the row mid-startup re-establishes the constructing
    // session's subscription; the close above dropped it with the old selection.
    if (pendingStart?.backendSessionId !== undefined) this.connectPendingStartSocket(pendingStart);
    if (options?.updateUrl !== false) this.updateUrl();
  }

  private async resolvePendingSessionStart(tempId: string, session: SessionInfo): Promise<void> {
    const pending = this.pendingSessionStarts.get(tempId);
    if (pending === undefined) return;
    this.pendingSessionStarts.delete(tempId);
    const queuedSends = pending.queuedSends.splice(0);
    const releasedCreatedSessions = this.takeSuppressedCreatedSessionsFor(pending.cwd, pending.machineId, session.id);
    if (pending.discarded) {
      clearDraft(machineSessionKey(pending.machineId, tempId));
      clearStagedAttachments(machineSessionKey(pending.machineId, tempId));
      this.setState({ clientQueuedSessionMessages: omitKey(this.getState().clientQueuedSessionMessages, tempId) });
      this.applyReleasedCreatedSessions(releasedCreatedSessions, pending.machineId);
      void this.api.stop(session, pending.machineId).catch(() => {
        // Best-effort cleanup for a backend session whose temporary UI row was discarded before creation finished.
      });
      return;
    }

    rememberCachedNewSession(session, pending.machineId);
    moveDraft(machineSessionKey(pending.machineId, tempId), machineSessionKey(pending.machineId, session.id));
    moveStagedAttachments(machineSessionKey(pending.machineId, tempId), machineSessionKey(pending.machineId, session.id));
    const cachedSession = markCachedNewSessionInfo(session, pending.machineId);
    if (!this.isCurrentPendingStart(pending)) {
      this.setState({ clientQueuedSessionMessages: omitKey(this.getState().clientQueuedSessionMessages, tempId) });
      await this.flushQueuedPendingSends(cachedSession, pending.machineId, queuedSends);
      return;
    }

    const state = this.getState();
    const wasSelected = state.selectedSession?.id === tempId;
    this.setState({
      sessions: replacePendingSessionInList(state.sessions, tempId, cachedSession),
      sessionActivities: omitSessionActivity(state.sessionActivities, tempId),
      sendingPrompts: moveRecordKey(state.sendingPrompts, tempId, cachedSession.id),
      clientQueuedSessionMessages: moveRecordKey(state.clientQueuedSessionMessages, tempId, cachedSession.id),
      ...(wasSelected ? { selectedSession: cachedSession, status: state.sessionStatuses[cachedSession.id], activity: state.sessionActivities[cachedSession.id], pendingAsk: state.sessionStatuses[cachedSession.id]?.pendingAsk, pendingDialogs: state.sessionStatuses[cachedSession.id]?.pendingDialogs ?? [], closedDialogs: [] } : {}),
      error: "",
    });
    this.applyReleasedCreatedSessions(releasedCreatedSessions, pending.machineId);
    if (wasSelected) {
      this.updateUrl({ replace: true });
      await this.selectSession(cachedSession, { updateUrl: false });
    }
    await this.flushQueuedPendingSends(cachedSession, pending.machineId, queuedSends);
  }

  private failPendingSessionStart(tempId: string, error: unknown): void {
    const pending = this.pendingSessionStarts.get(tempId);
    if (pending === undefined) return;
    this.pendingSessionStarts.delete(tempId);
    const wasDiscarded = pending.discarded;
    // The pending start is dead: stop routing its dialog frames (a card on the
    // failed row could never be answered) and drop the early-subscribed socket
    // so it stops reconnecting against a session that may not exist.
    pending.discarded = true;
    if (this.getState().selectedSession?.id === tempId) this.socket.close();
    const releasedCreatedSessions = this.takeSuppressedCreatedSessionsFor(pending.cwd, pending.machineId);
    const isCurrentPendingStart = this.isCurrentPendingStart(pending);
    if (wasDiscarded || !isCurrentPendingStart) {
      if (isCurrentPendingStart) this.applyReleasedCreatedSessions(releasedCreatedSessions, pending.machineId);
      return;
    }
    const state = this.getState();
    const message = errorMessage(error);
    const activity = failedPendingSessionActivity(tempId, message, pending.queuedSends.length);
    const hasPendingRow = state.sessions.some((session) => session.id === tempId);
    this.setState({
      sessions: hasPendingRow ? state.sessions : [pending.session, ...state.sessions],
      sessionActivities: { ...state.sessionActivities, [tempId]: activity },
      activity: state.selectedSession?.id === tempId ? activity : state.activity,
      // Open cards on the failed row are dead: the create is gone, so no
      // answer could ever reach the daemon. Settled outcomes stay as history.
      ...(state.selectedSession?.id === tempId ? { pendingDialogs: [] } : {}),
      error: `Failed to start session: ${message}`,
    });
    this.applyReleasedCreatedSessions(releasedCreatedSessions, pending.machineId);
  }

  private isCurrentPendingStart(pending: PendingSessionStart): boolean {
    const state = this.getState();
    return selectedMachineId(state) === pending.machineId && state.selectedWorkspace?.id === pending.workspaceId;
  }

  private hasPendingStartFor(cwd: string, machineId: string): boolean {
    return Array.from(this.pendingSessionStarts.values()).some((pending) => pending.cwd === cwd && pending.machineId === machineId);
  }

  private isSuppressedCreatedSession(session: SessionInfo, machineId: string): boolean {
    const suppressed = this.suppressedCreatedSessions.get(session.id);
    return suppressed?.session.cwd === session.cwd && suppressed.machineId === machineId;
  }

  private takeSuppressedCreatedSessionsFor(cwd: string, machineId: string, resolvedSessionId?: string): SessionInfo[] {
    if (resolvedSessionId !== undefined) this.suppressedCreatedSessions.delete(resolvedSessionId);
    if (this.hasPendingStartFor(cwd, machineId)) return [];
    const released: SessionInfo[] = [];
    for (const [sessionId, suppressed] of this.suppressedCreatedSessions) {
      if (suppressed.session.cwd !== cwd || suppressed.machineId !== machineId) continue;
      this.suppressedCreatedSessions.delete(sessionId);
      released.push(suppressed.session);
    }
    return released;
  }

  private applyReleasedCreatedSessions(sessions: readonly SessionInfo[], machineId: string): void {
    if (sessions.length === 0 || selectedMachineId(this.getState()) !== machineId) return;
    const state = this.getState();
    if (state.selectedWorkspace === undefined) return;
    const existingIds = new Set(state.sessions.map((session) => session.id));
    const released = sessions.filter((session) => session.cwd === state.selectedWorkspace?.path && !existingIds.has(session.id));
    if (released.length === 0) return;
    this.setState({ sessions: [...released.reverse(), ...state.sessions] });
  }

  private mergePendingStartSessions(cwd: string, sessions: SessionInfo[], machineId: string): SessionInfo[] {
    const pending = this.getState().sessions.filter((session): session is ClientPendingStartSessionInfo => isClientPendingStartSessionInfo(session) && session.cwd === cwd && session.machineId === machineId);
    if (pending.length === 0) return sessions;
    const pendingIds = new Set(pending.map((session) => session.id));
    return [...pending, ...sessions.filter((session) => !pendingIds.has(session.id))];
  }

  private async recreateCachedNewSession(session: SessionInfo, options?: { updateUrl?: boolean | undefined }): Promise<void> {
    try {
      const machineId = selectedMachineId(this.getState());
      const replacement = await this.api.startSession(session.cwd, machineId);
      rememberCachedNewSession(replacement, machineId);
      moveDraft(this.sessionCacheKey(session.id), this.sessionCacheKey(replacement.id));
      moveStagedAttachments(this.sessionCacheKey(session.id), this.sessionCacheKey(replacement.id));
      forgetCachedNewSession(session.id, machineId);
      const cachedReplacement = markCachedNewSessionInfo(replacement, machineId);
      this.setState({ sessions: [cachedReplacement, ...this.getState().sessions.filter((candidate) => candidate.id !== session.id)], error: "" });
      await this.selectSession(cachedReplacement, { updateUrl: false });
      this.updateUrl(options?.updateUrl === false ? { replace: true } : undefined);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private markCachedNewSessionPersisted(session: SessionInfo): void {
    if (!isCachedNewSessionInfo(session)) return;
    const latest = this.getState().sessions.find((candidate) => candidate.id === session.id) ?? session;
    this.replaceSession(stripCachedNewSessionMarker(latest));
  }

  private applyCommandResult(result: CommandResult) {
    if (result.type === "select") {
      this.setState({ commandDialog: result });
      return;
    }
    if (result.type === "tree") {
      this.setState({ treeDialog: result.tree });
      return;
    }
    const message = result.type === "unsupported" ? result.message : result.message;
    if (message !== undefined && message !== "") this.setState({ messages: [...this.getState().messages, textMessage(result.type === "unsupported" ? "system" : "tool", message)] });
    if (result.type === "done" && result.session) {
      if (result.promptDraft !== undefined) saveDraft(this.sessionCacheKey(result.session.id), result.promptDraft);
      const current = this.getState().selectedSession;
      const sessions = [result.session, ...this.getState().sessions.filter((session) => session.id !== result.session?.id)];
      this.setState({ sessions, selectedSession: current?.id === result.session.id ? result.session : current });
      if (current?.id !== result.session.id) void this.selectSession(result.session);
    }
  }

  private applyCreatedSession(session: SessionInfo) {
    const state = this.getState();
    // Session trees are worktree-scoped, so a session created elsewhere has no
    // bearing on this listing.
    if (state.selectedWorkspace?.path !== session.cwd) return;
    if (state.sessions.some((candidate) => candidate.id === session.id)) return;
    const machineId = selectedMachineId(state);
    if (this.hasPendingStartFor(session.cwd, machineId)) {
      this.suppressedCreatedSessions.set(session.id, { session, machineId });
      return;
    }
    this.setState({ sessions: [session, ...state.sessions] });
  }

  private applyActivity(activity: SessionActivity) {
    this.setState({
      sessionActivities: { ...this.getState().sessionActivities, [activity.sessionId]: activity },
      activity: this.getState().selectedSession?.id === activity.sessionId ? activity : this.getState().activity,
    });
  }

  private applyStatus(status: SessionStatus) {
    const state = this.getState();
    const isSelected = state.selectedSession?.id === status.sessionId;
    const clearsStaleActivity = state.sessionActivities[status.sessionId]?.phase === "active" && !isSessionActive(status);
    this.setState({
      sessionStatuses: { ...state.sessionStatuses, [status.sessionId]: status },
      ...sessionMessageCountPatch(state, status.sessionId, status.messageCount),
      ...(clearsStaleActivity ? { sessionActivities: omitSessionActivity(state.sessionActivities, status.sessionId) } : {}),
      status: isSelected ? status : state.status,
      activity: isSelected && clearsStaleActivity ? undefined : state.activity,
      // The daemon owns whether an ask is open, so every status it publishes is
      // authoritative for the selected session's card, including its removal.
      ...(isSelected ? { pendingAsk: status.pendingAsk } : {}),
      // Same for extension dialogs: the status projection is authoritative for
      // the open list. Closed-card outcomes are event/response-driven instead,
      // so a status without the dialog simply drops it from the open list.
      ...(isSelected ? { pendingDialogs: status.pendingDialogs ?? [] } : {}),
    });
  }

  private applyOpenedDialog(dialog: PendingExtensionDialog): void {
    const state = this.getState();
    if (state.selectedSession === undefined) return;
    // Events apply exactly once, so an id already on screen means this frame
    // was already reflected (e.g. a rehydrated open) and must not duplicate
    // the card.
    if (state.pendingDialogs.some((pending) => pending.dialogId === dialog.dialogId)) return;
    this.setState({ pendingDialogs: [...state.pendingDialogs, dialog] });
  }

  private applyClosedDialog(dialogId: string, reason: ExtensionDialogCloseReason, answer: ExtensionDialogAnswer | undefined): void {
    // A close for a dialog that is not on screen is already reflected here
    // (e.g. the answering browser's own response landed first), so it must not
    // clear or duplicate other cards.
    const dialog = this.getState().pendingDialogs.find((pending) => pending.dialogId === dialogId);
    if (dialog === undefined) return;
    this.recordClosedDialog({ dialog, reason, ...(answer === undefined ? {} : { answer }) });
  }

  private recordClosedDialog(closed: ClosedExtensionDialog): void {
    const state = this.getState();
    if (state.closedDialogs.some((entry) => entry.dialog.dialogId === closed.dialog.dialogId)) return;
    this.setState({
      pendingDialogs: state.pendingDialogs.filter((pending) => pending.dialogId !== closed.dialog.dialogId),
      closedDialogs: [...state.closedDialogs, closed],
    });
  }

  /** Drop a closed dialog's transient outcome card (e.g. the user dismissed it). */
  dismissClosedDialog(dialogId: string): void {
    const state = this.getState();
    if (!state.closedDialogs.some((entry) => entry.dialog.dialogId === dialogId)) return;
    this.setState({ closedDialogs: state.closedDialogs.filter((entry) => entry.dialog.dialogId !== dialogId) });
  }

  private applyOpenedAsk(ask: PendingAskUser): void {
    const state = this.getState();
    if (state.selectedSession === undefined) return;
    // A superseded ask keeps its draft: the read-only record of an ask the user
    // never submitted must still be able to show what they had typed.
    this.setState({ pendingAsk: ask });
  }

  private applyClosedAsk(askId: string): void {
    // A close for an ask that is not the one on screen is already reflected here
    // (typically the supersede half of an open), so it must not clear the card.
    if (this.getState().pendingAsk?.askId !== askId) return;
    this.setState({ pendingAsk: undefined });
  }

  private applySessionName(sessionId: string, name: string | undefined) {
    const rename = (session: SessionInfo) => {
      if (session.id !== sessionId) return session;
      const next = { ...session };
      if (name === undefined || name === "") delete next.name;
      else next.name = name;
      return next;
    };
    const selectedSession = this.getState().selectedSession;
    this.setState({
      sessions: this.getState().sessions.map(rename),
      selectedSession: selectedSession === undefined ? undefined : rename(selectedSession),
    });
  }

  private applyEvent(event: SessionUiEvent) {
    // Notification revisions use their own join snapshot. Handle them before the
    // transcript watermark so a notification event sharing an already-seeded
    // transcript sequence cannot be lost.
    if (event.type === "notifications.inbox") {
      this.notifications?.applyInboxEvent(selectedMachineId(this.getState()), event);
      return;
    }
    // Drop events already reflected in the seeded join snapshot (committed
    // history + partial). Everything past the watermark applies exactly once,
    // so live content streams directly on top of the seeded partial.
    if (this.isStreamEventBelowWatermark(event)) return;

    // Status and activity arrive once per token (the server republishes them on
    // every transcript event). Buffer them alongside high-frequency transcript
    // deltas so the host component renders at most once per animation frame
    // instead of once per token. Coalescing these here is what keeps the prompt
    // editor's DOM stable during streaming, so in-progress touch gestures (e.g.
    // the iOS long-press edit/paste callout) are not interrupted by a re-render.
    if (event.type === "status.update") {
      this.queueStatusUpdate(event.status);
      return;
    }
    if (event.type === "activity.update") {
      this.queueActivityUpdate(event.activity);
      return;
    }
    if (isHighFrequencyTranscriptEvent(event)) {
      this.queueTranscriptEvent(event);
      return;
    }

    this.flushPendingUpdates();
    // Ask frames are applied after the buffered status they were published with,
    // so the card follows the daemon's own open/close order.
    if (event.type === "ask.opened") {
      this.applyOpenedAsk(event.ask);
      return;
    }
    if (event.type === "ask.closed") {
      this.applyClosedAsk(event.askId);
      return;
    }
    if (event.type === "dialog.opened") {
      this.applyOpenedDialog(event.dialog);
      return;
    }
    if (event.type === "dialog.closed") {
      this.applyClosedDialog(event.dialogId, event.reason, event.answer);
      return;
    }
    const transcript = this.transcripts.applyLiveEvent(this.getState().messages, event);
    if (transcript) {
      this.setState({ messages: transcript });
    } else if (event.type === "session.name") {
      this.applySessionName(event.sessionId, event.name);
    }
  }

  private queueTranscriptEvent(event: SessionUiEvent): void {
    this.pendingTranscriptEvents.push(event);
    this.schedulePendingFlush();
  }

  private queueStatusUpdate(status: SessionStatus): void {
    this.pendingStatusBySession.set(status.sessionId, status);
    this.schedulePendingFlush();
  }

  private queueActivityUpdate(activity: SessionActivity): void {
    this.pendingActivityBySession.set(activity.sessionId, activity);
    this.schedulePendingFlush();
  }

  // Session startup progress arrives while the daemon is still constructing the
  // session, so the target row is resolved by exact identity only: a session id
  // the browser already knows (an open), else the correlation token this browser
  // minted for its own create and the daemon echoed back. Matching neither means
  // the row is not one this browser shows — an agent's or another tab's session is
  // *deliberately* absent while a create is pending — so it is ignored rather than
  // guessed at. A resolved row goes through the normal activity buffer, rendering
  // like any other activity and staying batched per frame.
  private queueStartupProgress(event: SessionStartupProgressEvent): void {
    if (this.getState().sessions.some((session) => session.id === event.activity.sessionId)) {
      this.queueActivityUpdate(event.activity);
      return;
    }
    const pending = event.startupToken === undefined ? undefined : this.pendingSessionStarts.get(event.startupToken);
    if (pending === undefined || pending.discarded) return;
    this.learnPendingStartBackendSession(pending, event.activity.sessionId);
    // An idle startup phase means the daemon has nothing left to attribute, so
    // restore this row's own generic wording rather than clearing the text of a
    // creation request that has not returned yet.
    this.queueActivityUpdate(event.activity.phase === "idle"
      ? creatingPendingSessionActivity(pending.tempId, pending.queuedSends.length)
      : pendingStartActivity(event.activity, pending.tempId));
  }

  private learnPendingStartBackendSession(pending: PendingSessionStart, sessionId: string): void {
    if (sessionId === "" || pending.backendSessionId !== undefined) return;
    pending.backendSessionId = sessionId;
    if (this.getState().selectedSession?.id === pending.tempId) this.connectPendingStartSocket(pending);
  }

  /**
   * Subscribe the selected pending-start row to its constructing session.
   * `session_start` dialogs park the create request until answered, so waiting
   * for readiness to subscribe would make them unanswerable; the per-session
   * event channel and (on this daemon version) the status route both serve a
   * session whose startup is still waiting on the user.
   */
  private connectPendingStartSocket(pending: PendingSessionStart): void {
    const backendSessionId = pending.backendSessionId;
    if (backendSessionId === undefined || pending.discarded) return;
    const ref: SessionRef = { id: backendSessionId, cwd: pending.cwd };
    this.socket.connect(
      ref,
      (event) => { this.applyPendingStartEvent(pending, event); },
      () => { this.resyncPendingStartDialogs(pending); },
      pending.machineId,
    );
    this.resyncPendingStartDialogs(pending);
  }

  /**
   * Recover dialogs that opened before this subscription connected (or during
   * a reconnect gap) from the daemon's status projection. The HTTP snapshot is
   * unordered against socket frames — dialogs the socket already opened or
   * closed are newer than anything it can say about them — so only genuinely
   * unknown opens are adopted, never a wholesale replace. A daemon that
   * predates mid-startup status answers 404 until readiness: tolerated, since
   * everything that opens from here still arrives as an event.
   */
  private resyncPendingStartDialogs(pending: PendingSessionStart): void {
    const backendSessionId = pending.backendSessionId;
    if (backendSessionId === undefined) return;
    void this.api.status({ id: backendSessionId, cwd: pending.cwd }, pending.machineId).then(
      (status) => {
        // Guard before applying: this unordered snapshot can land after the
        // readiness swap made the real session selected, and a stale replace
        // must not clobber the socket's fresher dialog state.
        if (pending.discarded || this.getState().selectedSession?.id !== pending.tempId) return;
        this.applyStatus(status);
        const state = this.getState();
        const knownIds = new Set<string>([
          ...state.pendingDialogs.map((pendingDialog) => pendingDialog.dialogId),
          ...state.closedDialogs.map((closed) => closed.dialog.dialogId),
        ]);
        const recovered = (status.pendingDialogs ?? []).filter((recoveredDialog) => !knownIds.has(recoveredDialog.dialogId));
        if (recovered.length > 0) this.setState({ pendingDialogs: [...state.pendingDialogs, ...recovered] });
      },
      () => undefined,
    );
  }

  /**
   * Route a constructing session's events onto its pending-start row. Only
   * dialog frames and their status reconciliation apply here: everything else
   * (transcript, activity, naming) is re-fetched authoritatively by the
   * readiness join, and routing it onto a temporary row would pollute state
   * keyed for a session that does not exist yet. Frames that arrive after the
   * row stopped being the selected pending start belong to the selection flow
   * that took over.
   */
  private applyPendingStartEvent(pending: PendingSessionStart, event: SessionUiEvent): void {
    if (pending.discarded || this.getState().selectedSession?.id !== pending.tempId) return;
    if (event.type === "dialog.opened") {
      this.applyOpenedDialog(event.dialog);
      return;
    }
    if (event.type === "dialog.closed") {
      this.applyClosedDialog(event.dialogId, event.reason, event.answer);
      return;
    }
    if (event.type === "status.update") this.applyPendingStartStatus(pending, event.status);
  }

  /**
   * Apply a constructing session's status from an ordered channel (the
   * socket's own status frame, or a dialog close response): the daemon's
   * projection is authoritative there, so the open list is replaced wholesale,
   * exactly as applyStatus does for a ready session. The per-session map stays
   * truthful too — the readiness swap seeds the selected status from it.
   */
  private applyPendingStartStatus(pending: PendingSessionStart, status: SessionStatus): void {
    this.applyStatus(status);
    if (pending.discarded || this.getState().selectedSession?.id !== pending.tempId) return;
    this.setState({ pendingDialogs: status.pendingDialogs ?? [] });
  }

  private schedulePendingFlush(): void {
    if (this.pendingFrame !== undefined) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = undefined;
      this.flushPendingUpdates();
    });
  }

  // Apply buffered transcript deltas, activity, and status in one task. Activity
  // is applied before status to mirror the server's publish order, so an idle
  // status can clear the now-stale active activity it supersedes. Status and
  // activity are last-write-wins per session, so iterating the maps applies only
  // the latest buffered value per session. These writes run in a single task, so
  // Lit batches them into one render.
  flushPendingUpdates(): void {
    if (this.pendingTranscriptEvents.length > 0) {
      const events = this.pendingTranscriptEvents;
      this.pendingTranscriptEvents = [];
      let messages = this.getState().messages;
      for (const event of events) messages = this.transcripts.applyLiveEvent(messages, event) ?? messages;
      if (messages !== this.getState().messages) this.setState({ messages });
    }
    if (this.pendingActivityBySession.size > 0) {
      const activities = Array.from(this.pendingActivityBySession.values());
      this.pendingActivityBySession.clear();
      for (const activity of activities) this.applyActivity(activity);
    }
    if (this.pendingStatusBySession.size > 0) {
      const statuses = Array.from(this.pendingStatusBySession.values());
      this.pendingStatusBySession.clear();
      for (const status of statuses) this.applyStatus(status);
    }
  }

  private clearPendingUpdates(): void {
    this.pendingTranscriptEvents = [];
    this.pendingStatusBySession.clear();
    this.pendingActivityBySession.clear();
    if (this.pendingFrame === undefined) return;
    cancelAnimationFrame(this.pendingFrame);
    this.pendingFrame = undefined;
  }

  // Watermark filter for join-time exactly-once application. An event is below
  // the watermark when it belongs to the selected session's seeded snapshot
  // (`seq <= watermark.seq`); such events are already reflected in the committed
  // history + seeded partial and must be dropped. Events with no `seq` (which
  // should not occur on the per-session socket) are never dropped.
  private isStreamEventBelowWatermark(event: SessionUiEvent): boolean {
    const watermark = this.streamWatermark;
    if (watermark === undefined || watermark.sessionId !== this.getState().selectedSession?.id) return false;
    return event.seq !== undefined && event.seq <= watermark.seq;
  }
}

function selectedRefreshPartialJson(snapshot: SessionStreamSnapshot): string {
  return JSON.stringify(snapshot.partial ?? null);
}

function omitSessionActivity(activities: Record<string, SessionActivity>, sessionId: string): Record<string, SessionActivity> {
  return omitKey(activities, sessionId);
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

function omitKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  if (keys.length === 0) return record;
  const removed = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([id]) => !removed.has(id)));
}

function moveRecordKey<T>(record: Record<string, T>, fromKey: string, toKey: string): Record<string, T> {
  if (fromKey === toKey || !(fromKey in record)) return record;
  const value = record[fromKey];
  if (value === undefined) return record;
  return { ...omitKey(record, fromKey), [toKey]: value };
}

function replacePendingSessionInList(sessions: readonly SessionInfo[], pendingSessionId: string, resolvedSession: SessionInfo): SessionInfo[] {
  const next: SessionInfo[] = [];
  let inserted = false;
  for (const session of sessions) {
    if (session.id === pendingSessionId) {
      if (!inserted) {
        next.push(resolvedSession);
        inserted = true;
      }
      continue;
    }
    if (session.id === resolvedSession.id) continue;
    next.push(session);
  }
  if (!inserted) return [resolvedSession, ...next];
  return next;
}

function isClientPendingStartSessionInfo(session: SessionInfo | undefined): session is ClientPendingStartSessionInfo {
  return session !== undefined && "clientPendingStart" in session && session.clientPendingStart === true;
}

/**
 * Re-label a startup report onto the browser's own pending create row.
 *
 * The daemon's startup marker is dropped: this row stands for a create the user
 * asked for and is waiting on, which the browser has always reported as active
 * work in progress, rather than for a session the daemon is opening. Only the
 * phase text is borrowed, so the row keeps its own `creating · ` appearance.
 */
function pendingStartActivity(activity: SessionActivity, sessionId: string): SessionActivity {
  return {
    sessionId,
    phase: activity.phase,
    label: activity.label,
    ...(activity.detail === undefined ? {} : { detail: activity.detail }),
    at: activity.at,
  };
}

function creatingPendingSessionActivity(sessionId: string, queuedCount = 0): SessionActivity {
  return {
    sessionId,
    phase: "active",
    label: "Creating session",
    detail: queuedCount > 0 ? `${String(queuedCount)} queued ${queuedCount === 1 ? "message" : "messages"} will send when the backend session is ready` : "Waiting for the backend session to be ready",
    at: new Date().toISOString(),
  };
}

function failedPendingSessionActivity(sessionId: string, message: string, queuedCount = 0): SessionActivity {
  const queuedDetail = queuedCount > 0 ? ` · ${String(queuedCount)} queued ${queuedCount === 1 ? "message" : "messages"} kept below` : "";
  return {
    sessionId,
    phase: "error",
    label: "Session creation failed",
    detail: `${message}${queuedDetail}`,
    at: new Date().toISOString(),
  };
}

function queuedSessionMessagePreview(queued: QueuedPendingSessionSend): QueuedSessionMessage {
  if (queued.type === "prompt") {
    return { kind: queued.streamingBehavior === "steer" ? "steer" : "followUp", text: queuedPromptPreviewText(queued.text, queued.attachments) };
  }
  return { kind: "followUp", text: queued.text };
}

function queuedPromptPreviewText(text: string, attachments: PromptAttachment[] | undefined): string {
  const attachmentText = queuedAttachmentSummary(attachments);
  if (attachmentText === undefined) return text;
  const trimmed = text.trim();
  return trimmed === "" ? attachmentText : `${text}\n\n${attachmentText}`;
}

function queuedAttachmentSummary(attachments: PromptAttachment[] | undefined): string | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined;
  const names = attachments.map((attachment) => attachment.name?.trim()).filter((name): name is string => name !== undefined && name !== "");
  const count = attachments.length;
  const label = `${String(count)} ${count === 1 ? "attachment" : "attachments"}`;
  if (names.length === 0) return `[${label} queued]`;
  const shownNames = names.slice(0, 3).join(", ");
  const suffix = names.length > 3 ? `, +${String(names.length - 3)} more` : "";
  return `[${label} queued: ${shownNames}${suffix}]`;
}

function uniqueSessionsById(sessions: readonly SessionInfo[]): SessionInfo[] {
  const seen = new Set<string>();
  const unique: SessionInfo[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
  }
  return unique;
}

function bulkFailureMessages(failures: readonly SessionBulkFailure[]): string[] {
  return failures.map((failure) => `${failure.sessionId}: ${failure.error}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionMessageCountPatch(state: AppState, sessionId: string, messageCount: number | undefined): Pick<Partial<AppState>, "sessions" | "selectedSession"> {
  if (messageCount === undefined) return {};

  const sessionsChanged = state.sessions.some((session) => session.id === sessionId && session.messageCount !== messageCount);
  const sessions = sessionsChanged
    ? state.sessions.map((session) => session.id === sessionId ? { ...session, messageCount } : session)
    : undefined;
  const selectedSession = state.selectedSession?.id === sessionId && state.selectedSession.messageCount !== messageCount
    ? { ...state.selectedSession, messageCount }
    : state.selectedSession;

  return {
    ...(sessions === undefined ? {} : { sessions }),
    ...(selectedSession !== state.selectedSession ? { selectedSession } : {}),
  };
}

function isHighFrequencyTranscriptEvent(event: SessionUiEvent): boolean {
  return event.type === "assistant.delta" || event.type === "assistant.thinking.delta" || event.type === "shell.chunk";
}

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("session not found");
}

