import type {
  AutomationModelPolicy,
  AutomationThinkingPolicy,
  AutomationUsageSnapshot,
  SessionModel,
  SessionStatus,
} from "../../shared/apiTypes.js";

export interface AutomationSessionService {
  startAutomation(cwd: string): Promise<{ id: string; cwd: string }>;
  automationModels(): SessionModel[];
  setAutomationModel(ref: { id: string; cwd: string }, provider: string, modelId: string): Promise<SessionStatus>;
  setAutomationThinkingLevel(ref: { id: string; cwd: string }, level: string): Promise<SessionStatus>;
  status(ref: { id: string; cwd: string }): Promise<SessionStatus>;
  promptAndWait(ref: { id: string; cwd: string }, text: string): Promise<SessionStatus>;
  abortAutomation(ref: { id: string; cwd: string }): Promise<void>;
  forceStopAndWait(ref: { id: string; cwd: string }): Promise<void>;
  releaseAutomationSession(ref: { id: string; cwd: string }): void;
}

export interface CreatedAutomationSession {
  sessionId: string;
  cwd: string;
  actualModel?: SessionModel;
  actualThinkingLevel?: string;
}

export class AutomationSessionRunner {
  constructor(private readonly sessions: AutomationSessionService) {}

  models(): SessionModel[] {
    return this.sessions.automationModels();
  }

  async create(input: {
    cwd: string;
    model: AutomationModelPolicy;
    thinking: AutomationThinkingPolicy;
  }, onCreated: (session: CreatedAutomationSession) => void): Promise<CreatedAutomationSession> {
    if (input.model.mode === "fixed") this.requireAvailableModel(input.model.provider, input.model.id);
    const created = await this.sessions.startAutomation(input.cwd);
    const ref = { id: created.id, cwd: input.cwd };
    onCreated({ sessionId: created.id, cwd: input.cwd });
    try {
      let status = input.model.mode === "fixed"
        ? await this.sessions.setAutomationModel(ref, input.model.provider, input.model.id)
        : await this.sessions.status(ref);
      if (input.thinking.mode === "fixed") status = await this.sessions.setAutomationThinkingLevel(ref, input.thinking.level);
      return {
        sessionId: created.id,
        cwd: input.cwd,
        ...(status.model === undefined ? {} : { actualModel: status.model }),
        ...(status.thinkingLevel === undefined ? {} : { actualThinkingLevel: status.thinkingLevel }),
      };
    } catch (error) {
      await this.sessions.forceStopAndWait(ref).catch(() => undefined);
      throw error;
    }
  }

  async run(session: CreatedAutomationSession, prompt: string, capturedAt: () => string): Promise<AutomationUsageSnapshot> {
    const status = await this.sessions.promptAndWait({ id: session.sessionId, cwd: session.cwd }, prompt);
    return usageFromStatus(status, capturedAt());
  }

  async snapshot(session: CreatedAutomationSession, capturedAt: string): Promise<AutomationUsageSnapshot | undefined> {
    try {
      return usageFromStatus(await this.sessions.status({ id: session.sessionId, cwd: session.cwd }), capturedAt);
    } catch {
      return undefined;
    }
  }

  abort(session: CreatedAutomationSession): Promise<void> {
    return this.sessions.abortAutomation({ id: session.sessionId, cwd: session.cwd });
  }

  forceStop(session: CreatedAutomationSession): Promise<void> {
    return this.sessions.forceStopAndWait({ id: session.sessionId, cwd: session.cwd });
  }

  release(session: CreatedAutomationSession): void {
    this.sessions.releaseAutomationSession({ id: session.sessionId, cwd: session.cwd });
  }

  private requireAvailableModel(provider: string, modelId: string): void {
    const available = this.models().some((model) => model.provider === provider && model.id === modelId);
    if (!available) throw new Error(`Configured model is unavailable: ${provider}/${modelId}`);
  }
}

function usageFromStatus(status: SessionStatus, capturedAt: string): AutomationUsageSnapshot {
  return {
    scope: "root_session",
    quality: "estimated",
    tokens: status.tokens,
    ...(Number.isFinite(status.cost) ? { estimatedCostMicros: Math.max(0, Math.round(status.cost * 1_000_000)) } : {}),
    capturedAt,
  };
}
