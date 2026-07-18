import crypto from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CommandOption, OAuthFlowState } from "../../shared/apiTypes.js";

/** The single runtime capability this service drives — narrowed for testable DI. */
type OAuthLoginRuntime = Pick<ModelRuntime, "login">;
type TimerHandle = ReturnType<typeof setTimeout>;
type SelectPrompt = Extract<AuthPrompt, { type: "select" }>;
type ValuePrompt = Exclude<AuthPrompt, { type: "select" }>;

interface PendingOAuthRequest {
  requestId: string;
  allowEmpty: boolean;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  allowedValues?: ReadonlySet<string>;
  cleanup?: () => void;
}

interface OAuthFlowRecord {
  flowId: string;
  state: OAuthFlowState;
  abort: AbortController;
  pending: PendingOAuthRequest | undefined;
  terminalAt?: number;
  cleanupTimer?: TimerHandle;
}

export interface OAuthLoginFlowLogger {
  error(details: Record<string, unknown>, message: string): void;
}

export interface OAuthLoginFlowServiceOptions {
  terminalTtlMs?: number;
  runningTtlMs?: number;
  now?: () => number;
  logger?: OAuthLoginFlowLogger;
}

const DEFAULT_TERMINAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RUNNING_TTL_MS = 30 * 60 * 1000;
const noopLogger: OAuthLoginFlowLogger = { error() { /* no-op */ } };

/**
 * AuthInteraction transport shared by OAuth and provider-driven API-key login.
 * The historical class and wire names remain for rolling browser/sessiond compatibility.
 */
export class OAuthLoginFlowService {
  private readonly flows = new Map<string, OAuthFlowRecord>();
  private readonly terminalTtlMs: number;
  private readonly runningTtlMs: number;
  private readonly now: () => number;
  private readonly logger: OAuthLoginFlowLogger;

  constructor(options: OAuthLoginFlowServiceOptions = {}) {
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
    this.runningTtlMs = options.runningTtlMs ?? DEFAULT_RUNNING_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? noopLogger;
  }

  start(options: {
    providerId: string;
    providerName: string;
    runtime: OAuthLoginRuntime;
    /** Defaults to OAuth so established callers retain their existing behavior. */
    authType?: AuthType;
    onComplete?: () => void | Promise<void>;
  }): OAuthFlowState {
    const flowId = crypto.randomUUID();
    const abort = new AbortController();
    const record: OAuthFlowRecord = {
      flowId,
      abort,
      pending: undefined,
      state: {
        flowId,
        providerId: options.providerId,
        providerName: options.providerName,
        status: "running",
        progress: [],
      },
    };
    this.flows.set(flowId, record);
    this.scheduleRunningExpiry(record);

    // Adapt the pi-ai AuthInteraction contract onto the web-UI flow state:
    // `prompt()` returns the entered/selected string; `notify()` surfaces
    // out-of-band login events (auth URL, device code, progress).
    const interaction: AuthInteraction = {
      signal: abort.signal,
      prompt: (prompt) => this.handlePrompt(record, prompt),
      notify: (event) => { this.handleEvent(record, event); },
    };

    void options.runtime.login(options.providerId, options.authType ?? "oauth", interaction).then(
      () => this.reconcileCommittedLogin(record, options.onComplete),
      (error: unknown) => {
        if (!this.isCurrent(record)) return;
        this.clearPending(record);
        if (record.state.status !== "running") return;
        this.markTerminal(record, { ...withoutInteraction(record.state), status: "error", error: error instanceof Error ? error.message : String(error) });
      },
    );

    return this.get(flowId);
  }

  get(flowId: string): OAuthFlowState {
    const record = this.flows.get(flowId);
    if (record === undefined) throw new Error("Login flow not found");
    return cloneState(record.state);
  }

  respond(flowId: string, requestId: string, value: string): OAuthFlowState {
    const record = this.flows.get(flowId);
    if (record === undefined) throw new Error("Login flow not found");
    if (record.state.status !== "running") return cloneState(record.state);
    const pending = record.pending;
    if (pending?.requestId !== requestId) throw new Error("Login request expired");
    if (!pending.allowEmpty && value.trim() === "") throw new Error("A value is required");
    if (pending.allowedValues !== undefined && !pending.allowedValues.has(value)) throw new Error("Invalid login selection");
    this.clearPending(record);
    this.updateState(record, withoutInteraction(record.state));
    pending.resolve(value);
    return cloneState(record.state);
  }

