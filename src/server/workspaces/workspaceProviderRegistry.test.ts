import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRemoveContext, ProviderWorkspace, WorkspaceProvider } from "../../server-plugin-api.js";
import type { Project } from "../types.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import { ProjectScopedSpawnTargetResolver } from "../sessions/spawnTargetResolver.js";
import {
  eligibleWorkspaceProviderContributions,
  WorkspaceProviderRegistry,
} from "./workspaceProviderRegistry.js";

const project: Project = {
  id: "project-1",
  name: "Project",
  path: hostPath("/repo"),
  createdAt: "2026-07-27T00:00:00.000Z",
};

/**
 * The registry resolves every project/provider path into the host's absolute
 * form, so fixture paths must be compared in their resolved platform form.
 */
function hostPath(path: string): string {
  return resolve(path);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceProviderRegistry", () => {
  it("selects one primary owner, suppresses fallback probes, and derives generic workspaces", async () => {
    const fallbackProbe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const primary = provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([
        workspace("root", hostPath("/repo"), true, {
          publicMetadata: { changeId: "abc", nested: [1, true, null] },
        }),
        workspace("feature", hostPath("/linked"), false, {
          removal: { actionLabel: "Remove", confirmation: "Remove linked?" },
        }),
      ]),
      prepareRemove: () => Promise.resolve({ title: "Remove", command: "tool remove" }),
    });
    const registry = registryFor([
      contribution("fallback", provider({ fallback: true, probe: fallbackProbe })),
      contribution("primary", primary),
    ]);

    const resolution = await registry.resolve(project);

    expect(fallbackProbe).not.toHaveBeenCalled();
    expect(resolution).toMatchObject({ status: "provider", projectId: project.id, ownerPluginId: "primary", diagnostics: [] });
    expect(resolution.workspaces).toEqual([
      expect.objectContaining({
        projectId: project.id,
        path: hostPath("/repo"),
        label: "root",
        isMain: true,
        provider: {
          pluginId: "primary",
          capabilities: { remove: false },
          metadata: { changeId: "abc", nested: [1, true, null] },
        },
      }),
      expect.objectContaining({
        projectId: project.id,
        path: hostPath("/linked"),
        provider: {
          pluginId: "primary",
          capabilities: { remove: true },
        },
      }),
    ]);
    const root = resolution.workspaces.find(({ path }) => path === hostPath("/repo"));
    const linked = resolution.workspaces.find(({ path }) => path === hostPath("/linked"));
    if (root === undefined || linked === undefined) throw new Error("Expected primary provider workspaces");
    expect(linked.removal).toMatchObject({
      actionLabel: "Remove",
      confirmation: "Remove linked?",
    });
    expect(linked.removal?.precondition).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(root.id).not.toBe(linked.id);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.workspaces)).toBe(true);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.provider)).toBe(true);
    expect(Object.isFrozen(root.provider?.capabilities)).toBe(true);
    expect(Object.isFrozen(root.provider?.metadata)).toBe(true);
    expect(Object.isFrozen(linked.removal)).toBe(true);
  });

  it("keeps lookups read-only, including cold and changed project identities", async () => {
    const probe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const list = vi.fn((input: { path: string }) => Promise.resolve([workspace("root", input.path, true)]));
    const registry = registryFor([contribution("owner", provider({ probe, list }))]);
    expect(await registry.lookup(project)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    const discovered = await registry.resolve(project);
    expect(await registry.lookup(project)).toBe(discovered);
    expect(await registry.lookup({ ...project, path: hostPath("/moved") })).toBeUndefined();
    expect(list).toHaveBeenCalledOnce();
    await registry.closeAll();
  });

  it("keeps established identity readable while a mutation-triggered refresh runs", async () => {
    const replacement = deferred<ProviderWorkspace[]>();
    const started = deferred<undefined>();
    const list = vi.fn().mockResolvedValueOnce([workspace("root", project.path, true)])
      .mockImplementationOnce(() => { started.resolve(undefined); return replacement.promise; });
    const registry = registryFor([contribution("owner", provider({ probe: () => Promise.resolve("claim"), list }))]);
    const established = await registry.resolve(project);
    registry.requestRefresh(project.id);
    await started.promise;
    expect(await registry.lookup(project)).toBe(established);
    replacement.resolve([workspace("new", hostPath("/new"), true)]);
    const refreshed = await registry.resolve(project);
    expect(await registry.lookup(project)).toBe(refreshed);
    expect(refreshed.workspaces[0]?.path).toBe(hostPath("/new"));
    expect(list).toHaveBeenCalledTimes(2);
    await registry.closeAll();
  });

  it("keeps caller-owned authority checks out of the shared workspace record", async () => {
    const started = deferred<undefined>();
    const list = vi.fn((_input: unknown, signal: AbortSignal) => {
      if (list.mock.calls.length === 1) return Promise.resolve([workspace("root", project.path, true)]);
      started.resolve(undefined);
      return new Promise<ProviderWorkspace[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => { reject(new Error("Disconnected")); }, { once: true });
      });
    });
    const registry = registryFor([contribution("owner", provider({ probe: () => Promise.resolve("claim"), list }))]);
    const known = await registry.resolve(project);
    const controller = new AbortController();
    const checking = registry.checkCurrent(project, controller.signal);
    const rejected = expect(checking).rejects.toThrow();
    await started.promise;
    // Neither an in-flight check nor its cancellation interrupts routine reads.
    expect(await registry.lookup(project)).toBe(known);
    controller.abort();
    await rejected;
    expect(await registry.lookup(project)).toBe(known);
    await registry.closeAll();
  });

  it("does not publish older discovery after a newer mutation refresh", async () => {
    const stale = deferred<ProviderWorkspace[]>();
    const started = deferred<undefined>();
    const list = vi.fn().mockImplementationOnce(() => {
      started.resolve(undefined);
      return stale.promise;
    }).mockResolvedValue([workspace("new", hostPath("/new"), true)]);
    const onPublished = vi.fn();
    const registry = new WorkspaceProviderRegistry({
      contributions: [contribution("owner", provider({ probe: () => Promise.resolve("claim"), list }))],
      logger: { warn: vi.fn() }, pathInspector: () => true, onPublished,
    });
    const oldDiscovery = registry.resolve(project);
    await started.promise;
    expect(await registry.lookup(project)).toBeUndefined();
    registry.requestRefresh(project.id);
    const fresh = await registry.resolve(project);
    stale.resolve([workspace("old", hostPath("/old"), true)]);
    await oldDiscovery;
    expect(await registry.lookup(project)).toBe(fresh);
    expect(fresh.workspaces[0]?.path).toBe(hostPath("/new"));
    expect(list).toHaveBeenCalledTimes(2);
    expect(onPublished).toHaveBeenCalledExactlyOnceWith(project.id);
    await registry.closeAll();
  });

  it("logs projection notification failures without failing already-published discovery", async () => {
    const warn = vi.fn();
    const registry = new WorkspaceProviderRegistry({
      contributions: [], logger: { warn },
      onPublished: () => { throw new Error("Projection unavailable"); },
    });
    const published = await registry.resolve(project);
    expect(await registry.lookup(project)).toBe(published);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id }),
      "workspace discovery projection notification failed",
    );
    await registry.closeAll();
  });

  it("drains superseded discovery still performing path inspection during shutdown", async () => {
    const inspection = deferred<boolean>();
    const started = deferred<undefined>();
    const pathInspector = vi.fn().mockImplementationOnce(() => {
      started.resolve(undefined);
      return inspection.promise;
    }).mockReturnValue(true);
    const registry = new WorkspaceProviderRegistry({
      contributions: [contribution("owner", provider({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([workspace("root", project.path, true)]),
      }))],
      logger: { warn: vi.fn() },
      pathInspector,
    });
    const oldDiscovery = registry.resolve(project);
    await started.promise;
    registry.requestRefresh(project.id);
    await registry.resolve(project);
    let closed = false;
    const closing = registry.closeAll().then(() => { closed = true; });
    try {
      // Give the shutdown promise a full event-loop turn to settle if it has
      // accidentally lost ownership of the superseded scan.
      await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
      expect(closed).toBe(false);
    } finally {
      inspection.resolve(true);
      await oldDiscovery;
      await closing;
    }
    expect(closed).toBe(true);
  });

  it("coalesces only equivalent in-flight resolutions and never retains a completed result", async () => {
    const firstBaselineList = deferred<ProviderWorkspace[]>();
    let baselineLists = 0;
    const probe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const list = vi.fn((input: { name: string }) => {
      if (input.name !== project.name) return Promise.resolve([workspace("root", hostPath("/repo"), true)]);
      baselineLists += 1;
      return baselineLists === 1
        ? firstBaselineList.promise
        : Promise.resolve([
            workspace("root", hostPath("/repo"), true),
            workspace("fresh", hostPath("/fresh"), false),
          ]);
    });
    const registry = registryFor([contribution("owner", provider({ probe, list }))]);

    const first = registry.resolve(project);
    const equivalent = registry.resolve({ ...project });
    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce(); });

    const differentSnapshot = await registry.resolve({ ...project, name: "Renamed" });
    expect(differentSnapshot.workspaces).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);

    firstBaselineList.resolve([workspace("root", hostPath("/repo"), true)]);
    const [firstResult, equivalentResult] = await Promise.all([first, equivalent]);
    expect(firstResult).toBe(equivalentResult);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);

    const fresh = await registry.resolve(project);
    expect(fresh.workspaces.map(({ path }) => path)).toEqual([hostPath("/repo"), hostPath("/fresh")]);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("keeps removal resolution fresh and outside ordinary resolution coalescing", async () => {
    const blockedList = deferred<ProviderWorkspace[]>();
    const topology = [
      workspace("root", hostPath("/repo"), true),
      workspace("view", hostPath("/view"), false, {
        removal: { actionLabel: "Disconnect", confirmation: "Disconnect view?" },
      }),
    ];
    let listCalls = 0;
    const registry = registryFor([contribution("owner", provider({
      probe: () => Promise.resolve("claim"),
      list: () => {
        listCalls += 1;
        return listCalls === 2 ? blockedList.promise : Promise.resolve(topology);
      },
      prepareRemove: () => Promise.resolve({ title: "Disconnect", command: "tool disconnect" }),
    }))]);
    const initial = await registry.resolve(project);
    const workspaceId = initial.workspaces.find(({ path }) => path === hostPath("/view"))?.id;
    if (workspaceId === undefined) throw new Error("Expected removable workspace");

    const pendingResolution = registry.resolve(project);
    await vi.waitFor(() => { expect(listCalls).toBe(2); });
    const removal = await registry.resolveRemoval(project, workspaceId);

    expect(removal.target.id).toBe(workspaceId);
    expect(listCalls).toBe(3);

    blockedList.resolve(topology);
    await pendingResolution;
  });

  it("preserves removal provenance and binds it to the destructive confirmation precondition", async () => {
    const resolveRemoval = async (localization: unknown) => {
      const linked = workspace("linked", hostPath("/linked"), false, {
        removal: { actionLabel: "Delete workspace", confirmation: "Raw confirmation" },
      });
      // Exercise untyped plugin output at the provider validation boundary.
      Object.defineProperty(linked.removal, "localization", { value: localization, enumerable: true });
      const registry = registryFor([contribution("owner", provider({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([
          workspace("main", hostPath("/repo"), true), linked,
        ]),
        prepareRemove: () => Promise.resolve({ title: "Remove", command: "tool remove" }),
      }))]);
      return (await registry.resolve(project)).workspaces.find(({ isMain }) => !isMain)?.removal;
    };
    const metadata = { kind: "gitWorktree", label: "review", path: hostPath("/linked") };
    const first = await resolveRemoval(metadata);
    expect(first?.localization).toEqual(metadata);
    expect(Object.isFrozen(first?.localization)).toBe(true);
    expect((await resolveRemoval({ ...metadata }))?.precondition).toBe(first?.precondition);
    expect((await resolveRemoval({ ...metadata, label: "changed" }))?.precondition).not.toBe(first?.precondition);
    expect(await resolveRemoval({ kind: "future" })).not.toHaveProperty("localization");
    expect(await resolveRemoval({ ...metadata, path: 42 })).not.toHaveProperty("localization");
  });

  it("keeps workspace ids stable while opaque removal preconditions bind owner snapshot drift", async () => {
    const resolveTarget = async (
      pluginId: string,
      moduleRevision: string,
      path: string,
      confirmation: string,
    ): Promise<{ id: string; precondition: string }> => {
      const registry = registryFor([contribution(pluginId, provider({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([
          workspace("main", hostPath("/repo"), true),
          workspace("secondary", path, false, {
            removal: { actionLabel: "Remove", confirmation },
          }),
        ]),
        prepareRemove: () => Promise.resolve({ title: "Remove", command: "tool remove" }),
      }), moduleRevision)]);
      const target = (await registry.resolve(project)).workspaces.find(({ isMain }) => !isMain);
      if (target?.removal === undefined) throw new Error("Expected removable workspace");
      return { id: target.id, precondition: target.removal.precondition };
    };

    const baseline = await resolveTarget("primary", "revision-1", hostPath("/linked"), "Remove linked?");
    const same = await resolveTarget("primary", "revision-1", hostPath("/linked"), "Remove linked?");
    const ownerChanged = await resolveTarget("replacement", "revision-1", hostPath("/linked"), "Remove linked?");
    const revisionChanged = await resolveTarget("primary", "revision-2", hostPath("/linked"), "Remove linked?");
    const pathChanged = await resolveTarget("primary", "revision-1", hostPath("/moved"), "Remove linked?");
    const wordingChanged = await resolveTarget("primary", "revision-1", hostPath("/linked"), "Disconnect linked?");

    expect(same).toEqual(baseline);
    expect(new Set([
      baseline.id,
      ownerChanged.id,
      revisionChanged.id,
      pathChanged.id,
      wordingChanged.id,
    ])).toEqual(new Set([baseline.id]));
    expect(new Set([
      baseline.precondition,
      ownerChanged.precondition,
      revisionChanged.precondition,
      pathChanged.precondition,
      wordingChanged.precondition,
    ]).size).toBe(5);
    expect(baseline.precondition).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(baseline.precondition).not.toContain("primary");
    expect(baseline.precondition).not.toContain("/linked");
  });

  it("excludes unhealthy providers from arbitration while retaining degraded providers", async () => {
    const contributions = [
      contribution("unhealthy", provider({ probe: () => Promise.resolve("claim") })),
      contribution("degraded", provider({ probe: () => Promise.resolve("pass") })),
      contribution("missing-inspection", provider({ probe: () => Promise.resolve("claim") })),
      contribution("fallback", provider({
        fallback: true,
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([workspace("root", hostPath("/repo"), true)]),
      })),
    ];
    const eligible = eligibleWorkspaceProviderContributions(contributions, [
      { pluginId: "unhealthy", health: { status: "unhealthy" } },
      { pluginId: "degraded", health: { status: "degraded" } },
      { pluginId: "fallback", health: { status: "healthy" } },
    ]);

    const resolution = await registryFor(eligible).resolve(project);

    expect(eligible.map(({ pluginId }) => pluginId)).toEqual(["degraded", "fallback"]);
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "fallback" });
  });

  it("evaluates fallback providers only after every primary passes", async () => {
    const calls: string[] = [];
    const registry = registryFor([
      contribution("primary-b", provider({ probe: () => { calls.push("primary-b"); return Promise.resolve("pass"); } })),
      contribution("fallback", provider({
        fallback: true,
        probe: () => { calls.push("fallback"); return Promise.resolve("claim"); },
        list: () => Promise.resolve([workspace("root", hostPath("/repo"), true)]),
      })),
      contribution("primary-a", provider({ probe: () => { calls.push("primary-a"); return Promise.resolve("pass"); } })),
    ]);

    const resolution = await registry.resolve(project);

    expect(calls).toEqual(["primary-a", "primary-b", "fallback"]);
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "fallback" });
  });

  it.each([
    { tier: "primary" as const, fallback: false },
    { tier: "fallback" as const, fallback: true },
  ])("degrades explicit same-tier $tier conflicts without choosing import order", async ({ tier, fallback }) => {
    const lowerProbe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const contributions = fallback
      ? [
          contribution("one", provider({ fallback, probe: () => Promise.resolve("claim") })),
          contribution("two", provider({ fallback, probe: () => Promise.resolve("claim") })),
        ]
      : [
          contribution("one", provider({ probe: () => Promise.resolve("claim") })),
          contribution("two", provider({ probe: () => Promise.resolve("claim") })),
          contribution("lower", provider({ fallback: true, probe: lowerProbe })),
        ];
    const { registry, logger } = registryFixture(contributions);

    const resolution = await registry.resolve(project);

    expect(resolution).toMatchObject({
      status: "degraded",
      workspaces: [{ path: hostPath("/repo"), isMain: true }],
      diagnostics: [{
        code: "claim-conflict",
        tier,
        pluginIds: ["one", "two"],
      }],
    });
    expect(resolution.workspaces[0]).not.toHaveProperty("provider");
    expect(lowerProbe).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, tier, pluginIds: ["one", "two"] }),
      "workspace provider claim conflict",
    );
  });

  it("contains invalid and rejected probes and still permits a fallback owner", async () => {
    const invalidProbeProvider = provider();
    // Exercise the JavaScript runtime boundary rather than the TypeScript declaration.
    Object.defineProperty(invalidProbeProvider, "probe", { value: () => Promise.resolve("maybe") });
    const { registry, logger } = registryFixture([
      contribution("invalid", invalidProbeProvider),
      contribution("rejected", provider({ probe: () => Promise.reject(new Error("detector broke")) })),
      contribution("git-shaped-fixture", provider({
        fallback: true,
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([workspace("root", hostPath("/repo"), true)]),
      })),
    ]);

    const resolution = await registry.resolve(project);

    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "git-shaped-fixture" });
    expect(resolution.diagnostics).toHaveLength(2);
    expect(resolution.diagnostics[0]).toMatchObject({ code: "probe-failed", pluginId: "invalid", tier: "primary" });
    expect(resolution.diagnostics[0]?.message).toContain("invalid probe result");
    expect(resolution.diagnostics[1]).toMatchObject({ code: "probe-failed", pluginId: "rejected", tier: "primary", message: "detector broke" });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("bounds a hanging probe, aborts its signal, and continues arbitration", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const hanging = provider({
      probe: (_project, signal) => new Promise((_resolve, rejectPromise) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => {
          const reason: unknown = signal.reason;
          rejectPromise(reason instanceof Error ? reason : new Error("Fixture probe aborted", { cause: reason }));
        }, { once: true });
      }),
    });
    const registry = registryFor([
      contribution("hanging", hanging),
      contribution("fallback", provider({
        fallback: true,
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([workspace("root", hostPath("/repo"), true)]),
      })),
    ], { providerTimeoutMs: 25 });

    const resolving = registry.resolve(project);
    await vi.advanceTimersByTimeAsync(25);

    const resolution = await resolving;
    expect(resolution).toMatchObject({
      status: "provider",
      ownerPluginId: "fallback",
      diagnostics: [{ code: "probe-failed", pluginId: "hanging" }],
    });
    expect(resolution.diagnostics[0]?.message).toContain("timed out");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps a successful claimant as owner when listing fails instead of switching to fallback", async () => {
    const fallbackProbe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const registry = registryFor([
      contribution("owner", provider({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.reject(new Error("listing broke")),
      })),
      contribution("fallback", provider({ fallback: true, probe: fallbackProbe })),
    ]);

    const resolution = await registry.resolve(project);

    expect(fallbackProbe).not.toHaveBeenCalled();
    expect(resolution).toMatchObject({
      status: "degraded",
      ownerPluginId: "owner",
      workspaces: [{ path: hostPath("/repo"), isMain: true }],
      diagnostics: [{ code: "list-failed", pluginId: "owner", message: "listing broke" }],
    });
    expect(resolution.workspaces[0]).not.toHaveProperty("provider");
  });

  it.each([
    {
      name: "non-array result",
      value: { key: "root" },
      message: "list result must be an array",
    },
    {
      name: "relative path",
      value: [workspace("root", "relative", true)],
      message: "path must be absolute",
    },
    {
      name: "duplicate key",
      value: [workspace("same", hostPath("/repo"), true), workspace("same", hostPath("/linked"), false)],
      message: "duplicate key",
    },
    {
      name: "duplicate normalized path",
      value: [workspace("root", hostPath("/repo"), true), workspace("other", hostPath("/repo/../repo"), false)],
      message: "duplicate path",
    },
    {
      name: "missing main",
      value: [workspace("secondary", hostPath("/linked"), false)],
      message: "exactly one main",
    },
    {
      name: "multiple mains",
      value: [workspace("root", hostPath("/repo"), true), workspace("other", hostPath("/linked"), true)],
      message: "exactly one main",
    },
    {
      name: "non-JSON private data",
      value: [{ key: "root", path: hostPath("/repo"), label: "root", isMain: true, data: { callback: () => undefined } }],
      message: "data must contain only JSON values",
    },
    {
      name: "removal presentation without planner capability",
      value: [
        workspace("root", hostPath("/repo"), true),
        workspace("secondary", hostPath("/linked"), false, { removal: { actionLabel: "Detach", confirmation: "Detach it?" } }),
      ],
      message: "advertises removal without a prepareRemove capability",
    },
  ])("rejects invalid provider workspace contracts: $name", async ({ value, message }) => {
    const invalidListProvider = provider({ probe: () => Promise.resolve("claim") });
    Object.defineProperty(invalidListProvider, "list", { value: () => Promise.resolve(value) });
    const registry = registryFor([contribution("invalid-list", invalidListProvider)]);

    const resolution = await registry.resolve(project);

    expect(resolution).toMatchObject({
      status: "degraded",
      ownerPluginId: "invalid-list",
      diagnostics: [{ code: "list-failed" }],
      workspaces: [{ path: hostPath("/repo"), isMain: true }],
    });
    expect(resolution.diagnostics[0]?.message).toContain(message);
  });

  it("rejects inaccessible workspace paths through the host path boundary", async () => {
    const registry = registryFor([contribution("owner", provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([workspace("root", hostPath("/repo"), true), workspace("gone", hostPath("/gone"), false)]),
    }))], { pathInspector: (path) => path !== hostPath("/gone") });

    const resolution = await registry.resolve(project);

    expect(resolution).toMatchObject({
      status: "degraded",
      diagnostics: [{ code: "list-failed" }],
    });
    expect(resolution.diagnostics[0]?.message).toContain(`not an accessible directory: ${hostPath("/gone")}`);
  });

  it("waits for admitted provider work to settle cooperatively after shutdown abort", async () => {
    const callbackStarted = deferred<undefined>();
    const callbackAborted = deferred<undefined>();
    const releaseCallback = deferred<undefined>();
    let callbackFinished = false;
    let listedSignal: AbortSignal | undefined;
    const { registry, logger } = registryFixture([contribution("owner", provider({
      probe: () => Promise.resolve("claim"),
      list: async (_project, signal) => {
        listedSignal = signal;
        callbackStarted.resolve(undefined);
        await new Promise<void>((resolveAbort) => {
          signal.addEventListener("abort", () => { resolveAbort(); }, { once: true });
        });
        callbackAborted.resolve(undefined);
        await releaseCallback.promise;
        callbackFinished = true;
        return [];
      },
    }))]);
    const pending = registry.resolve(project);
    await callbackStarted.promise;

    let closeFinished = false;
    const closing = registry.closeAll("provider shutdown");
    void closing.then(
      () => { closeFinished = true; },
      () => { closeFinished = true; },
    );

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "provider shutdown" });
    await callbackAborted.promise;
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    expect(callbackFinished).toBe(false);
    expect(listedSignal?.aborted).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();

    releaseCallback.resolve(undefined);
    await closing;
    expect(callbackFinished).toBe(true);
    await expect(registry.resolve(project)).rejects.toMatchObject({ name: "AbortError", message: "provider shutdown" });
  });

  it("propagates caller cancellation through removal resolution and planning", async () => {
    let mode: "ready" | "list" | "prepare" = "ready";
    let listedSignal: AbortSignal | undefined;
    let preparedSignal: AbortSignal | undefined;
    const providerContribution = provider({
      probe: () => Promise.resolve("claim"),
      list: (_project, signal) => {
        if (mode !== "list") {
          return Promise.resolve([
            workspace("main", hostPath("/repo"), true),
            workspace("view", hostPath("/view"), false, {
              removal: { actionLabel: "Disconnect", confirmation: "Disconnect view?" },
            }),
          ]);
        }
        listedSignal = signal;
        return new Promise((_resolve, rejectPromise) => {
          signal.addEventListener("abort", () => {
            const reason: unknown = signal.reason;
            rejectPromise(reason instanceof Error ? reason : new Error("List cancelled", { cause: reason }));
          }, { once: true });
        });
      },
      prepareRemove: ({ signal }) => {
        if (mode !== "prepare") return Promise.resolve({ title: "Disconnect", command: "board disconnect" });
        preparedSignal = signal;
        return new Promise((_resolve, rejectPromise) => {
          signal.addEventListener("abort", () => {
            const reason: unknown = signal.reason;
            rejectPromise(reason instanceof Error ? reason : new Error("Preparation cancelled", { cause: reason }));
          }, { once: true });
        });
      },
    });
    const registry = registryFor([contribution("board", providerContribution)]);
    const workspaceId = (await registry.resolve(project)).workspaces.find(({ path }) => path === hostPath("/view"))?.id;
    if (workspaceId === undefined) throw new Error("Expected removable workspace");

    mode = "list";
    const listController = new AbortController();
    const pendingResolution = registry.resolveRemoval(project, workspaceId, listController.signal);
    await vi.waitFor(() => { expect(listedSignal).toBeInstanceOf(AbortSignal); });
    const resolutionExpectation = expect(pendingResolution).rejects.toMatchObject({ name: "AbortError" });
    listController.abort(new DOMException("Removal request cancelled", "AbortError"));
    await resolutionExpectation;
    expect(listedSignal?.aborted).toBe(true);

    mode = "ready";
    const prepareController = new AbortController();
    const current = await registry.resolveRemoval(project, workspaceId, prepareController.signal);
    mode = "prepare";
    const pendingPlan = current.prepare();
    await vi.waitFor(() => { expect(preparedSignal).toBeInstanceOf(AbortSignal); });
    const planExpectation = expect(pendingPlan).rejects.toMatchObject({ name: "AbortError" });
    prepareController.abort(new DOMException("Removal request cancelled", "AbortError"));
    await planExpectation;
    expect(preparedSignal?.aborted).toBe(true);
  });

  it.each([
    { kind: "workspaceRemoval", label: "feature/<img>" }, null, {}, { kind: "future", label: "x" },
    { kind: "workspaceRemoval", label: "x".repeat(4097) },
  ])("snapshots optional removal-plan title provenance or retains raw fallback (%j)", async (metadata) => {
    const plan = { title: "Provider title", command: "tool remove" };
    Object.defineProperty(plan, "titlePresentation", { value: metadata });
    const registry = registryFor([contribution("provider", provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([
        workspace("main", hostPath("/repo"), true),
        workspace("view", hostPath("/view"), false, { removal: { actionLabel: "Remove", confirmation: "Remove?" } }),
      ]),
      prepareRemove: () => Promise.resolve(plan),
    }))]);
    const id = (await registry.resolve(project)).workspaces.find(({ isMain }) => !isMain)?.id;
    if (id === undefined) throw new Error("Expected removal target");
    const parsed = await (await registry.resolveRemoval(project, id)).prepare();
    expect(parsed.title).toBe(plan.title);
    expect(parsed.command).toBe(plan.command);
    if (metadata?.kind === "workspaceRemoval" && metadata.label.length <= 4096) {
      expect(parsed.titlePresentation).toEqual(metadata);
      expect(Object.isFrozen(parsed.titlePresentation)).toBe(true);
      metadata.label = "mutated";
      expect(parsed.titlePresentation?.label).toBe("feature/<img>");
    } else expect(parsed).not.toHaveProperty("titlePresentation");
  });

  it("re-resolves removal targets and contains stale, invalid, and timed-out provider plans", async () => {
    let observedRemoveContext: ProviderRemoveContext | undefined;
    const prepareRemove = vi.fn((context: ProviderRemoveContext) => {
      observedRemoveContext = context;
      return Promise.resolve({ title: "Detach view", command: "board detach view" });
    });
    const registry = registryFor([contribution("board", provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([
        workspace("main", hostPath("/repo"), true),
        workspace("view", hostPath("/view"), false, {
          data: { privateId: "view-1" },
          removal: { actionLabel: "Disconnect", confirmation: "Disconnect view?" },
        }),
      ]),
      prepareRemove,
    }))]);
    const workspaceId = (await registry.resolve(project)).workspaces.find(({ path }) => path === hostPath("/view"))?.id;
    if (workspaceId === undefined) throw new Error("Expected removable workspace");

    const current = await registry.resolveRemoval(project, workspaceId);
    await expect(current.prepare()).resolves.toEqual({ title: "Detach view", command: "board detach view" });
    expect(current).toMatchObject({ ownerPluginId: "board", target: { id: workspaceId, path: hostPath("/view") } });
    expect(prepareRemove).toHaveBeenCalledOnce();
    expect(observedRemoveContext).toMatchObject({
      workspace: { path: hostPath("/view"), data: { privateId: "view-1" } },
    });
    expect(observedRemoveContext?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.isFrozen(observedRemoveContext)).toBe(true);
    expect(Object.isFrozen(observedRemoveContext?.project)).toBe(true);
    expect(Object.isFrozen(observedRemoveContext?.workspace)).toBe(true);
    expect(Object.isFrozen(observedRemoveContext?.workspace.removal)).toBe(true);
    await expect(registry.resolveRemoval(project, "stale-id"))
      .rejects.toMatchObject({ code: "workspace-not-found", statusCode: 404 });
    const conflict = registryFor([
      contribution("one", provider({ probe: () => Promise.resolve("claim") })),
      contribution("two", provider({ probe: () => Promise.resolve("claim") })),
    ]);
    await expect(conflict.resolveRemoval(project, workspaceId))
      .rejects.toMatchObject({ code: "owner-conflict", statusCode: 409 });

    const invalidProvider = provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([
        workspace("main", hostPath("/repo"), true),
        workspace("view", hostPath("/view"), false, { removal: { actionLabel: "Disconnect", confirmation: "Disconnect?" } }),
      ]),
      prepareRemove: () => Promise.resolve({ title: "valid", command: "valid" }),
    });
    Object.defineProperty(invalidProvider, "prepareRemove", { value: () => Promise.resolve({ title: "", command: "ignored" }) });
    const invalidRegistry = registryFor([contribution("invalid", invalidProvider)]);
    const invalidId = (await invalidRegistry.resolve(project)).workspaces.find(({ path }) => path === hostPath("/view"))?.id;
    if (invalidId === undefined) throw new Error("Expected invalid-plan workspace");
    const invalidTarget = await invalidRegistry.resolveRemoval(project, invalidId);
    await expect(invalidTarget.prepare()).rejects.toMatchObject({ code: "invalid-plan", statusCode: 502 });

    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const hangingRegistry = registryFor([contribution("hanging", provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([
        workspace("main", hostPath("/repo"), true),
        workspace("view", hostPath("/view"), false, { removal: { actionLabel: "Disconnect", confirmation: "Disconnect?" } }),
      ]),
      prepareRemove: ({ signal }) => new Promise((_resolve, rejectPromise) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => { rejectPromise(new Error("planner aborted")); }, { once: true });
      }),
    }))], { providerTimeoutMs: 25 });
    const hangingId = (await hangingRegistry.resolve(project)).workspaces.find(({ path }) => path === hostPath("/view"))?.id;
    if (hangingId === undefined) throw new Error("Expected hanging-plan workspace");
    const hangingTarget = await hangingRegistry.resolveRemoval(project, hangingId);
    const pending = hangingTarget.prepare();
    const expectation = expect(pending).rejects.toMatchObject({ code: "preparation-timeout", statusCode: 504 });
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("uses the kernel folder workspace when no provider claims or Git is absent", async () => {
    const registry = registryFor([contribution("passing", provider())]);

    const first = await registry.resolve(project);
    const disabledGit = await registryFor([]).resolve(project);

    expect(first).toMatchObject({
      status: "folder",
      projectId: project.id,
      workspaces: [{
        projectId: project.id,
        path: hostPath("/repo"),
        label: "Project",
        isMain: true,
      }],
      diagnostics: [],
    });
    expect(first.workspaces[0]?.id).toMatch(/^[a-f0-9]{12}$/u);
    expect(disabledGit.workspaces).toEqual(first.workspaces);
  });

  it("serves live provider workspaces to spawned-session target validation", async () => {
    let linkedPath = hostPath("/first-linked");
    const registry = registryFor([contribution("owner", provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([
        workspace("root", hostPath("/repo"), true),
        workspace(linkedPath, linkedPath, false),
      ]),
    }))]);
    const resolver = new ProjectScopedSpawnTargetResolver({
      projects: { list: () => Promise.resolve([project]) },
      workspaces: registry,
    });

    await expect(resolver.resolveSpawnTarget(hostPath("/repo"), hostPath("/first-linked"))).resolves.toEqual({ allowed: true, cwd: hostPath("/first-linked") });

    linkedPath = hostPath("/new-linked");

    await expect(resolver.resolveSpawnTarget(hostPath("/repo"), hostPath("/first-linked"))).resolves.toEqual({
      allowed: false,
      reason: "out-of-project",
      allowedCwds: [hostPath("/repo"), hostPath("/new-linked")],
    });
    await expect(resolver.resolveSpawnTarget(hostPath("/repo"), hostPath("/new-linked"))).resolves.toEqual({ allowed: true, cwd: hostPath("/new-linked") });
  });
});

