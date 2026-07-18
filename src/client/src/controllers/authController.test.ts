import { describe, expect, it, vi } from "vitest";
import { api as defaultApi, type AuthProviderOption, type OAuthFlowState, type SessionInfo, type SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
import { AuthController, parseAuthSlashCommand } from "./authController";

describe("parseAuthSlashCommand", () => {
  it("parses login and logout commands", () => {
    expect(parseAuthSlashCommand("/login")).toEqual({ command: "login" });
    expect(parseAuthSlashCommand("/logout")).toEqual({ command: "logout" });
  });

  it("parses provider arguments", () => {
    expect(parseAuthSlashCommand("/login openai")).toEqual({ command: "login", providerId: "openai" });
    expect(parseAuthSlashCommand("/logout openai-codex ")).toEqual({ command: "logout", providerId: "openai-codex" });
  });

  it("ignores non-auth commands and extra arguments", () => {
    expect(parseAuthSlashCommand("/model")).toBeUndefined();
    expect(parseAuthSlashCommand("hello /login")).toBeUndefined();
    expect(parseAuthSlashCommand("/login openai extra")).toBeUndefined();
  });
});

describe("AuthController", () => {
  it("uses auth type to disambiguate provider options with the same id", async () => {
    const providers = [authProvider("anthropic", "oauth"), authProvider("anthropic", "api_key")];
    const { controller, getState } = createController({ authDialog: { step: "providers", mode: "login", providers } });

    await controller.selectLoginProvider("anthropic", "api_key");

    expect(getState().authDialog).toMatchObject({ step: "apiKey", provider: { id: "anthropic", authType: "api_key" } });
  });

  it("starts provider-driven API-key interactions instead of opening the legacy one-secret form", async () => {
    vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => undefined });
    const provider: AuthProviderOption = { ...authProvider("amazon-bedrock", "api_key"), loginFlow: "interactive" };
    const calls: { providerId: string; machineId: string | undefined }[] = [];
    const { controller, getState } = createController(
      { authDialog: { step: "providers", mode: "login", authType: "api_key", providers: [provider] } },
      {
        startInteractiveApiKeyLogin: (providerId, machineId) => {
          calls.push({ providerId, machineId });
          return Promise.resolve(oauthFlow({ providerId, providerName: "Amazon Bedrock", select: { requestId: "request-1", message: "Choose method", options: [] } }));
        },
      },
    );

    try {
      await controller.selectLoginProvider(provider.id, "api_key");

      expect(calls).toEqual([{ providerId: "amazon-bedrock", machineId: "local" }]);
      expect(getState().authDialog).toMatchObject({
        step: "oauth",
        flow: { providerId: "amazon-bedrock", select: { requestId: "request-1" } },
      });
    } finally {
      controller.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("keeps OAuth prompt input and submit state across poll refreshes for the same request", async () => {
    const flow = oauthFlow({ prompt: { requestId: "request-1", message: "Paste callback", kind: "manual" } });
    const { controller, getState } = createController(
      { authDialog: { step: "oauth", flow, inputValue: "https://callback", responding: true } },
      { respondOAuthFlow: () => Promise.resolve(oauthFlow({ prompt: { requestId: "request-1", message: "Paste callback", kind: "manual" }, progress: ["Still waiting"] })) },
    );

    await controller.respondOAuth();

    expect(getState().authDialog).toMatchObject({ step: "oauth", inputValue: "https://callback", responding: true });
  });

  it("submits an allowed blank OAuth text response without client-side rejection", async () => {
    const flow = oauthFlow({
      prompt: { requestId: "request-1", message: "GitHub Enterprise URL/domain (blank for github.com)", kind: "prompt", promptType: "text", allowEmpty: true },
    });
    const respondCalls: string[] = [];
    const { controller } = createController(
      { authDialog: { step: "oauth", flow, inputValue: "" } },
      {
        respondOAuthFlow: (_flowId, _requestId, value) => {
          respondCalls.push(value);
          return Promise.resolve(oauthFlow({ status: "complete" }));
        },
      },
    );

    await controller.respondOAuth();

    expect(respondCalls).toEqual([""]);
  });

  it("resets OAuth prompt input and submit state when the request id changes", async () => {
    const flow = oauthFlow({ prompt: { requestId: "request-1", message: "Paste callback", kind: "manual" } });
    const { controller, getState } = createController(
      { authDialog: { step: "oauth", flow, inputValue: "https://callback", responding: true } },
      {
        respondOAuthFlow: () => Promise.resolve(oauthFlow({
          select: { requestId: "request-2", message: "Choose an account", options: [{ value: "acct-1", label: "Account 1" }] },
          progress: ["Need account selection"],
        })),
      },
    );

    await controller.respondOAuth();

    expect(getState().authDialog).toMatchObject({
      step: "oauth",
      flow: { select: { requestId: "request-2" } },
      inputValue: "",
      responding: false,
    });
  });

  it("closes the OAuth dialog and refreshes selected session status when the flow completes", async () => {
    const flow = oauthFlow({ prompt: { requestId: "request-1", message: "Paste callback", kind: "manual" } });
    const session = sessionInfo("session-1");
    const refreshedStatus = sessionStatus(session.id);
    const respondCalls: { flowId: string; requestId: string; value: string; machineId: string | undefined }[] = [];
    const statusCalls: { session: Parameters<typeof defaultApi.status>[0]; machineId: string | undefined }[] = [];
    const appliedStatuses: SessionStatus[] = [];
    const { controller, getState } = createController(
      { selectedSession: session, authDialog: { step: "oauth", flow, inputValue: "https://callback" } },
      {
        respondOAuthFlow: (flowId, requestId, value, machineId) => {
          respondCalls.push({ flowId, requestId, value, machineId });
          return Promise.resolve(oauthFlow({ status: "complete" }));
        },
        status: (sessionArg, machineId) => {
          statusCalls.push({ session: sessionArg, machineId });
          return Promise.resolve(refreshedStatus);
        },
      },
      (status) => { appliedStatuses.push(status); },
    );

    await controller.respondOAuth();
    await flushMicrotasks();

    expect(respondCalls).toEqual([{ flowId: "flow-1", requestId: "request-1", value: "https://callback", machineId: "local" }]);
    expect(getState().authDialog).toBeUndefined();
    expect(statusCalls).toEqual([{ session, machineId: "local" }]);
    expect(appliedStatuses).toEqual([refreshedStatus]);
  });

  it("leaves the OAuth dialog ready to retry if responding fails", async () => {
    const flow = oauthFlow({ prompt: { requestId: "request-1", message: "Paste callback", kind: "manual" } });
    const { controller, getState } = createController(
      { authDialog: { step: "oauth", flow, inputValue: "https://callback", responding: true } },
      { respondOAuthFlow: () => Promise.reject(new Error("Invalid callback")) },
    );

    await controller.respondOAuth();

    expect(getState().authDialog).toMatchObject({
      step: "oauth",
      flow,
      inputValue: "https://callback",
      responding: false,
      error: "Error: Invalid callback",
    });
  });

  it("does not recreate an OAuth dialog when a pending response settles during cancellation", async () => {
    const prompt = { requestId: "request-1", message: "Paste callback", kind: "manual" } as const;
    const flow = oauthFlow({ prompt });
    const response = deferred<OAuthFlowState>();
    const cancellation = deferred<OAuthFlowState>();
    const { controller, getState } = createController(
      { authDialog: { step: "oauth", flow, inputValue: "https://callback" } },
      {
        respondOAuthFlow: () => response.promise,
        cancelOAuthFlow: () => cancellation.promise,
      },
    );

    const responsePending = controller.respondOAuth();
    const cancellationPending = controller.cancelOAuth();
    const dialogAfterCancel = getState().authDialog;

    response.resolve(oauthFlow({ prompt, progress: ["Stale response"] }));
    await responsePending;
    const dialogAfterResponse = getState().authDialog;

    cancellation.resolve(oauthFlow({ status: "cancelled" }));
    await cancellationPending;

    expect(dialogAfterCancel).toBeUndefined();
    expect(dialogAfterResponse).toBeUndefined();
    expect(getState().authDialog).toBeUndefined();
  });

  it("does not let a stale OAuth response overwrite a newer flow", async () => {
    vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => undefined });
    const oldPrompt = { requestId: "request-1", message: "Paste callback", kind: "manual" } as const;
    const oldFlow = oauthFlow({ prompt: oldPrompt });
    const newFlow = oauthFlow({ flowId: "flow-2", prompt: { requestId: "request-2", message: "Paste callback", kind: "manual" } });
    const response = deferred<OAuthFlowState>();
    const providers = [authProvider("anthropic", "oauth")];
    const { controller, getState } = createController(
      { authDialog: { step: "oauth", flow: oldFlow, inputValue: "https://old-callback" } },
      {
        respondOAuthFlow: () => response.promise,
        authProviders: () => Promise.resolve({ providers }),
        startOAuthLogin: () => Promise.resolve(newFlow),
      },
    );

    try {
      const responsePending = controller.respondOAuth();
      await controller.openLogin("anthropic");
      const dialogAfterNewFlow = getState().authDialog;

      response.resolve(oauthFlow({ prompt: oldPrompt, progress: ["Stale response"] }));
      await responsePending;

      expect(dialogAfterNewFlow).toMatchObject({ step: "oauth", flow: { flowId: "flow-2" } });
      expect(getState().authDialog).toMatchObject({ step: "oauth", flow: { flowId: "flow-2" } });
    } finally {
      response.resolve(oldFlow);
      controller.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("does not let an older poll restore a running flow after a newer poll stops polling", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
    const prompt = { requestId: "request-1", message: "Paste callback", kind: "manual" } as const;
    const runningFlow = oauthFlow({ prompt });
    const stalePoll = deferred<OAuthFlowState>();
    const providers = [authProvider("anthropic", "oauth")];
    let pollCalls = 0;
    const { controller, getState } = createController(
      {},
      {
        authProviders: () => Promise.resolve({ providers }),
        startOAuthLogin: () => Promise.resolve(runningFlow),
        oauthFlow: () => {
          pollCalls += 1;
          return pollCalls === 1 ? stalePoll.promise : Promise.resolve(oauthFlow({ status: "cancelled", prompt }));
        },
      },
    );

    try {
      await controller.openLogin("anthropic");
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      const dialogAfterPollingStopped = getState().authDialog;

      stalePoll.resolve(oauthFlow({ prompt, progress: ["Stale running poll"] }));
      await flushMicrotasks();

      expect(pollCalls).toBe(2);
      expect(dialogAfterPollingStopped).toMatchObject({ step: "oauth", flow: { status: "cancelled" } });
      expect(getState().authDialog).toMatchObject({ step: "oauth", flow: { status: "cancelled" } });
    } finally {
      stalePoll.resolve(runningFlow);
      controller.dispose();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("cancels the active OAuth flow and closes the dialog even when cancellation fails", async () => {
    const flow = oauthFlow({ prompt: { requestId: "request-1", message: "Paste callback", kind: "manual" } });
    const cancelCalls: { flowId: string; machineId: string | undefined }[] = [];
    const { controller, getState } = createController(
      { authDialog: { step: "oauth", flow } },
      {
        cancelOAuthFlow: (flowId, machineId) => {
          cancelCalls.push({ flowId, machineId });
          return Promise.reject(new Error("Cancel unavailable"));
        },
      },
    );

    await controller.cancelOAuth();

    expect(cancelCalls).toEqual([{ flowId: "flow-1", machineId: "local" }]);
    expect(getState().authDialog).toBeUndefined();
  });

  it("validates API key input before saving and clears the validation error when edited", async () => {
    const saveCalls: { providerId: string; key: string; machineId: string | undefined }[] = [];
    const provider = authProvider("openai", "api_key");
    const { controller, getState } = createController(
      { authDialog: { step: "apiKey", provider, value: "   " } },
      {
        saveApiKey: (providerId, key, machineId) => {
          saveCalls.push({ providerId, key, machineId });
          return Promise.resolve({ accepted: true });
        },
      },
    );

    await controller.saveApiKey();

    expect(saveCalls).toEqual([]);
    expect(getState().authDialog).toMatchObject({ step: "apiKey", error: "API key is required" });

    controller.updateApiKey("sk-live");

    expect(getState().authDialog).toMatchObject({ step: "apiKey", value: "sk-live" });
    expect(getState().authDialog).not.toHaveProperty("error");
  });

  it("saves a trimmed API key on the selected machine and refreshes selected session status", async () => {
    const saveCalls: { providerId: string; key: string; machineId: string | undefined }[] = [];
    const statusCalls: { session: Parameters<typeof defaultApi.status>[0]; machineId: string | undefined }[] = [];
    const appliedStatuses: SessionStatus[] = [];
    const provider = authProvider("openai", "api_key");
    const session = sessionInfo("session-1");
    const refreshedStatus = sessionStatus(session.id);
    const { controller, getState } = createController(
      {
        selectedMachine: remoteMachine("remote-1"),
        selectedSession: session,
        authDialog: { step: "apiKey", provider, value: "  sk-live  " },
      },
      {
        saveApiKey: (providerId, key, machineId) => {
          saveCalls.push({ providerId, key, machineId });
          return Promise.resolve({ accepted: true });
        },
        status: (sessionArg, machineId) => {
          statusCalls.push({ session: sessionArg, machineId });
          return Promise.resolve(refreshedStatus);
        },
      },
      (status) => { appliedStatuses.push(status); },
    );

    await controller.saveApiKey();
    await flushMicrotasks();

    expect(saveCalls).toEqual([{ providerId: "openai", key: "sk-live", machineId: "remote-1" }]);
    expect(getState().authDialog).toBeUndefined();
    expect(statusCalls).toEqual([{ session, machineId: "remote-1" }]);
    expect(appliedStatuses).toEqual([refreshedStatus]);
  });

  it("keeps the API key dialog open with an error if saving fails", async () => {
    const provider = authProvider("openai", "api_key");
    const { controller, getState } = createController(
      { authDialog: { step: "apiKey", provider, value: "sk-live" } },
      { saveApiKey: () => Promise.reject(new Error("Denied")) },
    );

    await controller.saveApiKey();

    expect(getState().authDialog).toMatchObject({ step: "apiKey", value: "sk-live", saving: false, error: "Error: Denied" });
  });
});

function createController(
  statePatch: Partial<AppState>,
  apiPatch: Partial<typeof defaultApi> = {},
  applyStatus: (status: SessionStatus) => void = () => undefined,
) {
  let state: AppState = { ...initialAppState(), ...statePatch };
  const api = { ...defaultApi, ...apiPatch };
  const controller = new AuthController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    applyStatus,
    { api },
  );
  return { controller, getState: () => state };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolveDeferred = resolve; });
  if (resolveDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred };
}

function remoteMachine(id: string): NonNullable<AppState["selectedMachine"]> {
  return {
    id,
    name: "Remote",
    kind: "remote",
    baseUrl: "https://remote.example",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function sessionInfo(id: string): SessionInfo {
  return {
    id,
    cwd: "/repo",
    path: `/tmp/${id}.jsonl`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
  };
}

function sessionStatus(sessionId: string): SessionStatus {
  return {
    sessionId,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function authProvider(id: string, authType: "oauth" | "api_key"): AuthProviderOption {
  return { id, authType, name: `${id} ${authType}`, status: { configured: false } };
}

function oauthFlow(patch: Partial<OAuthFlowState> = {}): OAuthFlowState {
  return {
    flowId: "flow-1",
    providerId: "anthropic",
    providerName: "Anthropic",
    status: "running",
    progress: [],
    ...patch,
  };
}
