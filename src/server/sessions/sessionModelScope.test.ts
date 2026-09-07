import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, ProjectTrustStore, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, sessionGateway } from "./piSessionService.testSupport.js";
import { applyEnabledModelToggle, catalogWithEnabledFirst, liveScopedModelIds, persistedEnabledModelPatterns, resolveEnabledModelIds, resolveSessionModelOptions, scopedModelsFromEnabledIds } from "./sessionModelScope.js";

const PROVIDER = "anthropic";
const FIRST_MODEL = "claude-opus-4-6";
const DEFAULT_MODEL = "claude-sonnet-4-5";

let modelRuntime: ModelRuntime;
const tempDirs: string[] = [];

beforeAll(async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, () => Promise.resolve({ type: "api_key", key: "sk-test" }));
  modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function services(settings: { enabledModels?: string[]; defaultProvider?: string; defaultModel?: string }) {
  return {
    modelRuntime,
    settingsManager: SettingsManager.inMemory(settings),
  };
}

describe("resolveSessionModelOptions", () => {
  it("preserves configured scope order and selects an in-scope saved default", async () => {
    const resolved = await resolveSessionModelOptions({
      services: services({
        enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`, `${PROVIDER}/${DEFAULT_MODEL}:low`],
        defaultProvider: PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }),
      hasExistingSession: false,
    });

    expect(resolved.scopedModels.map(({ model, thinkingLevel }) => ({ id: model.id, thinkingLevel }))).toEqual([
      { id: FIRST_MODEL, thinkingLevel: "high" },
      { id: DEFAULT_MODEL, thinkingLevel: "low" },
    ]);
    expect(resolved.model?.id).toBe(DEFAULT_MODEL);
    expect(resolved.thinkingLevel).toBe("low");
    expect(resolved.diagnostics).toEqual([]);
  });

  it("uses the first scoped model and its pinned thinking when the saved default is outside scope", async () => {
    const resolved = await resolveSessionModelOptions({
      services: services({
        enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`],
        defaultProvider: PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }),
      hasExistingSession: false,
    });

    expect(resolved.model?.id).toBe(FIRST_MODEL);
    expect(resolved.thinkingLevel).toBe("high");
  });

  it("keeps an explicit model and thinking level while still populating the cycle scope", async () => {
    const explicitModel = modelRuntime.getModel(PROVIDER, DEFAULT_MODEL);
    if (explicitModel === undefined) throw new Error("expected explicit model fixture");

    const resolved = await resolveSessionModelOptions({
      services: services({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`] }),
      hasExistingSession: false,
      initialModel: explicitModel,
      initialThinkingLevel: "minimal",
    });

    expect(resolved.model).toBe(explicitModel);
    expect(resolved.thinkingLevel).toBe("minimal");
    expect(resolved.scopedModels.map(({ model }) => model.id)).toEqual([FIRST_MODEL]);
  });

  it("leaves the initial model unset for an existing session so pi can restore it", async () => {
    const resolved = await resolveSessionModelOptions({
      services: services({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`] }),
      hasExistingSession: true,
    });

    expect(resolved.model).toBeUndefined();
    expect(resolved.thinkingLevel).toBeUndefined();
    expect(resolved.scopedModels.map(({ model }) => model.id)).toEqual([FIRST_MODEL]);
  });

  it("keeps an empty runtime scope when enabledModels is absent", async () => {
    await expect(resolveSessionModelOptions({
      services: services({}),
      hasExistingSession: false,
    })).resolves.toEqual({ scopedModels: [], diagnostics: [] });
  });

  it("reports unmatched patterns without blocking startup or inventing a scope", async () => {
    const resolved = await resolveSessionModelOptions({
      services: services({ enabledModels: ["anthropic/not-a-real-model"] }),
      hasExistingSession: false,
    });

    expect(resolved.scopedModels).toEqual([]);
    expect(resolved.model).toBeUndefined();
    expect(resolved.diagnostics).toEqual([{
      type: "warning",
      message: 'No models match pattern "anthropic/not-a-real-model"',
    }]);
  });

  it("keeps a matched model while surfacing an invalid pinned thinking level", async () => {
    const pattern = `${PROVIDER}/${FIRST_MODEL}:turbo`;
    const resolved = await resolveSessionModelOptions({
      services: services({ enabledModels: [pattern] }),
      hasExistingSession: false,
    });

    expect(resolved.scopedModels.map(({ model }) => model.id)).toEqual([FIRST_MODEL]);
    expect(resolved.scopedModels[0]?.thinkingLevel).toBeUndefined();
    expect(resolved.diagnostics).toEqual([{
      type: "warning",
      message: `Invalid thinking level "turbo" in pattern "${pattern}". Using default instead.`,
    }]);
  });

  it("wires project-overridden enabledModels into real PI WEB sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-model-scope-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      enabledModels: [`${PROVIDER}/${FIRST_MODEL}`],
    }));
    await writeFile(join(workspace, ".pi", "settings.json"), JSON.stringify({
      enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`, `${PROVIDER}/${DEFAULT_MODEL}:low`],
      defaultProvider: PROVIDER,
      defaultModel: DEFAULT_MODEL,
    }));
    // Project settings are trust-gated: a workspace shipping `.pi/settings.json`
    // only loads its overrides once trusted. Persist the decision through the
    // SDK store so the key is canonicalized the way the lookup reads it.
    new ProjectTrustStore(agentDir).set(workspace, true);

    const gateway = sessionGateway([]);
    gateway.create = (cwd) => SessionManager.inMemory(cwd);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir,
      modelRuntime,
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    try {
      const created = await service.start(workspace);
      await expect(service.availableModels({ id: created.id, cwd: workspace })).resolves.toEqual([
        expect.objectContaining({ provider: PROVIDER, id: FIRST_MODEL }),
        expect.objectContaining({ provider: PROVIDER, id: DEFAULT_MODEL }),
      ]);
      await expect(service.status({ id: created.id, cwd: workspace })).resolves.toMatchObject({
        model: { provider: PROVIDER, id: DEFAULT_MODEL },
        thinkingLevel: "low",
      });
      await expect(service.cycleModel({ id: created.id, cwd: workspace }, "forward")).resolves.toMatchObject({
        model: { provider: PROVIDER, id: FIRST_MODEL },
        thinkingLevel: "high",
      });
    } finally {
      await service.dispose();
    }
  });
});

describe("resolveEnabledModelIds", () => {
  it("prefers the session's live scope over configured patterns, mirroring pi's selector", async () => {
    const ids = await resolveEnabledModelIds({
      settingsManager: SettingsManager.inMemory({ enabledModels: [`${PROVIDER}/${DEFAULT_MODEL}`] }),
      modelRuntime,
      scopedModels: [{ model: { provider: PROVIDER, id: FIRST_MODEL } }],
    });

    expect(ids).toEqual([`${PROVIDER}/${FIRST_MODEL}`]);
  });

  it("returns null when no scope is configured, pi's \"everything enabled\" state", async () => {
    await expect(resolveEnabledModelIds({
      settingsManager: SettingsManager.inMemory({}),
      modelRuntime,
      scopedModels: [],
    })).resolves.toBeNull();
    await expect(resolveEnabledModelIds({
      settingsManager: SettingsManager.inMemory({ enabledModels: [] }),
      modelRuntime,
      scopedModels: [],
    })).resolves.toBeNull();
  });

  it("resolves configured patterns against the runtime catalog when no live scope exists", async () => {
    const ids = await resolveEnabledModelIds({
      settingsManager: SettingsManager.inMemory({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}`, `${PROVIDER}/${DEFAULT_MODEL}`] }),
      modelRuntime,
      scopedModels: [],
    });

    expect(ids).toEqual([`${PROVIDER}/${FIRST_MODEL}`, `${PROVIDER}/${DEFAULT_MODEL}`]);
  });

  it("keeps no-match patterns in the list so edits cannot silently drop them", async () => {
    const ids = await resolveEnabledModelIds({
      settingsManager: SettingsManager.inMemory({ enabledModels: ["anthropic/not-a-real-model", `${PROVIDER}/${FIRST_MODEL}`] }),
      modelRuntime,
      scopedModels: [],
    });

    // pi appends no-match patterns after the resolved matches, regardless of
    // their configured order.
    expect(ids).toEqual([`${PROVIDER}/${FIRST_MODEL}`, "anthropic/not-a-real-model"]);
  });
});

