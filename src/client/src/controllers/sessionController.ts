import { api as defaultApi, type CommandResult, type PromptAttachment, type SessionActivity, type SessionInfo, type SessionRef, type SessionStatus } from "../api";
import type { WorkspacePanelSessionInfo } from "../plugins/types";
import type { AppState } from "../appState";
import { forgetCachedNewSession, isCachedNewSessionInfo, markCachedNewSessionInfo, rememberCachedNewSession, stripCachedNewSessionMarker } from "../cachedNewSessions";
import { textMessage } from "../chatMessages";
import { machineSessionKey } from "../machineKeys";
import { clearDraft, moveDraft, saveDraft } from "../promptDraftStorage";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { isShellInput } from "../inputModes";
import { fileCompletionInsertText } from "../promptCompletions";
import { SessionSocket, type GlobalSessionEvent, type SessionUiEvent } from "../sessionSocket";
import { isSessionActive } from "../../../shared/activity";
import { PI_WEB_CAPABILITIES, supportsPiWebCapability } from "../../../shared/capabilities";
import { InMemorySessionSelectionMemory, markSessionArchived, markSessionsArchived, selectPreferredSession, selectionAfterArchivingSession, selectionAfterArchivingSessions, shouldDeselectAfterArchivedCollapse, type SessionSelectionMemory } from "./sessionSelection";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";

const MESSAGE_PAGE_SIZE = 100;

export interface SessionEventSocket {
  connect(session: SessionRef, onEvent: (event: SessionUiEvent) => void, onReconnect?: () => void, machineId?: string): void;
  setHandler(onEvent: (event: SessionUiEvent) => void): void;
  close(): void;
}

export interface SessionControllerDependencies {
  api?: typeof defaultApi;
  socket?: SessionEventSocket;
  transcripts?: ChatTranscriptStore;
}

