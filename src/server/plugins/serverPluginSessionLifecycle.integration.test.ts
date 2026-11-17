import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "../sessions/piSessionService.js";
import {
  CapturingSessionEventHub,
  emptyArchiveStore,
  fakeRuntime,
  fakeSessionManager,
  runtimeCreator,
  sessionGateway,
  sessionRecord,
  testModelRuntime,
} from "../sessions/piSessionService.testSupport.js";
import { createServerPluginSessionLifecycleV2CapabilityFactory } from "./serverPluginSessionLifecycleCapability.js";

const cwd = resolve("/workspace");

describe("plugin close with native session hosting", () => {
  it.each([
    { persisted: false, outcome: "removes the published unused hosted-only session from the catalog" },
    { persisted: true, outcome: "keeps the persisted conversation discoverable without hosting" },
  ])("$outcome", async ({ persisted }) => {
    const record = { ...sessionRecord("created", cwd), path: resolve("/sessions/created.jsonl") };
    const records: ReturnType<typeof sessionRecord>[] = [];
    const gateway = sessionGateway(records);
    const open = vi.spyOn(gateway, "open");
    const fake = fakeRuntime(record.id, { sessionFile: record.path, sessionManager: fakeSessionManager(cwd) });
    const events = new CapturingSessionEventHub();
    const service = new PiSessionService(events, {
      agentDir: resolve("/tmp/pi-web-test-agent"),
      modelRuntime: testModelRuntime,
      sessionManager: gateway,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
    });
    const archive = vi.spyOn(service, "archiveMany");
    const deleteArchived = vi.spyOn(service, "deleteArchivedMany");
    const onMutation = vi.fn();
    const instance = createServerPluginSessionLifecycleV2CapabilityFactory({
      projects: { requireProject: () => Promise.resolve({ id: "p", name: "Project", path: cwd, createdAt: "now" }) },
      workspaces: { checkCurrent: () => Promise.resolve({ projectId: "p", status: "provider", diagnostics: [], workspaces: [{ id: "w", projectId: "p", path: cwd, label: "Main", isMain: true }] }) },
      sessions: service,
      pins: { pinnedSessionIds: () => Promise.resolve([]), setPinned: vi.fn(() => Promise.resolve()) },
      onMutation,
    }).create({ pluginId: "consumer", packageRoot: "", lifetimeSignal: new AbortController().signal });
    try {
      const created = await service.createHostedSession(cwd, new AbortController().signal);
      expect(events.globalEvents.find((event) => event.type === "session.created"))
        .toMatchObject({ session: { id: created.id, cwd } });
      expect(fake.calls.prompt).toEqual([]);
      expect(service.activeCount()).toBe(1);
      // Model the scanner discovering a durable conversation at the same identity/path.
      if (persisted) records.push(record);
      expect(await service.listCatalogSessions(cwd)).toEqual([
        expect.objectContaining({ id: created.id, cwd, archived: false, runtime: "idle" }),
      ]);

      const selection = { projectId: "p", workspaceId: "w", sessionId: created.id };
      await instance.value.close(selection);

      expect(service.activeCount()).toBe(0);
      expect(fake.calls.dispose).toBe(1);
      expect(await service.listCatalogSessions(cwd)).toEqual(persisted ? [{
        id: created.id, cwd, archived: false, archivedAt: null, runtime: "not-hosted",
        created: record.created.toISOString(), modified: record.modified.toISOString(),
      }] : []);
      expect(open).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
      expect(deleteArchived).not.toHaveBeenCalled();
      expect(onMutation).toHaveBeenCalledExactlyOnceWith(selection);
    } finally {
      await instance.dispose?.(new AbortController().signal);
      await service.dispose();
    }
  });
});
