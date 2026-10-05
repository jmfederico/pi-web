import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  bootstrapAndFreezeGlobalExtensionProviders,
  type GlobalProviderBootstrapLogger,
} from "./globalProviderPolicy.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService, type PiSessionRef } from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  createTestModelRuntime,
  TEST_MODEL_ID,
  TEST_MODEL_PROVIDER,
} from "./piSessionService.testSupport.js";

/**
 * Acceptance coverage for the exact sessiond lifecycle: global extensions are
 * loaded once against the shared ModelRuntime, provider mutations are frozen,
 * and real sessions subsequently load both global and project extensions
 * through Pi's public session factories.
 *
 * These tests are also a tripwire for the instance-method shadowing used to
 * freeze `registerProvider`, native registration, and unregistration. If Pi
 * changes how real extension calls reach ModelRuntime, these scenarios fail.
 */

interface LogEntry {
  level: "error" | "info" | "warn";
  details: Record<string, unknown>;
  message: string;
}

interface PolicyHarness {
  service: PiSessionService;
  events: CapturingSessionEventHub;
  runtime: ModelRuntime;
  agentDir: string;
  logEntries: LogEntry[];
}

const tempDirs: string[] = [];
const services: PiSessionService[] = [];

const IGNORED_MUTATION_MESSAGE = "ignored provider mutation after global bootstrap";

function modelId(providerId: string, variant: string): string {
  return `${providerId}-${variant}-model`;
}

function providerBaseUrl(providerId: string, variant: string): string {
  return `https://${providerId}-${variant}.example.com`;
}

function providerConfig(providerId: string, variant = "baseline"): Record<string, unknown> {
  return {
    name: `${providerId} ${variant}`,
    baseUrl: providerBaseUrl(providerId, variant),
    apiKey: `sk-${providerId}-${variant}-secret`,
    api: "openai-completions",
    models: [{
      id: modelId(providerId, variant),
      name: `${providerId} ${variant} model`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    }],
  };
}

function providerRegistrationSource(providerId: string, variant = "baseline"): string {
  return `pi.registerProvider(${JSON.stringify(providerId)}, ${JSON.stringify(providerConfig(providerId, variant))});`;
}

/**
 * A catalog refresh as real provider extensions perform it: the *complete*
 * provider config is re-sent with only `models` replaced, never a delta.
 */
function catalogRefreshSource(providerId: string, refreshedModelId: string, variant = "baseline"): string {
  const config = providerConfig(providerId, variant);
  const models = [{
    id: refreshedModelId,
    name: `${providerId} refreshed model`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  }];
  return `pi.registerProvider(${JSON.stringify(providerId)}, ${JSON.stringify({ ...config, models })});`;
}

function nativeProviderRegistrationSource(providerId: string, variant = "baseline"): string {
  const baseUrl = providerBaseUrl(providerId, variant);
  const model = {
    id: modelId(providerId, variant),
    name: `${providerId} ${variant} model`,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 2_000,
    maxTokens: 200,
  };
  return `pi.registerProvider({
    id: ${JSON.stringify(providerId)},
    name: ${JSON.stringify(`${providerId} ${variant}`)},
    baseUrl: ${JSON.stringify(baseUrl)},
    auth: {
      apiKey: {
        name: ${JSON.stringify(`${providerId} API key`)},
        async resolve() {
          return {
            auth: { apiKey: ${JSON.stringify(`sk-${providerId}-${variant}-secret`)} },
            source: "acceptance fixture"
          };
        }
      }
    },
    getModels() { return [${JSON.stringify(model)}]; },
    stream() { throw new Error("stream should not be called in this acceptance test"); },
    streamSimple() { throw new Error("streamSimple should not be called in this acceptance test"); }
  });`;
}

function globalProvidersSource(): string {
  return `
    export default function (pi) {
      ${providerRegistrationSource("global-config")}
      ${nativeProviderRegistrationSource("global-native")}
    }
  `;
}

