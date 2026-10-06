import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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

const GLOBAL_PROVIDER_SOURCE = `
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
`;

function catalogModel(modelId: string): NonNullable<ProviderConfigInput["models"]>[number] {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

/**
 * The complete config the motivating extension re-sends when it refreshes its
 * catalog: every baseline field repeated verbatim, only `models` differing.
 */
function globalConfigWithModels(modelIds: readonly string[]): ProviderConfigInput {
  return {
    name: "Global Config",
    baseUrl: "https://global.example.com",
    apiKey: "$GLOBAL_PROVIDER_KEY",
    api: "openai-completions",
    models: modelIds.map(catalogModel),
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

type ProviderConfigInput = NonNullable<ReturnType<ModelRuntime["getRegisteredProviderConfig"]>>;

describe("bootstrapAndFreezeGlobalExtensionProviders", () => {
  it("rejects virtual models at real global bootstrap and every later runtime mutation without exposing definitions", async () => {
    const agentDir = await agentDirWithExtension(`
      export default function (pi) {
        pi.registerVirtualModel({
          provider: "router-secret-provider",
          id: "secret-id",
          name: "secret-name",
          route() { throw new Error("secret-router-must-not-run"); }
        });
      }
    `);
    const runtime = await createTestModelRuntime();
    const providersBefore = runtime.getProviders().map((provider) => provider.id);
    const { entries, logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);

    const diagnostic = entries.find((entry) => entry.details["diagnosticType"] === "error");
    expect(diagnostic?.level).toBe("error");
    expect(diagnostic?.details["diagnostic"]).toEqual(expect.stringContaining("PI WEB does not support registerVirtualModel()"));
    expect(diagnostic?.details["diagnostic"]).toEqual(expect.stringContaining("shared across sessions"));
    expect(diagnostic?.details["diagnostic"]).toEqual(expect.stringContaining("select a physical model instead"));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => {
        runtime.registerVirtualModel({
          provider: "router-secret-provider",
          id: "secret-id",
          name: "secret-name",
          route() { throw new Error("secret-router-must-not-run"); },
        });
      }).toThrow("PI WEB does not support registerVirtualModel()");
      expect(() => { runtime.unregisterVirtualModel("router-secret-provider", "secret-id"); })
        .toThrow("PI WEB does not support unregisterVirtualModel()");
    }
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel("router-secret-provider", "secret-id")).toBeUndefined();
    expect(runtime.getProviders().map((provider) => provider.id)).toEqual(providersBefore);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

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
      .map(({ details }) => ({ context: details["context"], operation: details["operation"], providerId: details["providerId"] }));
    expect(ignoredMutations).toEqual([
      { context: "global-provider-bootstrap", operation: "registerProvider", providerId: "global-config" },
      { context: "global-provider-bootstrap", operation: "registerNativeProvider", providerId: "global-config" },
      { context: "global-provider-bootstrap", operation: "unregisterProvider", providerId: "global-config" },
      { context: "global-provider-bootstrap", operation: "registerProvider", providerId: "project-config" },
      { context: "global-provider-bootstrap", operation: "registerNativeProvider", providerId: "project-native" },
      { context: "global-provider-bootstrap", operation: "unregisterProvider", providerId: "project-only" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

  it("keeps the frozen baseline intact across runtime refreshes that rebuild every provider", async () => {
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
    // Native and config registrations use separate runtime storage, so the
    // baseline must cover both before it is frozen.
    runtime.registerNativeProvider(nativeProvider("global-native", "Global Native"));
    const { logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);

    const baselineRegisteredIds = [...runtime.getRegisteredProviderIds()].sort();
    const baselineProviderIds = runtime.getProviders().map((provider) => provider.id).sort();
    const baselineConfig = runtime.getRegisteredProviderConfig("global-config");
    const baselineNative = runtime.getRegisteredNativeProvider("global-native");
    expect(baselineRegisteredIds).toEqual(["global-config", "global-native"]);
    expect(baselineProviderIds).toEqual(expect.arrayContaining(["global-config", "global-native", TEST_MODEL_PROVIDER]));

    // Pi 0.82 rebuilds every provider inside refresh(), and PI WEB's background
    // refresher calls it hourly, so ignored mutations must stay ignored across it.
    registerProjectConfigProvider(runtime);
    runtime.registerNativeProvider(nativeProvider("project-native"));
    runtime.unregisterProvider("global-config");
    runtime.unregisterProvider("global-native");
    await runtime.refresh();
    await runtime.refresh();

    expect([...runtime.getRegisteredProviderIds()].sort()).toEqual(baselineRegisteredIds);
    expect(runtime.getProviders().map((provider) => provider.id).sort()).toEqual(baselineProviderIds);
    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baselineConfig);
    expect(runtime.getRegisteredNativeProvider("global-native")).toBe(baselineNative);
    expect(runtime.getRegisteredProviderConfig("project-config")).toBeUndefined();
    expect(runtime.getRegisteredNativeProvider("project-native")).toBeUndefined();
    expect(runtime.getModel("global-config", "global-model")).toBeDefined();
    expect(runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID)).toBeDefined();
  });

  it.each(["info", "warn"] as const)("keeps ignored mutations as no-ops when %s logging fails", async (level) => {
    const agentDir = await tempDir("pi-web-global-provider-unit-");
    const runtime = await createTestModelRuntime();
    const { logger } = capturingLogger();
    const loggingError = new Error("provider mutation logger failed");
    const throwingLogger: GlobalProviderBootstrapLogger = {
      ...logger,
      [level](details: Record<string, unknown>, message: string) {
        if (message === "ignored provider mutation after global bootstrap") throw loggingError;
        logger[level](details, message);
      },
    };

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, throwingLogger);

    expect(() => { registerProjectConfigProvider(runtime); }).not.toThrow();
    expect(() => { runtime.registerNativeProvider(nativeProvider("project-native")); }).not.toThrow();
    expect(() => { runtime.unregisterProvider("project-only"); }).not.toThrow();
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
  });

  it("applies a models-only refresh from a known provider and rebases the baseline", async () => {
    const agentDir = await agentDirWithExtension(GLOBAL_PROVIDER_SOURCE);
    const runtime = await createTestModelRuntime();
    const { entries, logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);

    // A complete config, exactly as a refreshing extension re-sends it.
    runtime.registerProvider("global-config", globalConfigWithModels(["global-model", "refreshed-model"]));

    expect(runtime.getModel("global-config", "refreshed-model")).toBeDefined();
    expect(runtime.getModel("global-config", "global-model")).toBeDefined();
    expect(runtime.getRegisteredProviderConfig("global-config")).toMatchObject({
      baseUrl: "https://global.example.com",
      apiKey: "$GLOBAL_PROVIDER_KEY",
    });
    expect(entries).toContainEqual({
      level: "info",
      details: {
        context: "global-provider-bootstrap",
        operation: "registerProvider",
        providerId: "global-config",
        modelCount: 2,
      },
      message: "applied models-only provider update after global bootstrap",
    });

    // The accepted config becomes the new baseline, so the next honest refresh
    // (compared against it, not the original) is still accepted.
    runtime.registerProvider("global-config", globalConfigWithModels(["second-refresh-model"]));

    expect(runtime.getModel("global-config", "second-refresh-model")).toBeDefined();
    expect(runtime.getModel("global-config", "refreshed-model")).toBeUndefined();
    expect(entries.filter((entry) => entry.message === "ignored provider mutation after global bootstrap")).toEqual([]);
  });

  it("ignores a replay of the catalog it just accepted", async () => {
    const agentDir = await agentDirWithExtension(GLOBAL_PROVIDER_SOURCE);
    const runtime = await createTestModelRuntime();
    const { entries, logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);

    const refreshed = globalConfigWithModels(["global-model", "refreshed-model"]);
    runtime.registerProvider("global-config", refreshed);
    // A per-session `session_start` handler re-sends the same catalog on every
    // new session. Once applied, that is a replay of the current state, so it
    // must not be re-applied or logged again. This only holds because an
    // accepted update rebases the stored baseline; without that rebase every
    // replay still differs from the original catalog and is accepted forever.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.registerProvider("global-config", refreshed);
    }

    // Applied once; subsequent unchanged replays are completely silent.
    expect(entries.filter((entry) => entry.message === "applied models-only provider update after global bootstrap"))
      .toHaveLength(1);
    expect(entries.filter((entry) => entry.message === "ignored provider mutation after global bootstrap")).toEqual([]);
    expect(runtime.getModel("global-config", "refreshed-model")).toBeDefined();
  });

  it("surfaces an invalid catalog refresh without disturbing the baseline", async () => {
    // Narrowing the freeze introduced a failure mode the all-or-nothing version
    // could not have: an accepted call now reaches Pi's validation, so a known
    // provider sending a malformed catalog gets a real error instead of a silent
    // no-op. That error must stay visible to the extension — swallowing it would
    // hide a broken provider — while the recorded baseline and the previously
    // registered models keep working.
    //
    // Models carry their own `api`/`baseUrl` here so that a refreshed catalog
    // omitting them fails validation.
    const agentDir = await agentDirWithExtension(`
      export default function (pi) {
        pi.registerProvider("per-model-config", {
          name: "Per Model Config",
          apiKey: "$PER_MODEL_KEY",
          models: [{
            id: "first-model",
            name: "First Model",
            api: "openai-completions",
            baseUrl: "https://per-model.example.com",
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
    const { entries, logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);
    const baselineConfig = runtime.getRegisteredProviderConfig("per-model-config");
    const perModelConfig = (model: NonNullable<ProviderConfigInput["models"]>[number]): ProviderConfigInput => ({
      name: "Per Model Config",
      apiKey: "$PER_MODEL_KEY",
      models: [model],
    });

    // `catalogModel` omits `api`/`baseUrl`, which this provider needs per model.
    expect(() => { runtime.registerProvider("per-model-config", perModelConfig(catalogModel("broken-model"))); })
      .toThrow(/no "api" specified/);

    expect(runtime.getRegisteredProviderConfig("per-model-config")).toBe(baselineConfig);
    expect(runtime.getModel("per-model-config", "first-model")).toBeDefined();
    expect(runtime.getModel("per-model-config", "broken-model")).toBeUndefined();

    // The rejected attempt did not poison the baseline, so a valid refresh of
    // the same provider is still recognized as a models-only update.
    runtime.registerProvider("per-model-config", perModelConfig({
      ...catalogModel("second-model"),
      api: "openai-completions",
      baseUrl: "https://per-model.example.com",
    }));

    expect(runtime.getModel("per-model-config", "second-model")).toBeDefined();
    expect(entries.filter((entry) => entry.message === "applied models-only provider update after global bootstrap"))
      .toHaveLength(1);
  });

  it("ignores registrations that change any field other than the model catalog", async () => {
    const agentDir = await agentDirWithExtension(GLOBAL_PROVIDER_SOURCE);
    const runtime = await createTestModelRuntime();
    const { entries, logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);
    const baselineConfig = runtime.getRegisteredProviderConfig("global-config");

    const mismatches: Record<string, ProviderConfigInput> = {
      name: { ...globalConfigWithModels(["changed-model"]), name: "Renamed Config" },
      baseUrl: { ...globalConfigWithModels(["changed-model"]), baseUrl: "https://replacement-secret.example.com" },
      apiKey: { ...globalConfigWithModels(["changed-model"]), apiKey: "replacement-secret-api-key" },
      api: { ...globalConfigWithModels(["changed-model"]), api: "anthropic-messages" },
      headers: { ...globalConfigWithModels(["changed-model"]), headers: { Authorization: "replacement-secret-token" } },
      authHeader: { ...globalConfigWithModels(["changed-model"]), authHeader: false },
      // Function-valued fields cannot be compared by value, so any incoming
      // closure is conservatively treated as a mismatch.
      refreshModels: {
        ...globalConfigWithModels(["changed-model"]),
        refreshModels: () => Promise.resolve([catalogModel("changed-model")]),
      },
      streamSimple: {
        ...globalConfigWithModels(["changed-model"]),
        streamSimple: () => { throw new Error("streamSimple should not be called in this test"); },
      },
      oauth: {
        ...globalConfigWithModels(["changed-model"]),
        oauth: {
          name: "Replacement OAuth",
          login: () => Promise.reject(new Error("login should not be called in this test")),
          refreshToken: () => Promise.reject(new Error("refreshToken should not be called in this test")),
          getApiKey: () => "replacement-secret-oauth-key",
        },
      },
    };
    for (const config of Object.values(mismatches)) runtime.registerProvider("global-config", config);
    // A provider absent from the baseline stays blocked even for models-only shapes.
    runtime.registerProvider("unknown-config", { models: [catalogModel("unknown-model")] });

    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baselineConfig);
    expect(runtime.getModel("global-config", "changed-model")).toBeUndefined();
    expect(runtime.getRegisteredProviderIds()).toEqual(["global-config"]);
    expect(entries.filter((entry) => entry.message === "applied models-only provider update after global bootstrap"))
      .toEqual([]);
    // Repeated definite configuration changes stay de-duplicated.
    const ignoredDetails = entries
      .filter((entry) => entry.message === "ignored provider mutation after global bootstrap")
      .map(({ details }) => ({ context: details["context"], operation: details["operation"], providerId: details["providerId"] }));
    expect(ignoredDetails).toEqual([
      { context: "global-provider-bootstrap", operation: "registerProvider", providerId: "global-config" },
      { context: "global-provider-bootstrap", operation: "registerProvider", providerId: "unknown-config" },
    ]);
    // Rejected configs carry credentials; the decision log must never echo them.
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

  it("keeps callback replays informational without suppressing later configuration warnings or leaking secrets", async () => {
    const agentDir = await agentDirWithExtension(GLOBAL_PROVIDER_SOURCE.replace(
      'api: "openai-completions",',
      `api: "openai-completions",
       streamSimple() { throw new Error("startup-stream-secret"); },
       oauth: {
         name: "Global OAuth",
         async login() { throw new Error("startup-login-secret"); },
         async refreshToken() { throw new Error("startup-refresh-secret"); },
         getApiKey() { return "startup-oauth-secret"; }
       },`,
    ));
    const runtime = await createTestModelRuntime();
    const { entries, logger } = capturingLogger();
    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);
    const baseline = runtime.getRegisteredProviderConfig("global-config");
    if (!baseline?.oauth) throw new Error("Missing startup OAuth fixture");
    const freshCallbacks = {
      ...baseline,
      streamSimple() { throw new Error("replacement-stream-secret"); },
      oauth: {
        ...baseline.oauth,
        login: () => Promise.reject(new Error("replacement-login-secret")),
        refreshToken: () => Promise.reject(new Error("replacement-refresh-secret")),
        getApiKey() { return "replacement-oauth-secret"; },
      },
    } satisfies ProviderConfigInput;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.registerProvider("global-config", baseline);
      runtime.registerProvider("global-config", {});
      runtime.registerProvider("global-config", freshCallbacks);
      runtime.registerProvider("global-config", {
        ...freshCallbacks,
        oauth: { ...freshCallbacks.oauth, name: "replacement-oauth-name-secret" },
      });
      runtime.registerProvider("global-config", { headers: { Authorization: "replacement-header-secret" } });
    }
    const ignored = entries.filter((entry) => entry.message === "ignored provider mutation after global bootstrap");
    expect(ignored.map(({ level, details }) => ({ level, reason: details["reason"] }))).toEqual([
      { level: "info", reason: "implementation-unverified" },
      { level: "warn", reason: "configuration-change" },
    ]);
    for (const { details } of ignored) {
      expect(details).toMatchObject({
        code: "PROVIDER_MUTATION_IGNORED",
        operation: "registerProvider",
        providerId: "global-config",
      });
      expect(details["guidance"]).toEqual(expect.stringContaining("The startup provider, if any, remains in use"));
      expect(details["guidance"]).toEqual(expect.stringContaining("Project-only or session_start-only registrations are not enabled by a restart"));
      expect(details["guidance"]).toEqual(expect.stringContaining("interrupts active sessions and terminals"));
    }
    expect(JSON.stringify(ignored)).not.toContain("secret");
    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baseline);
  });

  it("keeps callback replays with cyclic config metadata as non-fatal informational no-ops", async () => {
    const agentDir = await agentDirWithExtension(GLOBAL_PROVIDER_SOURCE.replace(
      'api: "openai-completions",',
      `api: "openai-completions",
       oauth: (() => {
         const oauth = {
           name: "Cyclic OAuth",
           async login() { throw new Error("unused login"); },
           async refreshToken() { throw new Error("unused refresh"); },
           getApiKey() { return "unused key"; }
         };
         oauth.self = oauth;
         return oauth;
       })(),`,
    ));
    const runtime = await createTestModelRuntime();
    const { entries, logger } = capturingLogger();
    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);
    const baseline = runtime.getRegisteredProviderConfig("global-config");
    if (!baseline?.oauth) throw new Error("Missing cyclic OAuth fixture");
    const oauth = { ...baseline.oauth, login: () => Promise.reject(new Error("unused replacement login")) };
    Object.assign(oauth, { self: oauth });
    expect(() => { runtime.registerProvider("global-config", { ...baseline, oauth }); }).not.toThrow();
    expect(entries.filter((entry) => entry.message === "ignored provider mutation after global bootstrap"))
      .toMatchObject([{ level: "info", details: { reason: "implementation-unverified" } }]);
    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baseline);
  });

  it("warns when adding a callback absent from a known startup registration", async () => {
    const agentDir = await agentDirWithExtension(GLOBAL_PROVIDER_SOURCE);
    const runtime = await createTestModelRuntime();
    const { entries, logger } = capturingLogger();
    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);
    runtime.registerProvider("global-config", {
      api: "openai-completions",
      streamSimple() { throw new Error("new-stream-secret"); },
    });
    expect(entries.find((entry) => entry.level === "warn")).toMatchObject({
      details: { code: "PROVIDER_MUTATION_IGNORED", reason: "configuration-change" },
    });
    expect(JSON.stringify(entries)).not.toContain("new-stream-secret");
  });

  it("keeps native registration and unregistration frozen for a known provider", async () => {
    const agentDir = await agentDirWithExtension(GLOBAL_PROVIDER_SOURCE);
    const runtime = await createTestModelRuntime();
    const { entries, logger } = capturingLogger();

    await bootstrapAndFreezeGlobalExtensionProviders(runtime, agentDir, logger);
    const baselineConfig = runtime.getRegisteredProviderConfig("global-config");

    runtime.registerNativeProvider(nativeProvider("global-config", "native-secret-name"));
    runtime.unregisterProvider("global-config");

    expect(runtime.getRegisteredProviderConfig("global-config")).toBe(baselineConfig);
    expect(runtime.getRegisteredNativeProvider("global-config")).toBeUndefined();
    expect(runtime.getModel("global-config", "global-model")).toBeDefined();
    expect(entries
      .filter((entry) => entry.message === "ignored provider mutation after global bootstrap")
      .map(({ details }) => ({ context: details["context"], operation: details["operation"], providerId: details["providerId"] }))).toEqual([
      { context: "global-provider-bootstrap", operation: "registerNativeProvider", providerId: "global-config" },
      { context: "global-provider-bootstrap", operation: "unregisterProvider", providerId: "global-config" },
    ]);
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
    expect(entries.find((entry) => entry.details["providerId"] === "after-diagnostic")).toMatchObject({
      level: "warn",
      details: {
        context: "global-provider-bootstrap",
        code: "PROVIDER_MUTATION_IGNORED",
        operation: "registerProvider",
        providerId: "after-diagnostic",
        reason: "not-in-startup-baseline",
      },
      message: "ignored provider mutation after global bootstrap",
    });
  });
});
