import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  PI_WEB_HOST_WORKSPACES_CAPABILITY,
} from "../../server-plugin-api.js";
import type {
  JsonValue,
  PiWebHostPiSessionsV1,
  PiWebHostWorkspacesV1,
  PiWebServerPlugin,
  PluginCapability,
  ServerPluginActivation,
  ServerPluginActivationContext,
  ServerPluginNoticeInput,
  ServerPluginNoticeReporterV1,
  WorkspaceProvider,
} from "../../server-plugin-api.js";
import type { PiWebPluginScope } from "../../shared/apiTypes.js";
import {
  SERVER_NOTICE_SCOPE_ID_MAX_LENGTH,
  SERVER_PLUGIN_NOTICE_CONTEXT_MAX_BYTES,
  SERVER_PLUGIN_NOTICE_CONTEXT_MAX_DEPTH,
  SERVER_PLUGIN_NOTICE_MESSAGE_MAX_BYTES,
} from "../../shared/serverNoticeContract.js";
import { ServerNoticeService } from "../notices/serverNoticeService.js";
import { ServerNoticeStore } from "../notices/serverNoticeStore.js";
import { REQUIRED_TERMINAL_SERVICE_CAPABILITY } from "../terminals/requiredTerminalService.js";
import type { PiWebPluginCatalogEntry, PiWebPluginCatalogSnapshot } from "../piWebPluginCatalog.js";
import {
  createServerPluginRuntime as createRuntime,
  type CreateServerPluginRuntimeOptions,
  type ServerPluginHostCapabilityFactory,
  type ServerPluginModuleImporter,
} from "./serverPluginRuntime.js";

// A test-owned service exercises generic host factory lifetimes, not host storage.
interface TestScopedService {
  readonly version: 1;
  readonly read: () => Promise<JsonValue | undefined>;
  readonly write: (value: JsonValue) => Promise<void>;
  readonly clear: () => Promise<void>;
}

const testScopedService: PluginCapability<TestScopedService, 1> = {
  pluginId: "fixture.host",
  id: "scoped-service",
  version: 1,
  parse(value) {
    if (!isTestScopedService(value)) throw new Error("Invalid test service");
    return {
      version: 1,
      read: async () => await value.read(),
      write: async (input) => { await value.write(input); },
      clear: async () => { await value.clear(); },
    };
  },
};

function isTestScopedService(value: unknown): value is TestScopedService {
  return typeof value === "object" && value !== null
    && Reflect.get(value, "version") === 1
    && ["read", "write", "clear"].every((key) => typeof Reflect.get(value, key) === "function");
}

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createServerPluginRuntime(options: Omit<CreateServerPluginRuntimeOptions, "dataDir"> & { dataDir?: string }) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), "pi-web-plugin-runtime-"));
  if (options.dataDir === undefined) tempRoots.push(dataDir);
  return createRuntime({ ...options, dataDir, enforceRequiredTerminal: options.enforceRequiredTerminal ?? false });
}

function createServerPluginRuntimeWithRequiredTerminal(options: Omit<CreateServerPluginRuntimeOptions, "dataDir">) {
  return createServerPluginRuntime({ ...options, enforceRequiredTerminal: true });
}