interface RegistryFixtureOptions {
  providerTimeoutMs?: number;
  pathInspector?: (path: string) => boolean | Promise<boolean>;
}

function registryFor(
  contributions: readonly ServerPluginProviderContribution[],
  options: RegistryFixtureOptions = {},
): WorkspaceProviderRegistry {
  return registryFixture(contributions, options).registry;
}

function registryFixture(
  contributions: readonly ServerPluginProviderContribution[],
  options: RegistryFixtureOptions = {},
): { registry: WorkspaceProviderRegistry; logger: { warn: ReturnType<typeof vi.fn> } } {
  const logger = { warn: vi.fn() };
  return {
    registry: new WorkspaceProviderRegistry({
      contributions,
      logger,
      ...(options.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: options.providerTimeoutMs }),
      pathInspector: options.pathInspector ?? (() => true),
    }),
    logger,
  };
}

function contribution(
  pluginId: string,
  workspaceProvider: WorkspaceProvider,
  moduleRevision = "1",
): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision,
    provider: workspaceProvider,
  };
}

function provider(overrides: Partial<WorkspaceProvider> = {}): WorkspaceProvider {
  return {
    fallback: false,
    probe: () => Promise.resolve("pass"),
    list: () => Promise.resolve([]),
    ...overrides,
  };
}

function workspace(
  key: string,
  path: string,
  isMain: boolean,
  extras: Partial<ProviderWorkspace> = {},
): ProviderWorkspace {
  return { key, path, label: key, isMain, ...extras };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolveDeferred = resolve; });
  if (resolveDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred };
}
