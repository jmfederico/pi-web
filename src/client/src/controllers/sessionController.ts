import { api, type CommandResult, type SessionActivity, type SessionInfo, type SessionStatus, type ThinkingLevel } from "../api";

const MESSAGE_PAGE_SIZE = 100;
import { normalizeMessages, textMessage } from "../chatMessages";
import { readChatHistoryCache, mergeChatHistory, writeChatHistoryCache, type RawMessagePage } from "../chatHistoryCache";
import { applyTranscriptEvent } from "../chatTranscript";
import { isShellInput } from "../inputModes";
import { SessionSocket, type GlobalSessionEvent, type SessionUiEvent } from "../sessionSocket";
import { InMemorySessionSelectionMemory, markSessionArchived, selectPreferredSession, selectionAfterArchivingSession, type SessionSelectionMemory } from "./sessionSelection";
import type { GetState, SetState, UpdateUrl } from "./types";

export class SessionController {
  private readonly socket = new SessionSocket();
  private selectionSeq = 0;
  private catchupStreamSessionId: string | undefined;
  private pendingTranscriptEvents: SessionUiEvent[] = [];
  private pendingTranscriptFrame: number | undefined;
  private readonly rawHistoryPages = new Map<string, RawMessagePage>();

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessionSelection: SessionSelectionMemory = new InMemorySessionSelectionMemory(),
  ) {}

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
    this.socket.close();
    this.catchupStreamSessionId = undefined;
    this.clearPendingTranscriptEvents();
    this.setState({ selectedSession: undefined, messages: [], messagePageStart: 0, messagePageTotal: 0, isLoadingEarlierMessages: false, isReceivingPartialStream: false, status: undefined, activity: undefined });
  }

  async startSession() {
    const workspace = this.getState().selectedWorkspace;
    if (!workspace) return;
    try {
      const session = await api.startSession(workspace.path);
      this.setState({ sessions: [session, ...this.getState().sessions] });
      await this.selectSession(session);
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
    const cached = this.rawHistoryPage(session.id);
    this.setState({
      selectedSession: session,
      messages: normalizeMessages(cached?.messages ?? []),
      messagePageStart: cached?.start ?? 0,
      messagePageTotal: cached?.total ?? 0,
      isLoadingEarlierMessages: false,
      isReceivingPartialStream: false,
      status: session.archived === true ? undefined : this.getState().sessionStatuses[session.id],
      activity: session.archived === true ? undefined : this.getState().sessionActivities[session.id],
    });
    try {
      if (session.archived === true) {
        const page = await api.messages(session.id, { limit: MESSAGE_PAGE_SIZE });
        if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
        const history = this.mergeAndCacheHistory(session.id, page, cached);
        this.setState({ messages: normalizeMessages(history.messages), messagePageStart: history.start, messagePageTotal: history.total, isLoadingEarlierMessages: false, isReceivingPartialStream: false, status: undefined, activity: undefined });
        if (options?.updateUrl !== false) this.updateUrl();
        return;
      }
      const buffered: SessionUiEvent[] = [];
      this.socket.connect(
        session.id,
        (event) => buffered.push(event),
        () => { void this.refreshSelectedSession(session.id); },
      );
      const [page, status] = await Promise.all([api.messages(session.id, { limit: MESSAGE_PAGE_SIZE }), api.status(session.id)]);
      if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
      const history = this.mergeAndCacheHistory(session.id, page, cached);
      const isReceivingPartialStream = status.isStreaming;
      this.catchupStreamSessionId = isReceivingPartialStream ? session.id : undefined;
      this.setState({ messages: normalizeMessages(history.messages), messagePageStart: history.start, messagePageTotal: history.total, isLoadingEarlierMessages: false, isReceivingPartialStream, status, activity: this.getState().sessionActivities[session.id] });
      this.applyStatus(status);
      for (const event of buffered) this.applyEvent(event);
      this.socket.setHandler((event) => { this.applyEvent(event); });
      if (options?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (seq === this.selectionSeq) this.setState({ error: String(error) });
    }
  }

  async loadEarlierMessages() {
    const state = this.getState();
    const session = state.selectedSession;
    if (!session || state.isLoadingEarlierMessages || state.messagePageStart <= 0) return;
    this.setState({ isLoadingEarlierMessages: true });
    try {
      const base = this.rawHistoryPage(session.id);
      const page = await api.messages(session.id, { before: state.messagePageStart, limit: MESSAGE_PAGE_SIZE });
      if (this.getState().selectedSession?.id !== session.id) return;
      const history = this.mergeAndCacheHistory(session.id, page, base);
      this.setState({
        messages: normalizeMessages(history.messages),
        messagePageStart: history.start,
        messagePageTotal: history.total,
      });
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
      await api.prompt(session.id, text, streamingBehavior);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async runShell(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    try {
      await api.shell(session.id, text);
    } catch (error) {
      this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))], error: String(error) });
    }
  }

  async runCommand(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    try {
      this.applyCommandResult(await api.runCommand(session.id, text));
    } catch (error) {
      this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))], error: String(error) });
    }
  }

  async respondToCommand(requestId: string, value: string) {
    const session = this.getState().selectedSession;
    if (!session) return;
    this.setState({ commandDialog: undefined });
    try {
      this.applyCommandResult(await api.respondToCommand(session.id, requestId, value));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  cancelCommand() {
    this.setState({ commandDialog: undefined });
  }

  async archiveSession(session = this.getState().selectedSession) {
    if (!session) return;
    try {
      await api.archive(session.id);
      const state = this.getState();
      const sessions = markSessionArchived(state.sessions, session.id, new Date().toISOString());
      const selectionChange = selectionAfterArchivingSession(sessions, state.selectedSession?.id, session.id);
      this.setState({ sessions });

      if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
      else if (selectionChange.type === "clear") {
        this.clearActiveSession();
        this.updateUrl();
      }
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async restoreSession(session = this.getState().selectedSession) {
    if (!session) return;
    try {
      await api.restore(session.id);
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
      await api.detachParent(session.id);
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
      return (await api.models(session.id)).models;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  async setModel(provider: string, modelId: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await api.setModel(session.id, provider, modelId));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async cycleModel(direction: "forward" | "backward") {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await api.cycleModel(session.id, direction));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async listThinkingLevels() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return [];
    try {
      return (await api.thinkingLevels(session.id)).levels;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  async setThinkingLevel(level: ThinkingLevel) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await api.setThinkingLevel(session.id, level));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async cycleThinkingLevel() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await api.cycleThinkingLevel(session.id));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async stopActiveWork() {
    const session = this.getState().selectedSession;
    if (!session) return;
    try {
      await api.abort(session.id);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async refreshSelectedSession(sessionId = this.getState().selectedSession?.id): Promise<void> {
    const session = this.getState().selectedSession;
    if (sessionId === undefined || session?.id !== sessionId || session.archived === true) return;
    try {
      this.flushPendingTranscriptEvents();
      const base = this.rawHistoryPage(sessionId);
      const [page, status] = await Promise.all([api.messages(sessionId, { limit: MESSAGE_PAGE_SIZE }), api.status(sessionId)]);
      if (this.getState().selectedSession?.id !== sessionId) return;
      const history = this.mergeAndCacheHistory(sessionId, page, base);
      this.setState({
        messages: normalizeMessages(history.messages),
        messagePageStart: history.start,
        messagePageTotal: history.total,
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

  private mergeAndCacheHistory(sessionId: string, page: RawMessagePage, base = this.rawHistoryPage(sessionId)): RawMessagePage {
    const history = mergeChatHistory(base, page);
    this.rawHistoryPages.set(sessionId, history);
    writeChatHistoryCache(sessionId, history);
    return history;
  }

  private rawHistoryPage(sessionId: string): RawMessagePage | undefined {
    const cached = this.rawHistoryPages.get(sessionId) ?? readChatHistoryCache(sessionId);
    if (cached !== undefined) this.rawHistoryPages.set(sessionId, cached);
    return cached;
  }

  private applyCommandResult(result: CommandResult) {
    if (result.type === "select") {
      this.setState({ commandDialog: result });
      return;
    }
    const message = result.type === "unsupported" ? result.message : result.message;
    if (message !== undefined && message !== "") this.setState({ messages: [...this.getState().messages, textMessage(result.type === "unsupported" ? "system" : "tool", message)] });
    if (result.type === "done" && result.session) {
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
    this.setState({
      sessionStatuses: { ...this.getState().sessionStatuses, [status.sessionId]: status },
      status: this.getState().selectedSession?.id === status.sessionId ? status : this.getState().status,
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
    const transcript = applyTranscriptEvent(this.getState().messages, event);
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
    for (const event of events) messages = applyTranscriptEvent(messages, event) ?? messages;
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
      const base = this.rawHistoryPage(sessionId);
      const page = await api.messages(sessionId, { limit: MESSAGE_PAGE_SIZE });
      if (this.getState().selectedSession?.id !== sessionId) return;
      const history = this.mergeAndCacheHistory(sessionId, page, base);
      this.setState({ messages: normalizeMessages(history.messages), messagePageStart: history.start, messagePageTotal: history.total });
    } catch (error) {
      if (this.getState().selectedSession?.id === sessionId) this.setState({ error: String(error) });
    }
  }
}

function isTranscriptEvent(event: SessionUiEvent): boolean {
  return ["message.append", "assistant.delta", "assistant.thinking.delta", "tool.start", "tool.end", "shell.start", "shell.chunk", "shell.end", "command.output", "session.error"].includes(event.type);
}

function isHighFrequencyTranscriptEvent(event: SessionUiEvent): boolean {
  return event.type === "assistant.delta" || event.type === "assistant.thinking.delta" || event.type === "shell.chunk";
}

