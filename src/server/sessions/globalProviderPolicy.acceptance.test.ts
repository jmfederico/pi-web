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
  expect(ignored.map((entry) => entry.details)).toEqual(expect.arrayContaining(
    expected.map(({ operation, providerId }) => ({
      context: "global-provider-bootstrap",
      operation,
      providerId,
    })),
  ));
  expect(ignored.every((entry) => entry.level === "info")).toBe(true);
  const operationProviderKeys = ignored.map((entry) => `${String(entry.details["operation"])}:${String(entry.details["providerId"])}`);
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

  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir,
    modelRuntime: runtime,
    sessionManager: createPiSessionManagerGateway({ agentDir, env: {}, sessionDirEnvKeys: [] }),
    heartbeatIntervalMs: 60_000,
    logger,
  });
  services.push(service);
  return { service, runtime, agentDir, logEntries: entries };
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
      { operation: "registerProvider", providerId: "global-config" },
      { operation: "registerNativeProvider", providerId: "global-native" },
    ]);
    await expectNoProviderMutationFeedback(service, ref);
  });

  it("blocks real project add, replacement, and unregister calls without disabling other extension features", async () => {
    const agentDir = await agentDirWithExtension(globalProvidersSource());
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

  it("keeps a tensorX-style startup provider while ignoring its session_start refresh", async () => {
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
