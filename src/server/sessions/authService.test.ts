import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type AuthPrompt, type Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthFlowState } from "../../shared/apiTypes.js";
import { AuthService, createModelRuntimeForAgentDir, type AuthChange, type AuthServiceLogger } from "./authService.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AuthService", () => {
  it("saves API keys and emits a global auth change after the runtime refreshes", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const reloadConfig = vi.spyOn(runtime, "reloadConfig").mockResolvedValue(undefined);
    const refresh = vi.spyOn(runtime, "refresh");

    await expect(auth.saveApiKey("anthropic", "sk-test")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-test" });
    expect(reloadConfig).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it("logs out providers and emits the removed provider id after the runtime refreshes", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService({ anthropic: { type: "api_key", key: "sk-test" } });
    const refresh = vi.spyOn(runtime, "refresh");

    await expect(auth.logoutProvider("anthropic")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
    expect(changes).toEqual([{ removedProviderId: "anthropic" }]);
    auth.dispose();
  });

  it("persists an API key and attempts every listener when failure logging throws", async () => {
    const loggingFailure = new Error("auth logger failed");
    const error = vi.fn(() => { throw loggingFailure; });
    const logger: AuthServiceLogger = { error };
    const { auth, credentials, changes } = await createAuthService({}, logger);
    const failure = new Error("session auth refresh failed");
    const attempts: string[] = [];
    auth.subscribe(() => {
      attempts.push("throwing");
      throw failure;
    });
    auth.subscribe(async () => {
      await Promise.resolve();
      attempts.push("healthy");
    });

    await expect(auth.saveApiKey("anthropic", "sk-test")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-test" });
    expect(changes).toEqual([{}]);
    expect(attempts).toEqual(["throwing", "healthy"]);
    expect(error).toHaveBeenCalledWith(
      { err: failure, operation: "login", providerId: "anthropic", authType: "api_key" },
      "auth-change listener failed",
    );
    auth.dispose();
  });

  it("removes a credential when auth-change propagation rejects", async () => {
    const error = vi.fn();
    const logger: AuthServiceLogger = { error };
    const { auth, credentials, changes } = await createAuthService(
      { anthropic: { type: "api_key", key: "sk-test" } },
      logger,
    );
    const failure = new Error("session logout refresh failed");
    auth.subscribe(() => Promise.reject(failure));

    await expect(auth.logoutProvider("anthropic")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(changes).toEqual([{ removedProviderId: "anthropic" }]);
    expect(error).toHaveBeenCalledWith(
      { err: failure, operation: "logout", providerId: "anthropic" },
      "auth-change listener failed",
    );
    auth.dispose();
  });

  it("rejects blank API keys", async () => {
    const { auth, changes } = await createAuthService();

    await expect(auth.saveApiKey("anthropic", "   ")).rejects.toThrow("API key is required");
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("keeps existing file-backed credentials unchanged when legacy Cloudflare setup cannot finish", async () => {
    const seed = {
      "cloudflare-ai-gateway": {
        type: "api_key" as const,
        key: "existing-secret",
        env: { CLOUDFLARE_ACCOUNT_ID: "existing-account", CLOUDFLARE_GATEWAY_ID: "existing-gateway" },
      },
    };
    const { auth, authPath, changes } = await createFileBackedAuthService(seed);
    const before = await readFile(authPath, "utf8");

    await expect(auth.saveApiKey("cloudflare-ai-gateway", "new-secret")).rejects.toThrow(
      "Cloudflare AI Gateway requires interactive setup; use Pi's generic /login flow",
    );

    await expect(readFile(authPath, "utf8")).resolves.toBe(before);
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it.each([
    { providerId: "amazon-bedrock", providerName: "Amazon Bedrock" },
    { providerId: "google-vertex", providerName: "Google Vertex AI" },
  ])("keeps an empty file-backed store unchanged when legacy $providerName setup starts with a selection", async ({ providerId, providerName }) => {
    const { auth, authPath, changes } = await createFileBackedAuthService({});
    const before = await readFile(authPath, "utf8");

    await expect(auth.saveApiKey(providerId, "submitted-secret")).rejects.toThrow(
      `${providerName} requires interactive setup; use Pi's generic /login flow`,
    );

    await expect(readFile(authPath, "utf8")).resolves.toBe(before);
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("executes Cloudflare multi-field API-key setup through the interactive flow", async () => {
    const { auth, credentials, changes } = await createAuthService();

    const state = await auth.startApiKeyLogin("cloudflare-ai-gateway");
    expect(state.prompt).toMatchObject({ message: "Enter Cloudflare API key", promptType: "secret" });
    if (state.prompt === undefined) throw new Error("Expected Cloudflare key prompt");
    auth.respondToOAuthFlow(state.flowId, state.prompt.requestId, "cf-secret");

    await vi.waitFor(() => {
      expect(auth.oauthFlow(state.flowId).prompt).toMatchObject({ message: "Enter Cloudflare account ID", promptType: "text" });
    });
    const accountPrompt = auth.oauthFlow(state.flowId).prompt;
    if (accountPrompt === undefined) throw new Error("Expected Cloudflare account prompt");
    auth.respondToOAuthFlow(state.flowId, accountPrompt.requestId, "account-1");

    await vi.waitFor(() => {
      expect(auth.oauthFlow(state.flowId).prompt).toMatchObject({ message: "Enter Cloudflare AI Gateway ID", promptType: "text" });
    });
    const gatewayPrompt = auth.oauthFlow(state.flowId).prompt;
    if (gatewayPrompt === undefined) throw new Error("Expected Cloudflare gateway prompt");
    auth.respondToOAuthFlow(state.flowId, gatewayPrompt.requestId, "gateway-1");

    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });
    await expect(credentials.read("cloudflare-ai-gateway")).resolves.toEqual({
      type: "api_key",
      key: "cf-secret",
      env: { CLOUDFLARE_ACCOUNT_ID: "account-1", CLOUDFLARE_GATEWAY_ID: "gateway-1" },
    });
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it.each([
    { providerId: "amazon-bedrock", selection: "bearer-token", secretPrompt: "Enter Amazon Bedrock bearer token" },
    { providerId: "google-vertex", selection: "api-key", secretPrompt: "Enter Google Cloud API key" },
  ])("executes $providerId select-first API-key setup through the interactive flow", async ({ providerId, selection, secretPrompt }) => {
    const { auth, credentials, changes } = await createAuthService();

    const state = await auth.startApiKeyLogin(providerId);
    expect(state.select).toBeDefined();
    if (state.select === undefined) throw new Error("Expected auth method selection");
    auth.respondToOAuthFlow(state.flowId, state.select.requestId, selection);

    await vi.waitFor(() => {
      expect(auth.oauthFlow(state.flowId).prompt).toMatchObject({ message: secretPrompt, promptType: "secret" });
    });
    const prompt = auth.oauthFlow(state.flowId).prompt;
    if (prompt === undefined) throw new Error("Expected provider secret prompt");
    auth.respondToOAuthFlow(state.flowId, prompt.requestId, "provider-secret");

    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });
    await expect(credentials.read(providerId)).resolves.toEqual({ type: "api_key", key: "provider-secret" });
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it("reports a key-only legacy Cloudflare credential as unconfigured", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "");
    const { auth } = await createFileBackedAuthService({
      "cloudflare-ai-gateway": { type: "api_key", key: "legacy-secret" },
    });

    const response = await auth.authProviders("login", "api_key");

    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cloudflare-ai-gateway",
        loginFlow: "interactive",
        status: { configured: false },
      }),
    ]));
    auth.dispose();
  });

  it("reports a stored Cloudflare key as configured when ambient fields complete it", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "ambient-account");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "ambient-gateway");
    const { auth } = await createFileBackedAuthService({
      "cloudflare-ai-gateway": { type: "api_key", key: "legacy-secret" },
    });

    const response = await auth.authProviders("login", "api_key");

    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cloudflare-ai-gateway",
        loginFlow: "interactive",
        status: { configured: true, source: "stored" },
      }),
    ]));
    auth.dispose();
  });

  it.each([
    { label: "text", prompt: { type: "text", message: "Account" } satisfies AuthPrompt },
    {
      label: "select",
      prompt: { type: "select", message: "Region", options: [{ id: "us", label: "US" }] } satisfies AuthPrompt,
    },
    { label: "manual-code", prompt: { type: "manual_code", message: "Code" } satisfies AuthPrompt },
  ])("rejects a first $label prompt before credential persistence", async ({ prompt }) => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const login = mockLoginPromptsBeforePersistence(runtime, credentials, [prompt]);

    await expect(auth.saveApiKey("anthropic", "sk-test")).rejects.toThrow(
      "Anthropic requires interactive setup; use Pi's generic /login flow",
    );

    expect(login).toHaveBeenCalledOnce();
    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("rejects a repeated secret prompt before credential persistence", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const login = mockLoginPromptsBeforePersistence(runtime, credentials, [
      { type: "secret", message: "API key" },
      { type: "secret", message: "API key again" },
    ]);

    await expect(auth.saveApiKey("anthropic", "sk-test")).rejects.toThrow(
      "Anthropic requires interactive setup; use Pi's generic /login flow",
    );

    expect(login).toHaveBeenCalledOnce();
    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("rejects an aborted secret prompt before credential persistence", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const abort = new AbortController();
    abort.abort();
    const login = mockLoginPromptsBeforePersistence(runtime, credentials, [
      { type: "secret", message: "API key", signal: abort.signal },
    ]);

    await expect(auth.saveApiKey("anthropic", "sk-test")).rejects.toThrow("Login cancelled");

    expect(login).toHaveBeenCalledOnce();
    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("rejects unknown providers before starting API-key login", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const login = vi.spyOn(runtime, "login");

    await expect(auth.saveApiKey("unknown-provider", "sk-test")).rejects.toThrow(
      "API key provider not found: unknown-provider",
    );

    expect(login).not.toHaveBeenCalled();
    await expect(credentials.read("unknown-provider")).resolves.toBeUndefined();
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("rejects ambient-only providers before starting API-key login", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const providers = [...runtime.getProviders()];
    const interactiveProvider = providers.find((provider) => provider.auth.apiKey?.login !== undefined);
    if (interactiveProvider?.auth.apiKey === undefined) throw new Error("Expected an interactive API-key provider");
    const ambientApiKey = { ...interactiveProvider.auth.apiKey };
    delete ambientApiKey.login;
    const ambientProvider = {
      ...interactiveProvider,
      id: "ambient-only",
      name: "Ambient Only",
      auth: { apiKey: ambientApiKey },
    };
    vi.spyOn(runtime, "getProviders").mockReturnValue([...providers, ambientProvider]);
    const login = vi.spyOn(runtime, "login");

    await expect(auth.saveApiKey("ambient-only", "sk-test")).rejects.toThrow(
      "Ambient Only does not support interactive API-key setup",
    );

    expect(login).not.toHaveBeenCalled();
    await expect(credentials.read("ambient-only")).resolves.toBeUndefined();
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("reloads models.json before enumerating and validating OAuth providers", async () => {
    const agentDir = await tempAgentDir();
    const modelsPath = join(agentDir, "models.json");
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath,
      allowModelNetwork: false,
    });
    const authFlows = new CapturingOAuthLoginFlowService();
    const auth = await AuthService.create({ runtime, authFlows });

    await writeFile(modelsPath, radiusModelsConfig("First Radius"));
    const response = await auth.authProviders("login", "oauth");
    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "test-radius", name: "First Radius", authType: "oauth" }),
    ]));

    await writeFile(modelsPath, radiusModelsConfig("Updated Radius"));
    await expect(auth.startOAuthLogin("test-radius")).resolves.toMatchObject({
      providerId: "test-radius",
      providerName: "Updated Radius",
      status: "running",
    });
    expect(authFlows.startCalls.at(0)).toMatchObject({
      providerId: "test-radius",
      providerName: "Updated Radius",
      runtime,
    });
    auth.dispose();
  });

  it("stores credentials in the configured agent directory", async () => {
    const agentDir = await tempAgentDir();
    const runtime = await createModelRuntimeForAgentDir(agentDir, false);
    const auth = await AuthService.create({ runtime });

    await auth.saveApiKey("anthropic", "sk-test");

    await expect(readFile(join(agentDir, "auth.json"), "utf8")).resolves.toContain("sk-test");
    auth.dispose();
  });

  it("reconciles cancellation after ModelRuntime persists OAuth but before its refresh completes", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const provider = runtime.getProviders().find((option) => option.id === "anthropic" && option.auth.oauth !== undefined);
    if (provider?.auth.oauth === undefined) throw new Error("Expected built-in OAuth provider");
    const credential: Credential = {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    };
    vi.spyOn(provider.auth.oauth, "login").mockResolvedValue(credential);
    vi.spyOn(runtime, "reloadConfig").mockResolvedValue(undefined);
    const refreshStarted = deferred<undefined>();
    const finishRefresh = deferred<undefined>();
    const refresh = vi.spyOn(runtime, "refresh").mockImplementation(async () => {
      refreshStarted.resolve(undefined);
      await finishRefresh.promise;
      return { aborted: false, errors: new Map() };
    });

    const state = await auth.startOAuthLogin(provider.id);
    await refreshStarted.promise;

    await expect(credentials.read(provider.id)).resolves.toEqual(credential);
    expect(auth.cancelOAuthFlow(state.flowId)).toMatchObject({ status: "cancelled", error: "Login cancelled" });
    expect(changes).toEqual([]);

    finishRefresh.resolve(undefined);
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

    expect(auth.oauthFlow(state.flowId)).toMatchObject({ status: "complete", progress: ["Login complete"] });
    expect(auth.oauthFlow(state.flowId)).not.toHaveProperty("error");
    await expect(credentials.read(provider.id)).resolves.toEqual(credential);
    expect(changes).toEqual([{}]);
    expect(refresh).toHaveBeenCalledOnce();
    auth.dispose();
  });

  it("emits an auth change after OAuth login completes without refreshing twice", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const authFlows = new CapturingOAuthLoginFlowService();
    const auth = await AuthService.create({ runtime, authFlows });
    const changes: AuthChange[] = [];
    auth.subscribe((change) => { changes.push(change); });
    const refresh = vi.spyOn(runtime, "refresh");
    const provider = runtime.getProviders().find((option) => option.id === "anthropic" && option.auth.oauth !== undefined);
    if (provider === undefined) throw new Error("Expected built-in OAuth provider");

    await expect(auth.startOAuthLogin(provider.id)).resolves.toMatchObject({ providerId: provider.id, providerName: provider.name, status: "running" });

    const startOptions = authFlows.startCalls.at(0);
    if (startOptions === undefined) throw new Error("Expected OAuth flow to start");
    expect(startOptions.providerId).toBe(provider.id);
    expect(startOptions.providerName).toBe(provider.name);
    expect(startOptions.runtime).toBe(runtime);
    expect(changes).toEqual([]);

    refresh.mockClear();
    if (startOptions.onComplete === undefined) throw new Error("Expected OAuth completion callback");
    await startOptions.onComplete();
    expect(changes).toEqual([{}]);

    expect(refresh).not.toHaveBeenCalled();
    auth.dispose();
    expect(authFlows.disposed).toBe(true);
  });

  it("completes OAuth when an auth-change listener and failure logging throw", async () => {
    const loggingFailure = new Error("auth logger failed");
    const error = vi.fn(() => { throw loggingFailure; });
    const logger: AuthServiceLogger = { error };
    const { auth, runtime, changes } = await createAuthService({}, logger);
    const provider = runtime.getProviders().find((option) => option.id === "anthropic" && option.auth.oauth !== undefined);
    if (provider === undefined) throw new Error("Expected built-in OAuth provider");
    vi.spyOn(runtime, "login").mockResolvedValue({
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    });
    const failure = new Error("session OAuth refresh failed");
    auth.subscribe(() => Promise.reject(failure));

    const state = await auth.startOAuthLogin(provider.id);
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

    expect(changes).toEqual([{}]);
    expect(error).toHaveBeenCalledWith(
      { err: failure, operation: "login", providerId: provider.id, authType: "oauth" },
      "auth-change listener failed",
    );
    auth.dispose();
  });
});

