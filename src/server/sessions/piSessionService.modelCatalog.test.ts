import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
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
      expect(catalog.map((entry) => entry.catalogIndex)).toEqual(snapshotIds.map((_, index) => index));
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
      const naturalIds = catalogIds(modelRuntime.getAvailableSnapshot());
      expect(catalog.every((entry) => naturalIds[entry.catalogIndex ?? -1] === `${entry.provider}/${entry.id}`)).toBe(true);
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

  it("lazily projects a scope change into another active session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-model-scope-sync-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}`] }));

    const hub = new CapturingSessionEventHub();
    const gateway = sessionGateway([]);
    gateway.create = (cwd) => SessionManager.inMemory(cwd);
    const service = new PiSessionService(hub, {
      agentDir,
      modelRuntime,
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });
    try {
      const first = await service.start(workspace);
      const second = await service.start(workspace);
      const secondRef = { id: second.id, cwd: workspace };
      const before = await service.availableModels(secondRef);
      expect(catalogIds(before.map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual([`${PROVIDER}/${FIRST_MODEL}`]);

      const target = modelRuntime.getAvailableSnapshot().find((model) => model.id !== FIRST_MODEL);
      if (target === undefined) throw new Error("expected a second available model");
      await service.setModelEnabled({ id: first.id, cwd: workspace }, target.provider, target.id, true);

      expect(catalogIds((await service.availableModels(secondRef)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual([
        `${PROVIDER}/${FIRST_MODEL}`,
        `${target.provider}/${target.id}`,
      ]);
      expect((await service.modelCatalog(secondRef)).find((entry) => entry.provider === target.provider && entry.id === target.id)?.enabled).toBe(true);
      expect(hub.globalEvents).toContainEqual({ type: "models.changed", revision: 1 });
    } finally {
      await service.dispose();
    }
  });

  it("keeps a workspace enabled-model override isolated from global edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-model-scope-domains-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(workspaceA, ".pi"), { recursive: true });
    await mkdir(workspaceB, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}`] }));
    await writeFile(join(workspaceA, ".pi", "settings.json"), JSON.stringify({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}`, `${PROVIDER}/${DEFAULT_MODEL}`] }));
    new ProjectTrustStore(agentDir).set(workspaceA, true);

    const hub = new CapturingSessionEventHub();
    const gateway = sessionGateway([]);
    gateway.create = (cwd) => SessionManager.inMemory(cwd);
    const service = new PiSessionService(hub, {
      agentDir,
      modelRuntime,
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });
    try {
      const globalSession = await service.start(workspaceB);
      const projectSession = await service.start(workspaceA);
      const projectRef = { id: projectSession.id, cwd: workspaceA };
      const globalRef = { id: globalSession.id, cwd: workspaceB };
      expect(catalogIds((await service.availableModels(globalRef)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual([`${PROVIDER}/${FIRST_MODEL}`]);
      const projectIds = catalogIds((await service.availableModels(projectRef)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })));
      expect(projectIds).toEqual([`${PROVIDER}/${FIRST_MODEL}`, `${PROVIDER}/${DEFAULT_MODEL}`]);

      const target = modelRuntime.getAvailableSnapshot().find((model) => !projectIds.includes(`${model.provider}/${model.id}`));
      if (target === undefined) throw new Error("expected a model outside the project override");
      await service.setModelEnabled(globalRef, target.provider, target.id, true);

      expect(catalogIds((await service.availableModels(globalRef)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual([
        `${PROVIDER}/${FIRST_MODEL}`,
        `${target.provider}/${target.id}`,
      ]);
      expect(catalogIds((await service.availableModels(projectRef)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual(projectIds);
      expect((await service.modelCatalog(projectRef)).every((entry) => entry.editable === false)).toBe(true);
      expect((await service.modelCatalog(globalRef)).every((entry) => entry.editable !== false)).toBe(true);
      await expect(service.setModelScope(projectRef, "all")).rejects.toThrow("workspace's .pi/settings.json");
      expect(hub.globalEvents).toContainEqual({ type: "models.changed", revision: 1 });
    } finally {
      await service.dispose();
    }
  });

  it("serializes concurrent per-model edits so neither update is lost", async () => {
    const { service, ref } = await startSessionWithSettings(undefined);
    try {
      const current = (await service.status(ref)).model;
      const currentId = current?.provider === undefined || current.id === undefined ? undefined : `${current.provider}/${current.id}`;
      const targets = (await service.modelCatalog(ref)).filter((entry) => `${entry.provider}/${entry.id}` !== currentId).slice(0, 2);
      expect(targets).toHaveLength(2);

      await Promise.all(targets.map((target) => service.setModelEnabled(ref, target.provider, target.id, false)));

      const updated = await service.modelCatalog(ref);
      for (const target of targets) {
        expect(updated.find((entry) => entry.provider === target.provider && entry.id === target.id)?.enabled).toBe(false);
      }
    } finally {
      await service.dispose();
    }
  });

  it("atomically narrows to the current model and clears the setting when selecting all", async () => {
    const { service, ref, agentDir } = await startSessionWithSettings(undefined);
    try {
      const status = await service.status(ref);
      const current = status.model;
      if (current?.provider === undefined || current.id === undefined) throw new Error("expected a current model");
      const currentId = `${current.provider}/${current.id}`;

      const narrowed = await service.setModelScope(ref, "current");

      expect(catalogIds(narrowed.filter((entry) => entry.enabled))).toEqual([currentId]);
      await expectPersistedEnabledModels(agentDir, [currentId]);
      expect(catalogIds((await service.availableModels(ref)).map((model) => ({ provider: model.provider ?? "", id: model.id ?? "" })))).toEqual([currentId]);
      await expect(service.setModelEnabled(ref, current.provider, current.id, false)).rejects.toThrow("Current model cannot be disabled");

      const all = await service.setModelScope(ref, "all");

      expect(all.every((entry) => entry.enabled)).toBe(true);
      await expectPersistedEnabledModels(agentDir, undefined);
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
