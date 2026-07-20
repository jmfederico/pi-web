import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiSessionManagerGateway } from "./piSessionService.js";
import { CapturingSessionEventHub, sessionRef } from "./piSessionService.testSupport.js";
import { ProfileCredentialStore } from "./profileCredentialStore.js";
import { SessionAuthRuntimeRegistry } from "./sessionAuthRuntimeRegistry.js";
import { createSessionModelRuntimeFactory } from "./sessionModelRuntimeFactory.js";

const providerId = "runtime-isolation-fixture";
const collisionModelId = "collision-model";
const tempRoots: string[] = [];

afterEach(async () => {
  for (const path of tempRoots.splice(0)) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("PiSessionService real cwd runtime isolation", () => {
  it.each([
    ["A then B", ["A", "B"] as const],
    ["B then A", ["B", "A"] as const],
  ])("isolates providers in %s open order and cleanly reloads edited/removed registrations", async (_label, order) => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-runtime-isolation-acceptance-"));
    tempRoots.push(root);
    const agentDir = join(root, "agent");
    const cwdA = join(root, "workspace-a");
    const cwdB = join(root, "workspace-b");
    const lifecycleLog = join(root, "extension-lifecycle.log");
    await Promise.all([
      mkdir(join(cwdA, ".pi", "extensions"), { recursive: true }),
      mkdir(join(cwdB, ".pi", "extensions"), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "always" })}\n`, "utf8");
    await writeFixtureExtension(cwdA, lifecycleLog, { origin: "A", revision: "v1", dynamicProvider: true });
    await writeFixtureExtension(cwdB, lifecycleLog, { origin: "B", revision: "v1", dynamicProvider: true });

    const credentials = await ProfileCredentialStore.create({ agentDir });
    const registry = new SessionAuthRuntimeRegistry(credentials);
    const managers: SessionManager[] = [];
    const sessionManager: PiSessionManagerGateway = {
      create: (cwd) => {
        const manager = SessionManager.inMemory(cwd);
        managers.push(manager);
        return manager;
      },
      list: () => Promise.resolve([]),
      open: (path) => SessionManager.open(path),
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir,
      sessionModelRuntimeFactory: createSessionModelRuntimeFactory({ agentDir, credentials, authRuntimeRegistry: registry }),
      authRuntimeRegistry: registry,
      credentialRevisions: credentials,
      sessionManager,
      heartbeatIntervalMs: 60_000,
    });

    try {
      const sessions = new Map<string, { id: string; cwd: string }>();
      for (const origin of order) {
        const cwd = origin === "A" ? cwdA : cwdB;
        const created = await service.start(cwd);
        sessions.set(origin, { id: created.id, cwd });
      }
      const sessionA = required(sessions.get("A"), "session A");
      const sessionB = required(sessions.get("B"), "session B");
      const targetA = required(registry.resolveTarget({ sessionId: sessionA.id, cwd: cwdA }), "target A");
      const targetB = required(registry.resolveTarget({ sessionId: sessionB.id, cwd: cwdB }), "target B");
      const managerA = required(managers.find((manager) => manager.getSessionId() === sessionA.id), "manager A");
      const managerB = required(managers.find((manager) => manager.getSessionId() === sessionB.id), "manager B");

      expect(targetA.runtime).not.toBe(targetB.runtime);
      await expectFixtureRuntime(targetA.runtime, "A", "v1");
      await expectFixtureRuntime(targetB.runtime, "B", "v1");
      expect(targetA.runtime.getModel(providerId, "only-A-v1")).toBeDefined();
      expect(targetA.runtime.getModel(providerId, "only-B-v1")).toBeUndefined();
      expect(targetB.runtime.getModel(providerId, "only-B-v1")).toBeDefined();
      expect(targetB.runtime.getModel(providerId, "only-A-v1")).toBeUndefined();
      expect(targetA.runtime.getModel("dynamic-A", "dynamic-model")).toBeDefined();
      expect(targetB.runtime.getModel("dynamic-B", "dynamic-model")).toBeDefined();

      // Exercise the actual AgentSession stream boundary too, including each
      // extension's before_provider_headers hook.
      await service.setModel(sessionRef(sessionA.id, cwdA), providerId, collisionModelId);
      await service.setModel(sessionRef(sessionB.id, cwdB), providerId, collisionModelId);
      await service.prompt(sessionRef(sessionA.id, cwdA), "stream through A");
      await service.prompt(sessionRef(sessionB.id, cwdB), "stream through B");
      await expectSessionAssistantText(managerA, "A-v1|https://a-v1.example.test/v1|A-v1|hook-A-v1");
      await expectSessionAssistantText(managerB, "B-v1|https://b-v1.example.test/v1|B-v1|hook-B-v1");

      // Stored OAuth for a duplicated extension provider fails closed across
      // distinct cwd scopes; neither open order silently selects one definition.
      await credentials.modify(providerId, () => Promise.resolve({
        type: "oauth",
        refresh: "shared-refresh",
        access: "shared-access",
        expires: Date.now() + 60_000,
      }));
      await expect(targetA.runtime.getAuth(providerId)).rejects.toThrow(`Credential store read failed for ${providerId}`);
      await expect(targetB.runtime.getAuth(providerId)).rejects.toThrow(`Credential store read failed for ${providerId}`);
      await credentials.delete(providerId);

      const beforeReload = snapshotManager(managerA);
      const oldRuntimeA = targetA.runtime;

      await writeFixtureExtension(cwdA, lifecycleLog, { origin: "A", revision: "v2", dynamicProvider: false });
      await expect(service.runCommand(sessionRef(sessionA.id, cwdA), "/reload")).resolves.toMatchObject({ type: "done" });

      const reloadedA = required(registry.resolveTarget({ sessionId: sessionA.id, cwd: cwdA }), "reloaded target A");
      expect(reloadedA.runtime).not.toBe(oldRuntimeA);
      expect(registry.isCurrentGeneration(targetA)).toBe(false);
      await expectFixtureRuntime(reloadedA.runtime, "A", "v2");
      await expectFixtureRuntime(targetB.runtime, "B", "v1");
      expect(reloadedA.runtime.getModel(providerId, "only-A-v1")).toBeUndefined();
      expect(reloadedA.runtime.getModel(providerId, "only-A-v2")).toBeDefined();
      expect(reloadedA.runtime.getModel("dynamic-A", "dynamic-model")).toBeUndefined();
      expect(snapshotManager(managerA)).toEqual(beforeReload);
      await expect(service.status(sessionRef(sessionA.id, cwdA))).resolves.toMatchObject({
        model: { provider: providerId, id: collisionModelId },
      });
      await service.prompt(sessionRef(sessionA.id, cwdA), "stream through reloaded A");
      await expectSessionAssistantText(managerA, "A-v2|https://a-v2.example.test/v1|A-v2|hook-A-v2");

      const lifecycle = (await readFile(lifecycleLog, "utf8")).trim().split("\n");
      expectLifecycleOrder(lifecycle, ["A-v1:shutdown:reload", "A-v2:factory", "A-v2:start:reload"]);
      expect(lifecycle.filter((entry) => entry === "A-v2:factory")).toHaveLength(1);
      expect(lifecycle.find((entry) => entry.startsWith("A-v2:tools:"))).toContain("fixture-tool-A-v2");

      // Once the distinct B scope is gone, two sessions in the same canonical
      // cwd may share the profile credential and the same OAuth implementation.
      await service.stop(sessionRef(sessionB.id, cwdB));
      const secondA = await service.start(cwdA);
      const secondATarget = required(registry.resolveTarget({ sessionId: secondA.id, cwd: cwdA }), "second target A");
      await credentials.modify(providerId, () => Promise.resolve({
        type: "oauth",
        refresh: "same-cwd-refresh",
        access: "same-cwd-access",
        expires: Date.now() + 60_000,
      }));
      await expect(reloadedA.runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "same-cwd-access" } });
      await expect(secondATarget.runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "same-cwd-access" } });
      await credentials.delete(providerId);
      await service.stop(sessionRef(secondA.id, cwdA));

      // Removing the extension drops every registration in the next fresh
      // overlay while preserving the same in-memory manager and complete tree.
      const beforeRemovalReload = snapshotManager(managerA);
      await unlink(join(cwdA, ".pi", "extensions", "provider.ts"));
      await expect(service.runCommand(sessionRef(sessionA.id, cwdA), "/reload")).resolves.toMatchObject({ type: "done" });
      const withoutExtension = required(registry.resolveTarget({ sessionId: sessionA.id, cwd: cwdA }), "target A without extension");
      expect(withoutExtension.runtime.getModel(providerId, collisionModelId)).toBeUndefined();
      expect(withoutExtension.runtime.getRegisteredProviderIds()).not.toContain(providerId);
      expect(snapshotManager(managerA)).toEqual(beforeRemovalReload);
    } finally {
      await service.dispose();
      registry.dispose();
      credentials.dispose();
    }
  }, 20_000);
});

async function expectFixtureRuntime(runtime: ModelRuntime, origin: "A" | "B", revision: "v1" | "v2"): Promise<void> {
  const config = runtime.getRegisteredProviderConfig(providerId);
  expect(config).toMatchObject({
    baseUrl: `https://${origin.toLowerCase()}-${revision}.example.test/v1`,
    headers: { "x-fixture-origin": `${origin}-${revision}` },
  });
  const model = required(runtime.getModel(providerId, collisionModelId), `${origin} ${revision} collision model`);
  expect(model.name).toBe(`${origin}-${revision} collision`);
  expect(model.baseUrl).toBe(`https://${origin.toLowerCase()}-${revision}.example.test/v1`);
  const response = await runtime.completeSimple(model, { messages: [] });
  expect(assistantText(response)).toBe(`${origin}-${revision}|${model.baseUrl}|${origin}-${revision}|undefined`);
}

async function expectSessionAssistantText(manager: SessionManager, expected: string): Promise<void> {
  await vi.waitFor(() => {
    const messages: readonly unknown[] = manager.buildSessionContext().messages;
    const assistant = [...messages].reverse().find(isAssistantMessage);
    expect(assistantText({ content: assistant?.content ?? [] })).toBe(expected);
  });
}

function isAssistantMessage(value: unknown): value is { role: "assistant"; content: readonly unknown[] } {
  return typeof value === "object"
    && value !== null
    && "role" in value
    && value.role === "assistant"
    && "content" in value
    && Array.isArray(value.content);
}

function snapshotManager(manager: SessionManager) {
  return {
    manager,
    sessionId: manager.getSessionId(),
    leafId: manager.getLeafId(),
    entries: structuredClone(manager.getEntries()),
    tree: structuredClone(manager.getTree()),
  };
}

function expectLifecycleOrder(lines: readonly string[], expected: readonly string[]): void {
  let priorIndex = -1;
  for (const entry of expected) {
    const index = lines.indexOf(entry);
    expect(index, `missing lifecycle entry ${entry}`).toBeGreaterThan(priorIndex);
    priorIndex = index;
  }
}

function assistantText(message: { content: readonly unknown[] }): string {
  return message.content
    .flatMap((part) => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [])
    .join("");
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

async function writeFixtureExtension(
  cwd: string,
  lifecycleLog: string,
  fixture: { origin: "A" | "B"; revision: "v1" | "v2"; dynamicProvider: boolean },
): Promise<void> {
  const label = `${fixture.origin}-${fixture.revision}`;
  const endpoint = `https://${fixture.origin.toLowerCase()}-${fixture.revision}.example.test/v1`;
  const dynamicRegistration = fixture.dynamicProvider
    ? `pi.on("session_start", () => { pi.registerProvider("dynamic-${fixture.origin}", { baseUrl: "https://dynamic-${fixture.origin.toLowerCase()}.example.test/v1", apiKey: "dynamic-key", api: "openai-completions", models: [{ id: "dynamic-model", name: "Dynamic ${fixture.origin}", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }] }); });`
    : "";
  const source = `
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function fixtureProvider(pi) {
  appendFileSync(${JSON.stringify(lifecycleLog)}, ${JSON.stringify(`${label}:factory\n`)});
  pi.registerProvider(${JSON.stringify(providerId)}, {
    name: ${JSON.stringify(`${label} provider`)},
    baseUrl: ${JSON.stringify(endpoint)},
    apiKey: ${JSON.stringify(`fallback-${label}`)},
    headers: { "x-fixture-origin": ${JSON.stringify(label)} },
    api: "openai-completions",
    models: [
      { id: ${JSON.stringify(collisionModelId)}, name: ${JSON.stringify(`${label} collision`)}, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 },
      { id: ${JSON.stringify(`only-${label}`)}, name: ${JSON.stringify(`Only ${label}`)}, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }
    ],
    oauth: {
      name: ${JSON.stringify(`${label} OAuth`)},
      login: async () => ({ refresh: ${JSON.stringify(`login-${label}`)}, access: ${JSON.stringify(`login-${label}`)}, expires: Date.now() + 60000 }),
      refreshToken: async (credential) => ({ ...credential, access: ${JSON.stringify(`refreshed-${label}`)}, expires: Date.now() + 60000 }),
      getApiKey: (credential) => credential.access
    },
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const text = ${JSON.stringify(`${label}|`)} + model.baseUrl + "|" + String(options?.headers?.["x-fixture-origin"]) + "|" + String(options?.headers?.["x-fixture-hook"]);
      const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    }
  });
  pi.registerTool({ name: ${JSON.stringify(`fixture-tool-${label}`)}, label: ${JSON.stringify(`Fixture tool ${label}`)}, description: "Acceptance fixture", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: ${JSON.stringify(label)} }], details: {} }; } });
  pi.on("before_provider_headers", (event) => { event.headers["x-fixture-hook"] = ${JSON.stringify(`hook-${label}`)}; });
  ${dynamicRegistration}
  pi.on("session_start", (event) => {
    appendFileSync(${JSON.stringify(lifecycleLog)}, ${JSON.stringify(`${label}:start:`)} + event.reason + "\\n");
    appendFileSync(${JSON.stringify(lifecycleLog)}, ${JSON.stringify(`${label}:tools:`)} + pi.getActiveTools().join(",") + "\\n");
  });
  pi.on("session_shutdown", (event) => { appendFileSync(${JSON.stringify(lifecycleLog)}, ${JSON.stringify(`${label}:shutdown:`)} + event.reason + "\\n"); });
}
`;
  await writeFile(join(cwd, ".pi", "extensions", "provider.ts"), source, "utf8");
}
