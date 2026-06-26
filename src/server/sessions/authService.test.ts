import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService, type AuthChange } from "./authService.js";

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

    auth.saveApiKey("anthropic", "sk-omp");

    await expect(readFile(join(agentDir, "auth.json"), "utf8")).resolves.toContain("sk-omp");
    auth.dispose();
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
