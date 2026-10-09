import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, sessionGateway, testModel } from "./piSessionService.testSupport.js";
import { SESSION_DISPATCH_CHANNEL } from "./extensionSessionDispatch.js";
import type { SpawnSessionResult } from "./spawnSessionTool.js";

// Prove the default host runtime installs the generic bridge and shares its
// global capability gate. Isolate spawn itself: persistence is covered by the
// metadata lifecycle suite, and this check must never submit a provider prompt.
describe("default hosted session dispatch wiring", () => {
  it.each([true, false])("installs the bridge with the global spawn gate (enabled=%s)", async (enabled) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-host-dispatch-"));
    const modelRuntime = await createTestModelRuntime();
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: cwd, modelRuntime,
      sessionManager: { ...sessionGateway([]), create: (path) => SessionManager.inMemory(path) },
      archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
      ...(enabled ? { spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true as const, cwd }) } } : {}),
    });
    const spawn = vi.spyOn(service, "spawnSession").mockResolvedValue({ sessionId: "next", cwd });
    try {
      const parent = await service.start(cwd, { initialModel: testModel(), initialThinkingLevel: "high" });
      const connection = service.connectSessionEvents({ id: parent.id, cwd }, new AbortController().signal);
      let accepted: Promise<SpawnSessionResult> | undefined;
      connection.emit(SESSION_DISPATCH_CHANNEL, {
        input: { prompt: "Generated package handover", name: "Package leg 2", metadata: { package: { leg: 2 } } },
        accept: (promise: Promise<SpawnSessionResult>) => { accepted = promise; },
      });
      expect(accepted).toBeInstanceOf(Promise);
      if (enabled) {
        await expect(accepted).resolves.toEqual({ sessionId: "next", cwd });
        expect(spawn).toHaveBeenCalledExactlyOnceWith({
          spawningCwd: cwd, spawningSessionId: parent.id, prompt: "Generated package handover", cwd: undefined,
          name: "Package leg 2", metadata: { package: { leg: 2 } }, model: testModel(), thinkingLevel: "high",
        });
      } else {
        await expect(accepted).rejects.toThrow("dispatch is disabled");
        expect(spawn).not.toHaveBeenCalled();
      }
    } finally {
      await service.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
