import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../piSdk.js";
import { createSessionStateData, latestSessionStateEntries, readSessionState, SESSION_STATE_CUSTOM_TYPE } from "../../shared/sessionState.js";
import { PiSessionService } from "./piSessionService.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { CapturingSessionEventHub, fakeRuntime, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";
import { SessionArchiveStore } from "./sessionArchiveStore.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-state-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const managers = new Map<string, SessionManager>();
  const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();
  const startup = new Map<string, unknown[]>();
  const prompted = new Map<string, unknown[]>();
  let runtimeFactory: Parameters<RuntimeCreator>[0] | undefined;
  const createAgentRuntime: RuntimeCreator = (factory, options) => {
    runtimeFactory = factory;
    const manager = options.sessionManager;
    if (!(manager instanceof SessionManager)) throw new Error("Expected real SDK session storage");
    managers.set(manager.getSessionId(), manager);
    const fake = fakeRuntime(manager.getSessionId(), {
      sessionManager: manager, sessionFile: manager.getSessionFile(),
      prompt: (text) => {
        prompted.set(manager.getSessionId(), latestSessionStateEntries(manager.getEntries()).map(({ namespace, value }) => ({ namespace, value })));
        manager.appendMessage({ role: "user", content: text, timestamp: 0 });
        return Promise.resolve();
      },
    });
    runtimes.set(manager.getSessionId(), fake);
    const bind = fake.session.bindExtensions.bind(fake.session);
    fake.session.bindExtensions = (bindings) => {
      startup.set(manager.getSessionId(), latestSessionStateEntries(manager.getEntries()).map(({ namespace, value }) => ({ namespace, value })));
      return bind(bindings);
    };
    return Promise.resolve(fake.runtime);
  };
  const gateway = createPiSessionManagerGateway({ agentDir, env: {} });
  const archiveStore = new SessionArchiveStore(join(root, "archive.json"));
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir, modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore,
    createAgentRuntime,
    // The fork-boundary test observes the real service wrapper before any extension loads.
    createRuntime: () => Promise.reject(new Error("Observed initialized fork")),
    spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd }) },
    subsessionsEnabled: true, heartbeatIntervalMs: 60_000,
  });
  cleanups.push(() => service.dispose());
  const parent = await service.start(cwd);
  const manager = managers.get(parent.id);
  if (manager === undefined) throw new Error("Parent manager missing");
  return { service, manager, parent, cwd, agentDir, managers, runtimes, startup, prompted, gateway, archiveStore, factory: () => {
    if (runtimeFactory === undefined) throw new Error("Missing runtime factory");
    return runtimeFactory;
  } };
}

it("copies only latest opted-in namespaces before independent and tracked agent startup and prompts", async () => {
  const f = await fixture();
  f.manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("shared", ["old"], true));
  f.manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("shared", ["current"], true));
  f.manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("private", "secret", false));
  f.manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("opted-out", 1, true));
  f.manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("opted-out", 2, false));
  const independent = await f.service.spawnSession({ spawningCwd: f.cwd, spawningSessionId: f.parent.id, cwd: undefined, prompt: "Independent" });
  const tracked = await f.service.spawnSubsession({ spawningCwd: f.cwd, parentSessionId: f.parent.id, parentSessionFile: f.parent.path, prompt: "Tracked" });
  for (const id of [independent.sessionId, tracked.sessionId]) {
    expect(f.startup.get(id)).toEqual([{ namespace: "shared", value: ["current"] }]);
    expect(f.prompted.get(id)).toEqual([{ namespace: "shared", value: ["current"] }]);
  }
  f.manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("shared", [], true));
  for (const id of [independent.sessionId, tracked.sessionId]) {
    const manager = f.managers.get(id);
    if (manager === undefined) throw new Error("Child manager missing");
    expect(readSessionState(manager.getEntries(), "shared").value).toEqual(["current"]);
  }
  const fresh = await f.service.start(f.cwd);
  expect(f.startup.get(fresh.id)).toEqual([]);
});

