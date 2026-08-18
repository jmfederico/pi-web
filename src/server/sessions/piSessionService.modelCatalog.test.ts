import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, sessionGateway } from "./piSessionService.testSupport.js";

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

interface StartedSession {
  service: PiSessionService;
  ref: { id: string; cwd: string };
  agentDir: string;
}

async function startSessionWithSettings(settings: Record<string, unknown> | undefined): Promise<StartedSession> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-model-catalog-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  if (settings !== undefined) {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  }
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
    return { service, ref: { id: created.id, cwd: workspace }, agentDir };
  } catch (error) {
    await service.dispose();
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Settings writes are queued behind pi's write queue; poll the file until the edit lands. */
async function persistedEnabledModels(agentDir: string): Promise<{ found: boolean; value?: unknown }> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "settings.json"), "utf8");
  } catch {
    return { found: false };
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return { found: false };
  return Object.hasOwn(parsed, "enabledModels") ? { found: true, value: parsed["enabledModels"] } : { found: false };
}

async function expectPersistedEnabledModels(agentDir: string, expected: string[] | undefined): Promise<void> {
  await vi.waitFor(async () => {
    const persisted = await persistedEnabledModels(agentDir);
    if (expected === undefined) {
      expect(persisted.found).toBe(false);
    } else {
      expect(persisted).toEqual({ found: true, value: expected });
    }
  }, { timeout: 5_000 });
}

const catalogIds = (catalog: readonly { provider: string; id: string }[]): string[] => catalog.map((entry) => `${entry.provider}/${entry.id}`);

describe("PiSessionService model catalog", () => {
  it("marks every available model enabled in catalog order when no scope is configured", async () => {
    const { service, ref } = await startSessionWithSettings(undefined);
    try {
      const catalog = await service.modelCatalog(ref);
      const snapshotIds = catalogIds(modelRuntime.getAvailableSnapshot().map((model) => ({ provider: model.provider, id: model.id })));

      expect(catalog.length).toBeGreaterThan(1);
      expect(catalogIds(catalog)).toEqual(snapshotIds);
      expect(catalog.every((entry) => entry.enabled)).toBe(true);
      const first = catalog[0];
      expect(first?.provider).toBe(PROVIDER);
      expect(typeof first?.name).toBe("string");
      expect(typeof first?.contextWindow).toBe("number");
    } finally {
      await service.dispose();
    }
  });

  it("lists enabled models first in scoped order with the rest of the catalog below", async () => {
    const { service, ref } = await startSessionWithSettings({
      enabledModels: [`${PROVIDER}/${FIRST_MODEL}`, `${PROVIDER}/${DEFAULT_MODEL}`],
    });
    try {
      const catalog = await service.modelCatalog(ref);

      expect(catalogIds(catalog.slice(0, 2))).toEqual([`${PROVIDER}/${FIRST_MODEL}`, `${PROVIDER}/${DEFAULT_MODEL}`]);
      expect(catalog.slice(0, 2).map((entry) => entry.enabled)).toEqual([true, true]);
      const rest = catalog.slice(2);
      expect(rest.length).toBeGreaterThan(0);
      expect(rest.every((entry) => !entry.enabled)).toBe(true);
      expect([...catalogIds(catalog)].sort()).toEqual([...catalogIds(modelRuntime.getAvailableSnapshot())].sort());
    } finally {
      await service.dispose();
    }
  });

  it("persists a disable edit as an explicit list and narrows the live session scope", async () => {
    const { service, ref, agentDir } = await startSessionWithSettings(undefined);
    try {
      const catalog = await service.modelCatalog(ref);
      const target = catalog[0];
      if (target === undefined) throw new Error("expected a catalog entry");
      const remainingIds = catalogIds(catalog).filter((id) => id !== `${target.provider}/${target.id}`);

      const updated = await service.setModelEnabled(ref, target.provider, target.id, false);

      expect(updated.find((entry) => entry.provider === target.provider && entry.id === target.id)?.enabled).toBe(false);
      expect(catalogIds(updated)).toEqual([...remainingIds, `${target.provider}/${target.id}`]);
      await expectPersistedEnabledModels(agentDir, remainingIds);
      // The live scope follows immediately: the pickable models exclude the disabled one.
      expect(catalogIds((await service.availableModels(ref)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual(remainingIds);
    } finally {
      await service.dispose();
    }
  });

  it("normalizes re-enabling everything back to no scope, live and on disk", async () => {
    const { service, ref, agentDir } = await startSessionWithSettings(undefined);
    try {
      const catalog = await service.modelCatalog(ref);
      const target = catalog[0];
      if (target === undefined) throw new Error("expected a catalog entry");

      await service.setModelEnabled(ref, target.provider, target.id, false);
      const restored = await service.setModelEnabled(ref, target.provider, target.id, true);

      expect(restored.every((entry) => entry.enabled)).toBe(true);
      // The response is the fresh post-edit read: no scope, so plain catalog order.
      expect(catalogIds(restored)).toEqual(catalogIds(catalog));
      await expectPersistedEnabledModels(agentDir, undefined);
      expect(catalogIds((await service.availableModels(ref)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual(catalogIds(catalog));
    } finally {
      await service.dispose();
    }
  });

  it("resolves configured glob patterns to explicit ids when an edit is persisted, like pi's selector", async () => {
    const { service, ref, agentDir } = await startSessionWithSettings({ enabledModels: [`${PROVIDER}/*sonnet*`] });
    try {
      const catalog = await service.modelCatalog(ref);
      const matchedIds = catalogIds(catalog.filter((entry) => entry.enabled));
      expect(matchedIds.length).toBeGreaterThan(0);
      expect(matchedIds.every((id) => id.includes("sonnet"))).toBe(true);
      const target = catalog.find((entry) => !entry.enabled);
      if (target === undefined) throw new Error("expected a disabled catalog entry");

      const updated = await service.setModelEnabled(ref, target.provider, target.id, true);

      expect(updated.find((entry) => entry.provider === target.provider && entry.id === target.id)?.enabled).toBe(true);
      await expectPersistedEnabledModels(agentDir, [...matchedIds, `${target.provider}/${target.id}`]);
    } finally {
      await service.dispose();
    }
  });

  it("keeps stale no-match patterns through an edit, mirroring pi", async () => {
    const { service, ref, agentDir } = await startSessionWithSettings({ enabledModels: ["anthropic/not-a-real-model"] });
    try {
      const catalog = await service.modelCatalog(ref);
      expect(catalog.every((entry) => !entry.enabled)).toBe(true);
      const target = catalog[0];
      if (target === undefined) throw new Error("expected a catalog entry");

      await service.setModelEnabled(ref, target.provider, target.id, true);

      await expectPersistedEnabledModels(agentDir, ["anthropic/not-a-real-model", `${target.provider}/${target.id}`]);
      expect(catalogIds((await service.availableModels(ref)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual([`${target.provider}/${target.id}`]);
    } finally {
      await service.dispose();
    }
  });

  it("rejects an unknown model without touching the persisted scope", async () => {
    const { service, ref, agentDir } = await startSessionWithSettings({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}`] });
    try {
      await expect(service.setModelEnabled(ref, PROVIDER, "not-a-real-model", true)).rejects.toThrow(`Model not found: ${PROVIDER}/not-a-real-model`);
      expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}`] });
    } finally {
      await service.dispose();
    }
  });
});
