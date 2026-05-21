import crypto from "node:crypto";
import type { SessionUiEvent } from "../../shared/apiTypes.js";
import type { ClientCommandResult, ClientSession } from "../types.js";
import { isBuiltinCommand } from "./builtinCommands.js";

export interface CommandSession {
  sessionId: string;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  messages: readonly unknown[];
  isStreaming: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  promptTemplates: readonly { name: string }[];
  extensionRunner: { getRegisteredCommands(): readonly { invocationName: string }[] };
  resourceLoader: { getSkills(): { skills: readonly { name: string }[] } };
  sessionManager: { getLeafId(): string | null; getHeader?: () => { parentSession?: string } | null | undefined };
  setSessionName: (name: string) => void;
  compact: (instructions?: string) => Promise<{ summary: string; tokensBefore: number }>;
  getSessionStats: () => {
    sessionId: string;
    totalMessages: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    tokens: { input: number; output: number; total: number };
    cost: number;
  };
  getUserMessagesForForking: () => readonly { entryId: string; text: string }[];
}

export interface CommandRuntime<TSession extends CommandSession = CommandSession> {
  cwd: string;
  session: TSession;
  fork: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled: boolean; selectedText?: string }>;
}

export interface CommandActiveSession<TSession extends CommandSession = CommandSession> {
  runtime: CommandRuntime<TSession>;
}

export type GetCommandActiveSession<TSession extends CommandSession = CommandSession> = (sessionId: string) => Promise<CommandActiveSession<TSession>>;

export interface CommandEventPublisher {
  publish(sessionId: string, event: SessionUiEvent): void;
}

interface PendingCommandSelect {
  sessionId: string;
  command: "fork";
}

export class SessionCommandService<TSession extends CommandSession = CommandSession> {
  private readonly pendingSelects = new Map<string, PendingCommandSelect>();

  constructor(
    private readonly getActive: GetCommandActiveSession<TSession>,
    private readonly prompt: (sessionId: string, text: string) => Promise<void>,
    private readonly events: CommandEventPublisher,
    private readonly lifecycle: {
      onCompactionStart?: (session: TSession) => void;
      onCompactionEnd?: (session: TSession, result: "success" | "error", detail?: string) => void;
    } = {},
  ) {}

