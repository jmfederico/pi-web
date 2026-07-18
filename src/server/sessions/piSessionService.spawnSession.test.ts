import { describe, expect, it } from "vitest";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import type { SpawnTargetDecision } from "./spawnTargetResolver.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, testModel, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

describe("PiSessionService", () => {
  describe("spawnSession", () => {
    function spawnService(decision: SpawnTargetDecision) {
      const fake = fakeRuntime("spawned-1", { sessionFile: "/tmp/spawned-1.jsonl" });
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

      const result = await service.spawnSession({ spawningCwd: "/workspace", prompt: "continue the plan", cwd: "/workspace-feature" });

      expect(result).toEqual({ sessionId: "spawned-1", cwd: "/workspace-feature" });
      expect(fake.calls.prompt).toEqual([{ text: "continue the plan", options: undefined }]);
      expect(log).toEqual([{ details: { spawningCwd: "/workspace", sessionId: "spawned-1", cwd: "/workspace-feature", promptLength: 17 }, message: "spawn_session started a new session" }]);
      await service.dispose();
    });

    it("uses the dispatching session's model as the spawned session's initial model", async () => {
      const fake = fakeRuntime("spawned-1", { sessionFile: "/tmp/spawned-1.jsonl" });
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

      await service.spawnSession({ spawningCwd: "/workspace", prompt: "continue", cwd: "/workspace-feature", model });

      expect(initialModel).toBe(model);
      expect(delegationToolsEnabled).toBe(true);
      await service.dispose();
    });

    it("rejects an out-of-project target without starting a session", async () => {
      const { fake, service } = spawnService({ allowed: false, reason: "out-of-project", allowedCwds: ["/workspace"] });

      await expect(service.spawnSession({ spawningCwd: "/workspace", prompt: "go", cwd: "/elsewhere" }))
        .rejects.toThrow("cwd must be a workspace of this project. Allowed: /workspace");
      expect(fake.calls.prompt).toEqual([]);
      expect(service.activeCount()).toBe(0);
      await service.dispose();
    });

    it("rejects when the spawning session is not in a registered project", async () => {
      const { service } = spawnService({ allowed: false, reason: "not-registered" });

      await expect(service.spawnSession({ spawningCwd: "/workspace", prompt: "go", cwd: undefined }))
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

      await expect(service.spawnSession({ spawningCwd: "/workspace", prompt: "go", cwd: undefined }))
        .rejects.toThrow("Spawning sessions is disabled");
      await service.dispose();
    });
  });
});
