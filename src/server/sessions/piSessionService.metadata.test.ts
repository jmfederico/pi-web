import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";
import { SessionArchiveStore } from "./sessionArchiveStore.js";
import { readSessionUiMetadata, SESSION_UI_METADATA_CUSTOM_TYPE } from "./sessionMetadata.js";

let root: string;
const services: PiSessionService[] = [];
const metadata = { "example.workflow": { packet: ".pi-web/example", leg: 2, nested: [true, null] } };

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-web-session-metadata-")); });
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionManager = createPiSessionManagerGateway({ agentDir, env: {} });
  const archiveStore = new SessionArchiveStore(join(root, "archive.json"));
  const hub = new CapturingSessionEventHub();
  const startupMetadata: unknown[] = [];
  const promptMetadata: unknown[] = [];
  const startupNames: unknown[] = [];
  const promptNames: unknown[] = [];
  const createAgentRuntime: RuntimeCreator = async (_factory, options) => {
    await Promise.resolve();
    const manager = options.sessionManager;
    if (!(manager instanceof SessionManager)) throw new Error("Expected real SDK session storage");
    const fake = fakeRuntime(manager.getSessionId(), {
      sessionManager: manager,
      sessionFile: manager.getSessionFile(),
      sessionName: manager.getSessionName(),
      prompt: (text) => {
        promptMetadata.push(readSessionUiMetadata(manager.getEntries()));
        promptNames.push(manager.getSessionName());
        manager.appendMessage({ role: "user", content: text, timestamp: 0 });
        return Promise.resolve();
      },
    });
    const bind = fake.session.bindExtensions.bind(fake.session);
    fake.session.bindExtensions = (bindings) => {
      startupMetadata.push(readSessionUiMetadata(manager.getEntries()));
      startupNames.push(manager.getSessionName());
      return bind(bindings);
    };
    return fake.runtime;
  };
  const service = new PiSessionService(hub, {
    agentDir, modelRuntime: testModelRuntime, sessionManager, archiveStore, createAgentRuntime,
    spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd }) },
    heartbeatIntervalMs: 60_000,
  });
  services.push(service);
  return { cwd, service, hub, startupMetadata, promptMetadata, startupNames, promptNames, sessionManager };
}

it("initializes metadata before extensions, publication and the first prompt; preserves it in cold listings, reopen and archive", async () => {
  const first = fixture();
  await mkdir(first.cwd);
  const result = await first.service.spawnSession({ spawningCwd: first.cwd, spawningSessionId: "parent", cwd: undefined, prompt: "Continue", metadata, name: "Example workflow leg 2" });
  const ref = { id: result.sessionId, cwd: first.cwd };
  expect(first.startupMetadata).toEqual([metadata]);
  expect(first.promptMetadata).toEqual([metadata]);
  expect(first.startupNames).toEqual(["Example workflow leg 2"]);
  expect(first.promptNames).toEqual(["Example workflow leg 2"]);
  expect(first.hub.globalEvents.find((event) => event.type === "session.created")).toMatchObject({ session: { metadata } });
  await expect(first.service.list(first.cwd)).resolves.toMatchObject([{ id: ref.id, metadata, name: "Example workflow leg 2" }]);
  await first.service.dispose();

  // A fresh gateway/service has no live Pi event connection or in-memory session.
  const reopened = fixture();
  expect(reopened.service.activeCount()).toBe(0);
  await expect(reopened.service.list(first.cwd)).resolves.toMatchObject([{ id: ref.id, metadata, name: "Example workflow leg 2" }]);
  expect(reopened.service.activeCount()).toBe(0);
  await expect(reopened.sessionManager.listAll()).resolves.toMatchObject([{ id: ref.id, metadata }]);
  await reopened.service.status(ref);
  expect(reopened.startupMetadata).toEqual([metadata]);
  expect(reopened.startupNames).toEqual(["Example workflow leg 2"]);
  await reopened.service.archive(ref);
  await expect(reopened.service.list(first.cwd)).resolves.toMatchObject([{ id: ref.id, archived: true, metadata, name: "Example workflow leg 2" }]);
  await reopened.service.restore(ref);
  await expect(reopened.service.list(first.cwd)).resolves.toMatchObject([{ id: ref.id, metadata, name: "Example workflow leg 2" }]);
});

it("publishes metadata on a transient session before Pi flushes its conversation file", async () => {
  const { service, cwd, hub } = fixture();
  await mkdir(cwd);
  const created = await service.start(cwd, { metadata });
  expect(created).toMatchObject({ metadata, persisted: false });
  expect(hub.globalEvents.find((event) => event.type === "session.created")).toMatchObject({ session: { metadata } });
  await expect(service.list(cwd)).resolves.toMatchObject([{ id: created.id, metadata, persisted: false }]);
});

it("rejects invalid metadata before allocating a session", async () => {
  const { service, sessionManager, cwd } = fixture();
  const create = vi.spyOn(sessionManager, "create");
  await expect(service.spawnSession({ spawningCwd: cwd, spawningSessionId: "parent", cwd: undefined, prompt: "Continue", metadata: { example: { invalid: Number.NaN } } })).rejects.toThrow("finite JSON numbers");
  expect(create).not.toHaveBeenCalled();
  expect(service.activeCount()).toBe(0);
});

it("rejects invalid explicit names before allocating a session", async () => {
  const { service, sessionManager, cwd } = fixture();
  const create = vi.spyOn(sessionManager, "create");
  await expect(service.spawnSession({ spawningCwd: cwd, spawningSessionId: "parent", cwd: undefined, prompt: "Continue", name: "invalid\nname" })).rejects.toThrow("Initial session name");
  expect(create).not.toHaveBeenCalled();
});

it("does not expose unrelated custom entries when listing an active session", async () => {
  const { service, sessionManager, cwd } = fixture();
  await mkdir(cwd);
  const create = sessionManager.create.bind(sessionManager);
  vi.spyOn(sessionManager, "create").mockImplementation((path) => {
    const manager = create(path);
    manager.appendCustomEntry?.("private-extension", { token: "private" });
    manager.appendCustomEntry?.(SESSION_UI_METADATA_CUSTOM_TYPE, { version: 2, metadata });
    return manager;
  });
  const created = await service.start(cwd);
  expect(created).not.toHaveProperty("metadata");
  expect((await service.list(cwd))[0]).not.toHaveProperty("metadata");
});
