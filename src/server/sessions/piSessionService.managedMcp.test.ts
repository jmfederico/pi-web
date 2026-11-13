import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../piSdk.js";
import { createManagedMcpConfigService } from "../mcp/managedMcpConfig.js";
import { readManagedMcpSession, writeManagedMcpSession } from "../mcp/managedMcpSession.js";
import { PiSessionService } from "./piSessionService.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { CapturingSessionEventHub, fakeRuntime, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";
import { SessionArchiveStore } from "./sessionArchiveStore.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("copies only session grants into independent and tracked agent sessions before startup, without creation options", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-inheritance-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ mcp: { servers: { global: { url: "https://example.test/global" }, session: { url: "https://example.test/session" } }, enabledServers: ["global"] } }));
  const managers = new Map<string, SessionManager>();
  const startup = new Map<string, string[]>();
  const prompted = new Map<string, string[]>();
  const createAgentRuntime: RuntimeCreator = (_factory, options) => {
    const manager = options.sessionManager;
    if (!(manager instanceof SessionManager)) throw new Error("Expected real SDK session storage");
    managers.set(manager.getSessionId(), manager);
    const fake = fakeRuntime(manager.getSessionId(), {
      sessionManager: manager, sessionFile: manager.getSessionFile(),
      prompt: (text) => {
        prompted.set(manager.getSessionId(), readManagedMcpSession(manager));
        manager.appendMessage({ role: "user", content: text, timestamp: 0 });
        return Promise.resolve();
      },
    });
    const bind = fake.session.bindExtensions.bind(fake.session);
    fake.session.bindExtensions = (bindings) => {
      startup.set(manager.getSessionId(), readManagedMcpSession(manager));
      return bind(bindings);
    };
    return Promise.resolve(fake.runtime);
  };
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir, modelRuntime: testModelRuntime,
    sessionManager: createPiSessionManagerGateway({ agentDir, env: {} }),
    archiveStore: new SessionArchiveStore(join(root, "archive.json")),
    managedMcpConfig: createManagedMcpConfigService({ env: { PI_WEB_CONFIG: configPath } }),
    createAgentRuntime,
    spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd }) },
    subsessionsEnabled: true, heartbeatIntervalMs: 60_000,
  });
  cleanups.push(() => service.dispose());
  const parent = await service.start(cwd);
  const parentManager = managers.get(parent.id);
  if (parentManager === undefined) throw new Error("Parent manager missing");
  writeManagedMcpSession(parentManager, ["session"]);
  const independent = await service.spawnSession({ spawningCwd: cwd, spawningSessionId: parent.id, cwd: undefined, prompt: "Independent" });
  const tracked = await service.spawnSubsession({ spawningCwd: cwd, parentSessionId: parent.id, parentSessionFile: parent.path, prompt: "Tracked" });
  for (const id of [independent.sessionId, tracked.sessionId]) {
    expect(startup.get(id)).toEqual(["session"]);
    expect(prompted.get(id)).toEqual(["session"]);
  }
  writeManagedMcpSession(parentManager, []);
  for (const id of [independent.sessionId, tracked.sessionId]) {
    const manager = managers.get(id);
    if (manager === undefined) throw new Error("Child manager missing");
    expect(readManagedMcpSession(manager)).toEqual(["session"]);
  }
  const fresh = await service.start(cwd);
  expect(startup.get(fresh.id)).toEqual([]);
});
