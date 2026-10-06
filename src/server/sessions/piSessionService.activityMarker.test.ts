import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

describe("PiSessionService shared activity status", () => {
  it("publishes changing foreign activity through heartbeats for an already-open idle chat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dir = await mkdtemp(join(tmpdir(), "pi-web-activity-heartbeat-"));
    const sessionFile = join(dir, "shared.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"shared"}\n');
    let now = Date.now();
    const hub = new CapturingSessionEventHub();
    const viewer = fakeRuntime("shared", { sessionFile });
    const service = new PiSessionService(hub, {
      agentDir: dir,
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]),
      createAgentRuntime: runtimeCreator(viewer.runtime),
      now: () => new Date(now),
    });
    try {
      await service.start("/workspace");
      await service.status(sessionRef("shared"));
      const lastStatus = () => hub.globalEvents.filter((event) => event.type === "status.update").at(-1)?.status;
      await writeFile(`${sessionFile}.pi-web-activity.json`, JSON.stringify({ owner: "other-daemon", updatedAt: now }));
      now += 2_001;
      await vi.advanceTimersByTimeAsync(2_001);
      await vi.waitFor(() => {
        expect(lastStatus()?.recentlyActiveElsewhere).toBe(true);
        expect(lastStatus()?.warnings ?? []).toEqual([]);
      });

      // A crashed owner's marker disappears from the UI without a status fetch.
      now += 16_000;
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(lastStatus()?.recentlyActiveElsewhere).toBe(false);
      });
    } finally {
      await service.dispose();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports another daemon's work as status rather than a warning without claiming an idle viewer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-shared-activity-"));
    const sessionFile = join(dir, "shared.jsonl");
    const markerFile = `${sessionFile}.pi-web-activity.json`;
    await writeFile(sessionFile, '{"type":"session","id":"shared"}\n');
    let now = Date.now();
    const worker = fakeRuntime("shared", { sessionFile, isStreaming: true });
    const viewer = fakeRuntime("shared", { sessionFile });
    const services: PiSessionService[] = [];
    const createService = (fake: typeof worker) => {
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir: dir,
        modelRuntime: testModelRuntime,
        sessionManager: sessionGateway([]),
        createAgentRuntime: runtimeCreator(fake.runtime),
        heartbeatIntervalMs: 60_000,
        now: () => new Date(now),
      });
      services.push(service);
      return service;
    };
    try {
      const first = createService(worker);
      const second = createService(viewer);
      await first.start("/workspace");
      const local = await first.status(sessionRef("shared"));
      expect(local.recentlyActiveElsewhere).toBe(false);
      const ownedMarker = await readFile(markerFile, "utf8");

      await second.start("/workspace");
      const remote = await second.status(sessionRef("shared"));
      expect(remote.recentlyActiveElsewhere).toBe(true);
      expect(remote.warnings ?? []).toEqual([]);
      expect(await readFile(markerFile, "utf8")).toBe(ownedMarker);

      worker.session.isStreaming = false;
      now += 2_001;
      await first.status(sessionRef("shared"));
      const idle = await second.status(sessionRef("shared"));
      expect(idle.recentlyActiveElsewhere).toBe(false);
      await expect(readFile(markerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      worker.session.isStreaming = true;
      await first.status(sessionRef("shared"));
      await first.dispose();
      services.splice(services.indexOf(first), 1);
      await expect(readFile(markerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all(services.map((service) => service.dispose()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
