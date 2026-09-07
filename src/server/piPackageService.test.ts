import { join } from "node:path";
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
      .mockResolvedValueOnce(availableProfile("/state/first"))
      .mockResolvedValueOnce(availableProfile("/state/second"));
    const firstService = fakePiPackageService("first");
    const secondService = fakePiPackageService("second");
    const serviceForAgentDir = vi.fn((agentDir: string): PiPackageService => agentDir === "/state/first" ? firstService : secondService);
    const service = new ActiveProfilePiPackageService({ getActiveAgentProfile }, serviceForAgentDir, undefined, undefined, []);

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

  it("dismisses a known auto-installable package for the active profile once its declared name matches and removal succeeds", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>(() => Promise.resolve(availableProfile("/state/profile")));
    const packages = [{ source: "/opt/pi-packages/relays", scope: "user" as const, filtered: false, installedPath: "/opt/pi-packages/relays" }];
    const underlyingService = {
      list: vi.fn(() => Promise.resolve({ packages })),
      install: vi.fn(),
      remove: vi.fn(() => Promise.resolve({ action: "remove" as const, source: "/opt/pi-packages/relays", scope: "user" as const, removed: true, packages: [] })),
      update: vi.fn(),
    } satisfies PiPackageService;
    const dismiss = vi.fn(() => Promise.resolve());
    const resolveDeclaredName = vi.fn(() => Promise.resolve("@jmfederico/pi-relay"));
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile },
      () => underlyingService,
      { dismiss },
      { resolveDeclaredName },
    );

    const response = await service.remove("/opt/pi-packages/relays");

    expect(response).toMatchObject({ action: "remove", removed: true });
    expect(resolveDeclaredName).toHaveBeenCalledWith("/opt/pi-packages/relays");
    expect(dismiss).toHaveBeenCalledWith("/state/profile", "@jmfederico/pi-relay");
  });

  it("does not dismiss when the removed source's declared name is not a known auto-installable package", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>(() => Promise.resolve(availableProfile("/state/profile")));
    const packages = [{ source: "npm:@acme/tools", scope: "user" as const, filtered: false, installedPath: "/home/test/.pi/packages/tools" }];
    const underlyingService = {
      list: vi.fn(() => Promise.resolve({ packages })),
      install: vi.fn(),
      remove: vi.fn(() => Promise.resolve({ action: "remove" as const, source: "npm:@acme/tools", scope: "user" as const, removed: true, packages: [] })),
      update: vi.fn(),
    } satisfies PiPackageService;
    const dismiss = vi.fn(() => Promise.resolve());
    const resolveDeclaredName = vi.fn(() => Promise.resolve("@acme/tools"));
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile },
      () => underlyingService,
      { dismiss },
      { resolveDeclaredName },
    );

    await service.remove("npm:@acme/tools");

    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss when removal reports the source was not found", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>(() => Promise.resolve(availableProfile("/state/profile")));
    const packages = [{ source: "/opt/pi-packages/relays", scope: "user" as const, filtered: false, installedPath: "/opt/pi-packages/relays" }];
    const underlyingService = {
      list: vi.fn(() => Promise.resolve({ packages })),
      install: vi.fn(),
      remove: vi.fn(() => Promise.resolve({ action: "remove" as const, source: "/opt/pi-packages/relays", scope: "user" as const, removed: false, packages })),
      update: vi.fn(),
    } satisfies PiPackageService;
    const dismiss = vi.fn(() => Promise.resolve());
    const resolveDeclaredName = vi.fn(() => Promise.resolve("@jmfederico/pi-relay"));
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile },
      () => underlyingService,
      { dismiss },
      { resolveDeclaredName },
    );

    await service.remove("/opt/pi-packages/relays");

    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not resolve identity or dismiss when the removed source has no configured installedPath", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>(() => Promise.resolve(availableProfile("/state/profile")));
    const underlyingService = {
      list: vi.fn(() => Promise.resolve({ packages: [] })),
      install: vi.fn(),
      remove: vi.fn(() => Promise.resolve({ action: "remove" as const, source: "npm:@acme/gone", scope: "user" as const, removed: false, packages: [] })),
      update: vi.fn(),
    } satisfies PiPackageService;
    const dismiss = vi.fn(() => Promise.resolve());
    const resolveDeclaredName = vi.fn(() => Promise.resolve("@jmfederico/pi-relay"));
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile },
      () => underlyingService,
      { dismiss },
      { resolveDeclaredName },
    );

    await service.remove("npm:@acme/gone");

    expect(resolveDeclaredName).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("defaults to a no-op dismissal tracker and identity resolver so existing callers are unaffected", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>(() => Promise.resolve(availableProfile("/state/profile")));
    const underlyingService = fakePiPackageService("only");
    const service = new ActiveProfilePiPackageService({ getActiveAgentProfile }, () => underlyingService);

    await expect(service.remove("only")).resolves.toMatchObject({ action: "remove", removed: true });
  });

  it("lists a known auto-installable package as an installable suggestion when it is not configured", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>(() => Promise.resolve(availableProfile("/state/profile")));
    const underlyingService = fakePiPackageService("npm:@acme/tools");
    const resolveDeclaredName = vi.fn(() => Promise.resolve(undefined));
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile },
      () => underlyingService,
      undefined,
      { resolveDeclaredName },
      [{ id: "@acme/known", label: "Known package", description: "A known package.", shippedPathSegments: ["dist", "pi-packages", "known"] }],
      "/pi-web",
    );

    await expect(service.list()).resolves.toEqual({
      packages: [{ source: "npm:@acme/tools", scope: "user", filtered: false }],
      installableKnownPackages: [{ id: "@acme/known", label: "Known package", description: "A known package.", source: join("/pi-web", "dist", "pi-packages", "known") }],
    });
  });

  it("omits a known package from installable suggestions once a configured package's declared identity matches it", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>(() => Promise.resolve(availableProfile("/state/profile")));
    const packages = [{ source: "/opt/pi-packages/known", scope: "user" as const, filtered: false, installedPath: "/opt/pi-packages/known" }];
    const underlyingService = {
      list: vi.fn(() => Promise.resolve({ packages })),
      install: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    } satisfies PiPackageService;
    const resolveDeclaredName = vi.fn(() => Promise.resolve("@acme/known"));
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile },
      () => underlyingService,
      undefined,
      { resolveDeclaredName },
      [{ id: "@acme/known", label: "Known package", description: "A known package.", shippedPathSegments: ["dist", "pi-packages", "known"] }],
      "/pi-web",
    );

    const response = await service.list();

    expect(resolveDeclaredName).toHaveBeenCalledWith("/opt/pi-packages/known");
    expect(response).toEqual({ packages });
    expect(response.installableKnownPackages).toBeUndefined();
  });

  it("reflects a package installed through the one-click suggestion in the same install response", async () => {
    const getActiveAgentProfile = vi.fn<ActiveAgentProfileProvider["getActiveAgentProfile"]>(() => Promise.resolve(availableProfile("/state/profile")));
    const installedPackage = { source: "/pi-web/dist/pi-packages/known", scope: "user" as const, filtered: false, installedPath: "/pi-web/dist/pi-packages/known" };
    const underlyingService = {
      list: vi.fn(),
      install: vi.fn(() => Promise.resolve({ action: "install" as const, source: installedPackage.source, packages: [installedPackage] })),
      remove: vi.fn(),
      update: vi.fn(),
    } satisfies PiPackageService;
    const resolveDeclaredName = vi.fn(() => Promise.resolve("@acme/known"));
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile },
      () => underlyingService,
      undefined,
      { resolveDeclaredName },
      [{ id: "@acme/known", label: "Known package", description: "A known package.", shippedPathSegments: ["dist", "pi-packages", "known"] }],
      "/pi-web",
    );

    const response = await service.install(installedPackage.source);

    expect(response.installableKnownPackages).toBeUndefined();
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

function availableProfile(dir: string) {
  return {
    status: "available" as const,
    profile: {
      schemaVersion: 2 as const,
      dir,
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
