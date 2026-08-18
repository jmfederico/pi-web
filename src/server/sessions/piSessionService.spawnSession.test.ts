import { describe, expect, it } from "vitest";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import type { SpawnTargetDecision } from "./spawnTargetResolver.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, testModel, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const TEST_MODEL_SPEC = "anthropic/claude-sonnet-4-5-20250929";

describe("PiSessionService", () => {
  describe("spawnSession", () => {
    function spawnService(decision: SpawnTargetDecision) {
      const fake = fakeRuntime("spawned-1", { sessionFile: "/tmp/spawned-1.jsonl", sessionManager: fakeSessionManager(decision.allowed ? decision.cwd : "/workspace") });
      const log: { details: Record<string, unknown>; message: string }[] = [];
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([]),
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve(decision) },
        logger: { info: (details, message) => { log.push({ details, message }); } },
        heartbeatIntervalMs: 60_000,
      });
      return { fake, service, log };
    }

    it("starts a session at the resolved target, delivers the prompt, and logs the spawn", async () => {
      const { fake, service, log } = spawnService({ allowed: true, cwd: "/workspace-feature" });

      const result = await service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "continue the plan", cwd: "/workspace-feature" });

      expect(result).toEqual({ sessionId: "spawned-1", cwd: "/workspace-feature" });
      expect(fake.calls.prompt).toEqual([{ text: "continue the plan", options: undefined }]);
      expect(log).toEqual([{ details: { spawningCwd: "/workspace", sessionId: "spawned-1", cwd: "/workspace-feature", promptLength: 17 }, message: "spawn_session started a new session" }]);
      await service.dispose();
    });

    it("uses the dispatching session's model as the spawned session's initial model", async () => {
      const fake = fakeRuntime("spawned-1", { sessionFile: "/tmp/spawned-1.jsonl", sessionManager: fakeSessionManager("/workspace-feature") });
      const model = testModel();
      let initialModel: PiAgentSession["model"];
      let delegationToolsEnabled: boolean | undefined;
      const createAgentRuntime: RuntimeCreator = async (_createRuntime, options) => {
        await Promise.resolve();
        initialModel = options.initialModel;
        delegationToolsEnabled = options.delegationToolsEnabled;
        return fake.runtime;
      };
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
        createAgentRuntime,
        sessionManager: sessionGateway([]),
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
        heartbeatIntervalMs: 60_000,
      });

      await service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "continue", cwd: "/workspace-feature", model });

      expect(initialModel).toBe(model);
      expect(delegationToolsEnabled).toBe(true);
      await service.dispose();
    });

    it("passes the dispatching session's thinking level to the spawned session's runtime", async () => {
      const fake = fakeRuntime("spawned-1", { sessionFile: "/tmp/spawned-1.jsonl", sessionManager: fakeSessionManager("/workspace-feature") });
      let initialThinkingLevel: unknown;
      const createAgentRuntime: RuntimeCreator = async (_createRuntime, options) => {
        await Promise.resolve();
        initialThinkingLevel = options.initialThinkingLevel;
        return fake.runtime;
      };
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
        createAgentRuntime,
        sessionManager: sessionGateway([]),
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
        heartbeatIntervalMs: 60_000,
      });

      await service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "continue", cwd: "/workspace-feature", thinkingLevel: "high" });

      expect(initialThinkingLevel).toBe("high");
      await service.dispose();
    });

    it("leaves the spawned session's thinking level to pi defaults when the dispatcher has none", async () => {
      const fake = fakeRuntime("spawned-1", { sessionFile: "/tmp/spawned-1.jsonl", sessionManager: fakeSessionManager("/workspace-feature") });
      let initialThinkingLevel: unknown = "unset";
      const createAgentRuntime: RuntimeCreator = async (_createRuntime, options) => {
        await Promise.resolve();
        initialThinkingLevel = options.initialThinkingLevel;
        return fake.runtime;
      };
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
        createAgentRuntime,
        sessionManager: sessionGateway([]),
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
        heartbeatIntervalMs: 60_000,
      });

      await service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "continue", cwd: "/workspace-feature" });

      expect(initialThinkingLevel).toBeUndefined();
      await service.dispose();
    });

    it("names the spawned session's model in the result", async () => {
      const spawned = fakeRuntime("spawned-1", { sessionFile: "/tmp/spawned-1.jsonl", model: testModel(), sessionManager: fakeSessionManager("/workspace-feature") });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
        createAgentRuntime: runtimeCreator(spawned.runtime),
        sessionManager: sessionGateway([]),
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
        heartbeatIntervalMs: 60_000,
      });

      const result = await service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "continue", cwd: "/workspace-feature" });

      expect(result).toEqual({ sessionId: "spawned-1", cwd: "/workspace-feature", model: TEST_MODEL_SPEC });
      await service.dispose();
    });

    it("rejects an out-of-project target without starting a session", async () => {
      const { fake, service } = spawnService({ allowed: false, reason: "out-of-project", allowedCwds: ["/workspace"] });

      await expect(service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "go", cwd: "/elsewhere" }))
        .rejects.toThrow("cwd must be a workspace of this project. Allowed: /workspace");
      expect(fake.calls.prompt).toEqual([]);
      expect(service.activeCount()).toBe(0);
      await service.dispose();
    });

    it("rejects when the spawning session is not in a registered project", async () => {
      const { service } = spawnService({ allowed: false, reason: "not-registered" });

      await expect(service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "go", cwd: undefined }))
        .rejects.toThrow("Spawning session is not in a registered project");
      await service.dispose();
    });

    it("is disabled when no spawn target resolver is configured", async () => {
      const fake = fakeRuntime("spawned-x");
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([]),
        heartbeatIntervalMs: 60_000,
      });

      await expect(service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "go", cwd: undefined }))
        .rejects.toThrow("Spawning sessions is disabled");
      await service.dispose();
    });

    describe("model spec resolution", () => {
      /**
       * Harness: the spawner comes online via `service.start`, then the spawn
       * creates the next queued runtime. `initialModels` records every
       * creation-time model so tests can see exactly what the spawned session
       * was started with.
       */
      function specService(spawnerPatch: Parameters<typeof fakeRuntime>[1] = {}) {
        const spawner = fakeRuntime("spawner-1", { sessionFile: "/tmp/spawner-1.jsonl", sessionManager: fakeSessionManager("/workspace"), ...spawnerPatch });
        const spawned = fakeRuntime("spawned-2", { sessionFile: "/tmp/spawned-2.jsonl", model: testModel(), sessionManager: fakeSessionManager("/workspace-feature") });
        const initialModels: PiAgentSession["model"][] = [];
        const runtimes = [spawner.runtime, spawned.runtime];
        let index = 0;
        const createAgentRuntime: RuntimeCreator = async (_createRuntime, options) => {
          await Promise.resolve();
          initialModels.push(options.initialModel);
          const runtime = runtimes[index] ?? spawned.runtime;
          index += 1;
          return runtime;
        };
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
          createAgentRuntime,
          sessionManager: sessionGateway([]),
          spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
          heartbeatIntervalMs: 60_000,
        });
        return { service, spawner, spawned, initialModels };
      }

      it("resolves the spec against the spawning session's scoped models and names it in the result", async () => {
        const scoped = testModel();
        const { service, initialModels } = specService({ scopedModels: [{ model: scoped }] });
        await service.start("/workspace");

        const result = await service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "go", cwd: "/workspace-feature", modelSpec: TEST_MODEL_SPEC });

        expect(initialModels).toHaveLength(2);
        expect(initialModels[0]).toBeUndefined();
        expect(initialModels[1]).toBe(scoped);
        expect(result).toEqual({ sessionId: "spawned-2", cwd: "/workspace-feature", model: TEST_MODEL_SPEC });
        await service.dispose();
      });

      it("falls back to a direct runtime lookup when the spec is not among the available candidates", async () => {
        // The shared test runtime has no configured auth, so its available
        // snapshot is empty; only the getModel fallback can resolve the spec.
        const { service, initialModels } = specService();
        await service.start("/workspace");

        const result = await service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "go", cwd: "/workspace-feature", modelSpec: TEST_MODEL_SPEC });

        expect(initialModels[1]).toMatchObject({ provider: "anthropic", id: "claude-sonnet-4-5-20250929" });
        expect(result).toEqual({ sessionId: "spawned-2", cwd: "/workspace-feature", model: TEST_MODEL_SPEC });
        await service.dispose();
      });

      it.each(["no-slash", "anthropic/", "/id"])("rejects the malformed spec %s without starting a session", async (modelSpec) => {
        const { service, spawned, initialModels } = specService({ scopedModels: [{ model: testModel() }] });
        await service.start("/workspace");

        await expect(service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "go", cwd: "/workspace-feature", modelSpec }))
          .rejects.toThrow(`Unknown model "${modelSpec}". Pass an exact "provider/model-id".`);
        expect(initialModels).toEqual([undefined]);
        expect(spawned.calls.prompt).toEqual([]);
        expect(service.activeCount()).toBe(1);
        await service.dispose();
      });

      it("rejects an unknown spec without starting a session", async () => {
        const { service, spawned, initialModels } = specService({ scopedModels: [{ model: testModel() }] });
        await service.start("/workspace");

        await expect(service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "go", cwd: "/workspace-feature", modelSpec: "anthropic/does-not-exist" }))
          .rejects.toThrow('Unknown model "anthropic/does-not-exist". Pass an exact "provider/model-id".');
        expect(initialModels).toEqual([undefined]);
        expect(spawned.calls.prompt).toEqual([]);
        expect(service.activeCount()).toBe(1);
        await service.dispose();
      });

      it("rejects an unknown spec even when the spawning session has no available models", async () => {
        const { service } = specService();
        await service.start("/workspace");

        await expect(service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "spawner-1", prompt: "go", cwd: "/workspace-feature", modelSpec: "ghost/model" }))
          .rejects.toThrow('Unknown model "ghost/model". Pass an exact "provider/model-id".');
        await service.dispose();
      });

      it("does not resolve the spawning session when no model spec is given", async () => {
        const spawned = fakeRuntime("spawned-2", { sessionFile: "/tmp/spawned-2.jsonl", model: testModel(), sessionManager: fakeSessionManager("/workspace-feature") });
        const service = new PiSessionService(new CapturingSessionEventHub(), {
          agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
          createAgentRuntime: runtimeCreator(spawned.runtime),
          sessionManager: sessionGateway([]),
          spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
          heartbeatIntervalMs: 60_000,
        });

        // "ghost" is not a resolvable session, and the default path must not care.
        const result = await service.spawnSession({ spawningCwd: "/workspace", spawningSessionId: "ghost", prompt: "go", cwd: "/workspace-feature" });

        expect(result).toEqual({ sessionId: "spawned-2", cwd: "/workspace-feature", model: TEST_MODEL_SPEC });
        expect(spawned.calls.prompt).toEqual([{ text: "go", options: undefined }]);
        await service.dispose();
      });
    });
  });
});
