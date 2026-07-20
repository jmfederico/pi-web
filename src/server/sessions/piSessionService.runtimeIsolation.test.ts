import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionRuntime,
  SessionManager,
  type AgentSessionRuntime,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService, createModelRuntimeForAgentDir } from "./authService.js";
import {
  CapturingSessionEventHub,
  createTestModelRuntime,
  fakeRuntime,
  runtimeCreator,
  sessionGateway,
  sessionRecord,
  sessionRef,
  TEST_MODEL_ID,
  TEST_MODEL_PROVIDER,
} from "./piSessionService.testSupport.js";
import {
  adaptAgentSessionRuntime,
  PiSessionService,
  type PiSessionServiceDependencies,
} from "./piSessionService.js";
import { ProfileCredentialStore, ProfileCredentialStoreMalformedFileError } from "./profileCredentialStore.js";
import { SessionAuthRuntimeRegistry } from "./sessionAuthRuntimeRegistry.js";
import { createSessionModelRuntimeFactory } from "./sessionModelRuntimeFactory.js";

const tempRoots: string[] = [];

const collisionModel: ProviderModelConfig = {
  id: "same-model",
  name: "Same Model",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PiSessionService default runtime model ownership", () => {
  it("gives two real cwd service creations distinct overlays over the same profile store", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-default-runtime-isolation-"));
    tempRoots.push(root);
    const agentDir = join(root, "agent");
    const cwdA = join(root, "workspace-a");
    const cwdB = join(root, "workspace-b");
    const credentials = await ProfileCredentialStore.create({ agentDir });
    await credentials.modify("anthropic", () => Promise.resolve({ type: "api_key", key: "profile-key" }));
    const registry = new SessionAuthRuntimeRegistry(credentials);
    const runtimes: AgentSessionRuntime[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir,
      sessionModelRuntimeFactory: createSessionModelRuntimeFactory({ agentDir, credentials, authRuntimeRegistry: registry }),
      authRuntimeRegistry: registry,
      credentialRevisions: credentials,
      sessionManager: inMemorySessionGateway(),
      createAgentRuntime: capturingRealRuntimeCreator(runtimes),
      heartbeatIntervalMs: 60_000,
    });

    try {
      await service.start(cwdA);
      await service.start(cwdB);

      expect(runtimes).toHaveLength(2);
      const runtimeA = runtimes[0];
      const runtimeB = runtimes[1];
      if (runtimeA === undefined || runtimeB === undefined) throw new Error("Expected two runtimes");
      expect(runtimeA.services.cwd).toBe(cwdA);
      expect(runtimeB.services.cwd).toBe(cwdB);
      expect(runtimeA.session.modelRuntime).not.toBe(runtimeB.session.modelRuntime);
      const authResults = await Promise.all([
        runtimeA.session.modelRuntime.getAuth("anthropic"),
        runtimeB.session.modelRuntime.getAuth("anthropic"),
      ]);
      expect(authResults[0]?.auth.apiKey).toBe("profile-key");
      expect(authResults[1]?.auth.apiKey).toBe("profile-key");

      const firstGeneration = runtimeA.session.modelRuntime;
      const firstTarget = registry.resolveTarget({ sessionId: runtimeA.session.sessionId, cwd: cwdA });
      if (firstTarget === undefined) throw new Error("Expected active auth target");
      await runtimeA.newSession();
      expect(runtimeA.session.modelRuntime).not.toBe(firstGeneration);
      expect(runtimeA.session.modelRuntime).not.toBe(runtimeB.session.modelRuntime);
      expect(registry.isCurrentGeneration(firstTarget)).toBe(false);
      expect(registry.resolveTarget({ sessionId: runtimeA.session.sessionId, cwd: cwdA })?.runtime).toBe(runtimeA.session.modelRuntime);
    } finally {
      await service.dispose();
      registry.dispose();
      credentials.dispose();
    }
  });

  it("removes an invalidated SDK runtime when its replacement factory fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-sdk-replacement-failure-"));
    tempRoots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
    let modelRuntimeCreations = 0;
    const manager = SessionManager.inMemory(cwd);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir,
      sessionModelRuntimeFactory: async () => {
        modelRuntimeCreations += 1;
        if (modelRuntimeCreations > 1) throw new Error("replacement runtime factory failed");
        return createTestModelRuntime();
      },
      sessionManager: {
        create: () => manager,
        list: () => Promise.resolve([]),
        open: (path) => SessionManager.open(path),
      },
      heartbeatIntervalMs: 60_000,
    });

    try {
      const created = await service.start(cwd);
      await expect(service.runCommand(sessionRef(created.id, cwd), "/clone")).rejects.toThrow("replacement runtime factory failed");
      expect(modelRuntimeCreations).toBe(2);
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("resolves a spawned source model by identity in the target overlay", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-target-model-isolation-"));
    tempRoots.push(root);
    const agentDir = join(root, "agent");
    const credentials = await ProfileCredentialStore.create({ agentDir });
    await credentials.modify("collision", () => Promise.resolve({ type: "api_key", key: "shared" }));
    const createBaseRuntime = createSessionModelRuntimeFactory({ agentDir, credentials });
    let createdRuntimeCount = 0;
    const sessionModelRuntimeFactory: PiSessionServiceDependencies["sessionModelRuntimeFactory"] = async (input) => {
      const runtime = await createBaseRuntime(input);
      const origin = createdRuntimeCount === 0 ? "source" : "target";
      createdRuntimeCount += 1;
      runtime.registerProvider("collision", collisionProvider(origin));
      return runtime;
    };
    const runtimes: AgentSessionRuntime[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir,
      sessionModelRuntimeFactory,
      sessionManager: inMemorySessionGateway(),
      createAgentRuntime: capturingRealRuntimeCreator(runtimes),
      heartbeatIntervalMs: 60_000,
    });

    try {
      await service.start(join(root, "source"));
      const sourceRuntime = runtimes[0];
      if (sourceRuntime === undefined) throw new Error("Expected source runtime");
      const sourceModel = sourceRuntime.session.modelRuntime.getModel("collision", collisionModel.id);
      if (sourceModel === undefined) throw new Error("Expected source model");

      await service.start(join(root, "target"), { initialModel: sourceModel });
      const targetRuntime = runtimes[1];
      if (targetRuntime === undefined) throw new Error("Expected target runtime");
      const targetModel = targetRuntime.session.modelRuntime.getModel("collision", collisionModel.id);
      if (targetModel === undefined) throw new Error("Expected target model");

      expect(targetRuntime.session.model).toStrictEqual(targetModel);
      expect(targetRuntime.session.model).not.toStrictEqual(sourceModel);
      expect(targetRuntime.session.model?.baseUrl).toBe("https://target.example/v1");
    } finally {
      await service.dispose();
    }
  });

  it("coalesces overlapping auth revisions to one in-flight reload plus the latest retry", async () => {
    const modelRuntime = await createTestModelRuntime();
    const fake = fakeRuntime("serialized-auth-session", { modelRuntime });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let reloadCalls = 0;
    vi.spyOn(modelRuntime, "reloadConfig").mockImplementation(async () => {
      reloadCalls += 1;
      if (reloadCalls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-auth-serialization",
      sessionModelRuntimeFactory: () => Promise.resolve(modelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("serialized-auth-session")]),
      heartbeatIntervalMs: 60_000,
    });

    try {
      await service.status(sessionRef("serialized-auth-session"));
      const first = service.applyAuthChange();
      await firstStarted.promise;
      const second = service.applyAuthChange();
      const third = service.applyAuthChange();
      await Promise.resolve();
      expect(reloadCalls).toBe(1);

      releaseFirst.resolve();
      await Promise.all([first, second, third]);
      expect(reloadCalls).toBe(2);
      expect(fake.calls.dispose).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("persists profile login/logout and awaits active overlay recomposition without session replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-auth-runtime-coherence-"));
    tempRoots.push(root);
    const credentials = await ProfileCredentialStore.create({ agentDir: root });
    const profileRuntime = await createModelRuntimeForAgentDir(root, credentials, false);
    const auth = await AuthService.create({ runtime: profileRuntime });
    const sessionRuntime = await createSessionModelRuntimeFactory({ agentDir: root, credentials })({ cwd: "/workspace" });
    const model = sessionRuntime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
    if (model === undefined) throw new Error("Expected Anthropic model fixture");
    const fake = fakeRuntime("shared-auth-session", { model, modelRuntime: sessionRuntime });
    const reloadConfig = vi.spyOn(sessionRuntime, "reloadConfig");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: root,
      sessionModelRuntimeFactory: createSessionModelRuntimeFactory({ agentDir: root, credentials }),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("shared-auth-session")]),
      heartbeatIntervalMs: 60_000,
    });
    auth.subscribe((change) => service.applyAuthChange(change));

    try {
      await service.status(sessionRef("shared-auth-session"));
      await auth.saveApiKey("anthropic", "sk-profile");

      await expect(credentials.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-profile" });
      await expect(readFile(join(root, "auth.json"), "utf8")).resolves.toContain("sk-profile");
      await expect(sessionRuntime.getAuth("anthropic")).resolves.toMatchObject({ auth: { apiKey: "sk-profile" } });
      expect(reloadConfig).toHaveBeenCalledTimes(1);
      expect(fake.calls.dispose).toBe(0);

      await auth.logoutProvider("anthropic");

      await expect(credentials.read("anthropic")).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(join(root, "auth.json"), "utf8"))).toEqual({});
      expect(reloadConfig).toHaveBeenCalledTimes(2);
      expect(fake.calls.dispose).toBe(0);
    } finally {
      auth.dispose();
      await service.dispose();
    }
  });

  it("propagates request-time OAuth refresh revisions to every active overlay", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-oauth-refresh-revision-"));
    tempRoots.push(root);
    const credentials = await ProfileCredentialStore.create({ agentDir: root });
    const providerId = "refreshing-oauth";
    await credentials.modify(providerId, () => Promise.resolve({
      type: "oauth",
      refresh: "refresh-old",
      access: "access-old",
      expires: Date.now() - 1,
    }));
    const registry = new SessionAuthRuntimeRegistry(credentials);
    const scope = registry.createCredentialScope("/workspace");
    const sessionRuntime = await createModelRuntimeForAgentDir(root, scope.credentials, false);
    scope.bindRuntime(sessionRuntime);
    const refreshToken = vi.fn(() => Promise.resolve({
      refresh: "refresh-new",
      access: "access-new",
      expires: Date.now() + 60_000,
    }));
    sessionRuntime.registerProvider(providerId, refreshingOAuthProvider(refreshToken));
    registry.updateExtensionProviders(sessionRuntime);
    const fake = fakeRuntime("oauth-refresh-session", { modelRuntime: sessionRuntime });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: root,
      sessionModelRuntimeFactory: createSessionModelRuntimeFactory({ agentDir: root, credentials, authRuntimeRegistry: registry }),
      authRuntimeRegistry: registry,
      credentialRevisions: credentials,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("oauth-refresh-session")]),
      heartbeatIntervalMs: 60_000,
    });

    try {
      await service.status(sessionRef("oauth-refresh-session"));
      const reloadConfig = vi.spyOn(sessionRuntime, "reloadConfig");

      await expect(sessionRuntime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "access-new" } });
      await vi.waitFor(() => { expect(reloadConfig).toHaveBeenCalledOnce(); });
      expect(refreshToken).toHaveBeenCalledOnce();
      await expect(credentials.read(providerId)).resolves.toMatchObject({ access: "access-new", refresh: "refresh-new" });
      expect(fake.calls.dispose).toBe(0);
    } finally {
      await service.dispose();
      registry.dispose();
      credentials.dispose();
    }
  });

  it("propagates valid external auth edits and ignores malformed revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-external-auth-revision-"));
    tempRoots.push(root);
    const credentials = await ProfileCredentialStore.create({ agentDir: root });
    await credentials.startExternalObservation({ debounceMs: 1, pollIntervalMs: 10 });
    const sessionRuntime = await createModelRuntimeForAgentDir(root, credentials, false);
    const fake = fakeRuntime("external-auth-session", { modelRuntime: sessionRuntime });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: root,
      sessionModelRuntimeFactory: createSessionModelRuntimeFactory({ agentDir: root, credentials }),
      credentialRevisions: credentials,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("external-auth-session")]),
      heartbeatIntervalMs: 60_000,
    });

    try {
      await service.status(sessionRef("external-auth-session"));
      const reloadConfig = vi.spyOn(sessionRuntime, "reloadConfig");
      const authPath = join(root, "auth.json");
      await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "api_key", key: "external-key" } })}\n`, "utf8");

      await vi.waitFor(() => { expect(reloadConfig).toHaveBeenCalledOnce(); });
      await expect(sessionRuntime.getAuth("anthropic")).resolves.toMatchObject({ auth: { apiKey: "external-key" } });
      const revision = credentials.revision;

      await writeFile(authPath, "{malformed", "utf8");
      await vi.waitFor(() => { expect(credentials.reloadError).toBeInstanceOf(ProfileCredentialStoreMalformedFileError); });
      expect(credentials.revision).toBe(revision);
      expect(reloadConfig).toHaveBeenCalledOnce();
    } finally {
      await service.dispose();
      credentials.dispose();
    }
  });

  it("catches a runtime opened during a credential mutation up before activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-open-auth-ordering-"));
    tempRoots.push(root);
    const credentials = await ProfileCredentialStore.create({ agentDir: root });
    const sessionRuntime = await createModelRuntimeForAgentDir(root, credentials, false);
    const bindStarted = deferred();
    const releaseBind = deferred();
    const reloadStarted = deferred();
    const releaseReload = deferred();
    let reloadCalls = 0;
    const reloadConfig = vi.spyOn(sessionRuntime, "reloadConfig").mockImplementation(async () => {
      reloadCalls += 1;
      if (reloadCalls === 2) {
        reloadStarted.resolve();
        await releaseReload.promise;
      }
    });
    const fake = fakeRuntime("opening-auth-session", {
      modelRuntime: sessionRuntime,
      bindExtensions: async () => {
        bindStarted.resolve();
        await releaseBind.promise;
      },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: root,
      sessionModelRuntimeFactory: createSessionModelRuntimeFactory({ agentDir: root, credentials }),
      credentialRevisions: credentials,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("opening-auth-session")]),
      heartbeatIntervalMs: 60_000,
    });

    try {
      let statusSettled = false;
      const opening = service.status(sessionRef("opening-auth-session"));
      void opening.then(
        () => { statusSettled = true; },
        () => { statusSettled = true; },
      );
      await bindStarted.promise;
      await credentials.modify("anthropic", () => Promise.resolve({ type: "api_key", key: "during-open" }));
      await reloadStarted.promise;
      releaseBind.resolve();

      expect(statusSettled).toBe(false);
      expect(reloadConfig).toHaveBeenCalledTimes(2);
      releaseReload.resolve();
      await opening;
      await expect(sessionRuntime.getAuth("anthropic")).resolves.toMatchObject({ auth: { apiKey: "during-open" } });
    } finally {
      releaseBind.resolve();
      releaseReload.resolve();
      await service.dispose();
      credentials.dispose();
    }
  });
});

function collisionProvider(origin: "source" | "target"): ProviderConfig {
  return {
    name: `Collision ${origin}`,
    baseUrl: `https://${origin}.example/v1`,
    apiKey: "fallback",
    api: "openai-completions",
    models: [collisionModel],
  };
}

