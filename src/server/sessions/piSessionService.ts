import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import type { ClientCommand, ClientCommandResult, ClientMessagePage, ClientSession, ClientSessionStatus, SessionUiEvent } from "../types.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import { BUILTIN_COMMANDS } from "./builtinCommands.js";
import { SessionCommandService } from "./sessionCommandService.js";
import { SessionArchiveStore } from "./sessionArchiveStore.js";
import type { ActiveSession } from "./sessionRuntimeStore.js";
import { generateShortSessionName } from "./sessionNameGenerator.js";

function noop(): void {
  // Intentionally empty default unsubscribe callback.
}

export class PiSessionService {
  private readonly active = new Map<string, ActiveSession>();
  private readonly activities = new Map<string, { phase: "active" | "idle" | "error"; label: string; detail?: string; at: string }>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly commandService: SessionCommandService;
  private readonly archiveStore = new SessionArchiveStore();
  private readonly agentDir = getAgentDir();
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, authStorage: this.authStorage, modelRegistry: this.modelRegistry });
    const options = sessionStartEvent === undefined
      ? { services, sessionManager }
      : { services, sessionManager, sessionStartEvent };
    const result = await createAgentSessionFromServices(options);
    return { ...result, services, diagnostics: services.diagnostics };
  };

  constructor(private readonly events: SessionEventHub) {
    this.heartbeat = setInterval(() => { this.publishHeartbeats(); }, 2000);
    this.commandService = new SessionCommandService(
      (sessionId) => this.getActive(sessionId),
      (sessionId, text) => this.prompt(sessionId, text),
      events,
    );
  }

  activeCount(): number {
    return this.active.size;
  }

  async dispose(): Promise<void> {
    clearInterval(this.heartbeat);
    const activeSessions = Array.from(new Set(this.active.values()));
    this.active.clear();
    this.activities.clear();
    await Promise.all(activeSessions.map(async (active) => {
      active.unsubscribe();
      await active.runtime.session.abort();
      await active.runtime.dispose();
    }));
  }

  async list(cwd: string): Promise<ClientSession[]> {
    const [sessions, archivedRecords] = await Promise.all([SessionManager.list(cwd), this.archiveStore.list()]);
    const archivedById = new Map(archivedRecords.filter((record) => record.cwd === cwd).map((record) => [record.sessionId, record]));
    return sessions.map((s) => {
      const archived = archivedById.get(s.id);
      return {
        id: s.id,
        path: s.path,
        cwd: s.cwd,
        ...(s.name === undefined ? {} : { name: s.name }),
        created: s.created.toISOString(),
        modified: s.modified.toISOString(),
        messageCount: s.messageCount,
        firstMessage: s.firstMessage,
        ...(archived === undefined ? {} : { archived: true, archivedAt: archived.archivedAt }),
      };
    });
  }

  async start(cwd: string): Promise<ClientSession> {
    const active = await this.create(SessionManager.create(cwd), cwd);
    const { session } = active.runtime;
    return {
      id: session.sessionId,
      path: session.sessionFile ?? "",
      cwd,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: session.messages.length,
      firstMessage: "",
    };
  }

  async messages(sessionId: string, page?: { before?: number; limit?: number }): Promise<unknown[] | ClientMessagePage> {
    const session = await this.getOrOpen(sessionId);
    const messages = historyMessages(session);
    if (page?.before === undefined && page?.limit === undefined) return messages;
    const total = messages.length;
    const before = clampInteger(page.before ?? total, 0, total);
    const limit = clampInteger(page.limit ?? 100, 1, 500);
    const start = Math.max(0, before - limit);
    return { messages: messages.slice(start, before), start, total };
  }

  async status(sessionId: string): Promise<ClientSessionStatus> {
    return this.statusFromSession(await this.getOrOpen(sessionId));
  }

  async commands(sessionId: string): Promise<ClientCommand[]> {
    const session = await this.getOrOpen(sessionId);
    const commands: ClientCommand[] = [...BUILTIN_COMMANDS];
    for (const command of session.extensionRunner.getRegisteredCommands()) {
      commands.push({ name: command.invocationName, ...(command.description === undefined ? {} : { description: command.description }), source: "extension" });
    }
    for (const template of session.promptTemplates) {
      commands.push({ name: template.name, description: template.description, source: "prompt" });
    }
    for (const skill of session.resourceLoader.getSkills().skills) {
      commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill" });
    }
    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }

  async prompt(sessionId: string, text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.assertWritable(sessionId);
    const session = await this.getOrOpen(sessionId);
    this.maybeGenerateSessionName(session, text);
    const behavior = session.isStreaming || session.isCompacting ? streamingBehavior ?? "followUp" : undefined;
    this.publishActivity(session, session.isCompacting ? "message queued during compaction" : behavior === "steer" ? "steering queued" : behavior === "followUp" ? "message queued" : "prompt accepted", "active");
    void session.prompt(text, behavior === undefined ? undefined : { streamingBehavior: behavior }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.publishActivity(session, "error", "error", message);
      this.events.publish(sessionId, { type: "session.error", message });
    });
  }

  async shell(sessionId: string, text: string): Promise<void> {
    await this.assertWritable(sessionId);
    const active = await this.getActive(sessionId);
    const { session } = active.runtime;
    const isExcluded = text.startsWith("!!");
    const command = (isExcluded ? text.slice(2) : text.slice(1)).trim();
    if (!command) throw new Error("Usage: !<shell command>");
    if (session.isBashRunning) throw new Error("A bash command is already running");

    this.publishActivity(session, "running bash", "active", command);
    this.events.publish(session.sessionId, { type: "shell.start", command, excludeFromContext: isExcluded });
    void session.executeBash(command, (chunk) => {
      this.events.publish(session.sessionId, { type: "shell.chunk", chunk });
      this.publishActivity(session, "running bash", "active", command);
      this.publishStatus(session);
    }, { excludeFromContext: isExcluded }).then((result) => {
      this.events.publish(session.sessionId, {
        type: "shell.end",
        output: result.output,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        cancelled: result.cancelled,
        truncated: result.truncated,
        ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
      });
      this.publishActivity(session, "bash complete", result.exitCode === 0 ? "idle" : "error", command);
      this.publishStatus(session);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.events.publish(session.sessionId, { type: "shell.end", output: message, isError: true });
      this.events.publish(session.sessionId, { type: "session.error", message });
      this.publishActivity(session, "bash failed", "error", message);
      this.publishStatus(session);
    });
  }

  async runCommand(sessionId: string, text: string): Promise<ClientCommandResult> {
    await this.assertWritable(sessionId);
    return this.commandService.run(sessionId, text);
  }

  async respondToCommand(sessionId: string, requestId: string, value: string): Promise<ClientCommandResult> {
    await this.assertWritable(sessionId);
    return this.commandService.respond(sessionId, requestId, value);
  }

  async archive(sessionId: string): Promise<void> {
    const session = await this.getOrOpen(sessionId);
    if (session.isStreaming || session.isCompacting || session.isBashRunning || session.pendingMessageCount > 0) throw new Error("Stop current session activity before archiving");
    await this.archiveStore.archive(sessionId, session.sessionManager.getCwd());
    this.stop(sessionId);
  }

  async restore(sessionId: string): Promise<void> {
    await this.archiveStore.restore(sessionId);
  }

  async abort(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    await active.runtime.session.abort();
    this.publishActivity(active.runtime.session, "stopped", "idle");
    this.publishStatus(active.runtime.session);
  }

  stop(sessionId: string): void {
    const active = this.active.get(sessionId);
    if (!active) return;
    active.unsubscribe();
    void active.runtime.session.abort().finally(() => active.runtime.dispose());
    this.active.delete(sessionId);
    this.activities.delete(sessionId);
  }

  private async assertWritable(sessionId: string): Promise<void> {
    if (await this.archiveStore.isArchived(sessionId)) throw new Error("Archived sessions are read-only. Restore the session to continue.");
  }

  private async getOrOpen(sessionId: string): Promise<AgentSession> {
    return (await this.getActive(sessionId)).runtime.session;
  }

  private async getActive(sessionId: string): Promise<ActiveSession> {
    const active = this.active.get(sessionId);
    if (active) return active;

    const match = (await SessionManager.listAll()).find((s) => s.id === sessionId || s.id.startsWith(sessionId));
    if (!match) throw new Error("Session not found");
    return this.create(SessionManager.open(match.path), match.cwd);
  }

  private async create(sessionManager: SessionManager, cwd: string): Promise<ActiveSession> {
    const runtime = await createAgentSessionRuntime(this.createRuntime, { cwd, agentDir: this.agentDir, sessionManager });
    const active: ActiveSession = { runtime, unsubscribe: noop };
    this.bindRuntime(active);
    runtime.setRebindSession(() => {
      this.bindRuntime(active);
      return Promise.resolve();
    });
    this.active.set(runtime.session.sessionId, active);
    this.publishStatus(runtime.session);
    return active;
  }

  private bindRuntime(active: ActiveSession): void {
    active.unsubscribe();
    for (const [sessionId, candidate] of this.active.entries()) {
      if (candidate === active) this.active.delete(sessionId);
    }
    const { session } = active.runtime;
    active.unsubscribe = session.subscribe((event) => {
      this.events.publish(session.sessionId, toClientEvent(event));
      this.publishActivityForEvent(session, event);
      this.publishStatus(session);
    });
    this.active.set(session.sessionId, active);
  }

  private maybeGenerateSessionName(session: AgentSession, firstMessage: string): void {
    if (session.sessionName !== undefined || session.messages.length !== 0 || session.isStreaming || session.isCompacting) return;
    const model = session.model;
    if (model === undefined) return;

    void generateShortSessionName(this.modelRegistry, model, firstMessage).then((name) => {
      if (name === undefined || session.sessionName !== undefined) return;
      session.setSessionName(name);
      this.publishSessionName(session);
    }).catch(() => {
      // Session naming is best-effort and must not affect prompt handling.
    });
  }

  private publishSessionName(session: AgentSession): void {
    const event = session.sessionName === undefined
      ? { type: "session.name", sessionId: session.sessionId } as const
      : { type: "session.name", sessionId: session.sessionId, name: session.sessionName } as const;
    this.events.publish(session.sessionId, event);
    this.events.publishGlobal(event);
  }

  private publishHeartbeats(): void {
    for (const active of this.active.values()) {
      const { session } = active.runtime;
      const activity = this.activities.get(session.sessionId);
      const isActive = session.isStreaming || session.isBashRunning || session.isCompacting || session.pendingMessageCount > 0 || activity?.phase === "active";
      if (!isActive) continue;
      this.publishStatus(session);
      if (activity) this.publishActivity(session, activity.label, "active", activity.detail);
      else this.publishActivity(session, this.activityLabelFromStatus(session), "active");
    }
  }

  private activityLabelFromStatus(session: AgentSession): string {
    if (session.isCompacting) return "compacting";
    if (session.isBashRunning) return "running bash";
    if (session.isStreaming) return "agent running";
    if (session.pendingMessageCount) return "queued";
    return "active";
  }

  private publishActivityForEvent(session: AgentSession, event: unknown): void {
    const eventType = getString(event, "type");
    if (eventType === undefined) return;
    if (eventType === "agent_start") { this.publishActivity(session, "agent running", "active"); return; }
    if (eventType === "agent_end") {
      this.publishActivity(session, "idle", "idle");
      setTimeout(() => {
        this.publishActivity(session, "idle", "idle");
        this.publishStatus(session);
      }, 250);
      return;
    }
    if (eventType === "turn_end") { this.publishActivity(session, "turn complete", "active"); return; }
    if (eventType === "message_start") { this.publishActivity(session, "message started", "active"); return; }
    if (eventType === "message_end") { this.publishActivity(session, "message complete", "idle"); return; }
    if (eventType === "message_update") { this.publishActivity(session, "receiving response", "active"); return; }
    if (eventType === "tool_execution_start") { this.publishActivity(session, "running tool", "active", getString(event, "toolName")); return; }
    if (eventType === "tool_execution_end") {
      const isError = getBoolean(event, "isError") === true;
      this.publishActivity(session, isError ? "tool failed" : "tool complete", isError ? "error" : "active", getString(event, "toolName"));
      return;
    }
    if (eventType === "bash_execution_start") { this.publishActivity(session, "running bash", "active"); return; }
    if (eventType === "bash_execution_end") { this.publishActivity(session, "bash complete", "active"); return; }
    this.publishActivity(session, eventType.replaceAll("_", " "), "active");
  }

  private publishActivity(session: AgentSession, label: string, phase: "active" | "idle" | "error", detail?: string): void {
    const at = new Date().toISOString();
    const stored = detail === undefined ? { phase, label, at } : { phase, label, detail, at };
    this.activities.set(session.sessionId, stored);
    const activity = detail === undefined ? { sessionId: session.sessionId, phase, label, at } : { sessionId: session.sessionId, phase, label, detail, at };
    this.events.publish(session.sessionId, { type: "activity.update", activity });
    this.events.publishGlobal({ type: "activity.update", activity });
  }

  private publishStatus(session: AgentSession): void {
    const status = this.statusFromSession(session);
    this.events.publish(session.sessionId, { type: "status.update", status });
    this.events.publishGlobal({ type: "status.update", status });
  }

  private statusFromSession(session: AgentSession): ClientSessionStatus {
    const stats = session.getSessionStats();
    const model = session.model === undefined
      ? undefined
      : (() => {
          const name = getString(session.model, "name");
          const reasoning = getProperty(session.model, "reasoning");
          return {
            provider: session.model.provider,
            id: session.model.id,
            ...(name === undefined ? {} : { name }),
            contextWindow: session.model.contextWindow,
            ...(reasoning === undefined ? {} : { reasoning }),
          };
        })();
    const contextUsage = session.getContextUsage();
    return {
      sessionId: session.sessionId,
      ...(model === undefined ? {} : { model }),
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isBashRunning: session.isBashRunning,
      pendingMessageCount: session.pendingMessageCount,
      tokens: stats.tokens,
      cost: stats.cost,
      ...(contextUsage === undefined ? {} : { contextUsage }),
    };
  }
}

