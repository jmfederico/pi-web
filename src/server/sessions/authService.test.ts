import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { OAuthFlowState } from "../../shared/apiTypes.js";
import { AuthService, createModelRuntimeForAgentDir, type AuthChange } from "./authService.js";
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
    startOptions.onComplete();

    expect(changes).toEqual([{}]);
    auth.dispose();
    expect(authFlows.disposed).toBe(true);
  });
});

async function createAuthService(data: Record<string, Credential> = {}) {
  const credentials = new MemoryCredentialStore(data);
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const auth = new AuthService({ modelRuntime });
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
