import { ModelRuntime, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Credential, type CredentialStore } from "@earendil-works/pi-ai";
import type { GlobalSessionEvent, SessionUiEvent } from "../../shared/apiTypes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { PiAgentSession, PiSessionManager, PiSessionRuntime, PiSessionServiceDependencies } from "./piSessionService.js";

export class CapturingSessionEventHub extends SessionEventHub {
  readonly sessionEvents: { sessionId: string; event: SessionUiEvent }[] = [];
  readonly globalEvents: GlobalSessionEvent[] = [];
  private readonly seqBySessionOverride = new Map<string, number>();

  override publish(sessionId: string, event: SessionUiEvent): void {
    this.sessionEvents.push({ sessionId, event });
  }

  override publishGlobal(event: GlobalSessionEvent): void {
    this.globalEvents.push(event);
  }

  /** Test seam: set the per-session watermark returned by {@link currentSeq}. */
  setSeq(sessionId: string, value: number): void {
    this.seqBySessionOverride.set(sessionId, value);
  }

  override currentSeq(sessionId: string): number {
    return this.seqBySessionOverride.get(sessionId) ?? 0;
  }
}

export type SessionGateway = NonNullable<PiSessionServiceDependencies["sessionManager"]>;
export type RuntimeCreator = NonNullable<PiSessionServiceDependencies["createAgentRuntime"]>;

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

/**
 * Seed a credential into an {@link InMemoryCredentialStore}. `modify` is the
 * only write path on the pi-ai `CredentialStore` contract, so tests that need a
 * pre-populated store go through it rather than mutating internals.
 */
export async function seedCredential(store: InMemoryCredentialStore, providerId: string, credential: Credential): Promise<void> {
  await store.modify(providerId, () => Promise.resolve(credential));
}

/**
 * Build a real {@link ModelRuntime} over an in-memory credential store — the
 * async test seam that replaces the removed `ModelRegistry.create(AuthStorage
 * .inMemory())`. Pass a pre-seeded store to exercise credential-dependent
 * behavior (e.g. auth-loss warnings).
 */
export function createTestModelRuntime(credentials: CredentialStore = new InMemoryCredentialStore()): Promise<ModelRuntime> {
  return ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
}

/**
 * Shared runtime for the common case where a test only needs model catalog
 * reads and no configured auth. Built once so the many `fakeRuntime` sessions
 * and `PiSessionService` constructions can inject it synchronously.
 */
export const testModelRuntime = await createTestModelRuntime();

const testExtensionUiContext: ExtensionUIContext = {
  select: () => Promise.resolve(undefined),
  confirm: () => Promise.resolve(false),
  input: () => Promise.resolve(undefined),
  notify() { /* no-op */ },
  onTerminalInput: () => () => undefined,
  setStatus() { /* no-op */ },
  setWorkingMessage() { /* no-op */ },
  setWorkingVisible() { /* no-op */ },
  setWorkingIndicator() { /* no-op */ },
  setHiddenThinkingLabel() { /* no-op */ },
  setWidget() { /* no-op */ },
  setFooter() { /* no-op */ },
  setHeader() { /* no-op */ },
  setTitle() { /* no-op */ },
  custom: () => Promise.reject(new Error("Custom extension UI is unavailable in tests")),
  pasteToEditor() { /* no-op */ },
  setEditorText() { /* no-op */ },
  getEditorText: () => "",
  editor: () => Promise.resolve(undefined),
  addAutocompleteProvider() { /* no-op */ },
  setEditorComponent() { /* no-op */ },
  getEditorComponent: () => undefined,
  get theme(): ExtensionUIContext["theme"] { throw new Error("Extension UI theme is unavailable in tests"); },
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "Extension UI is unavailable in tests" }),
  getToolsExpanded: () => false,
  setToolsExpanded() { /* no-op */ },
};

export function testModel(): NonNullable<PiAgentSession["model"]> {
  const model = testModelRuntime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
  if (model === undefined) throw new Error("test model not found");
  return model;
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
    state: {},
    sessionName: undefined,
    model: undefined,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    sessionManager: fakeSessionManager(),
    settingsManager: { getWarnings: () => ({}), setWarnings: () => undefined },
    modelRuntime: testModelRuntime,
    scopedModels: [],
    extensionRunner: {
      getRegisteredCommands: () => [],
      getUIContext: () => testExtensionUiContext,
    },
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
