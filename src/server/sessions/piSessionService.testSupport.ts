import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { GlobalSessionEvent, SessionUiEvent } from "../../shared/apiTypes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { PiAgentSession, PiSessionManager, PiSessionRuntime, PiSessionServiceDependencies } from "./piSessionService.js";

export class CapturingSessionEventHub extends SessionEventHub {
  readonly sessionEvents: { sessionId: string; event: SessionUiEvent }[] = [];
  readonly globalEvents: GlobalSessionEvent[] = [];

  override publish(sessionId: string, event: SessionUiEvent): void {
    this.sessionEvents.push({ sessionId, event });
  }

  override publishGlobal(event: GlobalSessionEvent): void {
    this.globalEvents.push(event);
  }
}

export type SessionGateway = NonNullable<PiSessionServiceDependencies["sessionManager"]>;
export type RuntimeCreator = NonNullable<PiSessionServiceDependencies["createAgentRuntime"]>;
export const unreachableRuntimeFactory: NonNullable<PiSessionServiceDependencies["createRuntime"]> = () => Promise.reject(
  new Error("Test unexpectedly invoked the Pi session runtime factory"),
);

export interface TestSession extends PiAgentSession {
  sessionName: string | undefined;
  model: PiAgentSession["model"];
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  getSteeringMessages: () => readonly string[];
  getFollowUpMessages: () => readonly string[];
}

export function fakeSessionManager(cwd = "/workspace", patch: Partial<PiSessionManager> = {}): PiSessionManager {
  return {
    getCwd: () => cwd,
    getSessionId: () => "session-1",
    getSessionFile: () => undefined,
    getBranch: () => [],
    getLeafId: () => "leaf-1",
    ...patch,
  };
}

export function sessionRecord(id: string, cwd = "/workspace") {
  return { id, path: `/sessions/${id}.jsonl`, cwd, created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" };
}

export function sessionRef(id: string, cwd = "/workspace") {
  return { id, cwd };
}

export const TEST_MODEL_PROVIDER = "anthropic";
export const TEST_MODEL_ID = "claude-sonnet-4-5-20250929";

export function testModel(): NonNullable<PiAgentSession["model"]> {
  return getBuiltinModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
}

export function fakeModelRuntime(): PiAgentSession["modelRuntime"] {
  const model = testModel();
  return {
    reloadConfig: () => Promise.resolve(),
    getAvailableSnapshot: () => [model],
    getModel: (provider: string, modelId: string) => provider === model.provider && modelId === model.id ? model : undefined,
    getProviderAuthStatus: () => ({ configured: true }),
  };
}

export function fakeRuntime(sessionId = "session-1", patch: Partial<TestSession> = {}) {
  const promptCalls: { text: string; options: unknown }[] = [];
  const customMessageCalls: { message: { customType: string; content: string; display: boolean; details?: unknown }; options: unknown }[] = [];
  const bindExtensionCalls: unknown[] = [];
  const listeners: ((event: unknown) => void)[] = [];
  const calls = { abort: 0, bindExtensions: bindExtensionCalls, clearQueue: 0, dispose: 0, prompt: promptCalls, reload: 0, sendCustomMessage: customMessageCalls };
  const session: TestSession = {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    messages: [],
    sessionName: undefined,
    model: undefined,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    sessionManager: fakeSessionManager(),
    modelRuntime: fakeModelRuntime(),
    scopedModels: [],
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    bindExtensions: (bindings: unknown) => {
      calls.bindExtensions.push(bindings);
      return Promise.resolve();
    },
    getSessionStats: () => ({ sessionId, totalMessages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    reload: () => {
      calls.reload += 1;
      return Promise.resolve();
    },
    prompt: (text: string, options: unknown) => {
      calls.prompt.push({ text, options });
      return Promise.resolve();
    },
    sendCustomMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }, options: unknown) => {
      calls.sendCustomMessage.push({ message, options });
      return Promise.resolve();
    },
    executeBash: () => Promise.resolve({ output: "", exitCode: 0, cancelled: false, truncated: false }),
    abort: () => {
      calls.abort += 1;
      return Promise.resolve();
    },
    clearQueue: () => {
      calls.clearQueue += 1;
      return { steering: [], followUp: [] };
    },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    setModel: () => Promise.resolve(),
    cycleModel: () => Promise.resolve(undefined),
    getAvailableThinkingLevels: () => [],
    setThinkingLevel: () => undefined,
    cycleThinkingLevel: () => undefined,
    setSessionName: (name: string) => { session.sessionName = name; },
    compact: () => Promise.resolve({ summary: "", tokensBefore: 0 }),
    getUserMessagesForForking: () => [],
    agent: { streamFn: () => { throw new Error("streamFn should not be called in this test"); } },
    ...patch,
  };
  const runtime: PiSessionRuntime = {
    cwd: session.sessionManager.getCwd(),
    session,
    setRebindSession: () => undefined,
    fork: () => Promise.resolve({ cancelled: false }),
    dispose: () => {
      calls.dispose += 1;
      return Promise.resolve();
    },
  };
  return { runtime, session, calls, emit: (event: unknown) => { for (const listener of [...listeners]) listener(event); } };
}

export function runtimeCreator(runtime: PiSessionRuntime): RuntimeCreator {
  return async () => {
    await Promise.resolve();
    return runtime;
  };
}

export function sessionGateway(records: ReturnType<typeof sessionRecord>[]): SessionGateway {
  return {
    create: () => fakeSessionManager(),
    list: () => Promise.resolve(records),
    open: () => fakeSessionManager(),
  };
}

export function emptyArchiveStore(): NonNullable<PiSessionServiceDependencies["archiveStore"]> {
  return {
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    archive: () => Promise.reject(new Error("archive should not be called")),
    restore: () => Promise.resolve(),
    isArchived: () => Promise.resolve(false),
  };
}
