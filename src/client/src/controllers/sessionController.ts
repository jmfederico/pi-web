import { api as defaultApi, type CommandResult, type SessionActivity, type SessionInfo, type SessionStatus, type ThinkingLevel } from "../api";
import type { AppState } from "../appState";
import { forgetCachedNewSession, isCachedNewSessionInfo, markCachedNewSessionInfo, rememberCachedNewSession, stripCachedNewSessionMarker } from "../cachedNewSessions";
import { textMessage } from "../chatMessages";
import { clearDraft, moveDraft, saveDraft } from "../promptDraftStorage";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { isShellInput } from "../inputModes";
import { SessionSocket, type GlobalSessionEvent, type SessionUiEvent } from "../sessionSocket";
import { isSessionActive } from "../../../shared/activity";
import { InMemorySessionSelectionMemory, markSessionArchived, markSessionsArchived, selectPreferredSession, selectionAfterArchivingSession, selectionAfterArchivingSessions, shouldDeselectAfterArchivedCollapse, type SessionSelectionMemory } from "./sessionSelection";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";

const MESSAGE_PAGE_SIZE = 100;

export interface SessionEventSocket {
  connect(sessionId: string, onEvent: (event: SessionUiEvent) => void, onReconnect?: () => void, machineId?: string): void;
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
    this.setState({ selectedSession: undefined, messages: [], messagePageStart: 0, messagePageEnd: 0, messagePageTotal: 0, isLoadingEarlierMessages: false, isReceivingPartialStream: false, status: undefined, activity: undefined });
  }

  deselectSession(options?: { forgetRememberedSelection?: boolean | undefined; updateUrl?: boolean | undefined }) {
    const state = this.getState();
    const cwd = state.selectedSession?.cwd ?? state.selectedWorkspace?.path;
    if (options?.forgetRememberedSelection === true && cwd !== undefined) this.sessionSelection.forgetWorkspace(cwd);
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
      const session = await this.api.startSession(workspace.path, selectedMachineId(this.getState()));
      rememberCachedNewSession(session);
      const cachedSession = markCachedNewSessionInfo(session);
      this.setState({ sessions: [cachedSession, ...this.getState().sessions] });
      await this.selectSession(cachedSession);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  preferredSession(cwd: string, sessions: SessionInfo[], targetSessionId: string | undefined): SessionInfo | undefined {
    return selectPreferredSession(sessions, { targetSessionId, latestSessionId: this.sessionSelection.latestSessionId(cwd) });
  }

  async selectSession(session: SessionInfo, options?: { updateUrl?: boolean | undefined }) {
    this.sessionSelection.rememberSession(session);
    const seq = ++this.selectionSeq;
    this.socket.close();
    this.catchupStreamSessionId = undefined;
    this.clearPendingTranscriptEvents();
    const cached = this.transcripts.cachedView(session.id);
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
        const page = await this.api.messages(session.id, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
        if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
        const history = this.transcripts.mergeHistory(session.id, page);
        this.setState({ ...history, isLoadingEarlierMessages: false, isReceivingPartialStream: false, status: undefined, activity: undefined });
        if (options?.updateUrl !== false) this.updateUrl();
        return;
      }
      const buffered: SessionUiEvent[] = [];
      this.socket.connect(
        session.id,
        (event) => buffered.push(event),
        () => { void this.refreshSelectedSession(session.id); },
        selectedMachineId(this.getState()),
      );
      const [page, status] = await Promise.all([this.api.messages(session.id, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState())), this.api.status(session.id, selectedMachineId(this.getState()))]);
      if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
      const history = this.transcripts.mergeHistory(session.id, page);
      const isReceivingPartialStream = status.isStreaming;
      this.catchupStreamSessionId = isReceivingPartialStream ? session.id : undefined;
      this.setState({ ...history, isLoadingEarlierMessages: false, isReceivingPartialStream, status, activity: this.getState().sessionActivities[session.id] });
      this.applyStatus(status);
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
      const page = await this.api.messages(session.id, { before: state.messagePageStart, limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
      if (this.getState().selectedSession?.id !== session.id) return;
      const history = this.transcripts.mergeHistory(session.id, page);
      this.setState(history);
    } catch (error) {
      this.setState({ error: String(error) });
    } finally {
      if (this.getState().selectedSession?.id === session.id) this.setState({ isLoadingEarlierMessages: false });
    }
  }

  async send(text: string, streamingBehavior?: "steer" | "followUp") {
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) return this.runCommand(text);
    if (isShellInput(text)) return this.runShell(text);
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      await this.api.prompt(session.id, text, streamingBehavior, selectedMachineId(this.getState()));
      this.markCachedNewSessionPersisted(session);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async runShell(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    try {
      await this.api.shell(session.id, text, selectedMachineId(this.getState()));
      this.markCachedNewSessionPersisted(session);
    } catch (error) {
      this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))], error: String(error) });
    }
  }

  async runCommand(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    try {
      this.applyCommandResult(await this.api.runCommand(session.id, text, selectedMachineId(this.getState())));
      this.markCachedNewSessionPersisted(session);
    } catch (error) {
      this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))], error: String(error) });
    }
  }

  async respondToCommand(requestId: string, value: string) {
    const session = this.getState().selectedSession;
    if (!session) return;
    this.setState({ commandDialog: undefined });
    try {
      this.applyCommandResult(await this.api.respondToCommand(session.id, requestId, value, selectedMachineId(this.getState())));
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
      await this.api.archive(session.id, selectedMachineId(this.getState()));
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
      const response = await this.api.archiveWithDescendants(session.id, selectedMachineId(this.getState()));
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

  async deleteCachedNewSession(session = this.getState().selectedSession) {
    if (!isCachedNewSessionInfo(session)) return;
    void this.api.stop(session.id, selectedMachineId(this.getState())).catch(() => {
      // Best-effort cleanup for browser-cached sessions that may not exist server-side anymore.
    });
    forgetCachedNewSession(session.id);
    clearDraft(session.id);
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
      await this.api.restore(session.id, selectedMachineId(this.getState()));
      const restored = { ...session };
      delete restored.archived;
      delete restored.archivedAt;
      this.replaceSession(restored);
      if (this.getState().selectedSession?.id === restored.id) await this.selectSession(restored);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async detachParent(session = this.getState().selectedSession) {
    if (session?.parentSessionPath === undefined) return;
    try {
      await this.api.detachParent(session.id, selectedMachineId(this.getState()));
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
      return (await this.api.models(session.id, selectedMachineId(this.getState()))).models;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  async setModel(provider: string, modelId: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.setModel(session.id, provider, modelId, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async cycleModel(direction: "forward" | "backward") {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.cycleModel(session.id, direction, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async listThinkingLevels() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return [];
    try {
      return (await this.api.thinkingLevels(session.id, selectedMachineId(this.getState()))).levels;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  async setThinkingLevel(level: ThinkingLevel) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.setThinkingLevel(session.id, level, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async cycleThinkingLevel() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.cycleThinkingLevel(session.id, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async stopActiveWork() {
    const session = this.getState().selectedSession;
    if (!session) return;
    try {
      await this.api.abort(session.id, selectedMachineId(this.getState()));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async refreshSelectedSession(sessionId = this.getState().selectedSession?.id): Promise<void> {
    const session = this.getState().selectedSession;
    if (sessionId === undefined || session?.id !== sessionId || session.archived === true) return;
    try {
      this.flushPendingTranscriptEvents();
      const [page, status] = await Promise.all([this.api.messages(sessionId, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState())), this.api.status(sessionId, selectedMachineId(this.getState()))]);
      if (this.getState().selectedSession?.id !== sessionId) return;
      const history = this.transcripts.mergeHistory(sessionId, page);
      this.setState({
        ...history,
        status,
        activity: this.getState().sessionActivities[sessionId],
        isReceivingPartialStream: status.isStreaming,
      });
      this.applyStatus(status);
    } catch (error) {
      if (this.getState().selectedSession?.id === sessionId) this.setState({ error: String(error) });
    }
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
      const replacement = await this.api.startSession(session.cwd, selectedMachineId(this.getState()));
      rememberCachedNewSession(replacement);
      moveDraft(session.id, replacement.id);
      forgetCachedNewSession(session.id);
      const cachedReplacement = markCachedNewSessionInfo(replacement);
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
      if (result.promptDraft !== undefined) saveDraft(result.session.id, result.promptDraft);
      const current = this.getState().selectedSession;
      const sessions = [result.session, ...this.getState().sessions.filter((session) => session.id !== result.session?.id)];
      this.setState({ sessions, selectedSession: current?.id === result.session.id ? result.session : current });
      if (current?.id !== result.session.id) void this.selectSession(result.session);
    }
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
    if (this.catchupStreamSessionId === status.sessionId && !status.isStreaming) this.finishStreamCatchup(status.sessionId);
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

  private finishStreamCatchup(sessionId: string) {
    if (this.catchupStreamSessionId !== sessionId) return;
    this.catchupStreamSessionId = undefined;
    if (this.getState().selectedSession?.id === sessionId) this.setState({ isReceivingPartialStream: false });
    void this.refreshMessages(sessionId);
  }

  private async refreshMessages(sessionId: string) {
    try {
      const page = await this.api.messages(sessionId, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
      if (this.getState().selectedSession?.id !== sessionId) return;
      this.setState(this.transcripts.mergeHistory(sessionId, page));
    } catch (error) {
      if (this.getState().selectedSession?.id === sessionId) this.setState({ error: String(error) });
    }
  }
}

function omitSessionActivity(activities: Record<string, SessionActivity>, sessionId: string): Record<string, SessionActivity> {
  return Object.fromEntries(Object.entries(activities).filter(([id]) => id !== sessionId));
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