it("resets historical state and installs current opted-in values before an earlier-checkpoint fork runtime loads", async () => {
  const f = await fixture();
  const child = SessionManager.create(f.cwd, join(f.agentDir, "forks"));
  // These are the historical custom entries a native earlier-checkpoint fork copied.
  child.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("private", "secret", false));
  child.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("opted-out", "old", true));
  child.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("shared", "old", true));
  f.manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("opted-out", "new", false));
  f.manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("shared", "current", true));
  await expect(f.factory()({ cwd: f.cwd, agentDir: f.agentDir, sessionManager: child,
    sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile: f.parent.path },
  })).rejects.toThrow("Observed initialized fork");
  expect(latestSessionStateEntries(child.getEntries()).map(({ namespace, value }) => ({ namespace, value })))
    .toEqual([{ namespace: "shared", value: "current" }]);
});

it("rejects state writes while a fork holds the session replacement reservation", async () => {
  const f = await fixture();
  const runtime = f.runtimes.get(f.parent.id)?.runtime;
  if (runtime === undefined) throw new Error("Missing runtime");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  runtime.fork = async () => { entered(); await held; return { cancelled: true }; };
  const entryId = f.manager.appendMessage({ role: "user", content: "Fork here", timestamp: 0 });
  const ref = { id: f.parent.id, cwd: f.cwd };
  const fork = f.service.forkFromTree(ref, { entryId, expectedLeafId: f.manager.getLeafId() });
  try {
    await started;
    await expect(f.service.writeSessionState(ref, "example", { value: true, inherit: true, revision: "" })).rejects.toThrow("replacement");
    expect(readSessionState(f.manager.getEntries(), "example")).toEqual({ revision: "" });
  } finally { release(); await fork; }
});

it("hosts saved unloaded sessions safely and persists revisions while archived sessions reject writes", async () => {
  const f = await fixture();
  const saved = f.gateway.create(f.cwd);
  if (!(saved instanceof SessionManager)) throw new Error("Expected real SDK session storage");
  saved.appendMessage({ role: "user", content: "Saved", timestamp: 0 });
  saved.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData("example", "before", true));
  const ref = { id: saved.getSessionId(), cwd: f.cwd };
  expect(f.managers.has(ref.id)).toBe(false);
  const prior = await f.service.readSessionState(ref, "example");
  expect(prior.value).toBe("before");
  expect(f.managers.has(ref.id)).toBe(true);
  const written = await f.service.writeSessionState(ref, "example", { value: "after", inherit: false, revision: prior.revision });
  const file = saved.getSessionFile();
  if (file === undefined) throw new Error("Missing saved file");
  expect(readSessionState(SessionManager.open(file).getEntries(), "example")).toEqual(written);
  const archived = await f.service.archiveMany([ref]);
  expect(archived.archivedSessionIds).toContain(ref.id);
  await expect(f.service.writeSessionState(ref, "example", { value: "forbidden", inherit: true, revision: written.revision })).rejects.toThrow("read-only");
});

it("uses native optimistic revisions, detached JSON and exact workspace identity without public metadata", async () => {
  const f = await fixture();
  const ref = { id: f.parent.id, cwd: f.cwd };
  expect(await f.service.readSessionState(ref, "example")).toEqual({ revision: "" });
  const value = { choices: ["a"] };
  const written = await f.service.writeSessionState(ref, "example", { value, inherit: true, revision: "" });
  value.choices.push("not saved");
  expect(await f.service.readSessionState(ref, "example")).toEqual({ value: { choices: ["a"] }, revision: written.revision });
  await expect(f.service.writeSessionState(ref, "example", { value: null, inherit: false, revision: "" })).rejects.toMatchObject({ code: "SESSION_STATE_CONFLICT" });
  await expect(f.service.readSessionState({ ...ref, cwd: join(f.cwd, "other") }, "example")).rejects.toThrow();
  expect((await f.service.listCatalogSessions(f.cwd)).find(({ id }) => id === f.parent.id)?.metadata).toBeUndefined();
  const changed = await f.service.writeSessionState(ref, "example", { value: null, inherit: false, revision: written.revision });
  expect(changed.revision).not.toBe(written.revision);
  expect(changed.value).toBeNull();
  const cancelled = AbortSignal.abort();
  await expect(f.service.writeSessionState(ref, "example", { value: "late", inherit: true, revision: changed.revision }, cancelled)).rejects.toThrow();
  expect(await f.service.readSessionState(ref, "example")).toEqual(changed);
});
