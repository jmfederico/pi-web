import { describe, expect, it } from "vitest";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { SessionNotificationStore } from "../sessions/sessionNotificationStore.js";
import { SessionUnreadStore } from "../sessions/sessionUnreadStore.js";
import { PiSessionService, type PiSessionServiceDependencies } from "../sessions/piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, sessionGateway, testModelRuntime } from "../sessions/piSessionService.testSupport.js";
import { sessionServiceDependencies, type SessionServiceDependencyInput } from "./sessionServiceDependencies.js";

const AGENT_DIR = "/tmp/pi-web-test-agent";

/**
 * The collaborators sessiond hands the assembly, with only the process-facing
 * ones (agent dir, session store gateway) replaced. Everything the assembly
 * decides is left to the assembly.
 */
function daemonCollaborators(patch: Partial<SessionServiceDependencyInput> = {}): SessionServiceDependencyInput {
  return {
    agentDir: AGENT_DIR,
    archiveStore: emptyArchiveStore(),
    modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([]),
    workspaceActivity: new WorkspaceActivityService(),
    logger: { info() { /* no-op */ } },
    notificationStore: new SessionNotificationStore(),
    unreadStore: new SessionUnreadStore(),
    onUnreadChanged: () => { /* no-op */ },
    catalogRefreshStatus: { isRefreshInFlight: () => false },
    config: { read: () => Promise.reject(new Error("config read not expected in this test")) },
    subsessionsEnabled: false,
    askUserEnabled: true,
    appendSystemPromptSections: [],
    extensionDialogsTimeoutMs: 300_000,
    ...patch,
  };
}

/**
 * Start a session through a service built by the real assembly and collect what
 * the user is told while waiting. Only test-local seams are patched onto the
 * assembled dependencies, never anything the assembly is responsible for
 * supplying, so a dependency the assembly stops passing cannot be masked here.
 */
async function startupDetails(deps: PiSessionServiceDependencies): Promise<string[]> {
  const hub = new CapturingSessionEventHub();
  const fake = fakeRuntime();
  const service = new PiSessionService(hub, {
    ...deps,
    createAgentRuntime: () => Promise.resolve(fake.runtime),
    heartbeatIntervalMs: 60_000,
  });
  try {
    await service.start("/workspace");
  } finally {
    await service.dispose();
  }
  return hub.globalEvents.flatMap((event) =>
    event.type === "session.startup" && event.activity.detail !== undefined ? [event.activity.detail] : [],
  );
}

describe("sessiond session service dependency assembly", () => {
  it("reports a concurrent provider model list refresh to a waiting user", async () => {
    // The note is only reachable in the product because the assembly hands the
    // refresher to the session service. Asserting the note rather than the
    // property means dropping that line fails here instead of passing silently.
    const details = await startupDetails(sessionServiceDependencies(daemonCollaborators({
      catalogRefreshStatus: { isRefreshInFlight: () => true },
    })));

    expect(details).toEqual([
      "Starting the Pi session · provider model lists are refreshing",
      "Loading session extensions · provider model lists are refreshing",
    ]);
  });

  it("states the startup phase alone when no refresh is running", async () => {
    const details = await startupDetails(sessionServiceDependencies(daemonCollaborators()));

    // Pins the note to the refresher's answer, so the test above cannot pass on
    // wording that is always appended.
    expect(details).toEqual(["Starting the Pi session", "Loading session extensions"]);
  });

  it("keeps tracked subsessions off unless spawning is configured as well", () => {
    const spawnTargets = { resolveSpawnTarget: () => Promise.reject(new Error("not used")) };

    const withoutSpawnTargets = sessionServiceDependencies(daemonCollaborators({ subsessionsEnabled: true }));
    const withSpawnTargets = sessionServiceDependencies(daemonCollaborators({ subsessionsEnabled: true, spawnTargets }));

    expect(withoutSpawnTargets.spawnTargets).toBeUndefined();
    expect(withoutSpawnTargets.subsessionsEnabled).toBe(false);
    expect(withSpawnTargets.spawnTargets).toBe(spawnTargets);
    expect(withSpawnTargets.subsessionsEnabled).toBe(true);
  });

  it("passes the ask-user preference through to the session service", () => {
    expect(sessionServiceDependencies(daemonCollaborators({ askUserEnabled: true })).askUserEnabled).toBe(true);
    expect(sessionServiceDependencies(daemonCollaborators({ askUserEnabled: false })).askUserEnabled).toBe(false);
  });

  it("passes the live config reader through to the session service", () => {
    const config = { read: () => Promise.reject(new Error("not used")) };

    expect(sessionServiceDependencies(daemonCollaborators({ config })).config).toBe(config);
  });

  it("passes the extension-dialog timeout through to the session service", () => {
    expect(sessionServiceDependencies(daemonCollaborators({ extensionDialogsTimeoutMs: 60_000 })).extensionDialogsTimeoutMs).toBe(60_000);
  });

  it("passes deployment system-prompt sections through to the session service", () => {
    const sections = ["<pi_web_docker_environment>\n- fact\n</pi_web_docker_environment>"];

    expect(sessionServiceDependencies(daemonCollaborators({ appendSystemPromptSections: sections })).appendSystemPromptSections).toEqual(sections);
  });
});
