import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthFlowState } from "../../shared/apiTypes.js";
import { AuthService, type AuthChange } from "./authService.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AuthService", () => {
  it("saves API keys and emits a global auth change", () => {
    const { auth, authStorage, changes } = createAuthService();

    expect(auth.saveApiKey("anthropic", "sk-test")).toEqual({ accepted: true });

    expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it("logs out providers and emits the removed provider id", () => {
    const { auth, authStorage, changes } = createAuthService({ anthropic: { type: "api_key", key: "sk-test" } });

    expect(auth.logoutProvider("anthropic")).toEqual({ accepted: true });

    expect(authStorage.get("anthropic")).toBeUndefined();
    expect(changes).toEqual([{ removedProviderId: "anthropic" }]);
    auth.dispose();
  });

  it("rejects blank API keys", () => {
    const { auth, changes } = createAuthService();

    expect(() => { auth.saveApiKey("anthropic", "   "); }).toThrow("API key is required");
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("stores credentials in the configured agent directory", async () => {
    const agentDir = await tempAgentDir();
    const auth = new AuthService({ agentDir });

    auth.saveApiKey("anthropic", "sk-test");

    await expect(readFile(join(agentDir, "auth.json"), "utf8")).resolves.toContain("sk-test");
    auth.dispose();
  });

  it("refreshes auth state after OAuth login completes", () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.create(authStorage);
    const authFlows = new CapturingOAuthLoginFlowService();
    const auth = new AuthService({ modelRegistry, authFlows });
    const changes: AuthChange[] = [];
    auth.subscribe((change) => { changes.push(change); });
    const reload = vi.spyOn(authStorage, "reload");
    const refresh = vi.spyOn(modelRegistry, "refresh");
    const provider = authStorage.getOAuthProviders().find((option) => option.id === "anthropic");
    if (provider === undefined) throw new Error("Expected built-in OAuth provider");

    expect(auth.startOAuthLogin(provider.id)).toMatchObject({ providerId: provider.id, providerName: provider.name, status: "running" });

    const startOptions = authFlows.startCalls.at(0);
    if (startOptions === undefined) throw new Error("Expected OAuth flow to start");
    expect(startOptions.providerId).toBe(provider.id);
    expect(startOptions.providerName).toBe(provider.name);
    expect(startOptions.authStorage).toBe(authStorage);
    expect(changes).toEqual([]);

    reload.mockClear();
    refresh.mockClear();
    if (startOptions.onComplete === undefined) throw new Error("Expected OAuth completion callback");
    startOptions.onComplete();

    expect(reload).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(changes).toEqual([{}]);
    auth.dispose();
    expect(authFlows.disposed).toBe(true);
  });
});

function createAuthService(data: Parameters<typeof AuthStorage.inMemory>[0] = {}) {
  const authStorage = AuthStorage.inMemory(data);
  const modelRegistry = ModelRegistry.create(authStorage);
  const auth = new AuthService({ modelRegistry });
  const changes: AuthChange[] = [];
  auth.subscribe((change) => { changes.push(change); });
  return { auth, authStorage, changes };
}

async function tempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-auth-agent-"));
  tempDirs.push(dir);
  return dir;
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