export class SessionController {
  private readonly socket: SessionEventSocket;
  private readonly api: typeof defaultApi;
  private readonly transcripts: ChatTranscriptStore;
  private selectionSeq = 0;
  private catchupStreamSessionId: string | undefined;
  private pendingTranscriptEvents: SessionUiEvent[] = [];
  private pendingTranscriptFrame: number | undefined;

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
  }

  applyGlobalEvent(event: GlobalSessionEvent): void {
    if (event.type === "status.update") this.applyStatus(event.status);
    else if (event.type === "activity.update") this.applyActivity(event.activity);
    else if (event.type === "session.created") this.applyCreatedSession(event.session);
    else this.applySessionName(event.sessionId, event.name);
  }

  dispose() {
    this.socket.close();
    this.clearPendingTranscriptEvents();
  }

  clearActiveSession() {
    this.selectionSeq += 1;
    this.socket.close();
    this.catchupStreamSessionId = undefined;
    this.clearPendingTranscriptEvents();
    // Note: sendingPrompts is intentionally NOT cleared here. Deselecting a
    // session must not cancel the in-flight upload indicator of the session
    // that is still sending; the per-session entry is cleared by send()'s
    // finally block when the request settles.
    this.setState({ selectedSession: undefined, messages: [], messagePageStart: 0, messagePageEnd: 0, messagePageTotal: 0, isLoadingEarlierMessages: false, isReceivingPartialStream: false, status: undefined, activity: undefined, availableThinkingLevels: [] });
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
    try {
      const machineId = selectedMachineId(this.getState());
      const session = await this.api.startSession(workspace.path, machineId);
      rememberCachedNewSession(session, machineId);
      const cachedSession = markCachedNewSessionInfo(session, machineId);
      // Drop any entry the session.created broadcast may have inserted for this
      // same session before the HTTP response resolved, so the cached marker
      // (and its delete action) wins instead of leaving a duplicate badge.
      this.setState({ sessions: [cachedSession, ...this.getState().sessions.filter((candidate) => candidate.id !== cachedSession.id)] });
      await this.selectSession(cachedSession);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async startWorkspaceSessionWithPrompt(cwd: string, prompt: string, machineId = selectedMachineId(this.getState()), options?: { newWorkspace?: boolean | undefined; ideaId?: string | undefined }): Promise<WorkspacePanelSessionInfo> {
    let sessionCwd = cwd;
    let createdWorkspaceId: string | undefined;
    if (options?.newWorkspace === true) {
      const workspace = this.getState().selectedWorkspace;
      if (workspace !== undefined) {
        const ideaWorkspace = await this.api.createIdeaWorkspace(workspace.projectId, workspace.id, options.ideaId ?? "idea", machineId);
        sessionCwd = ideaWorkspace.path;
        createdWorkspaceId = ideaWorkspace.id;
        this.setState({ workspaces: [ideaWorkspace, ...this.getState().workspaces.filter((candidate) => candidate.id !== ideaWorkspace.id)] });
      }
    }
    const session = await this.api.startSession(sessionCwd, machineId);
    const currentModel = this.getState().status?.model;
    if (currentModel?.provider !== undefined && currentModel.id !== undefined) {
      await this.api.setModel(session.id, currentModel.provider, currentModel.id, machineId);
    }
    this.setState({ sessions: [session, ...this.getState().sessions.filter((candidate) => candidate.id !== session.id)] });
    await this.api.prompt(session.id, prompt, undefined, machineId);
    return createdWorkspaceId === undefined ? session : { ...session, workspaceId: createdWorkspaceId };
  }

  preferredSession(cwd: string, sessions: SessionInfo[], targetSessionId: string | undefined): SessionInfo | undefined {
    return selectPreferredSession(sessions, { targetSessionId, latestSessionId: this.sessionSelection.latestSessionId(this.workspaceSelectionKey(cwd)) });
  }

  async selectSession(session: SessionInfo, options?: { updateUrl?: boolean | undefined }) {
    this.sessionSelection.rememberSession({ ...session, cwd: this.workspaceSelectionKey(session.cwd) });
    const seq = ++this.selectionSeq;
    this.socket.close();
    this.catchupStreamSessionId = undefined;
    this.clearPendingTranscriptEvents();
    const transcriptKey = this.sessionCacheKey(session.id);
    const cached = this.transcripts.cachedView(transcriptKey);
    this.setState({
      selectedSession: session,
      ...cached,
      isLoadingEarlierMessages: false,
      isReceivingPartialStream: false,
      status: session.archived === true ? undefined : this.getState().sessionStatuses[session.id],
      activity: session.archived === true ? undefined : this.getState().sessionActivities[session.id],
    });
    try {
      if (session.archived === true) {
        const page = await this.api.messages(session, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
        if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
        const history = this.transcripts.mergeHistory(transcriptKey, page);
        this.setState({ ...history, isLoadingEarlierMessages: false, isReceivingPartialStream: false, status: undefined, activity: undefined });
        if (options?.updateUrl !== false) this.updateUrl();
        return;
      }
      const buffered: SessionUiEvent[] = [];
      this.socket.connect(
        session,
        (event) => buffered.push(event),
        () => { void this.refreshSelectedSession(session.id); },
        selectedMachineId(this.getState()),
      );
      const [page, status] = await Promise.all([this.api.messages(session, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState())), this.api.status(session, selectedMachineId(this.getState()))]);
      if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
      const history = this.transcripts.mergeHistory(transcriptKey, page);
      this.setState({ ...history, isLoadingEarlierMessages: false, ...this.setStreamCatchup(status.isStreaming ? session.id : undefined), status, activity: this.getState().sessionActivities[session.id], availableThinkingLevels: [] });
      this.applyStatus(status);
      void this.refreshAvailableThinkingLevels();
      for (const event of buffered) this.applyEvent(event);
      this.socket.setHandler((event) => { this.applyEvent(event); });
      if (options?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
      if (isCachedNewSessionInfo(session) && isSessionNotFoundError(error)) {
        await this.recreateCachedNewSession(session, options);
        return;
      }
      this.setState({ error: String(error) });
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

  async send(text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery: "inline" | "folder" = "inline") {
    const trimmed = text.trim();
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (!hasAttachments && trimmed.startsWith("/")) return this.runCommand(text);
    if (!hasAttachments && isShellInput(text)) return this.runShell(text);
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    // Capture the originating session/machine before any await so the request
    // and its sending indicator stay bound to the right session even if the
    // user navigates elsewhere mid-upload.
    const sessionId = session.id;
    const machineId = selectedMachineId(this.getState());
    // Surface a per-session optimistic sending state. It covers the pre-receipt
    // window (upload, server-side image resizing, first-session open) and is
    // superseded by real server activity/messages once api.prompt resolves.
    if (hasAttachments) this.markSendingPrompt(sessionId, true);
    try {
      if (hasAttachments && delivery === "folder") {
        const saved = await this.api.saveAttachments(session, attachments, machineId);
        const references = saved.map((file) => fileCompletionInsertText(file.path, false)).join(" ");
        const body = text === "" ? references : `${text}\n\n${references}`;
        await this.api.prompt(session, body, streamingBehavior, machineId);
      } else {
        await this.api.prompt(session, text, streamingBehavior, machineId, attachments);
      }
      this.markCachedNewSessionPersisted(session);
    } catch (error) {
      this.setState({ error: String(error) });
    } finally {
      if (hasAttachments) this.markSendingPrompt(sessionId, false);
    }
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
    this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    try {
      await this.api.shell(session, text, selectedMachineId(this.getState()));
      this.markCachedNewSessionPersisted(session);
    } catch (error) {
      this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))], error: String(error) });
    }
  }

  async runCommand(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    // Commands are not inserted into the transcript optimistically: a builtin
    // command produces its own result line, and a runtime/skill command is
    // forwarded to the agent, which streams back the canonical (expanded)
    // message. Inserting the raw text here would leave a line that doesn't
    // converge with server history and disappears on reload. Surface the same
    // per-session sending indicator that send() uses for the pre-receipt window.
    const sessionId = session.id;
    this.markSendingPrompt(sessionId, true);
    try {
      this.applyCommandResult(await this.api.runCommand(session, text, selectedMachineId(this.getState())));
      this.markCachedNewSessionPersisted(session);
    } catch (error) {
      this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))], error: String(error) });
    } finally {
      this.markSendingPrompt(sessionId, false);
    }
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

  applySessionStatus(status: SessionStatus): void {
    this.applyStatus(status);
  }

  async archiveSession(session = this.getState().selectedSession) {
    if (!session) return;
    if (isCachedNewSessionInfo(session)) {
      await this.deleteCachedNewSession(session);
      return;
    }
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
    if (!session || isCachedNewSessionInfo(session)) return;
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
    const candidates = uniqueSessionsById(sessions).filter((session) => session.archived !== true && !isCachedNewSessionInfo(session));
    if (candidates.length === 0) return;

    const machineId = selectedMachineId(this.getState());
    const results = await Promise.allSettled(candidates.map(async (session) => {
      await this.api.archive(session, machineId);
      return session.id;
    }));
    const archivedIds = fulfilledValues(results);
    if (archivedIds.length > 0) {
      const state = this.getState();
      const nextSessions = markSessionsArchived(state.sessions, archivedIds, new Date().toISOString());
      const selectionChange = selectionAfterArchivingSessions(nextSessions, state.selectedSession?.id, archivedIds);
      this.setState({ sessions: nextSessions });

      if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
      else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
    }
    this.applyBulkSessionError("Archive", results);
  }

  async deleteArchivedSessions(sessions: readonly SessionInfo[]): Promise<void> {
    const candidates = uniqueSessionsById(sessions).filter((session) => session.archived === true);
    if (candidates.length === 0) return;

    const machineId = selectedMachineId(this.getState());
    const runtime = this.getState().machineRuntimes[machineId];
    if (runtime?.ok !== true || !supportsPiWebCapability(runtime, PI_WEB_CAPABILITIES.sessionsDeleteArchived)) {
      this.setState({ error: "Deleting archived sessions requires an updated Pi-Web runtime on this machine." });
      return;
    }
    const results = await Promise.allSettled(candidates.map(async (session) => {
      await this.api.deleteArchived(session, machineId);
      return session.id;
    }));
    const deletedIds = fulfilledValues(results);
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
    this.applyBulkSessionError("Delete", results);
  }

  async deleteCachedNewSession(session = this.getState().selectedSession) {
    if (!isCachedNewSessionInfo(session)) return;
    void this.api.stop(session, selectedMachineId(this.getState())).catch(() => {
      // Best-effort cleanup for browser-cached sessions that may not exist server-side anymore.
    });
    forgetCachedNewSession(session.id, selectedMachineId(this.getState()));
    clearDraft(this.sessionCacheKey(session.id));
    const sessions = this.getState().sessions.filter((candidate) => candidate.id !== session.id);
    this.setState({ sessions });
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
    if (session === undefined || isCachedNewSessionInfo(session) || session.archived === true) return;
    const machineId = selectedMachineId(this.getState());
    const runtime = this.getState().machineRuntimes[machineId];
    if (runtime?.ok !== true || !supportsPiWebCapability(runtime, PI_WEB_CAPABILITIES.sessionsReload)) {
      this.setState({ error: "Reloading sessions requires an updated Pi-Web runtime on this machine." });
      return;
    }
    try {
      await this.api.reloadSession(session.id, machineId);
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

  async stopActiveWork() {
    const session = this.getState().selectedSession;
    if (!session) return;
    try {
      await this.api.abort(session, selectedMachineId(this.getState()));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async refreshSelectedSession(sessionId = this.getState().selectedSession?.id): Promise<void> {
    const session = this.getState().selectedSession;
    if (sessionId === undefined || session?.id !== sessionId || session.archived === true) return;
    try {
      this.flushPendingTranscriptEvents();
      const [page, status] = await Promise.all([this.api.messages(session, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState())), this.api.status(session, selectedMachineId(this.getState()))]);
      if (this.getState().selectedSession?.id !== sessionId) return;
      const history = this.transcripts.mergeHistory(this.sessionCacheKey(sessionId), page);
      this.setState({
        ...history,
        status,
        activity: this.getState().sessionActivities[sessionId],
        ...this.setStreamCatchup(status.isStreaming ? sessionId : undefined),
      });
      this.applyStatus(status);
    } catch (error) {
      if (this.getState().selectedSession?.id === sessionId) this.setState({ error: String(error) });
    }
  }

  private applyBulkSessionError(action: string, results: readonly PromiseSettledResult<string>[]): void {
    const failures = rejectedReasons(results);
    if (failures.length === 0) return;
    this.setState({ error: `${action} failed for ${String(failures.length)} session${failures.length === 1 ? "" : "s"}: ${failures.join("; ")}` });
  }

  private sessionCacheKey(sessionId: string): string {
    return machineSessionKey(selectedMachineId(this.getState()), sessionId);
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

  private async recreateCachedNewSession(session: SessionInfo, options?: { updateUrl?: boolean | undefined }): Promise<void> {
    try {
      const machineId = selectedMachineId(this.getState());
      const replacement = await this.api.startSession(session.cwd, machineId);
      rememberCachedNewSession(replacement, machineId);
      moveDraft(this.sessionCacheKey(session.id), this.sessionCacheKey(replacement.id));
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
    // Only surface sessions for the workspace currently in view; others are
    // picked up when their workspace is opened. Skip if already present (e.g.
    // the optimistic insert from startSession in this same tab).
    if (state.selectedWorkspace?.path !== session.cwd) return;
    if (state.sessions.some((candidate) => candidate.id === session.id)) return;
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
    const clearsStaleActivity = state.sessionActivities[status.sessionId]?.phase === "active" && !isSessionActive(status);
    this.setState({
      sessionStatuses: { ...state.sessionStatuses, [status.sessionId]: status },
      ...sessionMessageCountPatch(state, status.sessionId, status.messageCount),
      ...(clearsStaleActivity ? { sessionActivities: omitSessionActivity(state.sessionActivities, status.sessionId) } : {}),
      status: state.selectedSession?.id === status.sessionId ? status : state.status,
      activity: state.selectedSession?.id === status.sessionId && clearsStaleActivity ? undefined : state.activity,
    });
    if (!status.isStreaming) this.finishStreamCatchup(status.sessionId);
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
    const selectedSessionId = this.getState().selectedSession?.id;
    if (this.catchupStreamSessionId !== undefined && this.catchupStreamSessionId === selectedSessionId) {
      if (event.type === "message.end" || event.type === "agent.end") {
        this.finishStreamCatchup(this.catchupStreamSessionId);
        return;
      }
      if (isTranscriptEvent(event)) return;
    }

    if (isHighFrequencyTranscriptEvent(event)) {
      this.queueTranscriptEvent(event);
      return;
    }

    this.flushPendingTranscriptEvents();
    const transcript = this.transcripts.applyLiveEvent(this.getState().messages, event);
    if (transcript) {
      this.setState({ messages: transcript });
    } else if (event.type === "status.update") {
      this.applyStatus(event.status);
    } else if (event.type === "activity.update") {
      this.applyActivity(event.activity);
    } else if (event.type === "session.name") {
      this.applySessionName(event.sessionId, event.name);
    }
  }

  private queueTranscriptEvent(event: SessionUiEvent): void {
    this.pendingTranscriptEvents.push(event);
    if (this.pendingTranscriptFrame !== undefined) return;
    this.pendingTranscriptFrame = requestAnimationFrame(() => {
      this.pendingTranscriptFrame = undefined;
      this.flushPendingTranscriptEvents();
    });
  }

  private flushPendingTranscriptEvents(): void {
    if (this.pendingTranscriptEvents.length === 0) return;
    const events = this.pendingTranscriptEvents;
    this.pendingTranscriptEvents = [];
    let messages = this.getState().messages;
    for (const event of events) messages = this.transcripts.applyLiveEvent(messages, event) ?? messages;
    if (messages !== this.getState().messages) this.setState({ messages });
  }

  private clearPendingTranscriptEvents(): void {
    this.pendingTranscriptEvents = [];
    if (this.pendingTranscriptFrame === undefined) return;
    cancelAnimationFrame(this.pendingTranscriptFrame);
    this.pendingTranscriptFrame = undefined;
  }

  // Stream catch-up is a single mode with two coupled facets that must never
  // drift: the private `catchupStreamSessionId` guard (which suppresses live
  // transcript events while we lack the in-flight message prefix) and the
  // public `isReceivingPartialStream` flag (which drives the "Catching up…"
  // badge). Route every mutation of the mode through this helper so the guard
  // and the badge can never disagree. Catch-up only ever applies to the
  // selected session, so an active session id always implies the badge is on.
  private setStreamCatchup(sessionId: string | undefined): Pick<AppState, "isReceivingPartialStream"> {
    this.catchupStreamSessionId = sessionId;
    return { isReceivingPartialStream: sessionId !== undefined };
  }

  private finishStreamCatchup(sessionId: string) {
    const isSelected = this.getState().selectedSession?.id === sessionId;
    const wasCatchingUp = this.catchupStreamSessionId === sessionId || (isSelected && this.getState().isReceivingPartialStream);
    if (!wasCatchingUp) return;
    this.catchupStreamSessionId = undefined;
    if (isSelected) this.setState({ isReceivingPartialStream: false });
    void this.refreshMessages(sessionId);
  }

  private async refreshMessages(sessionId: string) {
    try {
      const session = this.getState().selectedSession;
      if (session?.id !== sessionId) return;
      const page = await this.api.messages(session, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
      if (this.getState().selectedSession?.id !== sessionId) return;
      this.setState(this.transcripts.mergeHistory(this.sessionCacheKey(sessionId), page));
    } catch (error) {
      if (this.getState().selectedSession?.id === sessionId) this.setState({ error: String(error) });
    }
  }
}

function omitSessionActivity(activities: Record<string, SessionActivity>, sessionId: string): Record<string, SessionActivity> {
  return omitKey(activities, sessionId);
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
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

function fulfilledValues<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results.filter(isFulfilled).map((result) => result.value);
}

function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): string[] {
  return results.filter(isRejected).map((result) => errorMessage(result.reason));
}

function isFulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === "fulfilled";
}

function isRejected<T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult {
  return result.status === "rejected";
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

function isTranscriptEvent(event: SessionUiEvent): boolean {
  return ["message.append", "assistant.delta", "assistant.thinking.delta", "tool.start", "tool.update", "tool.end", "shell.start", "shell.chunk", "shell.end", "command.output", "session.error"].includes(event.type);
}

function isHighFrequencyTranscriptEvent(event: SessionUiEvent): boolean {
  return event.type === "assistant.delta" || event.type === "assistant.thinking.delta" || event.type === "shell.chunk";
}

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("session not found");
}