function refreshingOAuthProvider(
  refreshToken: (credentials: { refresh: string; access: string; expires: number }) => Promise<{ refresh: string; access: string; expires: number }>,
): ProviderConfig {
  return {
    name: "Refreshing OAuth",
    baseUrl: "https://refresh.example.test/v1",
    api: "openai-completions",
    models: [collisionModel],
    oauth: {
      name: "Refreshing OAuth",
      login: () => Promise.resolve({ refresh: "login", access: "login", expires: Date.now() + 60_000 }),
      refreshToken,
      getApiKey: (credentials) => credentials.access,
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function inMemorySessionGateway(): PiSessionServiceDependencies["sessionManager"] {
  return {
    create: (cwd) => SessionManager.inMemory(cwd),
    list: () => Promise.resolve([]),
    open: (path) => SessionManager.open(path),
  };
}

function capturingRealRuntimeCreator(
  captures: AgentSessionRuntime[],
): NonNullable<PiSessionServiceDependencies["createAgentRuntime"]> {
  return async (createRuntime, options) => {
    if (!(options.sessionManager instanceof SessionManager)) throw new Error("Expected SDK SessionManager");
    let firstGeneration = true;
    const runtime = await createAgentSessionRuntime((runtimeOptions) => {
      const applyOneShotOptions = firstGeneration;
      firstGeneration = false;
      return createRuntime({
        ...runtimeOptions,
        ...(applyOneShotOptions && options.initialModel !== undefined ? { initialModel: options.initialModel } : {}),
        ...(applyOneShotOptions ? { delegationToolsEnabled: options.delegationToolsEnabled } : {}),
      });
    }, {
      cwd: options.cwd,
      agentDir: options.agentDir,
      sessionManager: options.sessionManager,
      ...(options.sessionStartEvent === undefined ? {} : { sessionStartEvent: options.sessionStartEvent }),
    });
    captures.push(runtime);
    return adaptAgentSessionRuntime(runtime);
  };
}