describe("applyEnabledModelToggle", () => {
  const available = ["anthropic/a", "anthropic/b", "openai/c"];

  it("treats enabling a model in the all-enabled state as a no-op", () => {
    expect(applyEnabledModelToggle(null, available, "anthropic/a", true)).toBeNull();
  });

  it("disabling from the all-enabled state narrows to everything but the target", () => {
    expect(applyEnabledModelToggle(null, available, "anthropic/a", false)).toEqual(["anthropic/b", "openai/c"]);
  });

  it("appends newly enabled models, preserving the existing enabled order", () => {
    expect(applyEnabledModelToggle(["anthropic/b"], available, "openai/c", true)).toEqual(["anthropic/b", "openai/c"]);
  });

  it("returns the same reference when the toggle changes nothing", () => {
    const enabled = ["anthropic/a", "anthropic/b"];
    expect(applyEnabledModelToggle(enabled, available, "anthropic/a", true)).toBe(enabled);
    expect(applyEnabledModelToggle(enabled, available, "openai/c", false)).toBe(enabled);
  });

  it("removes disabled models from the list", () => {
    expect(applyEnabledModelToggle(["anthropic/a", "anthropic/b"], available, "anthropic/a", false)).toEqual(["anthropic/b"]);
  });
});

describe("persistedEnabledModelPatterns", () => {
  const available = ["anthropic/a", "anthropic/b"];

  it("normalizes the all-enabled state to undefined (no scope), like pi", () => {
    expect(persistedEnabledModelPatterns(null, available)).toBeUndefined();
    expect(persistedEnabledModelPatterns(["anthropic/a", "anthropic/b"], available)).toBeUndefined();
  });

  it("persists partial scopes as the explicit id list", () => {
    expect(persistedEnabledModelPatterns(["anthropic/b"], available)).toEqual(["anthropic/b"]);
    expect(persistedEnabledModelPatterns([], available)).toEqual([]);
  });

  it("keeps stale patterns riding along even when they make the list longer than the catalog", () => {
    expect(persistedEnabledModelPatterns(["anthropic/a", "anthropic/b", "anthropic/gone"], available)).toEqual(["anthropic/a", "anthropic/b", "anthropic/gone"]);
  });
});

