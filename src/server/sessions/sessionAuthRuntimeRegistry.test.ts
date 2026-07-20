import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type ProviderConfig, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  AmbiguousSessionProviderCredentialError,
  SessionAuthRuntimeRegistry,
  StaleSessionAuthRuntimeError,
} from "./sessionAuthRuntimeRegistry.js";

const providerId = "workspace-auth";
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

describe("SessionAuthRuntimeRegistry", () => {
  it.each([
    ["workspace-a", "workspace-b"],
    ["workspace-b", "workspace-a"],
  ])("fails stored profile auth closed in registration order %s then %s", async (firstName, secondName) => {
    const profile = new InMemoryCredentialStore();
    await profile.modify(providerId, () => Promise.resolve({ type: "api_key", key: "profile-secret" }));
    const registry = new SessionAuthRuntimeRegistry(profile);
    const first = await scopedRuntime(registry, `/projects/${firstName}`, firstName);

    await expect(first.runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "profile-secret" } });

    const second = await scopedRuntime(registry, `/projects/${secondName}`, secondName);
    await expect(first.credentials.read(providerId)).rejects.toBeInstanceOf(AmbiguousSessionProviderCredentialError);
    await expect(second.credentials.read(providerId)).rejects.toBeInstanceOf(AmbiguousSessionProviderCredentialError);
    // ModelRuntime intentionally translates store failures at its public edge.
    await expect(first.runtime.getAuth(providerId)).rejects.toMatchObject({ code: "auth" });
    await expect(second.runtime.getAuth(providerId)).rejects.toMatchObject({ code: "auth" });

    registry.disposeRuntime(second.runtime);
    await expect(first.runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "profile-secret" } });
    registry.dispose();
  });

  it("treats multiple live sessions in one canonical cwd as one provider-definition scope", async () => {
    const profile = new InMemoryCredentialStore();
    await profile.modify(providerId, () => Promise.resolve({ type: "api_key", key: "shared" }));
    const registry = new SessionAuthRuntimeRegistry(profile);
    const first = await scopedRuntime(registry, "/projects/workspace/./", "first");
    const second = await scopedRuntime(registry, "/projects/workspace", "second");

    await expect(first.runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "shared" } });
    await expect(second.runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "shared" } });
    registry.dispose();
  });

  it("keeps each colliding extension's configured fallback runtime-local when no profile credential exists", async () => {
    const registry = new SessionAuthRuntimeRegistry(new InMemoryCredentialStore());
    const first = await scopedRuntime(registry, "/projects/a", "a");
    const second = await scopedRuntime(registry, "/projects/b", "b");

    await expect(first.runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "fallback-a" } });
    await expect(second.runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "fallback-b" } });
    registry.dispose();
  });

  it("does not apply one login generation's async context to sibling runtime reads", async () => {
    const registry = new SessionAuthRuntimeRegistry(new InMemoryCredentialStore());
    const first = await scopedRuntime(registry, "/projects/a", "a");
    const second = await scopedRuntime(registry, "/projects/b", "b");

    await expect(registry.runInGeneration(first.target, () => second.credentials.list())).resolves.toEqual([]);
    registry.dispose();
  });

  it("blocks a credential callback from committing after its runtime is disposed", async () => {
    const profile = new InMemoryCredentialStore();
    const registry = new SessionAuthRuntimeRegistry(profile);
    const scoped = await scopedRuntime(registry, "/projects/a", "a");
    const callbackStarted = deferred();
    const release = deferred();

    const mutation = scoped.credentials.modify(providerId, async () => {
      callbackStarted.resolve();
      await release.promise;
      return { type: "api_key", key: "stale" };
    });
    await callbackStarted.promise;
    registry.disposeRuntime(scoped.runtime);
    release.resolve();

    await expect(mutation).rejects.toBeInstanceOf(StaleSessionAuthRuntimeError);
    await expect(profile.read(providerId)).resolves.toBeUndefined();
    registry.dispose();
  });
});

async function scopedRuntime(
  registry: SessionAuthRuntimeRegistry,
  cwd: string,
  origin: string,
): Promise<{ runtime: ModelRuntime; credentials: CredentialStore; target: ReturnType<SessionAuthRuntimeRegistry["activateRuntime"]> }> {
  const scope = registry.createCredentialScope(cwd);
  const runtime = await ModelRuntime.create({ credentials: scope.credentials, modelsPath: null, allowModelNetwork: false });
  scope.bindRuntime(runtime);
  runtime.registerProvider(providerId, provider(origin));
  registry.updateExtensionProviders(runtime);
  const target = registry.activateRuntime(runtime, { sessionId: `session-${origin}`, cwd });
  return { runtime, credentials: scope.credentials, target };
}

function provider(origin: string): ProviderConfig {
  return {
    name: `Workspace ${origin}`,
    baseUrl: `https://${origin}.example.test/v1`,
    apiKey: `fallback-${origin}`,
    api: "openai-completions",
    models: [model],
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