  cancel(flowId: string): OAuthFlowState {
    const record = this.flows.get(flowId);
    if (record === undefined) throw new Error("Login flow not found");
    if (record.state.status === "running") {
      record.abort.abort();
      const pending = this.clearPending(record);
      this.markTerminal(record, { ...withoutInteraction(record.state), status: "cancelled", error: "Login cancelled" });
      pending?.reject(new Error("Login cancelled"));
    }
    return cloneState(record.state);
  }

  dispose(): void {
    for (const record of this.flows.values()) {
      this.clearTimer(record);
      record.abort.abort();
      const pending = this.clearPending(record);
      pending?.reject(new Error("Login cancelled"));
    }
    this.flows.clear();
  }

  private handlePrompt(record: OAuthFlowRecord, prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") return this.waitForSelect(record, prompt);
    return this.waitForPrompt(record, prompt);
  }

  private handleEvent(record: OAuthFlowRecord, event: AuthEvent): void {
    if (!this.isCurrentRunning(record)) return;
    switch (event.type) {
      case "auth_url":
        this.updateState(record, { ...record.state, auth: { url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) } });
        return;
      // Keep the legacy auth URL/instructions while adding structured metadata
      // that newer browsers can use during rolling sessiond upgrades.
      case "device_code":
        this.updateState(record, {
          ...record.state,
          auth: {
            url: event.verificationUri,
            instructions: `Enter code: ${event.userCode}`,
            deviceCode: {
              userCode: event.userCode,
              ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
              ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
            },
          },
        });
        return;
      case "info":
        this.updateState(record, {
          ...record.state,
          progress: [...record.state.progress, event.message],
          info: [
            ...(record.state.info ?? []),
            {
              message: event.message,
              ...(event.links === undefined ? {} : {
                links: event.links.map((link) => ({
                  url: link.url,
                  ...(link.label === undefined ? {} : { label: link.label }),
                })),
              }),
            },
          ],
        });
        return;
      case "progress":
        this.updateState(record, { ...record.state, progress: [...record.state.progress, event.message] });
        return;
    }
  }

  private waitForPrompt(record: OAuthFlowRecord, prompt: ValuePrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.isCurrentRunning(record)) {
        reject(new Error("Login cancelled"));
        return;
      }
      const requestId = crypto.randomUUID();
      const pending: PendingOAuthRequest = {
        requestId,
        allowEmpty: prompt.type === "text",
        resolve,
        reject,
      };
      record.pending = pending;
      if (!this.bindPromptSignal(record, pending, prompt.signal)) return;
      const base = withoutInteraction(record.state);
      this.updateState(record, {
        ...base,
        prompt: {
          requestId,
          message: prompt.message,
          kind: prompt.type === "manual_code" ? "manual" : "prompt",
          promptType: prompt.type,
          ...(prompt.type === "text" ? { allowEmpty: true } : {}),
          ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
        },
      });
    });
  }

  private waitForSelect(record: OAuthFlowRecord, prompt: SelectPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.isCurrentRunning(record)) {
        reject(new Error("Login cancelled"));
        return;
      }
      const requestId = crypto.randomUUID();
      const options: CommandOption[] = prompt.options.map((option) => ({
        value: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      }));
      const pending: PendingOAuthRequest = {
        requestId,
        allowEmpty: false,
        resolve,
        reject,
        allowedValues: new Set(options.map((option) => option.value)),
      };
      record.pending = pending;
      if (!this.bindPromptSignal(record, pending, prompt.signal)) return;
      const base = withoutInteraction(record.state);
      this.updateState(record, { ...base, select: { requestId, message: prompt.message, options } });
    });
  }

  // A prompt may carry its own AbortSignal (e.g. a manual_code prompt raced
  // against a callback server). When it fires, drop just that pending request
  // and clear the interaction from state — the overall login keeps running.
  private bindPromptSignal(record: OAuthFlowRecord, pending: PendingOAuthRequest, signal?: AbortSignal): boolean {
    if (signal === undefined) return true;
    const onAbort = () => {
      if (record.pending !== pending) return;
      this.clearPending(record);
      if (this.isCurrentRunning(record)) this.updateState(record, withoutInteraction(record.state));
      pending.reject(new Error("Prompt cancelled"));
    };
    pending.cleanup = () => { signal.removeEventListener("abort", onAbort); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return false;
    }
    return true;
  }

  private clearPending(record: OAuthFlowRecord): PendingOAuthRequest | undefined {
    const pending = record.pending;
    record.pending = undefined;
    pending?.cleanup?.();
    return pending;
  }

  // ModelRuntime persists the credential before its post-login refresh. If a
  // cancellation lands during that refresh, the resolved login is committed
  // truth and must supersede the transient cancelled state.
  private async reconcileCommittedLogin(record: OAuthFlowRecord, onComplete?: () => void | Promise<void>): Promise<void> {
    if (this.isCurrent(record)) this.clearPending(record);
    try {
      await onComplete?.();
    } catch (error) {
      this.logErrorNoThrow(
        { err: error, flowId: record.flowId, providerId: record.state.providerId },
        "login completion callback failed",
      );
    }
    if (!this.isCurrent(record)) return;
    const completed = withoutInteraction(record.state);
    delete completed.error;
    this.markTerminal(record, { ...completed, status: "complete", progress: [...record.state.progress, "Login complete"] });
  }

  private isCurrent(record: OAuthFlowRecord): boolean {
    return this.flows.get(record.flowId) === record;
  }

  private isCurrentRunning(record: OAuthFlowRecord): boolean {
    return this.isCurrent(record) && record.state.status === "running";
  }

  private logErrorNoThrow(details: Record<string, unknown>, message: string): void {
    try {
      this.logger.error(details, message);
    } catch {
      // Logging is post-commit diagnostics and must never change auth truth.
    }
  }

  private updateState(record: OAuthFlowRecord, state: OAuthFlowState): void {
    record.state = state;
  }

  private markTerminal(record: OAuthFlowRecord, state: OAuthFlowState): void {
    this.updateState(record, state);
    record.terminalAt = this.now();
    this.scheduleTerminalEviction(record);
  }

  private scheduleRunningExpiry(record: OAuthFlowRecord): void {
    if (this.runningTtlMs <= 0) {
      this.expireRunningFlow(record);
      return;
    }
    this.setTimer(record, this.runningTtlMs, () => { this.expireRunningFlow(record); });
  }

  private scheduleTerminalEviction(record: OAuthFlowRecord): void {
    if (this.terminalTtlMs <= 0) {
      this.flows.delete(record.flowId);
      this.clearTimer(record);
      return;
    }
    this.setTimer(record, this.terminalTtlMs, () => {
      if (this.flows.get(record.flowId) !== record) return;
      if (record.terminalAt === undefined) return;
      if (this.now() - record.terminalAt < this.terminalTtlMs) {
        this.scheduleTerminalEviction(record);
        return;
      }
      this.flows.delete(record.flowId);
      this.clearTimer(record);
    });
  }

  private expireRunningFlow(record: OAuthFlowRecord): void {
    if (!this.isCurrentRunning(record)) return;
    record.abort.abort();
    const pending = this.clearPending(record);
    this.markTerminal(record, { ...withoutInteraction(record.state), status: "error", error: "Login flow expired" });
    pending?.reject(new Error("Login flow expired"));
  }

  private setTimer(record: OAuthFlowRecord, delayMs: number, callback: () => void): void {
    this.clearTimer(record);
    record.cleanupTimer = setTimeout(callback, delayMs);
    unrefTimer(record.cleanupTimer);
  }

  private clearTimer(record: OAuthFlowRecord): void {
    if (record.cleanupTimer === undefined) return;
    clearTimeout(record.cleanupTimer);
    delete record.cleanupTimer;
  }
}

function withoutInteraction(state: OAuthFlowState): OAuthFlowState {
  const rest = { ...state };
  delete rest.prompt;
  delete rest.select;
  return rest;
}

function cloneState(state: OAuthFlowState): OAuthFlowState {
  return {
    ...state,
    progress: [...state.progress],
    ...(state.auth === undefined ? {} : {
      auth: {
        ...state.auth,
        ...(state.auth.deviceCode === undefined ? {} : { deviceCode: { ...state.auth.deviceCode } }),
      },
    }),
    ...(state.prompt === undefined ? {} : { prompt: { ...state.prompt } }),
    ...(state.select === undefined ? {} : { select: { ...state.select, options: state.select.options.map((option) => ({ ...option })) } }),
    ...(state.info === undefined ? {} : {
      info: state.info.map((item) => ({
        ...item,
        ...(item.links === undefined ? {} : { links: item.links.map((link) => ({ ...link })) }),
      })),
    }),
  };
}

function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "object" || !("unref" in timer) || typeof timer.unref !== "function") return;
  timer.unref();
}
