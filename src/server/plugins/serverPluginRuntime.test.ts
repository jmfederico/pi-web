import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebServerPlugin, ServerPluginActivation, ServerPluginActivationContext, ServerPluginNoticeInput, ServerPluginNoticeReporterV1, WorkspaceProvider } from "../../server-plugin-api.js";
import type { PiWebPluginScope } from "../../shared/apiTypes.js";
import { ServerNoticeService } from "../notices/serverNoticeService.js";
import { ServerNoticeStore } from "../notices/serverNoticeStore.js";
import type { PiWebPluginCatalogEntry, PiWebPluginCatalogSnapshot } from "../piWebPluginCatalog.js";
import {
  createServerPluginRuntime as createServerPluginRuntimeWithRequiredTerminal,
  type CreateServerPluginRuntimeOptions,
  type ServerPluginModuleImporter,
} from "./serverPluginRuntime.js";

afterEach(() => {
  vi.useRealTimers();
});

function createServerPluginRuntime(options: CreateServerPluginRuntimeOptions) {
  return createServerPluginRuntimeWithRequiredTerminal({ ...options, enforceRequiredTerminal: false });
}

describe("server plugin runtime", () => {
  it("activates deterministically, quarantines ordinary failures, publishes transactionally, and stops in reverse", async () => {
    const events: string[] = [];
    const provider = testProvider();
    const modules = new Map<string, unknown>([
      ["alpha", pluginModule("Alpha", {
        workspaceProvider: provider,
        pairedBackend: {
          version: 1,
          request: () => ({ ready: true }),
          openChannel: () => ({ receive: () => undefined }),
        },
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
      expect.objectContaining({ pluginId: "alpha", state: "active", name: "Alpha", browserRevision: "browser-7", settingsRevision: "settings-1", machineSpecific: true, backendCapabilityVersion: 1, channelVersion: 1 }),
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
    expect(activationContext.notices).toBeUndefined();
    expect(lifecycleSignals).toHaveLength(2);
    expect(lifecycleSignals.every((signal) => signal.aborted)).toBe(true);

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
      catalog: { snapshot: () => Promise.resolve(testSnapshot([entry("terminal"), entry("workspace.delete")])) },
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

    const terminalReporter = reporters.get("terminal");
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
        source: "plugin:terminal",
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

  it("validates and safely deep-clones notice context", async () => {
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
    const context = { nested: { labels: ["original"] } };
    noticeReporter.record({ severity: "warning", message: "Plugin warning", context });
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
      context: { nested: { labels: ["original"] } },
    });
    expect(Object.isFrozen(recorded)).toBe(true);
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

  it("rejects malformed or sparse notice arrays before mutating notice state", async () => {
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
    const bigintArray: unknown[] = [1n];
    const sanitizingMap = vi.fn(() => ["sanitized"]);
    Object.defineProperty(bigintArray, "map", { value: sanitizingMap, configurable: true, writable: true });
    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    const sparseArray: unknown[] = [];
    sparseArray.length = 2;
    sparseArray[1] = "present";
    const invalidCases: { context: unknown; message: string }[] = [
      { context: { values: bigintArray }, message: "must contain only JSON values" },
      { context: { values: [() => undefined] }, message: "must contain only JSON values" },
      { context: { values: circularArray }, message: "must not contain cycles" },
      { context: { values: sparseArray }, message: "must not contain sparse arrays" },
    ];

    for (const invalid of invalidCases) {
      expect(() => {
        Reflect.apply(noticeReporter.record, noticeReporter, [{
          severity: "error",
          message: "Invalid array",
          context: invalid.context,
        }]);
      }).toThrow(invalid.message);
    }

    expect(sanitizingMap).not.toHaveBeenCalled();
    expect(noticeSink).not.toHaveBeenCalled();
    expect(publishGlobal).not.toHaveBeenCalled();
    expect(notices.snapshot()).toEqual({ daemonInstanceId: "daemon-a", revision: 0, notices: [] });

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
      if (pluginId === "bad-health-details") {
        return Promise.resolve(pluginModule("Bad health details", {
          health: () => ({ status: "healthy", details: { checkedAt: new Date() } }),
          stop: () => { stops.push("bad-health-details"); },
        }));
      }
      return Promise.resolve(pluginModule("Degraded", {
        health: () => ({ status: "degraded", message: "tool unavailable", details: { retry: true } }),
        stop: () => { stops.push("degraded"); },
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

    await runtime.stop();

    expect(stops).toEqual(["degraded", "bad-health-details", "bad-health"]);
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
    const mutableActivation: Record<string, unknown> = {
      workspaceProvider: provider,
      pairedBackend: {
        version: 1,
        request: () => ({ captured: true }),
        openChannel: () => ({ receive: () => undefined }),
      },
    };
    mutableActivation["start"] = () => {
      mutableActivation["workspaceProvider"] = {};
      mutableActivation["pairedBackend"] = {};
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
    expect(runtime.healthRecords().find(({ pluginId }) => pluginId === "mutable")).toMatchObject({ channelVersion: 1 });
    await expect(Promise.resolve(runtime.pairedBackendContributions()[0]?.backend.request({
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

  it("rejects plural providers, malformed paired backends, and non-JSON settings before publication", async () => {
    const pluralActivation = { workspaceProviders: [testProvider()] };
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const importer: ServerPluginModuleImporter = (url) => {
      const pluginId = pluginIdFromUrl(url);
      const activation = pluginId === "plural"
        ? pluralActivation
        : pluginId === "invalid-backend" ? { pairedBackend: { version: 2, request: () => null } }
          : pluginId === "invalid-channel" ? { pairedBackend: { version: 1, request: () => null, openChannel: true } }
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
    expect(records[0]?.message).toContain("pairedBackend must be a version 1 request backend");
    expect(records[1]?.message).toContain("optional channel opener");
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
    expect(() => { recovery.requiredTerminalService().closeForCwd("/repo"); })
      .toThrow("Required Terminal plugin is unavailable in recovery safe start");
    await recovery.stop();
  });

  it("activates required Terminal before ordinary plugins and stops it after dependents", async () => {
    const events: string[] = [];
    const imported: string[] = [];
    const requiredService = requiredTerminalServiceFixture();
    const runtime = await createServerPluginRuntimeWithRequiredTerminal({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("zeta", { scope: "bundled" }),
        entry("terminal", { scope: "bundled", browserRevision: "terminal-browser" }),
      ])) },
      importer: (url) => {
        const id = pluginIdFromUrl(url);
        imported.push(id);
        if (id === "terminal") {
          return Promise.resolve(pluginModule("Terminal", {
            pairedBackend: {
              version: 1,
              request: () => null,
              openChannel: () => ({ receive: () => undefined }),
            },
            requiredTerminalService: requiredService,
            health: () => ({ status: "healthy" }),
            stop: () => { events.push("stop:terminal"); },
          }));
        }
        return Promise.resolve(pluginModule("Zeta", {
          stop: () => { events.push("stop:zeta"); },
        }));
      },
      logger: testLogger(),
    });

    expect(imported).toEqual(["terminal", "zeta"]);
    expect(runtime.healthRecords().map(({ pluginId, state }) => [pluginId, state])).toEqual([
      ["terminal", "active"],
      ["zeta", "active"],
    ]);
    expect(runtime.requiredTerminalService()).not.toBe(requiredService);
    expect(typeof runtime.requiredTerminalService().runCommand).toBe("function");

    await runtime.stop();
    expect(events).toEqual(["stop:zeta", "stop:terminal"]);
  });

  it("rolls back a required Terminal activation that fails contribution validation", async () => {
    const stopped = vi.fn();
    await expect(createServerPluginRuntimeWithRequiredTerminal({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("terminal", { scope: "bundled", browserRevision: "terminal-browser" }),
      ])) },
      importer: () => Promise.resolve(pluginModule("Terminal", {
        pairedBackend: {
          version: 1,
          request: () => null,
          openChannel: () => ({ receive: () => undefined }),
        },
        requiredTerminalService: {},
        stop: stopped,
      })),
      logger: testLogger(),
    })).rejects.toThrow("did not provide its composition service");
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("rolls back startup when required Terminal is unhealthy before importing ordinary plugins", async () => {
    const imported: string[] = [];
    const stopped = vi.fn();
    await expect(createServerPluginRuntimeWithRequiredTerminal({
      catalog: { snapshot: () => Promise.resolve(testSnapshot([
        entry("alpha", { scope: "bundled" }),
        entry("terminal", { scope: "bundled", browserRevision: "terminal-browser" }),
      ])) },
      importer: (url) => {
        const id = pluginIdFromUrl(url);
        imported.push(id);
        return Promise.resolve(pluginModule("Terminal", {
          pairedBackend: {
            version: 1,
            request: () => null,
            openChannel: () => ({ receive: () => undefined }),
          },
          requiredTerminalService: requiredTerminalServiceFixture(),
          health: () => ({ status: "unhealthy", message: "PTY unavailable" }),
          stop: stopped,
        }));
      },
      logger: testLogger(),
    })).rejects.toThrow("Required Terminal server entry is unhealthy: PTY unavailable");
    expect(imported).toEqual(["terminal"]);
    expect(stopped).toHaveBeenCalledOnce();
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