function capturingLogger(): { entries: LogEntry[]; logger: GlobalProviderBootstrapLogger } {
  const entries: LogEntry[] = [];
  const record = (level: LogEntry["level"], details: Record<string, unknown>, message: string): void => {
    entries.push({ level, details, message });
  };
  return {
    entries,
    logger: {
      error: (details, message) => { record("error", details, message); },
      info: (details, message) => { record("info", details, message); },
      warn: (details, message) => { record("warn", details, message); },
    },
  };
}

function ignoredMutationEntries(entries: readonly LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.message === IGNORED_MUTATION_MESSAGE);
}

function expectIgnoredMutations(
  entries: readonly LogEntry[],
  expected: readonly { operation: string; providerId: string }[],
): void {
  const ignored = ignoredMutationEntries(entries);
  expect(ignored).toHaveLength(expected.length);
  expect(ignored.map(({ details }) => ({ operation: details["operation"], providerId: details["providerId"] })))
    .toEqual(expect.arrayContaining([...expected]));
  for (const { details } of ignored) {
    expect(details["context"]).toBe("global-provider-bootstrap");
    expect(details["code"]).toBe("PROVIDER_MUTATION_IGNORED");
    expect(details["reason"]).toBeTypeOf("string");
    expect(details["guidance"]).toEqual(expect.stringContaining("manually restart the session daemon when safe"));
  }
  const operationProviderKeys = ignored.map((entry) => JSON.stringify([
    entry.details["operation"], entry.details["providerId"], entry.details["reason"],
  ]));
  expect(new Set(operationProviderKeys).size).toBe(ignored.length);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(services.splice(0).map(async (service) => service.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeAgentExtension(agentDir: string, source: string): Promise<void> {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "global-probe.js"), source);
}

async function agentDirWithExtension(source: string): Promise<string> {
  const agentDir = await tempDir("pi-web-policy-agent-");
  await writeAgentExtension(agentDir, source);
  return agentDir;
}

/** Write a project extension into `<cwd>/.pi/extensions/` and return the cwd. */
async function projectWithExtension(source: string): Promise<string> {
  const cwd = await tempDir("pi-web-policy-project-");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(cwd, ".pi", "extensions", "probe.js"), source);
  return cwd;
}

async function policyHarness(options: { runtime?: ModelRuntime; agentDir?: string } = {}): Promise<PolicyHarness> {
  const agentDir = options.agentDir ?? await tempDir("pi-web-policy-agent-");
  // Isolate Pi's per-user resource discovery (~/.agents/skills et al.) so the
  // harness sees only extensions written into its explicit agent/project dirs.
  vi.stubEnv("HOME", await tempDir("pi-web-policy-home-"));
  const runtime = options.runtime ?? await createTestModelRuntime();
  const { entries, logger } = capturingLogger();

  await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);

  const events = new CapturingSessionEventHub();
  const service = new PiSessionService(events, {
    agentDir,
    modelRuntime: runtime,
    sessionManager: createPiSessionManagerGateway({ agentDir, env: {} }),
    heartbeatIntervalMs: 60_000,
    logger,
  });
  services.push(service);
  return { service, events, runtime, agentDir, logEntries: entries };
}

async function expectNoProviderMutationFeedback(service: PiSessionService, ref: PiSessionRef): Promise<void> {
  const status = await service.status(ref);
  expect(status.warnings ?? []).toEqual([]);
  expect(service.notificationInbox(ref).notifications).toEqual([]);
}

/** Parse the session-start marker file without type assertions. */
function parseToolMarker(raw: string): { activeTools: string[]; allTools: string[] } {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("activeTools" in value) || !("allTools" in value)) {
    throw new Error(`Unexpected marker content: ${raw}`);
  }
  const { activeTools, allTools } = value;
  if (!Array.isArray(activeTools) || !Array.isArray(allTools)) throw new Error(`Unexpected marker content: ${raw}`);
  return { activeTools: activeTools.map(String), allTools: allTools.map(String) };
}

