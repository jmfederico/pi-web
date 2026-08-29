import { afterEach, describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRuntime,
  runtimeCreator,
  sessionGateway,
  sessionRef,
  testModelRuntime,
} from "./piSessionService.testSupport.js";

const services: PiSessionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

function serviceWithRuntime(runtime: ReturnType<typeof fakeRuntime>["runtime"]): PiSessionService {
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: "/agent",
    sessionManager: sessionGateway([]),
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(runtime),
    heartbeatIntervalMs: 60_000,
  });
  services.push(service);
  return service;
}

describe("PiSessionService plugin-owned background leases", () => {
  it("blocks interactive mutation while the attributed lease is active and releases after completion", async () => {
    const fixture = fakeRuntime("session-1");
    const service = serviceWithRuntime(fixture.runtime);
    const created = await service.startBackgroundSession("background-service", "/workspace", {});
    const ref = sessionRef(created.session.id);

    await expect(service.prompt(ref, "interactive")).rejects.toThrow("background-service lease is active");
    await expect(service.stop(ref)).rejects.toThrow("background-service lease is active");
    await expect(service.promptBackgroundSession("other", ref, "wrong owner")).rejects.toThrow("not active for plugin other");

    await expect(service.promptBackgroundSession("background-service", ref, "scheduled work")).resolves.toMatchObject({ sessionId: "session-1" });
    service.releaseBackgroundSession("background-service", ref);
    await expect(service.prompt(ref, "interactive after release")).resolves.toBeUndefined();
    expect(fixture.calls.prompt.map(({ text }) => text)).toEqual(["scheduled work", "interactive after release"]);
  });

  it("force-detaches without awaiting stalled runtime disposal", async () => {
    const fixture = fakeRuntime("session-1");
    fixture.runtime.dispose = () => new Promise<void>(() => undefined);
    const service = serviceWithRuntime(fixture.runtime);
    const created = await service.startBackgroundSession("background-service", "/workspace", {});

    await expect(service.forceStopBackgroundSession("background-service", sessionRef(created.session.id))).resolves.toBeUndefined();
    expect(service.activeCount()).toBe(0);
  });
});
