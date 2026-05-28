import crypto from "node:crypto";
import type { OAuthDeviceCodeInfo, OAuthLoginCallbacks, OAuthSelectPrompt, OAuthPrompt } from "@earendil-works/pi-ai";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { CommandOption, OAuthFlowState } from "../../shared/apiTypes.js";

type OAuthLoginStorage = Pick<AuthStorage, "login">;
type TimerHandle = ReturnType<typeof setTimeout>;

interface PendingOAuthRequest {
  requestId: string;
  allowEmpty: boolean;
  resolve: (value: string | undefined) => void;
  reject: (error: Error) => void;
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
    authStorage: OAuthLoginStorage;
    onComplete?: () => void;
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

    const callbacks: OAuthLoginCallbacks = {
      signal: abort.signal,
      onAuth: (info) => {
        if (!this.isCurrentRunning(record)) return;
        const state = { ...record.state };
        delete state.deviceCode;
        this.updateState(record, { ...state, auth: info });
      },
      onDeviceCode: (info) => {
        if (!this.isCurrentRunning(record)) return;
        const state = { ...record.state };
        delete state.auth;
        this.updateState(record, { ...state, deviceCode: toFlowDeviceCode(info) });
      },
      onPrompt: (prompt) => this.waitForPrompt(record, prompt, "prompt"),
      onManualCodeInput: () => this.waitForPrompt(record, { message: "Paste the callback URL or authorization code", allowEmpty: false }, "manual"),
      onSelect: (prompt) => this.waitForSelect(record, prompt),
      onProgress: (message) => {
        if (!this.isCurrentRunning(record)) return;
        this.updateState(record, { ...record.state, progress: [...record.state.progress, message] });
      },
    };

    void options.authStorage.login(options.providerId, callbacks)
      .then(() => {
        if (!this.isCurrentRunning(record)) return;
        record.pending = undefined;
        this.markTerminal(record, { ...withoutInteraction(record.state), status: "complete", progress: [...record.state.progress, "Login complete"] });
        options.onComplete?.();
      })
      .catch((error: unknown) => {
        if (this.flows.get(record.flowId) !== record) return;
        record.pending = undefined;
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
    record.pending = undefined;
    this.updateState(record, withoutInteraction(record.state));
    pending.resolve(value);
    return cloneState(record.state);
  }

  cancel(flowId: string): OAuthFlowState {
    const record = this.flows.get(flowId);
    if (record === undefined) throw new Error("OAuth login flow not found");
    if (record.state.status === "running") {
      record.abort.abort();
      const pending = record.pending;
      record.pending = undefined;
      this.markTerminal(record, { ...withoutInteraction(record.state), status: "cancelled", error: "Login cancelled" });
      pending?.reject(new Error("Login cancelled"));
    }
    return cloneState(record.state);
  }

  dispose(): void {
    for (const record of this.flows.values()) {
      this.clearTimer(record);
      record.abort.abort();
      const pending = record.pending;
      record.pending = undefined;
      pending?.reject(new Error("Login cancelled"));
    }
    this.flows.clear();
  }

  private waitForPrompt(record: OAuthFlowRecord, prompt: OAuthPrompt, kind: "prompt" | "manual"): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.isCurrentRunning(record)) {
        reject(new Error("Login cancelled"));
        return;
      }
      const requestId = crypto.randomUUID();
      record.pending = { requestId, allowEmpty: prompt.allowEmpty === true, resolve: (value) => { resolve(value ?? ""); }, reject };
      const base = withoutInteraction(record.state);
      this.updateState(record, {
        ...base,
        prompt: {
          requestId,
          message: prompt.message,
          kind,
          ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
          ...(prompt.allowEmpty === true ? { allowEmpty: true } : {}),
        },
      });
    });
  }

  private waitForSelect(record: OAuthFlowRecord, prompt: OAuthSelectPrompt): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      if (!this.isCurrentRunning(record)) {
        reject(new Error("Login cancelled"));
        return;
      }
      const requestId = crypto.randomUUID();
      const options: CommandOption[] = prompt.options.map((option) => ({ value: option.id, label: option.label }));
      record.pending = { requestId, allowEmpty: true, resolve, reject };
      const base = withoutInteraction(record.state);
      this.updateState(record, { ...base, select: { requestId, message: prompt.message, options } });
    });
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
    const pending = record.pending;
    record.pending = undefined;
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

function toFlowDeviceCode(info: OAuthDeviceCodeInfo): NonNullable<OAuthFlowState["deviceCode"]> {
  return {
    userCode: info.userCode,
    verificationUri: info.verificationUri,
    ...(info.intervalSeconds === undefined ? {} : { intervalSeconds: info.intervalSeconds }),
    ...(info.expiresInSeconds === undefined ? {} : { expiresInSeconds: info.expiresInSeconds }),
  };
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
    ...(state.auth === undefined ? {} : { auth: { ...state.auth } }),
    ...(state.deviceCode === undefined ? {} : { deviceCode: { ...state.deviceCode } }),
    ...(state.prompt === undefined ? {} : { prompt: { ...state.prompt } }),
    ...(state.select === undefined ? {} : { select: { ...state.select, options: state.select.options.map((option) => ({ ...option })) } }),
  };
}

function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "object" || !("unref" in timer) || typeof timer.unref !== "function") return;
  timer.unref();
}