  async run(sessionId: string, text: string): Promise<ClientCommandResult> {
    const active = await this.getActive(sessionId);
    const session = active.runtime.session;
    const [name = "", ...args] = text.trim().replace(/^\//, "").split(/\s+/);
    const rest = args.join(" ").trim();

    if (!isBuiltinCommand(name)) {
      if (this.isRuntimeCommand(session, name)) {
        await this.prompt(sessionId, text);
        return { type: "done", message: `Accepted ${text}` };
      }
      return { type: "unsupported", message: `Unknown command: /${name}` };
    }

    if (name === "session") return { type: "done", message: formatSessionStats(session) };
    if (name === "name") return this.nameSession(active, rest);
    if (name === "compact") return this.compact(session, rest);
    if (name === "clone") return this.clone(active);
    if (name === "fork") return this.fork(active);

    return { type: "unsupported", message: `/${name} is not implemented in the web UI yet` };
  }

  async respond(sessionId: string, requestId: string, value: string): Promise<ClientCommandResult> {
    const pending = this.pendingSelects.get(requestId);
    if (pending?.sessionId !== sessionId) return { type: "unsupported", message: "Command request expired" };
    this.pendingSelects.delete(requestId);

    const active = await this.getActive(sessionId);
    if (sessionHasActiveWork(active.runtime.session)) return forkActiveUnsupported("fork");
    const result = await active.runtime.fork(value);
    if (result.cancelled) return { type: "done", message: "Fork cancelled" };
    return { type: "done", message: "Session forked", session: clientSessionFromRuntime(active.runtime), ...promptDraft(result.selectedText) };
  }

  private nameSession(active: CommandActiveSession<TSession>, name: string): ClientCommandResult {
    if (name === "") return { type: "unsupported", message: "Usage: /name <session name>" };
    active.runtime.session.setSessionName(name);
    return { type: "done", message: `Session named: ${name}`, session: clientSessionFromRuntime(active.runtime) };
  }

  private compact(session: TSession, instructions: string): ClientCommandResult {
    this.lifecycle.onCompactionStart?.(session);
    void session.compact(instructions === "" ? undefined : instructions)
      .then((result) => {
        this.events.publish(session.sessionId, {
          type: "command.output",
          level: "success",
          message: formatCompactionResult(result),
        });
        this.lifecycle.onCompactionEnd?.(session, "success");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.events.publish(session.sessionId, { type: "command.output", level: "error", message: `Compaction failed: ${message}` });
        this.events.publish(session.sessionId, { type: "session.error", message });
        this.lifecycle.onCompactionEnd?.(session, "error", message);
      });
    return { type: "done", message: "Compaction started…" };
  }

  private async clone(active: CommandActiveSession<TSession>): Promise<ClientCommandResult> {
    if (sessionHasActiveWork(active.runtime.session)) return forkActiveUnsupported("clone");
    const leafId = active.runtime.session.sessionManager.getLeafId();
    if (leafId === null || leafId === "") return { type: "unsupported", message: "Cannot clone: no current session entry" };
    const result = await active.runtime.fork(leafId, { position: "at" });
    if (result.cancelled) return { type: "done", message: "Clone cancelled" };
    return { type: "done", message: "Session cloned", session: clientSessionFromRuntime(active.runtime) };
  }

  private fork(active: CommandActiveSession<TSession>): ClientCommandResult {
    if (sessionHasActiveWork(active.runtime.session)) return forkActiveUnsupported("fork");
    const messages = active.runtime.session.getUserMessagesForForking();
    if (!messages.length) return { type: "unsupported", message: "No user messages to fork from" };
    const requestId = crypto.randomUUID();
    this.pendingSelects.set(requestId, { sessionId: active.runtime.session.sessionId, command: "fork" });
    return {
      type: "select",
      requestId,
      title: "Fork from message",
      options: [...messages].reverse().map((message) => ({ value: message.entryId, label: truncate(message.text, 140) })),
    };
  }

  private isRuntimeCommand(session: TSession, name: string): boolean {
    return session.extensionRunner.getRegisteredCommands().some((command) => command.invocationName === name)
      || session.promptTemplates.some((template) => template.name === name)
      || session.resourceLoader.getSkills().skills.some((skill) => `skill:${skill.name}` === name);
  }
}

function clientSessionFromRuntime(runtime: CommandRuntime): ClientSession {
  const session = runtime.session;
  const parentSessionPath = typeof session.sessionManager.getHeader === "function" ? session.sessionManager.getHeader()?.parentSession : undefined;
  return {
    id: session.sessionId,
    path: session.sessionFile ?? "",
    cwd: runtime.cwd,
    ...(session.sessionName === undefined ? {} : { name: session.sessionName }),
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: session.messages.length,
    firstMessage: "",
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
  };
}

function sessionHasActiveWork(session: CommandSession): boolean {
  return session.isStreaming || session.isBashRunning || session.isCompacting || session.pendingMessageCount > 0;
}

function forkActiveUnsupported(command: "fork" | "clone"): ClientCommandResult {
  return { type: "unsupported", message: `Cannot ${command} while the session is active. Stop current activity before ${command === "fork" ? "forking" : "cloning"}.` };
}

function promptDraft(text: string | undefined): Partial<Pick<Extract<ClientCommandResult, { type: "done" }>, "promptDraft">> {
  return text === undefined ? {} : { promptDraft: text };
}

function formatSessionStats(session: CommandSession): string {
  const stats = session.getSessionStats();
  return [
    `Session: ${stats.sessionId}`,
    `Messages: ${String(stats.totalMessages)} (${String(stats.userMessages)} user, ${String(stats.assistantMessages)} assistant)`,
    `Tool calls: ${String(stats.toolCalls)}`,
    `Tokens: ↑${String(stats.tokens.input)} ↓${String(stats.tokens.output)} total ${String(stats.tokens.total)}`,
    `Cost: $${stats.cost.toFixed(4)}`,
  ].join("\n");
}

function formatCompactionResult(result: { summary: string; tokensBefore: number }): string {
  return [
    "Compaction complete.",
    `Tokens before: ${String(result.tokensBefore)}`,
    "",
    result.summary,
  ].join("\n");
}

function truncate(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}
