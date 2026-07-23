import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import {
  bootstrapAndFreezeGlobalExtensionProviders,
  type GlobalProviderBootstrapLogger,
} from "./globalProviderPolicy.js";
import {
  createTestModelRuntime,
  TEST_MODEL_ID,
  TEST_MODEL_PROVIDER,
} from "./piSessionService.testSupport.js";

interface LogEntry {
  level: "error" | "info" | "warn";
  details: Record<string, unknown>;
  message: string;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

async function agentDirWithExtension(source: string): Promise<string> {
  const agentDir = await tempDir("pi-web-global-provider-unit-");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "provider.js"), source);
  return agentDir;
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

function nativeProvider(providerId: string, name = providerId): Provider {
  return {
    id: providerId,
    name,
    auth: {
      apiKey: {
        name: `${providerId} API key`,
        resolve: () => Promise.resolve(undefined),
      },
    },
    getModels: () => [],
    stream: () => { throw new Error("stream should not be called in this test"); },
    streamSimple: () => { throw new Error("streamSimple should not be called in this test"); },
  };
}

function registerProjectConfigProvider(runtime: Awaited<ReturnType<typeof createTestModelRuntime>>): void {
  runtime.registerProvider("project-config", {
    name: "Project Config",
    baseUrl: "https://project-secret.example.com",
    apiKey: "project-secret-api-key",
    api: "openai-completions",
    models: [{
      id: "project-model",
      name: "Project Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    }],
  });
}

describe("bootstrapAndFreezeGlobalExtensionProviders", () => {
  it("captures the global baseline before making every later provider mutation a no-op", async () => {
    const agentDir = await agentDirWithExtension(`
      export default function (pi) {
        pi.registerProvider("global-config", {
          name: "Global Config",
          baseUrl: "https://global.example.com",
          apiKey: "$GLOBAL_PROVIDER_KEY",
          api: "openai-completions",
          models: [{
            id: "global-model",
            name: "Global Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024
          }]
        });
      }
    `);
    const runtime = await createTestModelRuntime();
    const builtInModel = runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
    expect(builtInModel).toBeDefined();
    const { entries, logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);

    const baselineConfig = runtime.getRegisteredProviderConfig("global-config");
    expect(baselineConfig).toMatchObject({ baseUrl: "https://global.example.com" });
    expect(runtime.getModel("global-config", "global-model")).toBeDefined();
    expect(entries).toContainEqual({
      level: "info",
      details: { context: "global-provider-bootstrap", providerIds: ["global-config"] },
      message: "global extension provider baseline bootstrapped and frozen",
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      runtime.registerProvider("global-config", {
        baseUrl: "https://replacement-secret.example.com",
        headers: { Authorization: "replacement-secret-token" },
      });
      runtime.registerNativeProvider(nativeProvider("global-config", "native-secret-name"));
      runtime.unregisterProvider("global-config");
      registerProjectConfigProvider(runtime);
      runtime.registerNativeProvider(nativeProvider("project-native", "project-native-secret-name"));
      runtime.unregisterProvider("project-only");
    }

    expect(runtime.getRegisteredProviderIds()).toEqual(["global-config"]);
    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baselineConfig);
    expect(runtime.getRegisteredNativeProvider("global-config")).toBeUndefined();
    expect(runtime.getRegisteredProviderConfig("project-config")).toBeUndefined();
    expect(runtime.getRegisteredNativeProvider("project-native")).toBeUndefined();
    expect(runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID)).toBe(builtInModel);

    const ignoredMutations = entries
      .filter((entry) => entry.message === "ignored provider mutation after global bootstrap")
      .map((entry) => entry.details);
    expect(ignoredMutations).toEqual([
      { context: "global-provider-bootstrap", operation: "registerProvider", providerId: "global-config" },
      { context: "global-provider-bootstrap", operation: "registerNativeProvider", providerId: "global-config" },
      { context: "global-provider-bootstrap", operation: "unregisterProvider", providerId: "global-config" },
      { context: "global-provider-bootstrap", operation: "registerProvider", providerId: "project-config" },
      { context: "global-provider-bootstrap", operation: "registerNativeProvider", providerId: "project-native" },
      { context: "global-provider-bootstrap", operation: "unregisterProvider", providerId: "project-only" },
    ]);
    expect(JSON.stringify(ignoredMutations)).not.toContain("secret");
  });

  it("keeps ignored mutations as no-ops when structured logging fails", async () => {
    const agentDir = await tempDir("pi-web-global-provider-unit-");
    const runtime = await createTestModelRuntime();
    const { logger } = capturingLogger();
    const loggingError = new Error("provider mutation logger failed");
    const throwingLogger: GlobalProviderBootstrapLogger = {
      ...logger,
      info(details, message) {
        if (message === "ignored provider mutation after global bootstrap") throw loggingError;
        logger.info(details, message);
      },
    };

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, throwingLogger);

    expect(() => { registerProjectConfigProvider(runtime); }).not.toThrow();
    expect(() => { runtime.registerNativeProvider(nativeProvider("project-native")); }).not.toThrow();
    expect(() => { runtime.unregisterProvider("project-only"); }).not.toThrow();
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
  });

  it("logs non-fatal Pi bootstrap diagnostics and still freezes the runtime", async () => {
    const agentDir = await agentDirWithExtension(`
      export default function (pi) {
        pi.registerProvider("broken-provider", { streamSimple() {} });
      }
    `);
    const runtime = await createTestModelRuntime();
    const { entries, logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);

    const diagnosticEntry = entries.find((entry) => entry.details["diagnosticType"] === "error");
    expect(diagnosticEntry?.level).toBe("error");
    expect(diagnosticEntry?.details["context"]).toBe("global-provider-bootstrap");
    expect(diagnosticEntry?.message).toBe("global extension provider bootstrap diagnostic");
    expect(diagnosticEntry?.details["diagnostic"])
      .toEqual(expect.stringContaining('"api" is required when registering streamSimple'));

    runtime.registerProvider("after-diagnostic", {});
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    expect(entries).toContainEqual({
      level: "info",
      details: {
        context: "global-provider-bootstrap",
        operation: "registerProvider",
        providerId: "after-diagnostic",
      },
      message: "ignored provider mutation after global bootstrap",
    });
  });
});
