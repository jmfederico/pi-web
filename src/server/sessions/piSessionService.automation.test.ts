import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("PiSessionService automation execution", () => {
  it("exposes an awaitable prompt path without changing interactive prompt admission", async () => {
    const completion = deferred();
    const promptCalls: string[] = [];
    const fake = fakeRuntime("automation-session", { prompt: (text) => { promptCalls.push(text); return completion.promise; } });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    await service.startAutomation("/workspace");

    let settled = false;
    const run = service.promptAndWait(sessionRef("automation-session"), "Do the work").then(() => { settled = true; });
    await vi.waitFor(() => { expect(promptCalls).toHaveLength(1); });
    expect(settled).toBe(false);
    expect(promptCalls[0]).toBe("Do the work");

    completion.resolve();
    await run;
    expect(settled).toBe(true);
    await service.dispose();
  });

  it("rejects interactive mutations while an automation owns the session", async () => {
    const fake = fakeRuntime("automation-owned");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    await service.startAutomation("/workspace");
    const ref = sessionRef("automation-owned");

    await expect(service.prompt(ref, "interfere")).rejects.toThrow(/Automation-owned sessions are read-only/u);
    await expect(service.setModel(ref, "test", "other")).rejects.toThrow(/Automation-owned sessions are read-only/u);
    await expect(service.abort(ref)).rejects.toThrow(/Automation-owned sessions are read-only/u);
    await expect(service.archive(ref)).rejects.toThrow(/Stop current session activity/u);
    expect(fake.calls.abort).toBe(0);

    service.releaseAutomationSession(ref);
    await service.abort(ref);
    expect(fake.calls.abort).toBe(1);
    await service.stopAndWait(ref);
    await service.dispose();
  });

  it("force-detaches a session without waiting for a stalled soft abort", async () => {
    const never = new Promise<void>(() => undefined);
    const fake = fakeRuntime("automation-stalled", { abort: () => never });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    await service.startAutomation("/workspace");

    await service.forceStopAndWait(sessionRef("automation-stalled"));

    expect(service.activeCount()).toBe(0);
    expect(fake.calls.dispose).toBe(1);
    await service.dispose();
  });

  it("propagates prompt failure to the automation runner and retains the inspectable session", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("automation-error", { prompt: () => Promise.reject(new Error("provider failed")) });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    await service.startAutomation("/workspace");

    await expect(service.promptAndWait(sessionRef("automation-error"), "Do the work")).rejects.toThrow("provider failed");
    expect(service.activeCount()).toBe(1);
    expect(hub.sessionEvents.some((entry) => entry.event.type === "session.error")).toBe(true);

    await service.stopAutomationAndWait(sessionRef("automation-error"));
    expect(fake.calls.dispose).toBe(1);
    expect(service.activeCount()).toBe(0);
    await service.dispose();
  });
});