async function createAuthService(seed: Record<string, Credential> = {}, logger?: AuthServiceLogger) {
  const credentials = new InMemoryCredentialStore();
  for (const [providerId, credential] of Object.entries(seed)) {
    await credentials.modify(providerId, () => Promise.resolve(credential));
  }
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const auth = await AuthService.create({ runtime, ...(logger === undefined ? {} : { logger }) });
  const changes: AuthChange[] = [];
  auth.subscribe((change) => { changes.push(change); });
  return { auth, runtime, credentials, changes };
}

async function createFileBackedAuthService(seed: Record<string, Credential>) {
  const agentDir = await tempAgentDir();
  const authPath = join(agentDir, "auth.json");
  await writeFile(authPath, JSON.stringify(seed, null, 2));
  const runtime = await createModelRuntimeForAgentDir(agentDir, false);
  const auth = await AuthService.create({ runtime });
  const changes: AuthChange[] = [];
  auth.subscribe((change) => { changes.push(change); });
  return { auth, runtime, authPath, changes };
}

function mockLoginPromptsBeforePersistence(
  runtime: ModelRuntime,
  credentials: InMemoryCredentialStore,
  prompts: readonly AuthPrompt[],
) {
  return vi.spyOn(runtime, "login").mockImplementation(async (providerId, _authType, interaction) => {
    let key: string | undefined;
    for (const prompt of prompts) key = await interaction.prompt(prompt);
    if (key === undefined) throw new Error("Expected at least one login prompt");
    const credential: Credential = { type: "api_key", key };
    await credentials.modify(providerId, () => Promise.resolve(credential));
    return credential;
  });
}

async function tempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-auth-agent-"));
  tempDirs.push(dir);
  return dir;
}

function deferred<T>() {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function radiusModelsConfig(name: string): string {
  return JSON.stringify({
    providers: {
      "test-radius": {
        name,
        baseUrl: "https://radius.example.test/v1",
        oauth: "radius",
      },
    },
  });
}

class CapturingOAuthLoginFlowService extends OAuthLoginFlowService {
  readonly startCalls: Parameters<OAuthLoginFlowService["start"]>[0][] = [];
  disposed = false;

  override start(options: Parameters<OAuthLoginFlowService["start"]>[0]): OAuthFlowState {
    this.startCalls.push(options);
    return { flowId: "flow-1", providerId: options.providerId, providerName: options.providerName, status: "running", progress: [] };
  }

  override dispose(): void {
    this.disposed = true;
  }
}
