import crypto from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { CommandOption, OAuthFlowState } from "../../shared/apiTypes.js";

type TimerHandle = ReturnType<typeof setTimeout>;
type LoginRunner = (interaction: AuthInteraction) => Promise<unknown>;
type SelectPrompt = Extract<AuthPrompt, { type: "select" }>;
type ValuePrompt = Exclude<AuthPrompt, { type: "select" }>;

interface PendingOAuthRequest {
  requestId: string;
  allowEmpty: boolean;
  resolve: (value: string | undefined) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
  allowedValues?: ReadonlySet<string>;
}

interface OAuthFlowRecord {
  flowId: string;
  state: OAuthFlowState;
  abort: AbortController;
  pending: PendingOAuthRequest | undefined;
  terminalAt?: number;
  cleanupTimer?: TimerHandle;
}

export interface OAuthLoginFlowServiceOptions {
  terminalTtlMs?: number;
  runningTtlMs?: number;
  now?: () => number;
}

const DEFAULT_TERMINAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RUNNING_TTL_MS = 30 * 60 * 1000;

export class OAuthLoginFlowService {
  private readonly flows = new Map<string, OAuthFlowRecord>();
  private readonly terminalTtlMs: number;
  private readonly runningTtlMs: number;
  private readonly now: () => number;

  constructor(options: OAuthLoginFlowServiceOptions = {}) {
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
    this.runningTtlMs = options.runningTtlMs ?? DEFAULT_RUNNING_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  start(options: {
    providerId: string;
    providerName: string;
    login: LoginRunner;
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

    const interaction: AuthInteraction = {
      signal: abort.signal,
      prompt: (prompt) => {
        if (prompt.type === "select") return this.waitForSelect(record, prompt);
        return this.waitForPrompt(record, prompt);
      },
      notify: (event) => {
        this.handleEvent(record, event);
      },
    };

    void options.login(interaction)
      .then(async () => {
        if (!this.isCurrentRunning(record)) return;
        this.clearPending(record);
        await options.onComplete?.();
        if (!this.isCurrentRunning(record)) return;
        this.markTerminal(record, { ...withoutInteraction(record.state), status: "complete", progress: [...record.state.progress, "Login complete"] });
      })
      .catch((error: unknown) => {
        if (this.flows.get(record.flowId) !== record) return;
        this.clearPending(record);
        if (record.state.status !== "running") return;
        this.markTerminal(record, { ...withoutInteraction(record.state), status: "error", error: error instanceof Error ? error.message : String(error) });
      });

    return this.get(flowId);
  }

  get(flowId: string): OAuthFlowState {
    const record = this.flows.get(flowId);
    if (record === undefined) throw new Error("OAuth login flow not found");
    return cloneState(record.state);
  }

  respond(flowId: string, requestId: string, value: string): OAuthFlowState {
    const record = this.flows.get(flowId);
    if (record === undefined) throw new Error("OAuth login flow not found");
    if (record.state.status !== "running") return cloneState(record.state);
    const pending = record.pending;
    if (pending?.requestId !== requestId) throw new Error("OAuth login request expired");
    if (!pending.allowEmpty && value.trim() === "") throw new Error("A value is required");
    if (pending.allowedValues !== undefined && !pending.allowedValues.has(value)) throw new Error("Invalid OAuth selection");
    record.pending = undefined;
    pending.cleanup?.();
    this.updateState(record, withoutInteraction(record.state));
    pending.resolve(value);
    return cloneState(record.state);
  }

  cancel(flowId: string): OAuthFlowState {
    const record = this.flows.get(flowId);
    if (record === undefined) throw new Error("OAuth login flow not found");
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

  private handleEvent(record: OAuthFlowRecord, event: AuthEvent): void {
    if (!this.isCurrentRunning(record)) return;
    if (event.type === "auth_url") {
      this.updateState(record, { ...record.state, auth: { url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) } });
      return;
    }
    if (event.type === "device_code") {
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
    }
    if (event.type === "info") {
      const link = event.links?.[0];
      this.updateState(record, {
        ...record.state,
        progress: [...record.state.progress, event.message],
        ...(link === undefined ? {} : { auth: { url: link.url, instructions: event.message } }),
      });
      return;
    }
    this.updateState(record, { ...record.state, progress: [...record.state.progress, event.message] });
  }

  private waitForPrompt(record: OAuthFlowRecord, prompt: ValuePrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.isCurrentRunning(record)) {
        reject(new Error("Login cancelled"));
        return;
      }
      const requestId = crypto.randomUUID();
      const onAbort = () => {
        if (record.pending?.requestId !== requestId) return;
        const pending = this.clearPending(record);
        this.updateState(record, withoutInteraction(record.state));
        pending?.reject(new Error("Login cancelled"));
      };
      const pending: PendingOAuthRequest = {
        requestId,
        allowEmpty: false,
        resolve: (value) => { resolve(value ?? ""); },
        reject,
        cleanup: () => { prompt.signal?.removeEventListener("abort", onAbort); },
      };
      record.pending = pending;
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      if (prompt.signal?.aborted === true) {
        onAbort();
        return;
      }
      const base = withoutInteraction(record.state);
      this.updateState(record, {
        ...base,
        prompt: {
          requestId,
          message: prompt.message,
          kind: prompt.type === "manual_code" ? "manual-code" : prompt.type,
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
      const onAbort = () => {
        if (record.pending?.requestId !== requestId) return;
        const pending = this.clearPending(record);
        this.updateState(record, withoutInteraction(record.state));
        pending?.reject(new Error("Login cancelled"));
      };
      const options: CommandOption[] = prompt.options.map((option) => ({
        value: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      }));
      const pending: PendingOAuthRequest = {
        requestId,
        allowEmpty: false,
        resolve: (value) => { resolve(value ?? ""); },
        reject,
        cleanup: () => { prompt.signal?.removeEventListener("abort", onAbort); },
        allowedValues: new Set(options.map((option) => option.value)),
      };
      record.pending = pending;
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      if (prompt.signal?.aborted === true) {
        onAbort();
        return;
      }
      const base = withoutInteraction(record.state);
      this.updateState(record, { ...base, select: { requestId, message: prompt.message, options } });
    });
  }

  private clearPending(record: OAuthFlowRecord): PendingOAuthRequest | undefined {
    const pending = record.pending;
    record.pending = undefined;
    pending?.cleanup?.();
    return pending;
  }

  private isCurrentRunning(record: OAuthFlowRecord): boolean {
    return this.flows.get(record.flowId) === record && record.state.status === "running";
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
    this.markTerminal(record, { ...withoutInteraction(record.state), status: "error", error: "OAuth login flow expired" });
    pending?.reject(new Error("OAuth login flow expired"));
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
  };
}

function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "object" || !("unref" in timer) || typeof timer.unref !== "function") return;
  timer.unref();
}