function historyMessages(session: AgentSession): unknown[] {
  const messages: unknown[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === "message") messages.push(entry.message);
    else if (entry.type === "custom_message" && entry.display) messages.push({ role: "custom", content: entry.content, customType: entry.customType, details: entry.details });
    else if (entry.type === "compaction") messages.push({ role: "system", source: "compaction", content: `Compacted history:\n\n${entry.summary}` });
    else if (entry.type === "branch_summary") messages.push({ role: "system", source: "branch_summary", content: `Branch summary:\n\n${entry.summary}` });
  }
  return messages;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function toClientEvent(event: unknown): SessionUiEvent {
  const eventType = getString(event, "type");
  const assistantMessageEvent = getProperty(event, "assistantMessageEvent");
  if (eventType === "message_update" && getString(assistantMessageEvent, "type") === "text_delta") {
    return { type: "assistant.delta", text: getString(assistantMessageEvent, "delta") ?? "" };
  }
  if (eventType === "tool_execution_start") {
    const args = getProperty(event, "args");
    return { type: "tool.start", toolName: getString(event, "toolName") ?? "", toolCallId: getString(event, "toolCallId") ?? "", summary: summarizeToolArgs(args), args };
  }
  if (eventType === "tool_execution_end") {
    const result = getProperty(event, "result");
    return { type: "tool.end", toolName: getString(event, "toolName") ?? "", toolCallId: getString(event, "toolCallId") ?? "", text: stringifyToolResult(result), content: toolResultContent(result), isError: getBoolean(event, "isError") === true };
  }
  if (eventType === "agent_start") return { type: "agent.start" };
  if (eventType === "agent_end") return { type: "agent.end" };
  if (eventType === "message_end") return { type: "message.end" };
  return { type: "pi.event", eventType: eventType ?? "unknown" };
}

