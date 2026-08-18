import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Credential, type OAuthAuth, type Provider } from "@earendil-works/pi-ai";
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
  it("logs out providers and emits the removed provider id after the runtime syncs", async () => {
    const credential: Credential = {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    };
    const provider = fakeOAuthProvider("test-logout-sync", () => Promise.resolve(credential));
    const { auth, runtime, credentials, changes } = await createAuthService({ [provider.id]: credential });
    // registerNativeProvider kicks off a background refresh whose availability
    // pass invalidates in-flight provider-scoped syncs (upstream's eventual
    // consistency). Await its exact promise so the logout sync below is the
    // only writer when it runs.
    const refresh = vi.spyOn(runtime, "refresh");
    runtime.registerNativeProvider(provider);
    const registrationRefresh = refresh.mock.results.at(0);
    if (registrationRefresh?.type !== "return") throw new Error("Expected the registration refresh");
    await registrationRefresh.value;

    await expect(auth.logoutProvider(provider.id)).resolves.toEqual({ accepted: true });

    await expect(credentials.read(provider.id)).resolves.toBeUndefined();
    // Pi 0.84 synchronizes provider state inside logout(); it resolving proves
    // the sync finished, so auth-change listeners observe post-sync truth.
    expect(runtime.getProviderAuthStatus(provider.id)).toEqual({ configured: false });
    expect(changes).toEqual([{ removedProviderId: provider.id }]);
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

    const state = await auth.startApiKeyLogin("anthropic");
    // Pi 0.84 queues credential operations, so the interactive prompt is
    // published asynchronously after the flow starts.
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).prompt).toBeDefined(); });
    const prompt = auth.oauthFlow(state.flowId).prompt;
    if (prompt === undefined) throw new Error("Expected Anthropic key prompt");
    auth.respondToOAuthFlow(state.flowId, prompt.requestId, "sk-test");
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

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

  it("executes Cloudflare multi-field API-key setup through the interactive flow", async () => {
    const { auth, credentials, changes } = await createAuthService();

    const state = await auth.startApiKeyLogin("cloudflare-ai-gateway");
    await vi.waitFor(() => {
      expect(auth.oauthFlow(state.flowId).prompt).toMatchObject({ message: "Enter Cloudflare API key", promptType: "secret" });
    });
    const keyPrompt = auth.oauthFlow(state.flowId).prompt;
    if (keyPrompt === undefined) throw new Error("Expected Cloudflare key prompt");
    auth.respondToOAuthFlow(state.flowId, keyPrompt.requestId, "cf-secret");

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
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).select).toBeDefined(); });
    const select = auth.oauthFlow(state.flowId).select;
    if (select === undefined) throw new Error("Expected auth method selection");
    auth.respondToOAuthFlow(state.flowId, select.requestId, selection);

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

  it("rejects unknown providers before starting API-key login", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const login = vi.spyOn(runtime, "login");

    await expect(auth.startApiKeyLogin("unknown-provider")).rejects.toThrow(
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

    await expect(auth.startApiKeyLogin("ambient-only")).rejects.toThrow(
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
    const runtime = await createModelRuntimeForAgentDir(agentDir);
    const auth = await AuthService.create({ runtime });

    const state = await auth.startApiKeyLogin("anthropic");
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).prompt).toBeDefined(); });
    const prompt = auth.oauthFlow(state.flowId).prompt;
    if (prompt === undefined) throw new Error("Expected Anthropic key prompt");
    auth.respondToOAuthFlow(state.flowId, prompt.requestId, "sk-test");
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

    await expect(readFile(join(agentDir, "auth.json"), "utf8")).resolves.toContain("sk-test");
    auth.dispose();
  });

  it("keeps the persisted credential when cancellation lands during the post-login sync", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const credential: Credential = {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    };
    // Pi 0.84 makes login abortable end to end: the credential is persisted
    // before the provider-scoped post-login sync, and cancelling the flow
    // aborts that sync, rejecting login with CredentialSynchronizationError.
    // The read gate holds the sync's availability pass open so cancel lands
    // inside the window; arming it from the provider login mock guarantees
    // every pre-login availability read of this provider already happened.
    let gateArmed = false;
    const syncStarted = deferred<undefined>();
    const finishSync = deferred<undefined>();
    const provider = fakeOAuthProvider("test-cancel-during-sync", () => {
      gateArmed = true;
      return Promise.resolve(credential);
    });
    // Await the registration refresh's exact promise so its credential reads
    // cannot trip the gate below once it is armed.
    const refresh = vi.spyOn(runtime, "refresh");
    runtime.registerNativeProvider(provider);
    const registrationRefresh = refresh.mock.results.at(0);
    if (registrationRefresh?.type !== "return") throw new Error("Expected the registration refresh");
    await registrationRefresh.value;
    refresh.mockRestore();
    vi.spyOn(credentials, "read").mockImplementation(async (providerId, options) => {
      if (gateArmed && providerId === provider.id) {
        gateArmed = false;
        syncStarted.resolve(undefined);
        await finishSync.promise;
      }
      return InMemoryCredentialStore.prototype.read.call(credentials, providerId, options);
    });
    const login = vi.spyOn(runtime, "login");

    const state = await auth.startOAuthLogin(provider.id);
    await syncStarted.promise;

    await expect(credentials.read(provider.id)).resolves.toEqual(credential);
    expect(auth.cancelOAuthFlow(state.flowId)).toMatchObject({ status: "cancelled", error: "Login cancelled" });

    finishSync.resolve(undefined);
    const loginCall = login.mock.results.at(0);
    if (loginCall?.type !== "return") throw new Error("Expected the runtime login call");
    await expect(loginCall.value).rejects.toBeInstanceOf(CredentialSynchronizationError);

    // The aborted login supersedes nothing: the flow stays cancelled and the
    // already-persisted credential remains the stored truth.
    expect(auth.oauthFlow(state.flowId)).toMatchObject({ status: "cancelled", error: "Login cancelled" });
    await expect(credentials.read(provider.id)).resolves.toEqual(credential);
    expect(changes).toEqual([]);
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

describe("createModelRuntimeForAgentDir", () => {
  it("keeps request-path refreshes local so they cannot stall on the network", async () => {
    const agentDir = await tempAgentDir();
    const runtime = await createModelRuntimeForAgentDir(agentDir);
    const auth = await AuthService.create({ runtime });
    const refresh = vi.spyOn(runtime, "refresh");

    await auth.authProviders("login");
    await auth.authProviders("logout");
    const apiKeyFlow = await auth.startApiKeyLogin("anthropic");
    auth.cancelOAuthFlow(apiKeyFlow.flowId);
    await expect(auth.startOAuthLogin("unknown-provider")).rejects.toThrow("OAuth provider not found: unknown-provider");

    // Every auth request path refreshes the runtime first; all of them must
    // stay local-only. Network refreshes belong to the background catalog
    // refresher.
    expect(refresh.mock.calls.length).toBeGreaterThan(0);
    for (const call of refresh.mock.calls) {
      expect(call).toEqual([{ allowNetwork: false }]);
    }
    auth.dispose();
  });

  it("leaves PI_OFFLINE untouched while creating runtimes concurrently", async () => {
    // Pi 0.84 made runtime-owned refreshes local-only, so construction no
    // longer forces PI_OFFLINE; the env var must stay exactly as found, even
    // when creations overlap.
    vi.stubEnv("PI_OFFLINE", "1");
    const dirs = await Promise.all([tempAgentDir(), tempAgentDir(), tempAgentDir()]);
    await Promise.all(dirs.map((dir) => createModelRuntimeForAgentDir(dir)));
    expect(process.env["PI_OFFLINE"]).toBe("1");

    vi.stubEnv("PI_OFFLINE", undefined);
    await createModelRuntimeForAgentDir(await tempAgentDir());
    expect(process.env["PI_OFFLINE"]).toBeUndefined();
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
  const runtime = await createModelRuntimeForAgentDir(agentDir);
  const auth = await AuthService.create({ runtime });
  const changes: AuthChange[] = [];
  auth.subscribe((change) => { changes.push(change); });
  return { auth, runtime, authPath, changes };
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

function fakeOAuthProvider(id: string, login: OAuthAuth["login"]): Provider {
  return {
    id,
    name: `Test ${id}`,
    auth: {
      oauth: {
        name: `Test ${id} OAuth`,
        login,
        refresh: (credential) => Promise.resolve(credential),
        toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
      },
    },
    getModels: () => [],
    stream: () => { throw new Error("stream not implemented"); },
    streamSimple: () => { throw new Error("streamSimple not implemented"); },
  };
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
