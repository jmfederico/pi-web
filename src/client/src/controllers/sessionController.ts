import { api, type CommandResult, type SessionActivity, type SessionInfo, type SessionStatus } from "../api";

const MESSAGE_PAGE_SIZE = 100;
import { normalizeMessages, textMessage } from "../chatMessages";
import { readChatHistoryCache, mergeChatHistory, writeChatHistoryCache, type RawMessagePage } from "../chatHistoryCache";
import { applyTranscriptEvent } from "../chatTranscript";
import { isShellInput } from "../inputModes";
import { GlobalSessionSocket, SessionSocket, type SessionUiEvent } from "../sessionSocket";
import type { GetState, SetState, UpdateUrl } from "./types";

export class SessionController {
  private readonly socket = new SessionSocket();
  private readonly globalSocket = new GlobalSessionSocket();

  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly updateUrl: UpdateUrl) {}

  connectStatusUpdates() {
    this.globalSocket.connect((event) => {
      if (event.type === "status.update") this.applyStatus(event.status);
      else this.applyActivity(event.activity);
    });
  }

  dispose() {
    this.socket.close();
    this.globalSocket.close();
  }

  clearActiveSession() {
    this.socket.close();
    this.setState({ selectedSession: undefined, messages: [], messagePageStart: 0, messagePageTotal: 0, isLoadingEarlierMessages: false, status: undefined, activity: undefined });
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

  async selectSession(session: SessionInfo, options?: { updateUrl?: boolean | undefined }) {
    this.socket.close();
    try {
      const buffered: SessionUiEvent[] = [];
      this.socket.connect(session.id, (event) => buffered.push(event));
      const [page, status] = await Promise.all([api.messages(session.id, { limit: MESSAGE_PAGE_SIZE }), api.status(session.id)]);
      const history = this.mergeAndCacheHistory(session.id, page);
      this.setState({ selectedSession: session, messages: normalizeMessages(history.messages), messagePageStart: history.start, messagePageTotal: history.total, isLoadingEarlierMessages: false, status });
      this.applyStatus(status);
      for (const event of buffered) this.applyEvent(event);
      this.socket.setHandler((event) => { this.applyEvent(event); });
      if (options?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async loadEarlierMessages() {
    const state = this.getState();
    const session = state.selectedSession;
    if (!session || state.isLoadingEarlierMessages || state.messagePageStart <= 0) return;
    this.setState({ isLoadingEarlierMessages: true });
    try {
      const page = await api.messages(session.id, { before: state.messagePageStart, limit: MESSAGE_PAGE_SIZE });
      if (this.getState().selectedSession?.id !== session.id) return;
      const history = this.mergeAndCacheHistory(session.id, page);
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

  async send(text: string) {
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) return this.runCommand(text);
    if (isShellInput(text)) return this.runShell(text);
    const session = this.getState().selectedSession;
    if (!session) return;
    this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    try {
      await api.prompt(session.id, text);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async runShell(text: string) {
    const session = this.getState().selectedSession;
    if (!session) return;
    this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    try {
      await api.shell(session.id, text);
    } catch (error) {
      this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))], error: String(error) });
    }
  }

  async runCommand(text: string) {
    const session = this.getState().selectedSession;
    if (!session) return;
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

  async stopSession() {
    const session = this.getState().selectedSession;
    if (!session) return;
    try {
      await api.stop(session.id);
    } catch (error) {
      this.setState({ error: String(error) });
    } finally {
      this.clearActiveSession();
      this.updateUrl();
    }
  }

  private mergeAndCacheHistory(sessionId: string, page: RawMessagePage): RawMessagePage {
    const history = mergeChatHistory(readChatHistoryCache(sessionId), page);
    writeChatHistoryCache(sessionId, history);
    return history;
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
  }

  private applyEvent(event: SessionUiEvent) {
    const transcript = applyTranscriptEvent(this.getState().messages, event);
    if (transcript) {
      this.setState({ messages: transcript });
    } else if (event.type === "status.update") {
      this.applyStatus(event.status);
    } else if (event.type === "activity.update") {
      this.applyActivity(event.activity);
    }
  }
}

