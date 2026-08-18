import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebServerPlugin, ServerPluginActivation, ServerPluginActivationContext, WorkspaceProvider } from "../../server-plugin-api.js";
import type { PiWebPluginScope } from "../../shared/apiTypes.js";
import type { PiWebPluginCatalogEntry, PiWebPluginCatalogSnapshot } from "../piWebPluginCatalog.js";
import {
  createServerPluginRuntime,
  type ServerPluginModuleImporter,
} from "./serverPluginRuntime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("server plugin runtime", () => {
  it("activates deterministically, quarantines ordinary failures, publishes transactionally, and stops in reverse", async () => {
    const events: string[] = [];
    const provider = testProvider();
    const modules = new Map<string, unknown>([
      ["alpha", pluginModule("Alpha", {
        workspaceProvider: provider,
        start: () => { events.push("start:alpha"); },
        stop: () => { events.push("stop:alpha"); },
      })],
      ["bad-activate", { default: plugin("Bad activate", () => { throw new Error("activate exploded"); }) }],
      ["bad-api", { default: { apiVersion: 2, name: "Future", activate: () => ({}) } }],
      ["bad-start", pluginModule("Bad start", {
        workspaceProvider: testProvider(),
        start: () => {
          events.push("start:bad-start");
          throw new Error("start exploded");
        },
        stop: () => { events.push("rollback:bad-start"); },
      })],
      ["omega", pluginModule("Omega", {
        workspaceProvider: testProvider(),
        start: () => { events.push("start:omega"); },
        stop: () => { events.push("stop:omega"); },
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
      expect.objectContaining({ pluginId: "alpha", state: "active", name: "Alpha", browserRevision: "browser-7", settingsRevision: "settings-1", machineSpecific: true }),
      expect.objectContaining({ pluginId: "bad-activate", state: "failed", phase: "activate", message: "activate exploded" }),
      expect.objectContaining({ pluginId: "bad-api", state: "incompatible", phase: "validate", message: "Unsupported server plugin API version: 2" }),
      expect.objectContaining({ pluginId: "bad-import", state: "failed", phase: "import", message: "import exploded" }),
      expect.objectContaining({ pluginId: "bad-start", state: "failed", phase: "start", message: "start exploded" }),
      expect.objectContaining({ pluginId: "omega", state: "active", name: "Omega" }),
    ]);
    expect(runtime.providerContributions().map((contribution) => contribution.pluginId)).toEqual(["alpha", "omega"]);

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
  });

  it("freezes activation inputs and scopes lifecycle signals to individual invocations", async () => {
    let activationContext: ServerPluginActivationContext | undefined;
    const lifecycleSignals: AbortSignal[] = [];
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("scoped")])) },
      importer: () => Promise.resolve({
        default: plugin("Scoped", (context) => {
          activationContext = context;
          lifecycleSignals.push(context.signal);
          return {
            start: (signal) => { lifecycleSignals.push(signal); },
            health: (signal) => {
              lifecycleSignals.push(signal);
              return { status: "healthy" };
            },
            stop: (signal) => { lifecycleSignals.push(signal); },
          };
        }),
      }),
      logger: testLogger(),
    });

    if (activationContext === undefined) throw new Error("Expected server plugin activation context");
    expect(Object.isFrozen(activationContext)).toBe(true);
    expect(Object.isFrozen(activationContext.logger)).toBe(true);
    expect(Object.isFrozen(activationContext.settings)).toBe(true);
    expect(lifecycleSignals).toHaveLength(2);
    expect(lifecycleSignals.every((signal) => signal.aborted)).toBe(true);

    await runtime.inspectHealth();
    await runtime.stop();

    expect(lifecycleSignals).toHaveLength(4);
    expect(new Set(lifecycleSignals).size).toBe(4);
    expect(lifecycleSignals.every((signal) => signal.aborted)).toBe(true);
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

    const bundledOnly = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(snapshot) },
      safeStart: "bundled-only",
      importer,
      logger: testLogger(),
    });

    expect(imported).toEqual(["bundled"]);
    expect(bundledOnly.healthRecords()).toEqual([
      expect.objectContaining({ pluginId: "bundled", state: "active" }),
      expect.objectContaining({ pluginId: "configured-off", state: "disabled", message: "disabled in PI WEB config" }),
      expect.objectContaining({ pluginId: "local", state: "disabled", message: "disabled by bundled-only safe start" }),
    ]);

    imported.splice(0);
    const noneCatalog = { snapshot: vi.fn(() => Promise.resolve(snapshot)) };
    const none = await createServerPluginRuntime({
      catalog: noneCatalog,
      safeStart: "none",
      importer,
      logger: testLogger(),
    });

    expect(imported).toEqual([]);
    expect(noneCatalog.snapshot).not.toHaveBeenCalled();
    expect(none.healthRecords()).toEqual([]);
  });

  it("aborts an uncooperative lifecycle phase at its deadline and continues activation", async () => {
    vi.useFakeTimers();
    const observedSignals: AbortSignal[] = [];
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      if (pluginId === "hang") {
        return Promise.resolve(pluginModule("Hang", {
          start: (signal) => new Promise((_resolve, reject) => {
            observedSignals.push(signal);
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
  });

  it("contains health and stop callback failures without hiding other plugins", async () => {
    const stops: string[] = [];
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      if (pluginId === "bad-health") {
        return Promise.resolve(pluginModule("Bad health", {
          health: () => { throw new Error("health exploded"); },
          stop: () => {
            stops.push("bad-health");
            throw new Error("stop exploded");
          },
        }));
      }
      return Promise.resolve(pluginModule("Degraded", {
        health: () => ({ status: "degraded", message: "tool unavailable", details: { retry: true } }),
        stop: () => { stops.push("degraded"); },
      }));
    };
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("bad-health"), entry("degraded")])) },
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
        pluginId: "degraded",
        health: { status: "degraded", message: "tool unavailable", details: { retry: true } },
      },
    ]);

    await runtime.stop();

    expect(stops).toEqual(["degraded", "bad-health"]);
    expect(runtime.healthRecords()).toContainEqual(expect.objectContaining({
      pluginId: "bad-health",
      state: "failed",
      phase: "stop",
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

  it("publishes validated snapshots rather than mutable activation properties", async () => {
    const provider = testProvider();
    const mutableActivation: Record<string, unknown> = { workspaceProvider: provider };
    mutableActivation["start"] = () => { mutableActivation["workspaceProvider"] = {}; };
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

  it("rejects plural provider contributions and non-JSON settings before publication", async () => {
    const pluralActivation = { workspaceProviders: [testProvider()] };
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      return Promise.resolve(pluginModule("Plural", pluginId === "plural" ? pluralActivation : {}));
    };
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("plural"),
        entry("invalid-settings", { settings: circular }),
      ])) },
      importer,
      logger: testLogger(),
    });

    expect(runtime.providerContributions()).toEqual([]);
    const records = runtime.healthRecords();
    expect(records.map((record) => [record.pluginId, record.state, record.phase])).toEqual([
      ["invalid-settings", "incompatible", "validate"],
      ["plural", "incompatible", "validate"],
    ]);
    expect(records[0]?.message).toContain("must not contain cycles");
    expect(records[1]?.message).toBe("Server plugins may contribute only one workspaceProvider");
  });
});

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

function plugin(name: string, activate: PiWebServerPlugin["activate"]): PiWebServerPlugin {
  return { apiVersion: 1, name, activate };
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

function testLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