describe("server plugin runtime", () => {
  it("creates isolated persistent directories before activation and retains plugin-owned files across runtimes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-data-"));
    tempRoots.push(root);
    const dataDir = join(root, "data");
    const directories = new Map<string, string>();
    const start = (revision: number) => createServerPluginRuntime({
      dataDir: relative(process.cwd(), dataDir),
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        { ...entry("alpha"), packageRoot: `/packages/revision-${String(revision)}/alpha` },
        entry("beta"),
        { ...entry("disabled"), enabled: false },
      ])) },
      importer: () => Promise.resolve({ default: plugin("Directory fixture", async (context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.dataDirectory).toBe(resolve(dataDir, "plugin-data", context.pluginId));
        directories.set(context.pluginId, context.dataDirectory);
        const filePath = join(context.dataDirectory, "owned.txt");
        if (revision === 1) await writeFile(filePath, context.pluginId);
        else expect(await readFile(filePath, "utf8")).toBe(context.pluginId);
        return {};
      }) }),
      logger: testLogger(),
    });
    const first = await start(1);
    expect(first.healthRecords().filter(({ state }) => state === "active")).toHaveLength(2);
    expect(directories.get("alpha")).not.toBe(directories.get("beta"));
    await expect(stat(join(dataDir, "plugin-data", "disabled"))).rejects.toMatchObject({ code: "ENOENT" });
    await first.stop();
    const second = await start(2);
    expect(second.healthRecords().filter(({ state }) => state === "active")).toHaveLength(2);
    await second.stop();
  });

  it("quarantines directory creation failures without activating the affected plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-data-error-"));
    tempRoots.push(root);
    const dataDir = join(root, "not-a-directory");
    await writeFile(dataDir, "occupied");
    const activate = vi.fn(() => ({}));
    const runtime = await createServerPluginRuntime({
      dataDir,
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("alpha")])) },
      importer: () => Promise.resolve({ default: plugin("Directory failure", activate) }),
      logger: testLogger(),
    });
    expect(activate).not.toHaveBeenCalled();
    expect(runtime.healthRecords()).toEqual([expect.objectContaining({ pluginId: "alpha", state: "failed", phase: "activate" })]);
    await runtime.stop();
  });

  it("activates deterministically, quarantines ordinary failures, publishes transactionally, and disposes in reverse", async () => {
    const events: string[] = [];
    const provider = testProvider();
    const modules = new Map<string, unknown>([
      ["alpha", pluginModule("Alpha", {
        workspaceProvider: provider,
        peer: {
          request: () => ({ ready: true }),
          openChannel: () => ({ receive: () => undefined }),
        },
        start: () => { events.push("start:alpha"); },
        dispose: () => { events.push("stop:alpha"); },
      })],
      ["bad-activate", { default: plugin("Bad activate", () => { throw new Error("activate exploded"); }) }],
      ["bad-api", { default: { apiVersion: 2, name: "Legacy", activate: () => ({}) } }],
      ["bad-start", pluginModule("Bad start", {
        workspaceProvider: testProvider(),
        start: () => {
          events.push("start:bad-start");
          throw new Error("start exploded");
        },
        dispose: () => { events.push("rollback:bad-start"); },
      })],
      ["omega", pluginModule("Omega", {
        workspaceProvider: testProvider(),
        start: () => { events.push("start:omega"); },
        dispose: () => { events.push("stop:omega"); },
      })],
    ]);
    const imported: string[] = [];
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      imported.push(pluginId);
      if (pluginId === "bad-import") return Promise.reject(new Error("import exploded"));
      return Promise.resolve(modules.get(pluginId));
    };
    const snapshot = testSnapshot([
      entry("omega"),
      entry("bad-start"),
      entry("bad-import"),
      entry("alpha", { browserRevision: "browser-7" }),
      entry("bad-api"),
      entry("bad-activate"),
    ]);
    const catalog = { snapshot: vi.fn(() => Promise.resolve(snapshot)) };

    const runtime = await createServerPluginRuntime({ catalog, importer, logger: testLogger() });

    expect(catalog.snapshot).toHaveBeenCalledOnce();
    expect(imported).toEqual(["alpha", "bad-activate", "bad-api", "bad-import", "bad-start", "omega"]);
    expect(events).toEqual(["start:alpha", "start:bad-start", "rollback:bad-start", "start:omega"]);
    expect(runtime.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "alpha", state: "active", name: "Alpha", browserRevision: "browser-7", settingsRevision: "settings-1", machineSpecific: true, pairedRequestVersion: 1, pairedChannelVersion: 1 }),
      expect.objectContaining({ pluginId: "bad-activate", state: "failed", phase: "activate", message: "activate exploded" }),
      expect.objectContaining({ pluginId: "bad-api", state: "incompatible", phase: "validate", message: "Unsupported server plugin API version: 2" }),
      expect.objectContaining({ pluginId: "bad-import", state: "failed", phase: "import", message: "import exploded" }),
      expect.objectContaining({ pluginId: "bad-start", state: "failed", phase: "start", message: "start exploded" }),
      expect.objectContaining({ pluginId: "omega", state: "active", name: "Omega" }),
    ]);
    expect(runtime.providerContributions().map((contribution) => contribution.pluginId)).toEqual(["alpha", "omega"]);
    expect(runtime.pairedBackendContributions().map((contribution) => contribution.pluginId)).toEqual(["alpha"]);

    await runtime.stop();
    await runtime.stop();

    expect(events).toEqual([
      "start:alpha",
      "start:bad-start",
      "rollback:bad-start",
      "start:omega",
      "stop:omega",
      "stop:alpha",
    ]);
    expect(runtime.providerContributions()).toEqual([]);
    expect(runtime.pairedBackendContributions()).toEqual([]);
  });

  it("starts exact capability providers before consumers, snapshots values, and disposes in reverse dependency order", async () => {
    const events: string[] = [];
    const service = testCapability("zeta.provider", "service", 1);
    const undeclared = testCapability("other.provider", "service", 1);
    const sourceValue = { label: "activation snapshot" };
    const lifetimes = new Map<string, AbortSignal>();
    let startSignal: AbortSignal | undefined;
    let resolvedLabel: string | undefined;
    let undeclaredMessage: string | undefined;
    let resolverWasFrozen = false;
    let startContextWasFrozen = false;
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("zeta.provider"), entry("alpha.consumer")])) },
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        if (pluginId === "zeta.provider") {
          return Promise.resolve({
            default: plugin("Provider", (context) => {
              events.push("activate:provider");
              lifetimes.set(pluginId, context.lifetimeSignal);
              return {
                provides: [{ capability: service, value: sourceValue }],
                start: () => {
                  events.push("start:provider");
                  sourceValue.label = "mutated during start";
                },
                dispose: () => { events.push("dispose:provider"); },
              };
            }),
          });
        }
        return Promise.resolve({
          default: plugin("Consumer", (context) => {
            events.push("activate:consumer");
            lifetimes.set(pluginId, context.lifetimeSignal);
            return {
              start: (startContext) => {
                events.push("start:consumer");
                startSignal = startContext.signal;
                startContextWasFrozen = Object.isFrozen(startContext);
                resolverWasFrozen = Object.isFrozen(startContext.capabilities);
                resolvedLabel = startContext.capabilities.resolve(service).label;
                try {
                  startContext.capabilities.resolve(undeclared);
                } catch (error) {
                  undeclaredMessage = errorMessage(error);
                }
              },
              dispose: () => { events.push("dispose:consumer"); },
            };
          }, [service]),
        });
      },
      logger: testLogger(),
    });

    expect(events).toEqual([
      "activate:consumer",
      "activate:provider",
      "start:provider",
      "start:consumer",
    ]);
    expect(resolvedLabel).toBe("activation snapshot");
    expect(startSignal?.aborted).toBe(true);
    expect(startContextWasFrozen).toBe(true);
    expect(resolverWasFrozen).toBe(true);
    expect(undeclaredMessage).toContain("did not declare required capability other.provider/service v1");
    expect(runtime.resolve(service)).toEqual({ label: "activation snapshot" });
    expect([...lifetimes.values()].every((signal) => !signal.aborted)).toBe(true);

    runtime.beginShutdown();
    expect([...lifetimes.values()].every((signal) => signal.aborted)).toBe(true);
    expect(runtime.healthRecords().every(({ state }) => state === "active")).toBe(true);
    expect(runtime.resolve(service)).toEqual({ label: "activation snapshot" });

    await runtime.stop();
    expect(events.slice(-2)).toEqual(["dispose:consumer", "dispose:provider"]);
    expect(() => runtime.resolve(service)).toThrow("is not active");
  });

  it("keeps provision, requirement, and resolve parser boundaries distinct", async () => {
    const provider = testCapability("fixture.host", "service", 1);
    const requirement = { ...provider, parse: vi.fn((value: unknown) => ({ label: `requirement:${provider.parse(value).label}` })) };
    const request = { ...provider, parse: (value: unknown) => ({ label: `request:${provider.parse(value).label}` }) };
    const rejectingRequest = { ...provider, parse: () => { throw new Error("request rejected"); } };
    let resolved: TestCapabilityValue | undefined;
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("consumer")])) },
      hostCapabilities: [{ capability: provider, value: { label: "ready" } }],
      importer: () => Promise.resolve({
        default: plugin("Consumer", () => ({
          start: ({ capabilities }) => {
            expect(requirement.parse).toHaveBeenCalledWith({ label: "ready" });
            resolved = capabilities.resolve(request);
            expect(() => capabilities.resolve(rejectingRequest)).toThrow("request rejected");
          },
        }), [requirement]),
      }),
      logger: testLogger(),
    });
    expect(resolved).toEqual({ label: "request:ready" });
    expect(runtime.healthRecords()).toEqual([expect.objectContaining({ pluginId: "consumer", state: "active" })]);
    await runtime.stop();
  });

  it("pre-registers host capabilities and limits each start resolver to declared requirements", async () => {
    const hostService = testCapability("pi-web.host.fixture", "clock", 1);
    let resolved: TestCapabilityValue | undefined;
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("consumer")])) },
      hostCapabilities: [{ capability: hostService, value: { label: "host clock" } }],
      importer: () => Promise.resolve({
        default: plugin("Consumer", () => ({
          start: ({ capabilities }) => { resolved = capabilities.resolve(hostService); },
        }), [hostService]),
      }),
      logger: testLogger(),
    });

    expect(resolved).toEqual({ label: "host clock" });
    expect(runtime.healthRecords()).toEqual([expect.objectContaining({ pluginId: "consumer", state: "active" })]);
    await runtime.stop();
    expect(() => runtime.resolve(hostService)).toThrow("is not active");
  });

  it("materializes host capabilities per declaring plugin and revokes and cleans them with that lifecycle", async () => {
    const contexts = new Map<string, ServerPluginActivationContext["lifetimeSignal"]>();
    const stateValues = new Map<string, JsonValue>();
    const resolvedStates = new Map<string, TestScopedService>();
    const starts: string[] = [];
    const cleanups: string[] = [];
    const mutableCapability: PluginCapability<TestScopedService, 1> = {
      ...testScopedService,
      parse: testScopedService.parse,
    };
    const factory: ServerPluginHostCapabilityFactory<TestScopedService> = {
      capability: mutableCapability,
      create(context) {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.packageRoot).toBe(`/plugins/${context.pluginId}`);
        contexts.set(context.pluginId, context.lifetimeSignal);
        Reflect.set(mutableCapability, "parse", () => { throw new Error("mutated parser was used"); });
        if (context.pluginId === "factory-failure") throw new Error("state factory failed");
        const assertActive = (): void => {
          if (context.lifetimeSignal.aborted) throw new Error(`state revoked for ${context.pluginId}`);
        };
        return {
          value: {
            version: 1,
            read: () => {
              assertActive();
              return Promise.resolve(stateValues.get(context.pluginId));
            },
            write: (value: JsonValue) => {
              assertActive();
              stateValues.set(context.pluginId, value);
              return Promise.resolve();
            },
            clear: () => {
              assertActive();
              stateValues.delete(context.pluginId);
              return Promise.resolve();
            },
          },
          dispose: () => { cleanups.push(context.pluginId); },
        };
      },
    };
    const stateV2: PluginCapability<TestScopedService, 2> = {
      ...testScopedService,
      version: 2,
    };
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("state-beta"),
        entry("wrong-version"),
        entry("independent"),
        entry("state-alpha"),
        entry("start-failure"),
        entry("factory-failure"),
      ])) },
      hostCapabilityFactories: [factory],
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        if (pluginId === "independent") {
          return Promise.resolve(pluginModule("Independent", { start: () => { starts.push(pluginId); } }));
        }
        const requirement = pluginId === "wrong-version" ? stateV2 : testScopedService;
        return Promise.resolve({
          default: plugin(pluginId, () => ({
            async start({ capabilities }) {
              starts.push(pluginId);
              const state = capabilities.resolve(requirement);
              resolvedStates.set(pluginId, state);
              await state.write({ pluginId });
              if (pluginId === "start-failure") throw new Error("start failed after state resolution");
            },
          }), [requirement]),
        });
      },
      logger: testLogger(),
    });

    expect(starts).toEqual(["independent", "start-failure", "state-alpha", "state-beta"]);
    expect(stateValues.get("state-alpha")).toEqual({ pluginId: "state-alpha" });
    expect(stateValues.get("state-beta")).toEqual({ pluginId: "state-beta" });
    expect(stateValues.get("start-failure")).toEqual({ pluginId: "start-failure" });
    expect(cleanups).toEqual(["start-failure"]);
    expect(contexts.get("start-failure")?.aborted).toBe(true);
    expect(runtime.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "factory-failure", state: "failed", phase: "start", message: "state factory failed" }),
      expect.objectContaining({ pluginId: "independent", state: "active" }),
      expect.objectContaining({ pluginId: "start-failure", state: "failed", phase: "start", message: "start failed after state resolution" }),
      expect.objectContaining({ pluginId: "state-alpha", state: "active" }),
      expect.objectContaining({ pluginId: "state-beta", state: "active" }),
      expect.objectContaining({ pluginId: "wrong-version", state: "failed", phase: "start" }),
    ]);
    expect(runtime.healthRecords().find(({ pluginId }) => pluginId === "wrong-version")?.message)
      .toContain("requires unavailable capability fixture.host/scoped-service v2");
    expect(contexts.has("wrong-version")).toBe(false);

    const alphaState = resolvedStates.get("state-alpha");
    if (alphaState === undefined) throw new Error("Expected state-alpha capability");
    runtime.beginShutdown();
    expect([...contexts.values()].every((signal) => signal.aborted)).toBe(true);
    await expect(alphaState.read()).rejects.toThrow("state revoked for state-alpha");
    await runtime.stop();
    expect(cleanups).toEqual(["start-failure", "state-beta", "state-alpha"]);
  });

  it("starts early authority immediately and resumes exact late host capabilities once with failure isolation", async () => {
    const service = testCapability("provider", "service", 1);
    const workspacesV2: PluginCapability<PiWebHostWorkspacesV1, 2> = {
      ...PI_WEB_HOST_WORKSPACES_CAPABILITY,
      version: 2,
    };
    const events: string[] = [];
    const lateContexts = new Map<string, ServerPluginActivationContext["lifetimeSignal"]>();
    const lateCleanups: string[] = [];
    const resolvedWorkspaces = new Map<string, PiWebHostWorkspacesV1>();
    const stateFactory: ServerPluginHostCapabilityFactory<TestScopedService> = {
      capability: testScopedService,
      create: () => ({
        value: {
          version: 1,
          read: () => Promise.resolve(undefined),
          write: () => Promise.resolve(),
          clear: () => Promise.resolve(),
        },
      }),
    };
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("late-omega"),
        entry("late-pi"),
        entry("wrong-version"),
        entry("provider"),
        entry("late-beta"),
        entry("early-state"),
        entry("late-gamma"),
        entry("late-alpha"),
      ])) },
      hostCapabilityFactories: [stateFactory],
      lateHostCapabilities: [PI_WEB_HOST_WORKSPACES_CAPABILITY, PI_WEB_HOST_PI_SESSIONS_CAPABILITY],
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        if (pluginId === "provider") {
          return Promise.resolve({ default: plugin("Provider", () => ({
            provides: [{ capability: service, value: { label: "ready" } }],
            start: () => { events.push("start:provider"); },
            dispose: () => { events.push("dispose:provider"); },
          })) });
        }
        if (pluginId === "early-state") {
          return Promise.resolve({ default: plugin("Early state", () => ({
            start: ({ capabilities }) => {
              capabilities.resolve(testScopedService);
              events.push("start:early-state");
            },
            dispose: () => { events.push("dispose:early-state"); },
          }), [testScopedService]) });
        }
        const requirement = pluginId === "wrong-version"
          ? workspacesV2
          : pluginId === "late-pi"
            ? PI_WEB_HOST_PI_SESSIONS_CAPABILITY
            : PI_WEB_HOST_WORKSPACES_CAPABILITY;
        const requirements = pluginId === "late-alpha" ? [service, requirement] : [requirement];
        return Promise.resolve({ default: plugin(pluginId, (context) => {
          lateContexts.set(pluginId, context.lifetimeSignal);
          return {
            start: ({ capabilities }) => {
              events.push(`start:${pluginId}`);
              if (pluginId === "late-pi") capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
              else {
                const workspaceRequirement = pluginId === "wrong-version"
                  ? workspacesV2
                  : PI_WEB_HOST_WORKSPACES_CAPABILITY;
                const resolved = capabilities.resolve(workspaceRequirement);
                if (pluginId !== "wrong-version") resolvedWorkspaces.set(pluginId, resolved);
              }
              if (pluginId === "late-alpha" && capabilities.resolve(service).label !== "ready") {
                throw new Error("provider capability was not ready");
              }
              if (pluginId === "late-gamma") throw new Error("late start failed");
            },
            dispose: () => { events.push(`dispose:${pluginId}:${String(context.lifetimeSignal.aborted)}`); },
          };
        }, requirements) });
      },
      logger: testLogger(),
    });

    expect(events).toEqual([
      "start:early-state",
      "start:provider",
      "dispose:wrong-version:true",
    ]);
    expect(runtime.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "early-state", state: "active" }),
      expect.objectContaining({ pluginId: "provider", state: "active" }),
      expect.objectContaining({ pluginId: "wrong-version", state: "failed", phase: "start" }),
    ]);
    expect(runtime.healthRecords().find(({ pluginId }) => pluginId === "wrong-version")?.message)
      .toContain("requires unavailable capability pi-web.host/workspaces v2");
    expect([...lateContexts.entries()]
      .filter(([pluginId]) => pluginId !== "wrong-version")
      .every(([, signal]) => !signal.aborted)).toBe(true);

    const lateFactory: ServerPluginHostCapabilityFactory<PiWebHostWorkspacesV1> = {
      capability: PI_WEB_HOST_WORKSPACES_CAPABILITY,
      create(context) {
        if (context.pluginId === "late-beta") throw new Error("late factory failed");
        return {
          value: {
            version: 1,
            resolve: () => Promise.reject(new Error("not exercised by this lifecycle fixture")),
          },
          dispose: () => { lateCleanups.push(context.pluginId); },
        };
      },
    };
    const piSessionsFactory: ServerPluginHostCapabilityFactory<PiWebHostPiSessionsV1> = {
      capability: PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
      create: () => ({
        value: {
          version: 1,
          create: () => Promise.resolve({ sessionId: "session-created" }),
          run: () => Promise.resolve({
            sessionId: "session-1",
            completion: Promise.resolve({ status: "completed" as const }),
          }),
        },
      }),
    };
    await expect(runtime.resumeWithHostCapabilityFactories([lateFactory]))
      .rejects.toThrow("Late host capability pi-web.host/pi-sessions v1 was not registered");
    await runtime.resumeWithHostCapabilityFactories([lateFactory, piSessionsFactory]);

    expect(events).toEqual([
      "start:early-state",
      "start:provider",
      "dispose:wrong-version:true",
      "start:late-alpha",
      "dispose:late-beta:true",
      "start:late-gamma",
      "dispose:late-gamma:true",
      "start:late-omega",
      "start:late-pi",
    ]);
    expect(lateCleanups).toEqual(["late-gamma"]);
    expect(resolvedWorkspaces.has("late-alpha")).toBe(true);
    expect(resolvedWorkspaces.has("late-omega")).toBe(true);
    expect(runtime.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "early-state", state: "active" }),
      expect.objectContaining({ pluginId: "late-alpha", state: "active" }),
      expect.objectContaining({ pluginId: "late-beta", state: "failed", message: "late factory failed" }),
      expect.objectContaining({ pluginId: "late-gamma", state: "failed", message: "late start failed" }),
      expect.objectContaining({ pluginId: "late-omega", state: "active" }),
      expect.objectContaining({ pluginId: "late-pi", state: "active" }),
      expect.objectContaining({ pluginId: "provider", state: "active" }),
      expect.objectContaining({ pluginId: "wrong-version", state: "failed" }),
    ]);
    await expect(runtime.resumeWithHostCapabilityFactories([lateFactory, piSessionsFactory]))
      .rejects.toThrow("already resumed");

    runtime.beginShutdown();
    expect([...lateContexts.values()].every((signal) => signal.aborted)).toBe(true);
    await runtime.stop();
    expect(lateCleanups).toEqual(["late-gamma", "late-omega", "late-alpha"]);
    expect(events.slice(-5)).toEqual([
      "dispose:late-pi:true",
      "dispose:late-omega:true",
      "dispose:late-alpha:true",
      "dispose:provider",
      "dispose:early-state",
    ]);
  });

  it("rejects workspace providers blocked on late authority as topology cycles before publishing the registry", async () => {
    const providerService = testCapability("cycle-provider", "service", 1);
    const starts: string[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("ordinary-consumer"),
        entry("downstream"),
        entry("cycle-provider"),
      ])) },
      lateHostCapabilities: [PI_WEB_HOST_WORKSPACES_CAPABILITY],
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        if (pluginId === "cycle-provider") {
          return Promise.resolve({ default: plugin("Cycle provider", () => ({
            workspaceProvider: testProvider(),
            provides: [{ capability: providerService, value: { label: "provider" } }],
            start: () => { starts.push(pluginId); },
          }), [PI_WEB_HOST_WORKSPACES_CAPABILITY]) });
        }
        if (pluginId === "downstream") {
          return Promise.resolve({ default: plugin("Downstream", () => ({
            start: () => { starts.push(pluginId); },
          }), [providerService]) });
        }
        return Promise.resolve({ default: plugin("Ordinary", () => ({
          start: () => { starts.push(pluginId); },
        }), [PI_WEB_HOST_WORKSPACES_CAPABILITY]) });
      },
      logger: testLogger(),
    });

    expect(starts).toEqual([]);
    expect(runtime.providerContributions()).toEqual([]);
    expect(runtime.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "cycle-provider", state: "failed", phase: "start" }),
      expect.objectContaining({ pluginId: "downstream", state: "failed", phase: "start" }),
    ]);
    expect(runtime.healthRecords().find(({ pluginId }) => pluginId === "cycle-provider")?.message)
      .toContain("workspace provider that depends on late host capability pi-web.host/workspaces v1 in a capability dependency cycle");
    expect(runtime.healthRecords().find(({ pluginId }) => pluginId === "downstream")?.message)
      .toContain("provider plugin cycle-provider did not start");

    await runtime.resumeWithHostCapabilityFactories([{
      capability: PI_WEB_HOST_WORKSPACES_CAPABILITY,
      create: () => ({
        value: {
          version: 1,
          resolve: () => Promise.reject(new Error("not exercised by this topology fixture")),
        },
      }),
    }]);
    expect(starts).toEqual(["ordinary-consumer"]);
    expect(runtime.healthRecords().find(({ pluginId }) => pluginId === "ordinary-consumer"))
      .toEqual(expect.objectContaining({ state: "active" }));
    await runtime.stop();
  });

  it("propagates failed and missing exact-version dependencies without blocking independent plugins", async () => {
    const serviceV1 = testCapability("provider", "service", 1);
    const serviceV2 = testCapability("provider", "service", 2);
    const events: string[] = [];
    const lifetimes = new Map<string, AbortSignal>();
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("versioned"),
        entry("provider"),
        entry("independent"),
        entry("consumer"),
      ])) },
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        const activate = (context: ServerPluginActivationContext): ServerPluginActivation => {
          events.push(`activate:${pluginId}`);
          lifetimes.set(pluginId, context.lifetimeSignal);
          if (pluginId === "provider") {
            return {
              provides: [{ capability: serviceV1, value: { label: "provider" } }],
              start: () => { events.push("start:provider"); throw new Error("provider exploded"); },
              dispose: () => { events.push(`dispose:provider:${String(context.lifetimeSignal.aborted)}`); },
            };
          }
          if (pluginId === "independent") {
            return {
              start: () => { events.push("start:independent"); },
              dispose: () => { events.push("dispose:independent"); },
            };
          }
          return {
            start: () => { events.push(`unexpected-start:${pluginId}`); },
            dispose: () => { events.push(`dispose:${pluginId}:${String(context.lifetimeSignal.aborted)}`); },
          };
        };
        const requires = pluginId === "consumer" ? [serviceV1] : pluginId === "versioned" ? [serviceV2] : undefined;
        return Promise.resolve({ default: plugin(pluginId, activate, requires) });
      },
      logger: testLogger(),
    });

    expect(events).not.toContain("unexpected-start:consumer");
    expect(events).not.toContain("unexpected-start:versioned");
    expect(events).toEqual(expect.arrayContaining([
      "start:independent",
      "start:provider",
      "dispose:provider:true",
      "dispose:consumer:true",
      "dispose:versioned:true",
    ]));
    const records = runtime.healthRecords();
    expect(records.map(({ pluginId, state, phase }) => [pluginId, state, phase])).toEqual([
      ["consumer", "failed", "start"],
      ["independent", "active", undefined],
      ["provider", "failed", "start"],
      ["versioned", "failed", "start"],
    ]);
    expect(records.find(({ pluginId }) => pluginId === "consumer")?.message)
      .toContain("provider plugin provider did not start");
    expect(records.find(({ pluginId }) => pluginId === "provider")?.message).toBe("provider exploded");
    expect(records.find(({ pluginId }) => pluginId === "versioned")?.message).toContain("provider/service v2");
    expect(() => runtime.resolve(serviceV1)).toThrow("is not active");
    expect([...lifetimes.entries()].filter(([id]) => id !== "independent").every(([, signal]) => signal.aborted)).toBe(true);
    expect(lifetimes.get("independent")?.aborted).toBe(false);

    await runtime.stop();
    expect(events.at(-1)).toBe("dispose:independent");
  });

  it("attributes capability cycles to their members and then fails downstream dependents", async () => {
    const alphaService = testCapability("alpha", "service", 1);
    const betaService = testCapability("beta", "service", 1);
    const starts: string[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("downstream"),
        entry("beta"),
        entry("independent"),
        entry("alpha"),
      ])) },
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        if (pluginId === "alpha") {
          return Promise.resolve({ default: plugin("Alpha", () => ({
            provides: [{ capability: alphaService, value: { label: "alpha" } }],
            start: () => { starts.push("alpha"); },
          }), [betaService]) });
        }
        if (pluginId === "beta") {
          return Promise.resolve({ default: plugin("Beta", () => ({
            provides: [{ capability: betaService, value: { label: "beta" } }],
            start: () => { starts.push("beta"); },
          }), [alphaService]) });
        }
        if (pluginId === "downstream") {
          return Promise.resolve({ default: plugin("Downstream", () => ({
            start: () => { starts.push("downstream"); },
          }), [alphaService]) });
        }
        return Promise.resolve(pluginModule("Independent", { start: () => { starts.push("independent"); } }));
      },
      logger: testLogger(),
    });

    expect(starts).toEqual(["independent"]);
    const records = runtime.healthRecords();
    expect(records.find(({ pluginId }) => pluginId === "alpha")).toMatchObject({ state: "failed", phase: "start" });
    expect(records.find(({ pluginId }) => pluginId === "alpha")?.message).toContain("capability dependency cycle");
    expect(records.find(({ pluginId }) => pluginId === "beta")).toMatchObject({ state: "failed", phase: "start" });
    expect(records.find(({ pluginId }) => pluginId === "beta")?.message).toContain("capability dependency cycle");
    expect(records.find(({ pluginId }) => pluginId === "downstream")).toMatchObject({ state: "failed", phase: "start" });
    expect(records.find(({ pluginId }) => pluginId === "downstream")?.message).toContain("provider plugin alpha did not start");
    expect(records.find(({ pluginId }) => pluginId === "independent")).toEqual(expect.objectContaining({ state: "active" }));
    await runtime.stop();
  });

  it("rejects malformed contracts plus foreign and duplicate provisions during validation", async () => {
    const foreign = testCapability("foreign", "service", 1);
    const duplicate = testCapability("duplicate", "service", 1);
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("foreign"), entry("duplicate"), entry("bad-version")])) },
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        if (pluginId === "bad-version") {
          return Promise.resolve({
            default: {
              apiVersion: 3,
              name: "Bad version",
              requires: [{ pluginId: "provider", id: "service", version: 0, parse: (value: unknown) => value }],
              activate: () => ({}),
            },
          });
        }
        const activation = pluginId === "foreign"
          ? { provides: [{ capability: testCapability("other", "service", 1), value: { label: "wrong owner" } }] }
          : { provides: [
              { capability: duplicate, value: { label: "first" } },
              { capability: duplicate, value: { label: "second" } },
            ] };
        return Promise.resolve(pluginModule(pluginId, activation));
      },
      logger: testLogger(),
    });

    const records = runtime.healthRecords();
    expect(records.map(({ pluginId, state, phase }) => [pluginId, state, phase])).toEqual([
      ["bad-version", "incompatible", "validate"],
      ["duplicate", "incompatible", "validate"],
      ["foreign", "incompatible", "validate"],
    ]);
    expect(records[0]?.message).toContain("version must be a positive integer");
    expect(records[1]?.message).toContain("more than once");
    expect(records[2]?.message).toContain("cannot provide capability owned by other");
    expect(() => runtime.resolve(foreign)).toThrow("is not active");
  });

  it("freezes activation inputs, scopes invocation signals, and cancels lifetime before disposal", async () => {
    let activationContext: ServerPluginActivationContext | undefined;
    const lifecycleSignals: AbortSignal[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("scoped")])) },
      importer: () => Promise.resolve({
        default: plugin("Scoped", (context) => {
          activationContext = context;
          lifecycleSignals.push(context.signal);
          return {
            start: ({ signal }) => { lifecycleSignals.push(signal); },
            health: (signal) => {
              lifecycleSignals.push(signal);
              return { status: "healthy" };
            },
            dispose: (signal) => { lifecycleSignals.push(signal); },
          };
        }),
      }),
      logger: testLogger(),
    });

    if (activationContext === undefined) throw new Error("Expected server plugin activation context");
    expect(Object.isFrozen(activationContext)).toBe(true);
    expect(Object.isFrozen(activationContext.logger)).toBe(true);
    expect(Object.isFrozen(activationContext.settings)).toBe(true);
    expect(activationContext.notices).toBeUndefined();
    expect(lifecycleSignals).toHaveLength(2);
    expect(lifecycleSignals.every((signal) => signal.aborted)).toBe(true);
    expect(activationContext.lifetimeSignal.aborted).toBe(false);

    runtime.beginShutdown();
    expect(activationContext.lifetimeSignal.aborted).toBe(true);
    await runtime.inspectHealth();
    await runtime.stop();

    expect(lifecycleSignals).toHaveLength(4);
    expect(new Set(lifecycleSignals).size).toBe(4);
    expect(lifecycleSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("provides frozen notice reporters with host-namespaced attribution", async () => {
    const reporters = new Map<string, ServerPluginNoticeReporterV1 | undefined>();
    const records: { source: string; input: ServerPluginNoticeInput }[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("pi-web.terminal"), entry("workspace.delete")])) },
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        return Promise.resolve({
          default: plugin(pluginId, (context) => {
            reporters.set(pluginId, context.notices);
            return {};
          }),
        });
      },
      logger: testLogger(),
      noticeSink: (source, input) => { records.push({ source, input }); },
    });

    const terminalReporter = reporters.get("pi-web.terminal");
    const workspaceDeleteReporter = reporters.get("workspace.delete");
    if (terminalReporter === undefined || workspaceDeleteReporter === undefined) {
      throw new Error("Expected notice reporters");
    }
    expect(terminalReporter.version).toBe(1);
    expect(Object.isFrozen(terminalReporter)).toBe(true);
    terminalReporter.record({ severity: "warning", message: "Terminal warning" });
    workspaceDeleteReporter.record({ severity: "error", message: "Plugin warning" });

    expect(records).toEqual([
      {
        source: "plugin:pi-web.terminal",
        input: { severity: "warning", message: "Terminal warning" },
      },
      {
        source: "plugin:workspace.delete",
        input: { severity: "error", message: "Plugin warning" },
      },
    ]);
    expect(() => {
      Reflect.apply(workspaceDeleteReporter.record, workspaceDeleteReporter, [{
        severity: "error",
        message: "Spoof",
        source: "workspace.delete",
      }]);
    }).toThrow("cannot set their source");
    expect(records).toHaveLength(2);

    await runtime.stop();
  });

  it("revokes a successful reporter before ordinary disposal", async () => {
    let reporter: ServerPluginNoticeReporterV1 | undefined;
    let stopError: unknown;
    const records: ServerPluginNoticeInput[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("alpha")])) },
      importer: () => Promise.resolve({
        default: plugin("Alpha", (context) => {
          reporter = context.notices;
          reporter?.record({ severity: "info", message: "activation" });
          return {
            start: () => { reporter?.record({ severity: "info", message: "start" }); },
            dispose: () => {
              try {
                reporter?.record({ severity: "info", message: "stop" });
              } catch (error) {
                stopError = error;
              }
            },
          };
        }),
      }),
      logger: testLogger(),
      noticeSink: (_source, input) => { records.push(input); },
    });

    const noticeReporter = reporter;
    if (noticeReporter === undefined) throw new Error("Expected notice reporter");
    noticeReporter.record({ severity: "warning", message: "active" });
    await runtime.stop();

    expect(stopError).toMatchObject({ message: "Server plugin notice reporter for alpha is no longer active" });
    expect(() => { noticeReporter.record({ severity: "error", message: "too late" }); })
      .toThrow("no longer active");
    expect(records.map(({ message }) => message)).toEqual(["activation", "start", "active"]);
  });

  it("revokes a failed reporter before startup rollback", async () => {
    let reporter: ServerPluginNoticeReporterV1 | undefined;
    let rollbackError: unknown;
    const noticeSink = vi.fn();
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("failed")])) },
      importer: () => Promise.resolve({
        default: plugin("Failed", (context) => {
          reporter = context.notices;
          return {
            start: () => { throw new Error("start failed"); },
            dispose: () => {
              try {
                reporter?.record({ severity: "error", message: "rollback" });
              } catch (error) {
                rollbackError = error;
              }
            },
          };
        }),
      }),
      logger: testLogger(),
      noticeSink,
    });

    const noticeReporter = reporter;
    if (noticeReporter === undefined) throw new Error("Expected notice reporter");
    expect(runtime.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "failed", state: "failed", phase: "start", message: "start failed" }),
    ]);
    expect(rollbackError).toMatchObject({ message: "Server plugin notice reporter for failed is no longer active" });
    expect(() => { noticeReporter.record({ severity: "error", message: "too late" }); })
      .toThrow("no longer active");
    expect(noticeSink).not.toHaveBeenCalled();
  });

  it("validates and safely deep-clones notice scope and context", async () => {
    let reporter: ServerPluginNoticeReporterV1 | undefined;
    const records: { source: string; input: ServerPluginNoticeInput }[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("alpha")])) },
      importer: () => Promise.resolve({
        default: plugin("Alpha", (context) => {
          reporter = context.notices;
          return {};
        }),
      }),
      logger: testLogger(),
      noticeSink: (source, input) => { records.push({ source, input }); },
    });

    const noticeReporter = reporter;
    if (noticeReporter === undefined) throw new Error("Expected notice reporter");
    const scope = { projectId: "project-1", workspaceId: "workspace-1" };
    const context = { nested: { labels: ["original"] } };
    noticeReporter.record({ severity: "warning", message: "Plugin warning", scope, context });
    scope.projectId = "mutated";
    context.nested.labels[0] = "mutated";

    const protoContext = { label: "safe" };
    Object.defineProperty(protoContext, "__proto__", {
      value: { preserved: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    noticeReporter.record({ severity: "info", message: "Prototype key", context: protoContext });

    expect(records.map(({ source }) => source)).toEqual(["plugin:alpha", "plugin:alpha"]);
    const recorded = records[0]?.input;
    expect(recorded).toEqual({
      severity: "warning",
      message: "Plugin warning",
      scope: { projectId: "project-1", workspaceId: "workspace-1" },
      context: { nested: { labels: ["original"] } },
    });
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded?.scope)).toBe(true);
    expect(Object.isFrozen(recorded?.context)).toBe(true);
    const nested = requireRecord(recorded?.context?.["nested"], "Expected recorded nested notice context");
    const labels = nested["labels"];
    if (!Array.isArray(labels)) throw new Error("Expected recorded notice labels");
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(labels)).toBe(true);

    const preservedContext = requireRecord(records[1]?.input.context, "Expected prototype-key context");
    expect(Object.hasOwn(preservedContext, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(preservedContext)).toBe(Object.prototype);
    expect(requireRecord(preservedContext["__proto__"], "Expected preserved __proto__ value"))
      .toEqual({ preserved: true });
    expect(preservedContext["label"]).toBe("safe");
    expect(Object.isFrozen(preservedContext)).toBe(true);

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const recordContext = (invalidContext: unknown): void => {
      Reflect.apply(noticeReporter.record, noticeReporter, [{
        severity: "error",
        message: "Invalid JSON",
        context: invalidContext,
      }]);
    };
    expect(() => { recordContext(new Date()); }).toThrow("must be a JSON object");
    expect(() => { recordContext({ createdAt: new Date() }); }).toThrow("must contain only JSON values");
    expect(() => { recordContext({ count: Number.NaN }); }).toThrow("finite JSON numbers");
    expect(() => { recordContext(circular); }).toThrow("must not contain cycles");
    expect(records).toHaveLength(2);

    await runtime.stop();
  });

  it("accepts notice values exactly at the documented size and depth limits", async () => {
    let reporter: ServerPluginNoticeReporterV1 | undefined;
    const records: ServerPluginNoticeInput[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("alpha")])) },
      importer: () => Promise.resolve({
        default: plugin("Alpha", (context) => {
          reporter = context.notices;
          return {};
        }),
      }),
      logger: testLogger(),
      noticeSink: (_source, input) => { records.push(input); },
    });

    const noticeReporter = reporter;
    if (noticeReporter === undefined) throw new Error("Expected notice reporter");
    const serializedEmptyContextBytes = JSON.stringify({ value: "" }).length;
    noticeReporter.record({
      severity: "info",
      message: "🙂".repeat(SERVER_PLUGIN_NOTICE_MESSAGE_MAX_BYTES / 4),
      scope: { sessionId: "s".repeat(SERVER_NOTICE_SCOPE_ID_MAX_LENGTH) },
      context: { value: "x".repeat(SERVER_PLUGIN_NOTICE_CONTEXT_MAX_BYTES - serializedEmptyContextBytes) },
    });
    const escapedUnit = "\u0000";
    const escapedUnitBytes = JSON.stringify(escapedUnit).length - 2;
    const escapedCapacity = SERVER_PLUGIN_NOTICE_CONTEXT_MAX_BYTES - serializedEmptyContextBytes;
    const escapedValue = escapedUnit.repeat(Math.floor(escapedCapacity / escapedUnitBytes))
      + "x".repeat(escapedCapacity % escapedUnitBytes);
    expect(new TextEncoder().encode(JSON.stringify({ value: escapedValue })).byteLength)
      .toBe(SERVER_PLUGIN_NOTICE_CONTEXT_MAX_BYTES);
    noticeReporter.record({
      severity: "info",
      message: "Escaped context boundary",
      context: { value: escapedValue },
    });
    const maximumDepth: Record<string, unknown> = {};
    let cursor = maximumDepth;
    for (let depth = 0; depth < SERVER_PLUGIN_NOTICE_CONTEXT_MAX_DEPTH; depth += 1) {
      const nested: Record<string, unknown> = {};
      cursor["nested"] = nested;
      cursor = nested;
    }
    Reflect.apply(noticeReporter.record, noticeReporter, [{
      severity: "warning",
      message: "Maximum depth",
      context: maximumDepth,
    }]);

    expect(records).toHaveLength(3);
    await runtime.stop();
  });

  it("clones dense notice arrays without invoking plugin-owned array methods", async () => {
    let reporter: ServerPluginNoticeReporterV1 | undefined;
    const records: { source: string; input: ServerPluginNoticeInput }[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("alpha")])) },
      importer: () => Promise.resolve({
        default: plugin("Alpha", (context) => {
          reporter = context.notices;
          return {};
        }),
      }),
      logger: testLogger(),
      noticeSink: (source, input) => { records.push({ source, input }); },
    });

    const noticeReporter = reporter;
    if (noticeReporter === undefined) throw new Error("Expected notice reporter");
    const ownSourceItem = { label: "own" };
    const subclassSourceItem = { label: "subclass" };
    const hiddenCycle: Record<string, unknown> = {};
    hiddenCycle["self"] = hiddenCycle;
    const ownMap = vi.fn(() => [1n, () => undefined, hiddenCycle, ownSourceItem]);
    const ownMapArray: unknown[] = [ownSourceItem];
    Object.defineProperty(ownMapArray, "map", {
      value: ownMap,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    class PluginArray extends Array<unknown> {}
    const inheritedMap = vi.fn(() => [subclassSourceItem]);
    Object.defineProperty(PluginArray.prototype, "map", {
      value: inheritedMap,
      configurable: true,
      writable: true,
    });
    const subclassedArray = new PluginArray(subclassSourceItem);

    Reflect.apply(noticeReporter.record, noticeReporter, [{
      severity: "info",
      message: "Dense arrays",
      context: { own: ownMapArray, inherited: subclassedArray },
    }]);
    ownSourceItem.label = "mutated";
    subclassSourceItem.label = "mutated";

    expect(ownMap).not.toHaveBeenCalled();
    expect(inheritedMap).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    const recordedContext = requireRecord(records[0]?.input.context, "Expected recorded array context");
    expect(recordedContext).toEqual({
      own: [{ label: "own" }],
      inherited: [{ label: "subclass" }],
    });
    for (const key of ["own", "inherited"]) {
      const array = recordedContext[key];
      if (!Array.isArray(array)) throw new Error(`Expected recorded ${key} array`);
      expect(Object.getPrototypeOf(array)).toBe(Array.prototype);
      expect(Object.isFrozen(array)).toBe(true);
      expect(Object.isFrozen(requireRecord(array[0], `Expected recorded ${key} item`))).toBe(true);
    }

    await runtime.stop();
  });

  it("rejects malformed or oversized notice records before mutating or publishing state", async () => {
    let reporter: ServerPluginNoticeReporterV1 | undefined;
    const publishGlobal = vi.fn();
    const store = new ServerNoticeStore({ daemonInstanceId: "daemon-a", createNoticeId: () => "notice-1" });
    const notices = new ServerNoticeService(store, { publishGlobal });
    const noticeSink = vi.fn((source: string, input: ServerPluginNoticeInput) => {
      notices.record({ ...input, source });
    });
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("alpha")])) },
      importer: () => Promise.resolve({
        default: plugin("Alpha", (context) => {
          reporter = context.notices;
          return {};
        }),
      }),
      logger: testLogger(),
      noticeSink,
    });

    const noticeReporter = reporter;
    if (noticeReporter === undefined) throw new Error("Expected notice reporter");
    noticeReporter.record({ severity: "info", message: "Existing notice", scope: { projectId: "project-1" } });
    const baseline = notices.snapshot();
    const bigintArray: unknown[] = [1n];
    const sanitizingMap = vi.fn(() => ["sanitized"]);
    Object.defineProperty(bigintArray, "map", { value: sanitizingMap, configurable: true, writable: true });
    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    const sparseArray: unknown[] = [];
    sparseArray.length = 2;
    sparseArray[1] = "present";
    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let depth = 0; depth <= SERVER_PLUGIN_NOTICE_CONTEXT_MAX_DEPTH; depth += 1) {
      const nested: Record<string, unknown> = {};
      cursor["nested"] = nested;
      cursor = nested;
    }
    const broadPropertyCount = 20_000;
    let broadContextReads = 0;
    const broadContext: Record<string, unknown> = {};
    for (let index = 0; index < broadPropertyCount; index += 1) {
      Object.defineProperty(broadContext, `field-${String(index).padStart(5, "0")}`, {
        enumerable: true,
        get() {
          broadContextReads += 1;
          if (index === broadPropertyCount - 1) throw new Error("notice validation read beyond its byte budget");
          return "x";
        },
      });
    }
    const invalidCases: { input: unknown; message: string }[] = [
      { input: { severity: "error", message: "Invalid array", context: { values: bigintArray } }, message: "must contain only JSON values" },
      { input: { severity: "error", message: "Invalid array", context: { values: [() => undefined] } }, message: "must contain only JSON values" },
      { input: { severity: "error", message: "Invalid array", context: { values: circularArray } }, message: "must not contain cycles" },
      { input: { severity: "error", message: "Invalid array", context: { values: sparseArray } }, message: "must not contain sparse arrays" },
      { input: { severity: "error", message: "🙂".repeat((SERVER_PLUGIN_NOTICE_MESSAGE_MAX_BYTES / 4) + 1) }, message: "message exceeds the 4096 byte limit" },
      { input: { severity: "error", message: "Broad oversized context", context: broadContext }, message: "context exceeds the 16384 byte limit" },
      { input: { severity: "error", message: "Oversized context", context: { value: "x".repeat(SERVER_PLUGIN_NOTICE_CONTEXT_MAX_BYTES) } }, message: "context exceeds the 16384 byte limit" },
      { input: { severity: "error", message: "Deep context", context: tooDeep }, message: "maximum JSON depth of 32" },
      { input: { severity: "error", message: "Empty scope", scope: {} }, message: "must contain at least one" },
      { input: { severity: "error", message: "Unknown scope", scope: { projectId: "project-1", tenantId: "tenant-1" } }, message: "Unsupported Server plugin notice scope field" },
      { input: { severity: "error", message: "Blank scope", scope: { workspaceId: " " } }, message: "workspaceId must be a non-empty string" },
      { input: { severity: "error", message: "Long scope", scope: { sessionId: "x".repeat(SERVER_NOTICE_SCOPE_ID_MAX_LENGTH + 1) } }, message: "at most 512 characters" },
    ];

    for (const invalid of invalidCases) {
      expect(() => { Reflect.apply(noticeReporter.record, noticeReporter, [invalid.input]); })
        .toThrow(invalid.message);
    }

    expect(sanitizingMap).not.toHaveBeenCalled();
    expect(broadContextReads).toBeGreaterThan(0);
    expect(broadContextReads).toBeLessThan(broadPropertyCount);
    expect(noticeSink).toHaveBeenCalledOnce();
    expect(publishGlobal).toHaveBeenCalledOnce();
    expect(notices.snapshot()).toEqual(baseline);

    await runtime.stop();
  });

  it("applies disabled and both safe-start states before importing any skipped module", async () => {
    const imported: string[] = [];
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      imported.push(pluginId);
      if (pluginId !== "bundled") throw new Error(`Skipped plugin imported: ${pluginId}`);
      return Promise.resolve(pluginModule("Bundled", {}));
    };
    const snapshot = testSnapshot([
      entry("local", { scope: "local" }),
      entry("bundled", { scope: "bundled" }),
      entry("configured-off", { scope: "bundled", enabled: false }),
    ]);

    const createBundledLateHostCapability = vi.fn(() => ({
      value: {
        version: 1 as const,
        resolve: () => Promise.reject(new Error("bundled safe start must not resolve workspaces")),
      },
    }));
    const createBundledPiSessionsCapability = vi.fn(() => ({
      value: {
        version: 1 as const,
        run: () => Promise.reject(new Error("bundled safe start must not run sessions")),
      },
    }));
    const bundledOnly = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(snapshot) },
      safeStart: "bundled-only",
      importer,
      logger: testLogger(),
      lateHostCapabilities: [PI_WEB_HOST_WORKSPACES_CAPABILITY, PI_WEB_HOST_PI_SESSIONS_CAPABILITY],
    });
    await bundledOnly.resumeWithHostCapabilityFactories([{
      capability: PI_WEB_HOST_WORKSPACES_CAPABILITY,
      create: createBundledLateHostCapability,
    }, {
      capability: PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
      create: createBundledPiSessionsCapability,
    }]);

    expect(imported).toEqual(["bundled"]);
    expect(bundledOnly.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "bundled", state: "active" }),
      expect.objectContaining({ pluginId: "configured-off", state: "disabled", message: "disabled in PI WEB config" }),
      expect.objectContaining({ pluginId: "local", state: "disabled", message: "disabled by bundled-only safe start" }),
    ]);
    expect(createBundledLateHostCapability).not.toHaveBeenCalled();
    expect(createBundledPiSessionsCapability).not.toHaveBeenCalled();
    await bundledOnly.stop();

    imported.splice(0);
    const noneCatalog = { snapshot: vi.fn(() => Promise.resolve(snapshot)) };
    const createHostCapability = vi.fn(() => ({
      value: { version: 1 as const, read: () => Promise.resolve(undefined), write: () => Promise.resolve(), clear: () => Promise.resolve() },
    }));
    const createLateHostCapability = vi.fn(() => ({
      value: {
        version: 1 as const,
        resolve: () => Promise.reject(new Error("safe start must not resolve workspaces")),
      },
    }));
    const createPiSessionsCapability = vi.fn(() => ({
      value: {
        version: 1 as const,
        run: () => Promise.reject(new Error("safe start must not run sessions")),
      },
    }));
    const none = await createServerPluginRuntime({
      catalog: noneCatalog,
      safeStart: "none",
      importer,
      logger: testLogger(),
      hostCapabilityFactories: [{ capability: testScopedService, create: createHostCapability }],
      lateHostCapabilities: [PI_WEB_HOST_WORKSPACES_CAPABILITY, PI_WEB_HOST_PI_SESSIONS_CAPABILITY],
    });
    await none.resumeWithHostCapabilityFactories([{
      capability: PI_WEB_HOST_WORKSPACES_CAPABILITY,
      create: createLateHostCapability,
    }, {
      capability: PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
      create: createPiSessionsCapability,
    }]);

    expect(imported).toEqual([]);
    expect(noneCatalog.snapshot).not.toHaveBeenCalled();
    expect(createHostCapability).not.toHaveBeenCalled();
    expect(createLateHostCapability).not.toHaveBeenCalled();
    expect(createPiSessionsCapability).not.toHaveBeenCalled();
    expect(none.healthRecords()).toEqual([]);
  });

  it("aborts an uncooperative lifecycle phase at its deadline and continues activation", async () => {
    vi.useFakeTimers();
    const observedSignals: AbortSignal[] = [];
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      if (pluginId === "hang") {
        return Promise.resolve(pluginModule("Hang", {
          start: ({ signal }) => new Promise((_resolve, reject) => {
            observedSignals.push(signal);
            markStarted?.();
            signal.addEventListener("abort", () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error("fixture aborted", { cause: reason }));
            }, { once: true });
          }),
        }));
      }
      return Promise.resolve(pluginModule("Later", {}));
    };

    const creating = createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("hang"), entry("later")])) },
      importer,
      logger: testLogger(),
      lifecycleTimeoutMs: 50,
    });
    await started;
    await vi.advanceTimersByTimeAsync(50);
    const runtime = await creating;

    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(true);
    const records = runtime.healthRecords();
    expect(records.map((record) => [record.pluginId, record.state, record.phase])).toEqual([
      ["hang", "failed", "start"],
      ["later", "active", undefined],
    ]);
    expect(records[0]?.message).toContain("timed out");
    await runtime.stop();
  });

  it("contains health and disposal callback failures without hiding other plugins", async () => {
    const stops: string[] = [];
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      if (pluginId === "bad-health") {
        return Promise.resolve(pluginModule("Bad health", {
          health: () => { throw new Error("health exploded"); },
          dispose: () => {
            stops.push("bad-health");
            throw new Error("stop exploded");
          },
        }));
      }
      if (pluginId === "bad-health-details") {
        return Promise.resolve(pluginModule("Bad health details", {
          health: () => ({ status: "healthy", details: { checkedAt: new Date() } }),
          dispose: () => { stops.push("bad-health-details"); },
        }));
      }
      return Promise.resolve(pluginModule("Degraded", {
        health: () => ({ status: "degraded", message: "tool unavailable", details: { retry: true } }),
        dispose: () => { stops.push("degraded"); },
      }));
    };
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("bad-health"), entry("bad-health-details"), entry("degraded")])) },
      importer,
      logger: testLogger(),
    });

    expect(await runtime.inspectHealth()).toEqual([
      {
        pluginId: "bad-health",
        health: { status: "unhealthy", message: "health exploded" },
        phase: "health",
        error: "health exploded",
      },
      {
        pluginId: "bad-health-details",
        health: { status: "unhealthy", message: "server plugin health details must contain only JSON values" },
        phase: "health",
        error: "server plugin health details must contain only JSON values",
      },
      {
        pluginId: "degraded",
        health: { status: "degraded", message: "tool unavailable", details: { retry: true } },
      },
    ]);
    await expect(runtime.inspectHealth(["degraded"])).resolves.toEqual([{
      pluginId: "degraded",
      health: { status: "degraded", message: "tool unavailable", details: { retry: true } },
    }]);

    await runtime.stop();

    expect(stops).toEqual(["degraded", "bad-health-details", "bad-health"]);
    expect(runtime.healthRecords()).toContainEqual(expect.objectContaining({
      pluginId: "bad-health",
      state: "failed",
      phase: "dispose",
      message: "stop exploded",
    }));
  });

  it("bounds health inspection and reports a timed-out provider as unhealthy", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("health-timeout")])) },
      importer: () => Promise.resolve(pluginModule("Health timeout", {
        workspaceProvider: testProvider(),
        health: (signal) => new Promise((_resolve, rejectPromise) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => {
            const reason: unknown = signal.reason;
            rejectPromise(reason instanceof Error ? reason : new Error("Fixture health inspection aborted", { cause: reason }));
          }, { once: true });
        }),
      })),
      logger: testLogger(),
      lifecycleTimeoutMs: 50,
    });

    const inspecting = runtime.inspectHealth();
    await vi.advanceTimersByTimeAsync(50);
    const [inspection] = await inspecting;

    expect(observedSignal?.aborted).toBe(true);
    expect(inspection).toMatchObject({
      pluginId: "health-timeout",
      health: { status: "unhealthy" },
      phase: "health",
    });
    expect(inspection?.health.message).toContain("timed out");
    expect(inspection?.error).toContain("timed out");
  });

  it("publishes paired request and channel capabilities independently", async () => {
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("channel-only"),
        entry("empty"),
        entry("request-only"),
      ])) },
      importer: (url) => {
        const pluginId = pluginIdFromUrl(url);
        const peer = pluginId === "request-only"
          ? { request: () => null }
          : pluginId === "channel-only"
            ? { openChannel: () => ({ receive: () => undefined }) }
            : {};
        return Promise.resolve(pluginModule(pluginId, { peer }));
      },
      logger: testLogger(),
    });

    expect(runtime.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "channel-only", state: "active", pairedChannelVersion: 1 }),
      expect.objectContaining({ pluginId: "empty", state: "incompatible" }),
      expect.objectContaining({ pluginId: "request-only", state: "active", pairedRequestVersion: 1 }),
    ]);
    expect(runtime.healthRecords()[0]).not.toHaveProperty("pairedRequestVersion");
    expect(runtime.healthRecords()[2]).not.toHaveProperty("pairedChannelVersion");
    expect(runtime.pairedBackendContributions().map(({ pluginId }) => pluginId)).toEqual(["channel-only", "request-only"]);
  });

  it("publishes validated snapshots rather than mutable activation properties", async () => {
    const provider = testProvider();
    const mutableActivation: Record<string, unknown> = {
      workspaceProvider: provider,
      peer: {
        request: () => ({ captured: true }),
        openChannel: () => ({ receive: () => undefined }),
      },
    };
    mutableActivation["start"] = () => {
      mutableActivation["workspaceProvider"] = {};
      mutableActivation["peer"] = {};
    };
    const throwingActivation: Record<string, unknown> = {};
    Object.defineProperty(throwingActivation, "stop", {
      enumerable: true,
      get() { throw new Error("stop getter exploded"); },
    });
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      if (pluginId === "mutable") return Promise.resolve(pluginModule("Mutable", mutableActivation));
      if (pluginId === "throwing-accessor") return Promise.resolve(pluginModule("Throwing accessor", throwingActivation));
      return Promise.resolve(pluginModule("Later", {}));
    };

    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("mutable"),
        entry("throwing-accessor"),
        entry("later"),
      ])) },
      importer,
      logger: testLogger(),
    });

    expect(runtime.providerContributions().map((contribution) => contribution.pluginId)).toEqual(["mutable"]);
    expect(runtime.pairedBackendContributions().map((contribution) => contribution.pluginId)).toEqual(["mutable"]);
    expect(Object.isFrozen(runtime.pairedBackendContributions()[0]?.backend)).toBe(true);
    expect(runtime.healthRecords().find(({ pluginId }) => pluginId === "mutable")).toMatchObject({ pairedRequestVersion: 1, pairedChannelVersion: 1 });
    await expect(Promise.resolve(runtime.pairedBackendContributions()[0]?.backend.request?.({
      project: { id: "p", name: "P", path: "/p" },
      workspace: { id: "w", projectId: "p", path: "/p", label: "P", isMain: true },
      operation: "status",
      input: null,
      signal: new AbortController().signal,
    }))).resolves.toEqual({ captured: true });
    const channel = await runtime.pairedBackendContributions()[0]?.backend.openChannel?.({
      project: { id: "p", name: "P", path: "/p" },
      workspace: { id: "w", projectId: "p", path: "/p", label: "P", isMain: true },
      operation: "attach",
      input: null,
      signal: new AbortController().signal,
      send: () => undefined,
    });
    expect(channel).toBeDefined();
    expect(Object.isFrozen(channel)).toBe(true);
    await expect(runtime.providerContributions()[0]?.provider.probe(
      { id: "p", name: "P", path: "/p" },
      new AbortController().signal,
    )).resolves.toBe("pass");
    expect(runtime.healthRecords().map((record) => [record.pluginId, record.state, record.message])).toEqual([
      ["later", "active", undefined],
      ["mutable", "active", undefined],
      ["throwing-accessor", "failed", "stop getter exploded"],
    ]);
  });

  it("rejects plural providers, malformed peers, and non-JSON settings before publication", async () => {
    const pluralActivation = { workspaceProviders: [testProvider()] };
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      const activation = pluginId === "plural"
        ? pluralActivation
        : pluginId === "invalid-backend" ? { peer: {} }
          : pluginId === "invalid-channel" ? { peer: { request: () => null, openChannel: true } }
            : {};
      return Promise.resolve(pluginModule("Plural", activation));
    };
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("plural"),
        entry("invalid-backend"),
        entry("invalid-channel"),
        entry("invalid-settings", { settings: circular }),
        entry("non-json-settings", { settings: { installedAt: new Date() } }),
      ])) },
      importer,
      logger: testLogger(),
    });

    expect(runtime.providerContributions()).toEqual([]);
    const records = runtime.healthRecords();
    expect(records.map((record) => [record.pluginId, record.state, record.phase])).toEqual([
      ["invalid-backend", "incompatible", "validate"],
      ["invalid-channel", "incompatible", "validate"],
      ["invalid-settings", "incompatible", "validate"],
      ["non-json-settings", "incompatible", "validate"],
      ["plural", "incompatible", "validate"],
    ]);
    expect(records[0]?.message).toContain("peer must include a request or channel handler");
    expect(records[1]?.message).toContain("peer must include a request or channel handler");
    expect(records[2]?.message).toContain("must not contain cycles");
    expect(records[3]?.message).toContain("must contain only JSON values");
    expect(records[4]?.message).toBe("Server plugins may contribute only one workspaceProvider");
  });

  it("requires the bundled Terminal shape in normal and bundled-only startup but bypasses discovery in no-plugin recovery", async () => {
    const catalog = { snapshot: vi.fn(() => Promise.resolve(testSnapshot([]))) };

    await expect(createServerPluginRuntimeWithRequiredTerminal({ catalog, logger: testLogger() }))
      .rejects.toThrow("Required bundled Terminal package is missing");
    await expect(createServerPluginRuntimeWithRequiredTerminal({ catalog, safeStart: "bundled-only", logger: testLogger() }))
      .rejects.toThrow("safe-start set none");

    const recovery = await createServerPluginRuntimeWithRequiredTerminal({
      catalog: { snapshot: vi.fn(() => Promise.reject(new Error("recovery must not discover plugins"))) },
      safeStart: "none",
      logger: testLogger(),
    });
    expect(recovery.healthRecords()).toEqual([]);
    expect(() => recovery.resolve(REQUIRED_TERMINAL_SERVICE_CAPABILITY))
      .toThrow("is not active");
    await recovery.stop();
  });

  it("activates required Terminal before ordinary plugins and stops it after dependents", async () => {
    const events: string[] = [];
    const imported: string[] = [];
    const requiredService = requiredTerminalServiceFixture();
    const runtime = await createServerPluginRuntimeWithRequiredTerminal({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("zeta", { scope: "bundled" }),
        entry("pi-web.terminal", { scope: "bundled", browserRevision: "terminal-browser" }),
      ])) },
      importer: (url) => {
        const id = pluginIdFromUrl(url);
        imported.push(id);
        if (id === "pi-web.terminal") {
          return Promise.resolve(pluginModule("Terminal", {
            peer: {
              request: () => null,
              openChannel: () => ({ receive: () => undefined }),
            },
            provides: [{ capability: REQUIRED_TERMINAL_SERVICE_CAPABILITY, value: requiredService }],
            health: () => ({ status: "healthy" }),
            dispose: () => { events.push("stop:terminal"); },
          }));
        }
        return Promise.resolve(pluginModule("Zeta", {
          dispose: () => { events.push("stop:zeta"); },
        }));
      },
      logger: testLogger(),
    });

    expect(imported).toEqual(["pi-web.terminal", "zeta"]);
    expect(runtime.healthRecords().map(({ pluginId, state }) => [pluginId, state])).toEqual([
      ["pi-web.terminal", "active"],
      ["zeta", "active"],
    ]);
    expect(runtime.resolve(REQUIRED_TERMINAL_SERVICE_CAPABILITY)).not.toBe(requiredService);
    expect(typeof runtime.resolve(REQUIRED_TERMINAL_SERVICE_CAPABILITY).runCommand).toBe("function");

    await runtime.stop();
    expect(events).toEqual(["stop:zeta", "stop:terminal"]);
  });

  it("rolls back a required Terminal activation that fails contribution validation", async () => {
    const stopped = vi.fn();
    await expect(createServerPluginRuntimeWithRequiredTerminal({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("pi-web.terminal", { scope: "bundled", browserRevision: "terminal-browser" }),
      ])) },
      importer: () => Promise.resolve(pluginModule("Terminal", {
        peer: {
          request: () => null,
          openChannel: () => ({ receive: () => undefined }),
        },
        provides: [{ capability: REQUIRED_TERMINAL_SERVICE_CAPABILITY, value: {} }],
        dispose: stopped,
      })),
      logger: testLogger(),
    })).rejects.toThrow("did not provide its composition service");
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("rolls back two-stage startup when required Terminal is unhealthy before publication", async () => {
    const imported: string[] = [];
    const stopped = vi.fn();
    await expect(createServerPluginRuntimeWithRequiredTerminal({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("alpha", { scope: "bundled" }),
        entry("pi-web.terminal", { scope: "bundled", browserRevision: "terminal-browser" }),
      ])) },
      importer: (url) => {
        const id = pluginIdFromUrl(url);
        imported.push(id);
        if (id !== "pi-web.terminal") return Promise.resolve(pluginModule("Alpha", { dispose: stopped }));
        return Promise.resolve(pluginModule("Terminal", {
          peer: {
            request: () => null,
            openChannel: () => ({ receive: () => undefined }),
          },
          provides: [{ capability: REQUIRED_TERMINAL_SERVICE_CAPABILITY, value: requiredTerminalServiceFixture() }],
          health: () => ({ status: "unhealthy", message: "PTY unavailable" }),
          dispose: stopped,
        }));
      },
      logger: testLogger(),
    })).rejects.toThrow("Required Terminal server entry is unhealthy: PTY unavailable");
    expect(imported).toEqual(["pi-web.terminal", "alpha"]);
    expect(stopped).toHaveBeenCalledTimes(2);
  });
});

