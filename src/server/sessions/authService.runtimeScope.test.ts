import { InMemoryCredentialStore, type OAuthCredentials } from "@earendil-works/pi-ai";
import { ModelRuntime, type ProviderConfig, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./authService.js";
import { SessionAuthRuntimeRegistry } from "./sessionAuthRuntimeRegistry.js";

const providerId = "workspace-oauth";
const target = { sessionId: "session-a", cwd: "/projects/a" };
const model: ProviderModelConfig = {
  id: "model",
  name: "Model",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};

describe("AuthService runtime-scoped provider references", () => {
  it("discovers an exact target without adding cwd providers to the no-target profile view", async () => {
    const credential = oauthTokens("immediate");
    const fixture = await authFixture(() => Promise.resolve(credential));

    const profileProviders = await fixture.auth.authProviders("login", "oauth");
    expect(profileProviders.providers.some((provider) => provider.id === providerId)).toBe(false);
    await expect(fixture.auth.authProviders("login", "oauth", { ...target, cwd: "/projects/other" }))
      .rejects.toThrow("Target session auth runtime is no longer active");

    const response = await fixture.auth.authProviders("login", "oauth", target);
    const provider = response.providers.find((candidate) => candidate.id === providerId);
    expect(provider).toMatchObject({ id: providerId, name: "Workspace OAuth", authType: "oauth" });
    expect(provider?.providerRef).toEqual(expect.any(String));
    if (provider?.providerRef === undefined) throw new Error("Expected provider reference");

    const flow = await fixture.auth.startOAuthLogin(provider.id, provider.providerRef);
    await vi.waitFor(() => { expect(fixture.auth.oauthFlow(flow.flowId).status).toBe("complete"); });
    await expect(fixture.profileCredentials.read(providerId)).resolves.toEqual({
      type: "oauth",
      ...credential,
    });
    await expect(fixture.auth.startOAuthLogin(provider.id, provider.providerRef)).rejects.toThrow("reference expired");

    fixture.auth.dispose();
    fixture.registry.dispose();
  });

  it("invalidates an unconsumed provider reference when the runtime generation changes", async () => {
    const fixture = await authFixture(() => Promise.resolve(oauthTokens("unused")));
    const response = await fixture.auth.authProviders("login", "oauth", target);
    const provider = response.providers.find((candidate) => candidate.id === providerId);
    if (provider?.providerRef === undefined) throw new Error("Expected provider reference");

    fixture.registry.invalidateProviderGeneration(fixture.sessionRuntime);

    await expect(fixture.auth.startOAuthLogin(provider.id, provider.providerRef)).rejects.toThrow("reference expired");
    fixture.auth.dispose();
    fixture.registry.dispose();
  });

  it.each(["reload", "dispose"] as const)("cancels a flow and blocks its credential commit on runtime %s", async (lifecycle) => {
    const loginResult = deferred<OAuthCredentials>();
    const fixture = await authFixture(() => loginResult.promise);
    const response = await fixture.auth.authProviders("login", "oauth", target);
    const provider = response.providers.find((candidate) => candidate.id === providerId);
    if (provider?.providerRef === undefined) throw new Error("Expected provider reference");

    const flow = await fixture.auth.startOAuthLogin(provider.id, provider.providerRef);
    expect(flow.status).toBe("running");

    if (lifecycle === "reload") {
      fixture.registry.invalidateProviderGeneration(fixture.sessionRuntime);
      fixture.registry.activateRuntime(fixture.sessionRuntime, target);
    } else {
      fixture.registry.disposeRuntime(fixture.sessionRuntime);
    }
    expect(fixture.auth.oauthFlow(flow.flowId)).toMatchObject({
      status: "cancelled",
      error: "Session auth runtime changed",
    });

    loginResult.resolve(oauthTokens("stale"));
    await vi.waitFor(() => {
      expect(fixture.auth.oauthFlow(flow.flowId).status).toBe("cancelled");
    });
    await expect(fixture.profileCredentials.read(providerId)).resolves.toBeUndefined();

    fixture.auth.dispose();
    fixture.registry.dispose();
  });
});

async function authFixture(login: () => Promise<OAuthCredentials>) {
  const profileCredentials = new InMemoryCredentialStore();
  const profileRuntime = await ModelRuntime.create({ credentials: profileCredentials, modelsPath: null, allowModelNetwork: false });
  const registry = new SessionAuthRuntimeRegistry(profileCredentials);
  const scope = registry.createCredentialScope(target.cwd);
  const sessionRuntime = await ModelRuntime.create({ credentials: scope.credentials, modelsPath: null, allowModelNetwork: false });
  scope.bindRuntime(sessionRuntime);
  sessionRuntime.registerProvider(providerId, oauthProvider(login));
  registry.updateExtensionProviders(sessionRuntime);
  registry.activateRuntime(sessionRuntime, target);
  const auth = await AuthService.create({ runtime: profileRuntime, authRuntimeRegistry: registry });
  return { auth, profileCredentials, profileRuntime, registry, sessionRuntime };
}

function oauthProvider(login: () => Promise<OAuthCredentials>): ProviderConfig {
  return {
    name: "Workspace OAuth",
    baseUrl: "https://workspace.example.test/v1",
    api: "openai-completions",
    models: [model],
    oauth: {
      name: "Workspace OAuth",
      login,
      refreshToken: (credentials) => Promise.resolve(credentials),
      getApiKey: (credentials) => credentials.access,
    },
  };
}

function oauthTokens(suffix: string): OAuthCredentials {
  return { refresh: `refresh-${suffix}`, access: `access-${suffix}`, expires: Date.now() + 60_000 };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