describe("immutable global provider bootstrap acceptance", () => {
  it("rejects a shared virtual router in two real sessions through reload and disposal without cross-session contamination", async () => {
    const agentDir = await agentDirWithExtension(globalProvidersSource());
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "always" })}\n`);
    const { service, events, runtime, logEntries } = await policyHarness({ agentDir });
    const baselineConfig = runtime.getRegisteredProviderConfig("global-config");
    const baselineNative = runtime.getRegisteredNativeProvider("global-native");
    const source = (name: string): string => `
      export default function (pi) {
        const router = {
          provider: "shared-router",
          id: "auto",
          name: ${JSON.stringify(name)},
          route(request, ctx) {
            return {
              model: ctx.modelRegistry.find("global-config", ${JSON.stringify(modelId("global-config", "baseline"))}),
              thinkingLevel: "off",
              state: { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }
            };
          }
        };
        pi.registerVirtualModel(router);
        pi.on("session_start", () => pi.registerVirtualModel(router));
        pi.on("session_shutdown", () => pi.unregisterVirtualModel("shared-router", "auto"));
      }
    `;
    const firstCwd = await projectWithExtension(source("first-secret-router"));
    const secondCwd = await projectWithExtension(source("second-secret-router"));
    const first = { id: (await service.start(firstCwd)).id, cwd: firstCwd };
    const second = { id: (await service.start(secondCwd)).id, cwd: secondCwd };
    expect(first.id).not.toBe(second.id);

    const errorMessages = (ref: PiSessionRef): string[] => events.sessionEvents.flatMap(({ sessionId, event }) =>
      sessionId === ref.id && event.type === "session.error" ? [event.message] : []);
    for (const ref of [first, second]) {
      const warnings = (await service.status(ref)).warnings ?? [];
      expect(warnings.filter((warning) => warning.severity === "error").map((warning) => warning.message))
        .toContainEqual(expect.stringContaining("PI WEB does not support registerVirtualModel()"));
      expect(errorMessages(ref)).toContainEqual(expect.stringContaining("select a physical model instead"));
      await expect(service.setModel(ref, "shared-router", "auto")).rejects.toThrow(/not found/i);
    }
    const secondCatalog = await service.availableModels(second);
    const secondModel = (await service.status(second)).model;
    const secondErrors = errorMessages(second);
    expect(secondModel).toBeDefined();
    expect(secondCatalog.some((model) => model.provider === "shared-router")).toBe(false);

    const errorsBeforeReload = errorMessages(first).length;
    await expect(service.runCommand(first, "/reload")).resolves.toMatchObject({ type: "done" });
    const reloadErrors = errorMessages(first).slice(errorsBeforeReload);
    expect(reloadErrors).toContainEqual(expect.stringContaining("PI WEB does not support unregisterVirtualModel()"));
    expect(reloadErrors).toContainEqual(expect.stringContaining("PI WEB does not support registerVirtualModel()"));
    expect(await service.availableModels(second)).toEqual(secondCatalog);
    expect((await service.status(second)).model).toEqual(secondModel);

    const errorsBeforeDisposal = errorMessages(first).length;
    await service.stop(first);
    expect(errorMessages(first).slice(errorsBeforeDisposal))
      .toContainEqual(expect.stringContaining("PI WEB does not support unregisterVirtualModel()"));
    expect(errorMessages(second)).toEqual(secondErrors);
    expect(await service.availableModels(second)).toEqual(secondCatalog);
    expect((await service.status(second)).model).toEqual(secondModel);
    expect(runtime.getModel("shared-router", "auto")).toBeUndefined();
    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baselineConfig);
    expect(runtime.getRegisteredNativeProvider("global-native")).toBe(baselineNative);
    expect(JSON.stringify(logEntries)).not.toContain("secret");
    expect(JSON.stringify(events.sessionEvents)).not.toContain("secret");
  });

  it("loads global config and native providers once, then treats normal session replay as a no-op", async () => {
    const agentDir = await agentDirWithExtension(globalProvidersSource());
    const { service, runtime, logEntries } = await policyHarness({ agentDir });
    const baselineConfig = runtime.getRegisteredProviderConfig("global-config");
    const baselineNative = runtime.getRegisteredNativeProvider("global-native");

    expect(baselineConfig).toMatchObject({ baseUrl: providerBaseUrl("global-config", "baseline") });
    expect(baselineNative).toMatchObject({
      id: "global-native",
      baseUrl: providerBaseUrl("global-native", "baseline"),
    });
    expect(logEntries).toContainEqual({
      level: "info",
      details: { context: "global-provider-bootstrap", providerIds: ["global-config", "global-native"] },
      message: "global extension provider baseline bootstrapped and frozen",
    });

    const cwd = await tempDir("pi-web-policy-project-");
    const session = await service.start(cwd);
    const ref = { id: session.id, cwd };

    expect(runtime.getRegisteredProviderIds()).toEqual(["global-config", "global-native"]);
    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baselineConfig);
    expect(runtime.getRegisteredNativeProvider("global-native")).toBe(baselineNative);
    expect(runtime.getModel("global-config", modelId("global-config", "baseline"))).toMatchObject({
      provider: "global-config",
      baseUrl: providerBaseUrl("global-config", "baseline"),
    });
    expect(runtime.getModel("global-native", modelId("global-native", "baseline"))).toMatchObject({
      provider: "global-native",
      baseUrl: providerBaseUrl("global-native", "baseline"),
    });
    const available = await service.availableModels(ref);
    expect(available).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "global-config", id: modelId("global-config", "baseline") }),
      expect.objectContaining({ provider: "global-native", id: modelId("global-native", "baseline") }),
    ]));
    expectIgnoredMutations(logEntries, [
      { operation: "registerNativeProvider", providerId: "global-native" },
    ]);
    expect(ignoredMutationEntries(logEntries).every((entry) => entry.level === "info")).toBe(true);
    await expectNoProviderMutationFeedback(service, ref);
  });

  it("blocks real project add, replacement, and unregister calls without disabling other extension features", async () => {
    const agentDir = await agentDirWithExtension(globalProvidersSource());
    // PI WEB always honors project trust, so the project extension only loads
    // when the workspace is trusted. Trust it: the provider-policy assertions
    // below are about blocking provider mutations, not about gating the
    // extension itself.
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "always" })}\n`);
    const { service, runtime, logEntries } = await policyHarness({ agentDir });
    const baselineConfig = runtime.getRegisteredProviderConfig("global-config");
    const baselineNative = runtime.getRegisteredNativeProvider("global-native");
    const markerPath = join(await tempDir("pi-web-policy-marker-"), "session-start.json");
    const cwd = await projectWithExtension(`
      import { writeFileSync } from "node:fs";
      export default function (pi) {
        ${providerRegistrationSource("project-config", "project-secret")}
        ${providerRegistrationSource("global-config", "project-secret")}
        ${nativeProviderRegistrationSource("project-native", "project-secret")}
        ${nativeProviderRegistrationSource("global-native", "project-secret")}
        pi.registerTool({
          name: "project_probe_tool",
          label: "Project Probe Tool",
          description: "non-provider acceptance probe",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "project probe ok" }] }; }
        });
        pi.registerCommand("project-probe", {
          description: "non-provider acceptance probe",
          async handler() {}
        });
        pi.on("session_start", () => {
          ${providerRegistrationSource("project-config", "late-secret")}
          pi.unregisterProvider("global-config");
          pi.unregisterProvider("global-config");
          pi.unregisterProvider("global-native");
          pi.unregisterProvider("global-native");
          writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
            activeTools: pi.getActiveTools(),
            allTools: pi.getAllTools().map((tool) => tool.name)
          }));
        });
      }
    `);

    const session = await service.start(cwd);
    const ref = { id: session.id, cwd };

    expect(runtime.getRegisteredProviderIds()).toEqual(["global-config", "global-native"]);
    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baselineConfig);
    expect(runtime.getRegisteredNativeProvider("global-native")).toBe(baselineNative);
    expect(runtime.getRegisteredProviderConfig("project-config")).toBeUndefined();
    expect(runtime.getRegisteredNativeProvider("project-native")).toBeUndefined();
    expect(runtime.getModel("global-config", modelId("global-config", "baseline"))).toBeDefined();
    expect(runtime.getModel("global-config", modelId("global-config", "project-secret"))).toBeUndefined();
    expect(runtime.getModel("global-native", modelId("global-native", "baseline"))).toBeDefined();
    expect(runtime.getModel("global-native", modelId("global-native", "project-secret"))).toBeUndefined();
    expect(runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID)).toBeDefined();

    expect(await service.commands(ref)).toContainEqual({
      name: "project-probe",
      description: "non-provider acceptance probe",
      source: "extension",
    });
    const marker = parseToolMarker(await readFile(markerPath, "utf-8"));
    expect(marker.activeTools).toContain("project_probe_tool");
    expect(marker.allTools).toContain("project_probe_tool");

    expectIgnoredMutations(logEntries, [
      { operation: "registerProvider", providerId: "global-config" },
      { operation: "registerProvider", providerId: "project-config" },
      { operation: "registerNativeProvider", providerId: "global-native" },
      { operation: "registerNativeProvider", providerId: "project-native" },
      { operation: "unregisterProvider", providerId: "global-config" },
      { operation: "unregisterProvider", providerId: "global-native" },
    ]);
    expect(JSON.stringify(ignoredMutationEntries(logEntries))).not.toContain("secret");
    expect(JSON.stringify(ignoredMutationEntries(logEntries))).not.toContain("example.com");
    await expectNoProviderMutationFeedback(service, ref);
  });

  it("applies a tensorX-style session_start catalog refresh from a known provider", async () => {
    const providerId = "tensorx-style";
    const refreshedModelId = "tensorx-style-refreshed-model";
    const agentDir = await agentDirWithExtension(`
      export default function (pi) {
        ${providerRegistrationSource(providerId)}
        pi.on("session_start", () => {
          ${catalogRefreshSource(providerId, refreshedModelId)}
        });
      }
    `);
    const { service, runtime, logEntries } = await policyHarness({ agentDir });
    const cwd = await tempDir("pi-web-policy-project-");

    const session = await service.start(cwd);
    const ref = { id: session.id, cwd };

    expect(runtime.getModel(providerId, refreshedModelId)).toMatchObject({
      provider: providerId,
      baseUrl: providerBaseUrl(providerId, "baseline"),
    });
    expect(runtime.getModel(providerId, modelId(providerId, "baseline"))).toBeUndefined();
    expect(runtime.getRegisteredProviderConfig(providerId)).toMatchObject({
      baseUrl: providerBaseUrl(providerId, "baseline"),
      apiKey: `sk-${providerId}-baseline-secret`,
    });
    expect(await service.availableModels(ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: providerId, id: refreshedModelId }),
    ]));
    // The unchanged startup replay is a silent no-op, not a diagnostic.
    expectIgnoredMutations(logEntries, []);
    expect(logEntries).toContainEqual({
      level: "info",
      details: {
        context: "global-provider-bootstrap",
        operation: "registerProvider",
        providerId,
        modelCount: 1,
      },
      message: "applied models-only provider update after global bootstrap",
    });
    await expectNoProviderMutationFeedback(service, ref);
  });

  it("keeps a tensorX-style startup provider while ignoring a session_start config replacement", async () => {
    const providerId = "tensorx-style";
    const agentDir = await agentDirWithExtension(`
      export default function (pi) {
        ${providerRegistrationSource(providerId, "startup")}
        pi.on("session_start", () => {
          ${providerRegistrationSource(providerId, "late-refresh-secret")}
        });
      }
    `);
    const { service, runtime, logEntries } = await policyHarness({ agentDir });
    const baseline = runtime.getRegisteredProviderConfig(providerId);
    const cwd = await tempDir("pi-web-policy-project-");

    const session = await service.start(cwd);
    const ref = { id: session.id, cwd };

    expect(runtime.getRegisteredProviderConfig(providerId)).toBe(baseline);
    expect(runtime.getRegisteredProviderConfig(providerId)).toMatchObject({
      baseUrl: providerBaseUrl(providerId, "startup"),
    });
    expect(runtime.getModel(providerId, modelId(providerId, "startup"))).toBeDefined();
    expect(runtime.getModel(providerId, modelId(providerId, "late-refresh-secret"))).toBeUndefined();
    expectIgnoredMutations(logEntries, [
      { operation: "registerProvider", providerId },
    ]);
    expect(JSON.stringify(ignoredMutationEntries(logEntries))).not.toContain("late-refresh-secret");
    await expectNoProviderMutationFeedback(service, ref);
  });

  it("requires a fresh daemon bootstrap for global extension changes instead of applying them on reload", async () => {
    const providerId = "reload-global";
    const variantEnv = "PI_WEB_ACCEPTANCE_PROVIDER_VARIANT";
    vi.stubEnv(variantEnv, "first");
    const agentDir = await agentDirWithExtension(`
      export default function (pi) {
        const variant = process.env[${JSON.stringify(variantEnv)}] ?? "missing";
        pi.registerProvider(${JSON.stringify(providerId)}, {
          name: "reload global " + variant,
          baseUrl: "https://reload-" + variant + ".example.com",
          apiKey: "sk-reload-" + variant,
          api: "openai-completions",
          models: [{
            id: "model-" + variant,
            name: "Reload " + variant,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100
          }]
        });
      }
    `);
    const firstDaemon = await policyHarness({ agentDir });
    const firstBaseline = firstDaemon.runtime.getRegisteredProviderConfig(providerId);
    const cwd = await tempDir("pi-web-policy-project-");
    const session = await firstDaemon.service.start(cwd);
    const ref = { id: session.id, cwd };

    vi.stubEnv(variantEnv, "second");
    await expect(firstDaemon.service.runCommand(ref, "/reload")).resolves.toMatchObject({ type: "done" });

    expect(firstDaemon.runtime.getRegisteredProviderConfig(providerId)).toBe(firstBaseline);
    expect(firstDaemon.runtime.getRegisteredProviderConfig(providerId)).toMatchObject({
      baseUrl: "https://reload-first.example.com",
    });
    expect(firstDaemon.runtime.getModel(providerId, "model-first")).toBeDefined();
    expect(firstDaemon.runtime.getModel(providerId, "model-second")).toBeUndefined();

    const secondDaemon = await policyHarness({ agentDir });
    expect(secondDaemon.runtime.getRegisteredProviderConfig(providerId)).toMatchObject({
      baseUrl: "https://reload-second.example.com",
    });
    expect(secondDaemon.runtime.getModel(providerId, "model-first")).toBeUndefined();
    expect(secondDaemon.runtime.getModel(providerId, "model-second")).toBeDefined();
  });

  it("diagnoses a provider extension installed after bootstrap without session warnings or duplicate logs", async () => {
    const providerId = "late-global";
    const agentDir = await tempDir("pi-web-policy-agent-");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [providerId]: providerConfig(providerId) } }));
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const { service, logEntries, events } = await policyHarness({ runtime, agentDir });
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    await writeAgentExtension(agentDir, `
      export default function (pi) {
        pi.registerProvider(${JSON.stringify(providerId)}, {
          api: "openai-completions",
          streamSimple() { throw new Error("late-stream-secret"); }
        });
      }
    `);
    const cwd = await tempDir("pi-web-policy-project-");
    const first = { id: (await service.start(cwd)).id, cwd };
    const second = { id: (await service.start(cwd)).id, cwd };
    await expect(service.runCommand(first, "/reload")).resolves.toMatchObject({ type: "done" });

    expectIgnoredMutations(logEntries, [{ operation: "registerProvider", providerId }]);
    expect(ignoredMutationEntries(logEntries)[0]).toMatchObject({
      level: "warn",
      details: { code: "PROVIDER_MUTATION_IGNORED", reason: "not-in-startup-baseline" },
    });
    expect(runtime.getRegisteredProviderConfig(providerId)).toBeUndefined();
    expect(runtime.getModel(providerId, modelId(providerId, "baseline"))).toBeDefined();
    expect(JSON.stringify(ignoredMutationEntries(logEntries))).not.toContain("secret");
    expect(events.sessionEvents.filter(({ event }) => event.type === "session.error")).toEqual([]);
    await expectNoProviderMutationFeedback(service, first);
    await expectNoProviderMutationFeedback(service, second);
  });

  it("retains a startup custom stream through fresh callback replays and reload without warning", async () => {
    const providerId = "startup-stream";
    const agentDir = await agentDirWithExtension(`
      import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
      export default function (pi) {
        pi.registerProvider(${JSON.stringify(providerId)}, {
          ...${JSON.stringify(providerConfig(providerId))},
          streamSimple(model) {
            const stream = createAssistantMessageEventStream();
            stream.push({
              type: "done", reason: "stop", message: {
                role: "assistant", content: [{ type: "text", text: "startup stream is active" }],
                api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
              }
            });
            stream.end();
            return stream;
          }
        });
      }
    `);
    const { service, runtime, logEntries } = await policyHarness({ agentDir });
    const baselineStream = runtime.getRegisteredProviderConfig(providerId)?.streamSimple;
    expect(baselineStream).toBeTypeOf("function");
    const cwd = await tempDir("pi-web-policy-project-");
    const ref = { id: (await service.start(cwd)).id, cwd };
    await expect(service.runCommand(ref, "/reload")).resolves.toMatchObject({ type: "done" });
    const model = runtime.getModel(providerId, modelId(providerId, "baseline"));
    if (!model) throw new Error("Missing startup stream model");
    const result = await runtime.completeSimple(model, { messages: [] });
    expect(result.content).toEqual([{ type: "text", text: "startup stream is active" }]);
    expect(runtime.getRegisteredProviderConfig(providerId)?.streamSimple).toBe(baselineStream);
    expectIgnoredMutations(logEntries, [{ operation: "registerProvider", providerId }]);
    expect(ignoredMutationEntries(logEntries)[0]).toMatchObject({
      level: "info", details: { reason: "implementation-unverified" },
    });
    expect(logEntries.filter((entry) => entry.level === "warn" || entry.level === "error")).toEqual([]);
    await expectNoProviderMutationFeedback(service, ref);
  });

  it("leaves project-level models.json behavior unchanged", async () => {
    const agentDir = await tempDir("pi-web-policy-agent-");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { "global-acme": providerConfig("global-acme") },
    }));
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const { service } = await policyHarness({ runtime, agentDir });
    const cwd = await tempDir("pi-web-policy-project-");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "models.json"), JSON.stringify({
      providers: { "project-acme": providerConfig("project-acme") },
    }));

    const session = await service.start(cwd);
    const ref = { id: session.id, cwd };

    expect(runtime.getModel("global-acme", modelId("global-acme", "baseline"))).toBeDefined();
    expect(runtime.getModel("project-acme", modelId("project-acme", "baseline"))).toBeUndefined();
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    await expectNoProviderMutationFeedback(service, ref);
  });
});
