import { describe, expect, it, vi } from "vitest";
import type { PiPackageInfo } from "../shared/apiTypes.js";
import { type ActiveAgentProfileProvider } from "./activeAgentProfileProvider.js";
import { ActiveProfilePiPackageService, DefaultPiPackageService, type PiPackageManagerPort, type PiPackageService } from "./piPackageService.js";

function fakeManager(packages: PiPackageInfo[] = []) {
  const listConfiguredPackages = vi.fn<PiPackageManagerPort["listConfiguredPackages"]>(() => packages);
  const installAndPersist = vi.fn<PiPackageManagerPort["installAndPersist"]>(() => Promise.resolve());
  const removeAndPersist = vi.fn<PiPackageManagerPort["removeAndPersist"]>(() => Promise.resolve(true));
  const update = vi.fn<PiPackageManagerPort["update"]>(() => Promise.resolve());
  const manager: PiPackageManagerPort = { listConfiguredPackages, installAndPersist, removeAndPersist, update };
  return { manager, listConfiguredPackages, installAndPersist, removeAndPersist, update };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("ActiveProfilePiPackageService", () => {
  it("uses the daemon profile active when each package operation begins", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>()
      .mockResolvedValueOnce(availableProfile("a", "/state/first"))
      .mockResolvedValueOnce(availableProfile("b", "/state/second"));
    const firstService = fakePiPackageService("first");
    const secondService = fakePiPackageService("second");
    const serviceForAgentDir = vi.fn((agentDir: string): PiPackageService => agentDir === "/state/first" ? firstService : secondService);
    const service = new ActiveProfilePiPackageService({ getActiveAgentProfile }, serviceForAgentDir);

    await expect(service.list()).resolves.toEqual({ packages: [{ source: "first", scope: "user", filtered: false }] });
    await expect(service.install("npm:@acme/tools")).resolves.toMatchObject({ action: "install", source: "npm:@acme/tools", packages: [{ source: "second" }] });

    expect(serviceForAgentDir).toHaveBeenNthCalledWith(1, "/state/first");
    expect(serviceForAgentDir).toHaveBeenNthCalledWith(2, "/state/second");
    expect(firstService.list).toHaveBeenCalledOnce();
    expect(secondService.install).toHaveBeenCalledWith("npm:@acme/tools");
  });

  it.each(["unavailable", "invalid"] as const)("fails closed without constructing a package manager when the profile is %s", async (status) => {
    const activeAgentProfile: ActiveAgentProfileProvider = {
      getActiveAgentProfile: () => Promise.resolve({ status, error: `${status} profile` }),
    };
    const serviceForAgentDir = vi.fn<(agentDir: string) => PiPackageService>();
    const service = new ActiveProfilePiPackageService(activeAgentProfile, serviceForAgentDir);

    await expect(service.list()).rejects.toMatchObject({
      profileStatus: status,
      message: `Active agent profile is ${status}: ${status} profile`,
    });
    await expect(service.install("npm:@acme/tools")).rejects.toMatchObject({
      profileStatus: status,
      message: `Active agent profile is ${status}: ${status} profile`,
    });
    expect(serviceForAgentDir).not.toHaveBeenCalled();
  });
});

