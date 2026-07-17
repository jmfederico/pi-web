import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, AuthPrompt, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthFlowState } from "../../shared/apiTypes.js";
import { AuthService, createModelRuntimeForAgentDir, type AuthChange, type AuthModelRuntime, type AuthServiceLogger } from "./authService.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AuthService", () => {
  it("saves API keys and emits a global auth change", async () => {
    const { auth, credentials, changes } = await createAuthService();

    await expect(auth.saveApiKey("anthropic", "sk-test")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-test" });
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it("logs out providers and emits the removed provider id", async () => {
    const { auth, credentials, changes } = await createAuthService({ anthropic: { type: "api_key", key: "sk-test" } });

    await expect(auth.logoutProvider("anthropic")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(changes).toEqual([{ removedProviderId: "anthropic" }]);
    auth.dispose();
  });

  it("rejects blank API keys", async () => {
    const { auth, changes } = await createAuthService();

    await expect(auth.saveApiKey("anthropic", "   ")).rejects.toThrow("API key is required");
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("stores credentials in the configured agent directory", async () => {
    const agentDir = await tempAgentDir();
    const modelRuntime = await createModelRuntimeForAgentDir(agentDir, false);
    const auth = new AuthService({ modelRuntime });

    await auth.saveApiKey("anthropic", "sk-test");

    await expect(readFile(join(agentDir, "auth.json"), "utf8")).resolves.toContain("sk-test");
    auth.dispose();
  });


  it("awaits auth-change propagation before completing API-key login", async () => {
    const runtime = new PromptingAuthRuntime([{ type: "secret", message: "API key" }]);
    const auth = new AuthService({ modelRuntime: runtime });
    const propagation = deferred<undefined>();
    auth.subscribe(() => propagation.promise);

    let settled = false;
    const saving = auth.saveApiKey("test-provider", "sk-test").finally(() => { settled = true; });
    await flushMicrotasks();

    expect(settled).toBe(false);
    propagation.resolve(undefined);
    await expect(saving).resolves.toEqual({ accepted: true });
    auth.dispose();
  });

  it("persists an API key and attempts every listener when propagation fails", async () => {
    const error = vi.fn();
    const logger: AuthServiceLogger = { error };
    const { auth, credentials } = await createAuthService({}, logger);
    const failure = new Error("session refresh failed");
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
    expect(attempts).toEqual(["throwing", "healthy"]);
    expect(error).toHaveBeenCalledWith({ err: failure }, "auth-change listener failed");
    auth.dispose();
  });

  it("removes a credential when propagation rejects", async () => {
    const error = vi.fn();
    const logger: AuthServiceLogger = { error };
    const { auth, credentials } = await createAuthService({ anthropic: { type: "api_key", key: "sk-test" } }, logger);
    const failure = new Error("session logout refresh failed");
    auth.subscribe(() => Promise.reject(failure));

    await expect(auth.logoutProvider("anthropic")).resolves.toEqual({ accepted: true });
    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith({ err: failure }, "auth-change listener failed");
    auth.dispose();
  });

  it.each([
    { prompt: { type: "text", message: "Account" } as const, label: "text" },
    { prompt: { type: "manual_code", message: "Code" } as const, label: "manual-code" },
    { prompt: { type: "select", message: "Region", options: [{ id: "us", label: "US" }] } as const, label: "select" },
  ])("rejects a first $label prompt in the API-key endpoint", async ({ prompt }) => {
    const runtime = new PromptingAuthRuntime([prompt]);
    const auth = new AuthService({ modelRuntime: runtime });

    await expect(auth.saveApiKey("test-provider", "sk-test")).rejects.toThrow("requires interactive setup");
    expect(runtime.completedLogins).toBe(0);
    auth.dispose();
  });

  it("rejects a second API-key prompt", async () => {
    const runtime = new PromptingAuthRuntime([
      { type: "secret", message: "API key" },
      { type: "text", message: "Account" },
    ]);
    const auth = new AuthService({ modelRuntime: runtime });

    await expect(auth.saveApiKey("test-provider", "sk-test")).rejects.toThrow("requires interactive setup");
    expect(runtime.completedLogins).toBe(0);
    auth.dispose();
  });

  it("rejects an aborted API-key prompt", async () => {
    const abort = new AbortController();
    abort.abort();
    const runtime = new PromptingAuthRuntime([{ type: "secret", message: "API key", signal: abort.signal }]);
    const auth = new AuthService({ modelRuntime: runtime });

    await expect(auth.saveApiKey("test-provider", "sk-test")).rejects.toThrow("Login cancelled");
    expect(runtime.completedLogins).toBe(0);
    auth.dispose();
  });

  it("emits an auth change after OAuth login completes", async () => {
    const modelRuntime = await ModelRuntime.create({ credentials: new MemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    const authFlows = new CapturingOAuthLoginFlowService();
    const auth = new AuthService({ modelRuntime, authFlows });
    const changes: AuthChange[] = [];
    auth.subscribe((change) => { changes.push(change); });

    expect(auth.startOAuthLogin("anthropic")).toMatchObject({ providerId: "anthropic", status: "running" });

    const startOptions = authFlows.startCalls.at(0);
    if (startOptions === undefined) throw new Error("Expected OAuth flow to start");
    expect(startOptions.providerId).toBe("anthropic");
    expect(typeof startOptions.login).toBe("function");
    expect(changes).toEqual([]);

    if (startOptions.onComplete === undefined) throw new Error("Expected OAuth completion callback");
    await startOptions.onComplete();

    expect(changes).toEqual([{}]);
    auth.dispose();
    expect(authFlows.disposed).toBe(true);
  });

  it("completes OAuth after persistence when propagation rejects", async () => {
    const modelRuntime = new PromptingAuthRuntime([]);
    const auth = new AuthService({ modelRuntime });
    auth.subscribe(() => Promise.reject(new Error("session refresh failed")));

    const state = auth.startOAuthLogin("test-provider");
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });
    auth.dispose();
  });
});

async function createAuthService(data: Record<string, Credential> = {}, logger?: AuthServiceLogger) {
  const credentials = new MemoryCredentialStore(data);
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const auth = new AuthService({ modelRuntime, ...(logger === undefined ? {} : { logger }) });
  const changes: AuthChange[] = [];
  auth.subscribe((change) => { changes.push(change); });
  return { auth, credentials, changes };
}

async function tempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-auth-agent-"));
  tempDirs.push(dir);
  return dir;
}

class MemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();

  constructor(data: Record<string, Credential> = {}) {
    for (const [providerId, credential] of Object.entries(data)) this.credentials.set(providerId, credential);
  }

  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(this.credentials.get(providerId));
  }

  list(): Promise<readonly { providerId: string; type: Credential["type"] }[]> {
    return Promise.resolve([...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type })));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const credential = await fn(this.credentials.get(providerId));
    if (credential !== undefined) this.credentials.set(providerId, credential);
    return credential;
  }

  delete(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
    return Promise.resolve();
  }
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


class PromptingAuthRuntime implements AuthModelRuntime {
  completedLogins = 0;

  constructor(private readonly prompts: readonly AuthPrompt[]) {}

  getProviders() {
    return [{ id: "test-provider", name: "Test Provider", auth: { apiKey: { login: true }, oauth: true } }];
  }

  getProvider(providerId: string) {
    return this.getProviders().find((provider) => provider.id === providerId);
  }

  listCredentials(): Promise<readonly { providerId: string; type: "api_key" | "oauth" }[]> {
    return Promise.resolve([]);
  }

  getProviderAuthStatus() {
    return { configured: false };
  }

  async login(_providerId: string, _authType: "api_key" | "oauth", interaction: AuthInteraction): Promise<void> {
    for (const prompt of this.prompts) await interaction.prompt(prompt);
    this.completedLogins++;
  }

  logout(): Promise<void> {
    return Promise.resolve();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolveValue: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectValue: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}