describe("liveScopedModelIds", () => {
  const available = ["anthropic/a", "anthropic/b"];

  it("clears the scope for the all-enabled state and for lists covering the whole catalog", () => {
    expect(liveScopedModelIds(null, available)).toBeNull();
    expect(liveScopedModelIds(["anthropic/a", "anthropic/b"], available)).toBeNull();
  });

  it("clears the scope when no enabled id is currently available, like pi", () => {
    expect(liveScopedModelIds([], available)).toBeNull();
    expect(liveScopedModelIds(["anthropic/gone"], available)).toBeNull();
  });

  it("scopes the session to a partial enabled list", () => {
    expect(liveScopedModelIds(["anthropic/b"], available)).toEqual(["anthropic/b"]);
  });
});

describe("scopedModelsFromEnabledIds", () => {
  const available = [
    { provider: "anthropic", id: "a" },
    { provider: "anthropic", id: "b" },
  ];

  it("resolves a partial scope while dropping stale ids", () => {
    expect(scopedModelsFromEnabledIds(available, ["anthropic/b", "anthropic/gone"]).map(({ model }) => `${model.provider}/${model.id}`)).toEqual(["anthropic/b"]);
  });

  it("returns an empty SDK scope when every model is enabled", () => {
    expect(scopedModelsFromEnabledIds(available, null)).toEqual([]);
    expect(scopedModelsFromEnabledIds(available, ["anthropic/a", "anthropic/b"])).toEqual([]);
  });
});

describe("catalogWithEnabledFirst", () => {
  const available = [
    { provider: "anthropic", id: "a" },
    { provider: "anthropic", id: "b" },
    { provider: "openai", id: "c" },
  ];

  it("marks every model enabled in catalog order when nothing is scoped", () => {
    expect(catalogWithEnabledFirst(available, null)).toEqual([
      { model: available[0], enabled: true, catalogIndex: 0 },
      { model: available[1], enabled: true, catalogIndex: 1 },
      { model: available[2], enabled: true, catalogIndex: 2 },
    ]);
  });

  it("lists enabled models first in enabled-list order, then the rest in catalog order", () => {
    expect(catalogWithEnabledFirst(available, ["openai/c", "anthropic/a"])).toEqual([
      { model: available[2], enabled: true, catalogIndex: 2 },
      { model: available[0], enabled: true, catalogIndex: 0 },
      { model: available[1], enabled: false, catalogIndex: 1 },
    ]);
  });

  it("skips enabled ids that match nothing available and ignores duplicates", () => {
    expect(catalogWithEnabledFirst(available, ["anthropic/gone", "anthropic/a", "anthropic/a"])).toEqual([
      { model: available[0], enabled: true, catalogIndex: 0 },
      { model: available[1], enabled: false, catalogIndex: 1 },
      { model: available[2], enabled: false, catalogIndex: 2 },
    ]);
  });
});