describe("DefaultPiPackageService", () => {
  it("lists configured Pi packages with source, scope, filtered status, and installed path", async () => {
    const fake = fakeManager([
      { source: "npm:@acme/user-tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/user-tools" },
      { source: "../project-tools", scope: "project", filtered: true },
    ]);
    const service = new DefaultPiPackageService(fake.manager);

    await expect(service.list()).resolves.toEqual({
      packages: [
        { source: "npm:@acme/user-tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/user-tools" },
        { source: "../project-tools", scope: "project", filtered: true },
      ],
    });
  });

  it("installs through the default Pi package-manager behavior without a local option", async () => {
    const fake = fakeManager([{ source: "npm:@acme/tools", scope: "user", filtered: false }]);
    const service = new DefaultPiPackageService(fake.manager);

    const response = await service.install("npm:@acme/tools");

    expect(fake.installAndPersist).toHaveBeenCalledWith("npm:@acme/tools");
    expect(response).toEqual({ action: "install", source: "npm:@acme/tools", packages: [{ source: "npm:@acme/tools", scope: "user", filtered: false }] });
  });

  it("removes user packages by default and project packages only when the known scope is supplied", async () => {
    const fake = fakeManager();
    const service = new DefaultPiPackageService(fake.manager);

    await service.remove("npm:@acme/user-tools");
    await service.remove("../project-tools", "project");

    expect(fake.removeAndPersist).toHaveBeenNthCalledWith(1, "npm:@acme/user-tools");
    expect(fake.removeAndPersist).toHaveBeenNthCalledWith(2, "../project-tools", { local: true });
  });

  it("updates all configured packages or a single source", async () => {
    const fake = fakeManager();
    const service = new DefaultPiPackageService(fake.manager);

    await service.update();
    await service.update("npm:@acme/tools");

    expect(fake.update).toHaveBeenNthCalledWith(1);
    expect(fake.update).toHaveBeenNthCalledWith(2, "npm:@acme/tools");
  });

  it("serializes package mutations in call order and lists after each mutation before starting the next", async () => {
    const firstMutation = deferred();
    const events: string[] = [];
    let packages: PiPackageInfo[] = [{ source: "npm:@acme/old-tools", scope: "user", filtered: false }];
    const listConfiguredPackages = vi.fn<PiPackageManagerPort["listConfiguredPackages"]>(() => {
      events.push(`list:${packages.map((configuredPackage) => configuredPackage.source).join(",")}`);
      return packages;
    });
    const installAndPersist = vi.fn<PiPackageManagerPort["installAndPersist"]>(async (source) => {
      events.push(`install:start:${source}`);
      await firstMutation.promise;
      packages = [{ source, scope: "user", filtered: false }];
      events.push(`install:finish:${source}`);
    });
    const removeAndPersist = vi.fn<PiPackageManagerPort["removeAndPersist"]>((source) => {
      events.push(`remove:start:${source}`);
      packages = [];
      events.push(`remove:finish:${source}`);
      return Promise.resolve(true);
    });
    const update = vi.fn<PiPackageManagerPort["update"]>(() => Promise.resolve());
    const flush = vi.fn<NonNullable<PiPackageManagerPort["flush"]>>(() => {
      events.push("flush");
      return Promise.resolve();
    });
    const manager: PiPackageManagerPort = { listConfiguredPackages, installAndPersist, removeAndPersist, update, flush };
    const service = new DefaultPiPackageService(manager);

    const installPromise = service.install("npm:@acme/new-tools");
    const removePromise = service.remove("npm:@acme/new-tools");

    await Promise.resolve();
    expect(installAndPersist).toHaveBeenCalledOnce();
    expect(removeAndPersist).not.toHaveBeenCalled();
    expect(events).toEqual(["install:start:npm:@acme/new-tools"]);

    firstMutation.resolve();
    await expect(Promise.all([installPromise, removePromise])).resolves.toEqual([
      { action: "install", source: "npm:@acme/new-tools", packages: [{ source: "npm:@acme/new-tools", scope: "user", filtered: false }] },
      { action: "remove", source: "npm:@acme/new-tools", scope: "user", removed: true, packages: [] },
    ]);
    expect(events).toEqual([
      "install:start:npm:@acme/new-tools",
      "install:finish:npm:@acme/new-tools",
      "flush",
      "list:npm:@acme/new-tools",
      "remove:start:npm:@acme/new-tools",
      "remove:finish:npm:@acme/new-tools",
      "flush",
      "list:",
    ]);
  });

  it("does not queue list requests behind an in-flight mutation", async () => {
    const mutation = deferred();
    const events: string[] = [];
    let packages: PiPackageInfo[] = [{ source: "npm:@acme/old-tools", scope: "user", filtered: false }];
    const listConfiguredPackages = vi.fn<PiPackageManagerPort["listConfiguredPackages"]>(() => {
      events.push("list");
      return packages;
    });
    const installAndPersist = vi.fn<PiPackageManagerPort["installAndPersist"]>(async (source) => {
      events.push(`install:start:${source}`);
      await mutation.promise;
      packages = [{ source, scope: "user", filtered: false }];
      events.push(`install:finish:${source}`);
    });
    const removeAndPersist = vi.fn<PiPackageManagerPort["removeAndPersist"]>(() => Promise.resolve(true));
    const update = vi.fn<PiPackageManagerPort["update"]>(() => Promise.resolve());
    const manager: PiPackageManagerPort = { listConfiguredPackages, installAndPersist, removeAndPersist, update };
    const service = new DefaultPiPackageService(manager);

    const installPromise = service.install("npm:@acme/new-tools");
    await Promise.resolve();

    await expect(service.list()).resolves.toEqual({ packages: [{ source: "npm:@acme/old-tools", scope: "user", filtered: false }] });
    expect(events).toEqual(["install:start:npm:@acme/new-tools", "list"]);

    mutation.resolve();
    await expect(installPromise).resolves.toEqual({
      action: "install",
      source: "npm:@acme/new-tools",
      packages: [{ source: "npm:@acme/new-tools", scope: "user", filtered: false }],
    });
  });

  it("releases the mutation queue after a mutation fails", async () => {
    const failingMutation = deferred();
    const events: string[] = [];
    const packages: PiPackageInfo[] = [{ source: "npm:@acme/tools", scope: "user", filtered: false }];
    const listConfiguredPackages = vi.fn<PiPackageManagerPort["listConfiguredPackages"]>(() => {
      events.push("list");
      return packages;
    });
    const installAndPersist = vi.fn<PiPackageManagerPort["installAndPersist"]>(async (source) => {
      events.push(`install:start:${source}`);
      await failingMutation.promise;
    });
    const removeAndPersist = vi.fn<PiPackageManagerPort["removeAndPersist"]>(() => Promise.resolve(true));
    const update = vi.fn<PiPackageManagerPort["update"]>((source) => {
      events.push(`update:start:${source ?? "all"}`);
      return Promise.resolve();
    });
    const flush = vi.fn<NonNullable<PiPackageManagerPort["flush"]>>(() => {
      events.push("flush");
      return Promise.resolve();
    });
    const manager: PiPackageManagerPort = { listConfiguredPackages, installAndPersist, removeAndPersist, update, flush };
    const service = new DefaultPiPackageService(manager);

    const installPromise = service.install("npm:@acme/fails");
    const updatePromise = service.update("npm:@acme/tools");

    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
    expect(events).toEqual(["install:start:npm:@acme/fails"]);

    failingMutation.reject(new Error("install failed"));
    await expect(installPromise).rejects.toThrow("install failed");
    await expect(updatePromise).resolves.toEqual({
      action: "update",
      source: "npm:@acme/tools",
      packages: [{ source: "npm:@acme/tools", scope: "user", filtered: false }],
    });
    expect(events).toEqual([
      "install:start:npm:@acme/fails",
      "update:start:npm:@acme/tools",
      "flush",
      "list",
    ]);
  });
});

function availableProfile(revisionCharacter: string, dir: string) {
  return {
    status: "available" as const,
    profile: {
      schemaVersion: 1 as const,
      revision: `sha256:${revisionCharacter.repeat(64)}`,
      command: `${revisionCharacter}-agent`,
      dir,
      sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
    },
  };
}

function fakePiPackageService(source: string) {
  const packages = [{ source, scope: "user" as const, filtered: false }];
  return {
    list: vi.fn(() => Promise.resolve({ packages })),
    install: vi.fn((installedSource: string) => Promise.resolve({ action: "install" as const, source: installedSource, packages })),
    remove: vi.fn((removedSource: string, scope: "user" | "project" = "user") => Promise.resolve({ action: "remove" as const, source: removedSource, scope, removed: true, packages })),
    update: vi.fn((updatedSource?: string) => Promise.resolve({ action: "update" as const, ...(updatedSource === undefined ? {} : { source: updatedSource }), packages })),
  } satisfies PiPackageService;
}
