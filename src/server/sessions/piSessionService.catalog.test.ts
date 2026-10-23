import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, testModelRuntime } from "./piSessionService.testSupport.js";

describe("read-only session catalog", () => {
  it("lists cold conversations without opening a runtime or leaking transcript/file fields", async () => {
    const gateway = sessionGateway([{ ...sessionRecord("cold"), firstMessage: "private text" }]);
    const open = vi.spyOn(gateway, "open");
    const createRuntime = vi.fn(runtimeCreator(fakeRuntime().runtime));
    const events = new CapturingSessionEventHub();
    const service = new PiSessionService(events, { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: createRuntime });
    try {
      expect(await service.listCatalogSessions("/workspace")).toEqual([
        { id: "cold", cwd: "/workspace", archived: false, runtime: "not-hosted" },
      ]);
      expect(open).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("reports already-hosted idle/busy sessions, without assigning runtime state to a cloned file", async () => {
    const fake = fakeRuntime("live");
    const gateway = sessionGateway([]);
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime) });
    try {
      await service.start("/workspace");
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("idle");
      fake.session.isStreaming = true;
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("busy");
      fake.session.isStreaming = false;
      gateway.list = () => Promise.resolve([sessionRecord("live")]);
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("not-hosted");
    } finally {
      await service.dispose();
    }
  });

  it("rejects cancelled reads before touching storage", async () => {
    const gateway = sessionGateway([]);
    const list = vi.spyOn(gateway, "list");
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore() });
    try {
      await expect(service.listCatalogSessions("/workspace", AbortSignal.abort())).rejects.toThrow();
      expect(list).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
    }
  });
});
