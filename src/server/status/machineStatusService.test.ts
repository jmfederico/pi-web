import { describe, expect, it, vi } from "vitest";
import { CORE_STATUS_FLAGS, type MachineStatusSnapshot } from "../../shared/machineStatus.js";
import { MachineStatusService, type ActiveCwdActivity } from "./machineStatusService.js";
import type { CwdAttribution } from "./workspaceAttribution.js";

const WORKING = CORE_STATUS_FLAGS.working;
const TERMINAL = CORE_STATUS_FLAGS.terminal;
const UNREAD = CORE_STATUS_FLAGS.unread;

describe("MachineStatusService", () => {
  it("lights the project and workspace of an active session in a project the browser never opened", async () => {
    const { service, published } = statusService({
      activity: [{ cwd: "/srv/wt/feature", hasSessionActivity: true, hasTerminalActivity: false }],
      topology: { "/srv/wt/feature": { projectId: "project-1", workspaceId: "workspace-1" } },
    });

    await service.refresh();

    expect(published.at(-1)).toMatchObject({
      machine: { [WORKING]: true },
      projects: { "project-1": { [WORKING]: true } },
      workspaces: { "workspace-1": { [WORKING]: true } },
      unattributed: {},
    });
  });

  it("lights the project of an unread session completion", async () => {
    const { service } = statusService({
      unread: ["/srv/wt/feature"],
      topology: { "/srv/wt/feature": { projectId: "project-1", workspaceId: "workspace-1" } },
    });

    await service.refresh();

    expect(service.snapshot()).toMatchObject({
      machine: { [UNREAD]: true },
      projects: { "project-1": { [UNREAD]: true } },
      workspaces: { "workspace-1": { [UNREAD]: true } },
    });
  });

  it("rolls every flag of a project's workspaces up to the project and the machine", async () => {
    const { service } = statusService({
      activity: [
        { cwd: "/srv/wt/one", hasSessionActivity: true, hasTerminalActivity: false },
        { cwd: "/srv/wt/two", hasSessionActivity: false, hasTerminalActivity: true },
      ],
      unread: ["/srv/wt/two"],
      topology: {
        "/srv/wt/one": { projectId: "project-1", workspaceId: "workspace-1" },
        "/srv/wt/two": { projectId: "project-1", workspaceId: "workspace-2" },
      },
    });

    await service.refresh();

    expect(service.snapshot()).toMatchObject({
      machine: { [WORKING]: true, [TERMINAL]: true, [UNREAD]: true },
      projects: { "project-1": { [WORKING]: true, [TERMINAL]: true, [UNREAD]: true } },
      workspaces: {
        "workspace-1": { [WORKING]: true },
        "workspace-2": { [TERMINAL]: true, [UNREAD]: true },
      },
    });
  });

  it("lights only the machine row through unattributed for a cwd under no known workspace", async () => {
    const { service } = statusService({
      activity: [{ cwd: "/home/user/scratch", hasSessionActivity: true, hasTerminalActivity: false }],
    });

    await service.refresh();

    expect(service.snapshot()).toMatchObject({
      machine: { [WORKING]: true },
      projects: {},
      workspaces: {},
      unattributed: { [WORKING]: true },
    });
  });

  it("omits nodes and flags that are not set", async () => {
    const { service } = statusService({
      activity: [{ cwd: "/srv/wt/feature", hasSessionActivity: false, hasTerminalActivity: true }],
      topology: { "/srv/wt/feature": { projectId: "project-1", workspaceId: "workspace-1" } },
    });

    await service.refresh();

    const snapshot = service.snapshot();
    expect(snapshot.workspaces["workspace-1"]).toEqual({ [TERMINAL]: true });
    expect(snapshot.machine).toEqual({ [TERMINAL]: true });
    expect(snapshot.unattributed).toEqual({});
  });

  it("publishes nothing while the computed tree is unchanged", async () => {
    const activity: ActiveCwdActivity[] = [{ cwd: "/srv/wt/feature", hasSessionActivity: true, hasTerminalActivity: false }];
    const { service, published } = statusService({
      activity,
      topology: { "/srv/wt/feature": { projectId: "project-1", workspaceId: "workspace-1" } },
    });

    await service.refresh();
    await service.refresh();
    activity[0] = { cwd: "/srv/wt/feature", hasSessionActivity: true, hasTerminalActivity: true };
    await service.refresh();

    expect(published).toHaveLength(2);
    expect(published.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
  });

  it("keeps one epoch and a monotonic revision across publications", async () => {
    const unread: string[] = [];
    const { service, published } = statusService({ unread });

    await service.refresh();
    unread.push("/home/user/scratch");
    await service.refresh();
    unread.length = 0;
    await service.refresh();

    expect(published.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
    expect(new Set(published.map((snapshot) => snapshot.epochId)).size).toBe(1);
    expect(service.snapshot().epochId).toBe(published[0]?.epochId);
  });

  it("recomputes once more when a change is reported while a pass is in flight", async () => {
    const unread: string[] = [];
    const { service, published, attribute } = statusService({ unread });

    const first = service.refresh();
    unread.push("/home/user/scratch");
    service.notifyChanged();
    await first;

    expect(attribute).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(1);
    expect(published[0]?.unattributed).toEqual({ [UNREAD]: true });
  });

  it("keeps serving the last snapshot and logs when a status source fails", async () => {
    const { service, published, logger, failUnreadReads } = statusService({
      unread: ["/home/user/scratch"],
    });
    await service.refresh();
    const lastGood = service.snapshot();

    failUnreadReads();
    await service.refresh();

    expect(service.snapshot()).toBe(lastGood);
    expect(published).toHaveLength(1);
    expect(logger.warn.mock.calls).toHaveLength(1);
    const [details, message] = logger.warn.mock.calls[0] ?? [];
    expect(message).toBe("machine status projection could not be recomputed");
    expect(details?.["err"]).toBeInstanceOf(Error);
  });

  it("logs instead of rejecting into the daemon when publication fails", async () => {
    const { service, logger, failPublication } = statusService({ unread: ["/home/user/scratch"] });
    failPublication();

    await expect(service.refresh()).resolves.toBeUndefined();

    expect(service.snapshot().revision).toBe(1);
    const [details, message] = logger.warn.mock.calls[0] ?? [];
    expect(message).toBe("machine status projection could not be published");
    expect(details?.["err"]).toBeInstanceOf(Error);
  });
});

interface StatusServiceScenario {
  activity?: readonly ActiveCwdActivity[];
  unread?: readonly string[];
  topology?: Record<string, CwdAttribution>;
}

/**
 * Assembles the service over in-memory sources. The scenario arrays stay live,
 * so a test mutates them to model a status change and calls `refresh` again.
 */
function statusService(scenario: StatusServiceScenario = {}) {
  const activity = scenario.activity ?? [];
  const unread = scenario.unread ?? [];
  const topology = scenario.topology ?? {};
  const published: MachineStatusSnapshot[] = [];
  const logger = { warn: vi.fn<(details: Record<string, unknown>, message: string) => void>() };
  let failUnreadRead = false;
  let failPublish = false;

  const attribute = vi.fn((cwds: Iterable<string>) => Promise.resolve(
    new Map([...cwds].flatMap((cwd) => {
      const attribution = topology[cwd];
      return attribution === undefined ? [] : [[cwd, attribution] as const];
    })),
  ));

  const service = new MachineStatusService({
    activity: { snapshot: () => ({ workspaces: [...activity] }) },
    unread: {
      catalogSnapshot: () => {
        if (failUnreadRead) throw new Error("unread store unavailable");
        return { sessions: unread.map((cwd) => ({ cwd })) };
      },
    },
    attribution: { attribute },
    publisher: {
      publish: (snapshot) => {
        if (failPublish) throw new Error("event hub unavailable");
        published.push(snapshot);
      },
    },
    logger,
  });

  return {
    service,
    published,
    attribute,
    logger,
    failUnreadReads: (): void => {
      failUnreadRead = true;
    },
    failPublication: (): void => {
      failPublish = true;
    },
  };
}