interface TestCapabilityValue {
  readonly label: string;
}

function testCapability(pluginId: string, id: string, version: number): PluginCapability<TestCapabilityValue> {
  return Object.freeze({
    pluginId,
    id,
    version,
    parse(value: unknown): TestCapabilityValue {
      if (!isRecord(value) || typeof value["label"] !== "string") throw new Error("test capability must include a label");
      return Object.freeze({ label: value["label"] });
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entry(
  id: string,
  options: { scope?: PiWebPluginScope; enabled?: boolean; settings?: Record<string, unknown>; browserRevision?: string } = {},
): PiWebPluginCatalogEntry {
  return {
    id,
    packageRoot: `/plugins/${id}`,
    ...(options.browserRevision === undefined ? {} : { browserModule: { path: "browser.js", filePath: `/plugins/${id}/browser.js`, revision: options.browserRevision } }),
    serverModule: { path: "server.js", filePath: `/plugins/${id}/server.js`, revision: "1" },
    source: options.scope === "bundled" ? "bundled" : "fixture",
    scope: options.scope ?? "local",
    machineSpecific: options.browserRevision !== undefined,
    enabled: options.enabled ?? true,
    settings: options.settings ?? {},
    settingsRevision: "settings-1",
  };
}

function testSnapshot(plugins: PiWebPluginCatalogEntry[]): PiWebPluginCatalogSnapshot {
  return { plugins, diagnostics: [] };
}

function pluginModule(name: string, activation: ServerPluginActivation | Record<string, unknown>): unknown {
  return { default: plugin(name, () => activation) };
}

function plugin(
  name: string,
  activate: PiWebServerPlugin["activate"],
  requires?: readonly PluginCapability[],
): PiWebServerPlugin {
  return { apiVersion: 3, name, ...(requires === undefined ? {} : { requires }), activate };
}

function requiredTerminalServiceFixture() {
  const run = {
    id: "run-1",
    origin: "core",
    projectId: "project-1",
    workspaceId: "workspace-1",
    terminalId: "terminal-1",
    title: "Run",
    command: "true",
    status: "running" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    metadata: {},
  };
  return {
    closeForCwd: () => undefined,
    runCommand: () => run,
    bindActivitySink: () => undefined,
  };
}

function testProvider(): WorkspaceProvider {
  return {
    probe: () => Promise.resolve("pass"),
    list: () => Promise.resolve([]),
  };
}

function pluginIdFromUrl(url: string): string {
  const segments = new URL(url).pathname.split("/");
  const pluginId = segments.at(-2);
  if (pluginId === undefined || pluginId === "") throw new Error(`Missing plugin id in ${url}`);
  return pluginId;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function testLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