function summarizeToolArgs(args: unknown): string {
  if (!isRecord(args)) return stringifyPrimitive(args);
  const command = getString(args, "command");
  if (command !== undefined) return command;
  const path = getString(args, "path");
  if (path !== undefined) return path;
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") return "edit text replacement";
  const edits = args["edits"];
  if (Array.isArray(edits)) return `${String(edits.length)} edit${edits.length === 1 ? "" : "s"}`;
  const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortToolValue(value)}`).join(" · ");
}

function shortToolValue(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object" && value !== null) return "object";
  return "";
}

function toolResultContent(result: unknown): unknown {
  if (isRecord(result)) {
    const content = getProperty(result, "content");
    if (content !== undefined) return content;
    const text = getString(result, "text") ?? getString(result, "output");
    if (text !== undefined) return [{ type: "text", text }];
  }
  if (typeof result === "string") return [{ type: "text", text: result }];
  return result;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(stringifyToolResult).filter((text) => text !== "").join("\n");
  if (isRecord(result)) {
    if (getString(result, "type") === "image") return "[image]";
    const text = getString(result, "text") ?? getString(result, "content") ?? getString(result, "output");
    if (text !== undefined) return text;
    const content = getProperty(result, "content");
    if (Array.isArray(content)) return stringifyToolResult(content);
    return JSON.stringify(result, null, 2);
  }
  return stringifyPrimitive(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  const property = getProperty(value, key);
  return typeof property === "boolean" ? property : undefined;
}

function stringifyPrimitive(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}
