import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiWebRuntimeResponse } from "../../shared/apiTypes.js";
import { PI_WEB_CAPABILITIES } from "../../shared/capabilities.js";
import type { MachineClient } from "./machineClient.js";
import { MachineService } from "./machineService.js";
import { MachineStore, machineStorePath } from "./machineStore.js";

let tempDir: string;
let storePath: string;
let service: MachineService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-machines-test-"));
  storePath = join(tempDir, "machines.json");
  service = new MachineService(new MachineStore(storePath));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("MachineService", () => {
  it("synthesizes local machine without persisting it", async () => {
    expect(await service.list()).toEqual([
      { id: "local", name: "Local", kind: "local", createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z" },
    ]);
    await expect(stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adds remote machines and omits secrets from public responses", async () => {
    const machine = await service.add({ name: " Dev Box ", baseUrl: "https://devbox.example.test/", token: "secret" });

    expect(machine).toMatchObject({ name: "Dev Box", kind: "remote", baseUrl: "https://devbox.example.test" });
    expect(machine).not.toHaveProperty("token");
    expect(await service.list()).toEqual([expect.objectContaining({ id: "local", kind: "local" }), machine]);

    const raw: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(raw).toMatchObject({ machines: [expect.objectContaining({ kind: "remote", token: "secret" })] });
    await expectOwnerOnlyMachineStore(storePath);
  });

  it("gets, updates, and removes remote machines without exposing stored secrets", async () => {
    const machine = await service.add({
      name: "Remote",
      baseUrl: "https://remote.example.test",
      token: "initial-secret",
      headers: { "X-Pi-Web-Test": "initial" },
    });

    expect(await service.get(machine.id)).toEqual(machine);

    const updated = await service.update(machine.id, {
      name: " Updated Remote ",
      baseUrl: "https://updated.example.test/",
      token: "updated-secret",
      headers: { "X-Pi-Web-Test": "updated" },
    });
    if (updated === undefined) throw new Error("Expected remote machine update to succeed");

    expect(updated).toMatchObject({
      id: machine.id,
      name: "Updated Remote",
      kind: "remote",
      baseUrl: "https://updated.example.test",
      createdAt: machine.createdAt,
    });
    expect(updated).not.toHaveProperty("token");
    expect(updated).not.toHaveProperty("headers");
    expect(await service.get(machine.id)).toEqual(updated);
    expect(await service.list()).toEqual([expect.objectContaining({ id: "local", kind: "local" }), updated]);

    const persistedAfterUpdate: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(persistedAfterUpdate).toMatchObject({
      machines: [expect.objectContaining({
        id: machine.id,
        name: "Updated Remote",
        baseUrl: "https://updated.example.test",
        token: "updated-secret",
        headers: { "X-Pi-Web-Test": "updated" },
      })],
    });

    await expect(service.remove(machine.id)).resolves.toBe(true);
    await expect(service.get(machine.id)).resolves.toBeUndefined();
    await expect(service.remove(machine.id)).resolves.toBe(false);
    expect(await service.list()).toEqual([expect.objectContaining({ id: "local", kind: "local" })]);

    const persistedAfterRemove: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(persistedAfterRemove).toEqual({ machines: [] });
  });

  it.skipIf(process.platform === "win32")("tightens permissions after reading an existing machine store", async () => {
    await writeFile(storePath, `${JSON.stringify({
      machines: [{
        id: "remote-1",
        name: "Remote",
        kind: "remote",
        baseUrl: "https://remote.example.test",
        token: "secret",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      }],
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    await chmod(storePath, 0o644);

    await expect(service.list()).resolves.toEqual([expect.objectContaining({ id: "local" }), expect.objectContaining({ id: "remote-1" })]);

    await expectOwnerOnlyMachineStore(storePath);
  });

  it("rejects invalid remote base URLs", async () => {
    await expect(service.add({ name: "Bad", baseUrl: "ftp://example.test" })).rejects.toThrow("http or https");
    await expect(service.add({ name: "Bad", baseUrl: "https://user@example.test" })).rejects.toThrow("credentials");
    await expect(service.add({ name: "Bad", baseUrl: "https://example.test/path?q=1" })).rejects.toThrow("query or hash");
  });

  it("rejects configured machine headers that would override proxy transport semantics", async () => {
    await expect(service.add({ name: "Bad", baseUrl: "https://example.test", headers: { Authorization: "Bearer secret" } })).rejects.toThrow("not allowed");
    await expect(service.add({ name: "Bad", baseUrl: "https://example.test", headers: { Connection: "close" } })).rejects.toThrow("not allowed");
  });

  it("uses the lightweight runtime check for local machine health", async () => {
    const localRuntime = vi.fn(() => Promise.resolve({
      packageName: "@jmfederico/pi-web",
      generatedAt: "2026-05-25T00:00:00.000Z",
      components: {
        web: { component: "web" as const, label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: [] },
        sessiond: { component: "sessiond" as const, label: "Session daemon", runtimeVersion: "1.0.0", available: true, capabilities: [] },
      },
      capabilities: [],
    }));
    const healthService = new MachineService(new MachineStore(storePath), {
      localRuntime,
      now: () => new Date("2026-05-25T00:00:00.000Z"),
    });

    const health = await healthService.health("local");

    expect(localRuntime).toHaveBeenCalledTimes(1);
    expect(health).toEqual({
      machineId: "local",
      ok: true,
      checkedAt: "2026-05-25T00:00:00.000Z",
      status: "online",
      web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", stale: false, available: true },
    });
  });

  it("fetches and caches remote runtime through the configured client", async () => {
    const body = remoteRuntimeBody();
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({ statusCode: 200, headers: {}, body }));
    const factoryMachines: unknown[] = [];
    const remoteService = new MachineService(new MachineStore(storePath), {
      remoteClientFactory: (machine) => {
        factoryMachines.push(machine);
        return fakeRemoteClient({ requestJson });
      },
      now: () => new Date("2026-05-25T00:00:00.000Z"),
      runtimeCacheTtlMs: 10_000,
    });
    const machine = await remoteService.add({
      name: " Remote ",
      baseUrl: "https://remote.example.test/",
      token: "secret",
      headers: { "X-Pi-Web-Test": "yes" },
    });

    const first = await remoteService.runtime(machine.id);
    const second = await remoteService.runtime(machine.id);
    const forced = await remoteService.runtime(machine.id, true);

    expect(first).toEqual({
      machineId: machine.id,
      ok: true,
      checkedAt: "2026-05-25T00:00:00.000Z",
      packageName: body.packageName,
      generatedAt: body.generatedAt,
      components: body.components,
      capabilities: body.capabilities,
    });
    expect(second).toEqual(first);
    expect(forced).toEqual(first);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson).toHaveBeenCalledWith("GET", "/api/pi-web/runtime", undefined, { timeoutMs: 3000 });
    expect(factoryMachines).toEqual([
      expect.objectContaining({
        id: machine.id,
        name: "Remote",
        baseUrl: "https://remote.example.test",
        token: "secret",
        headers: { "X-Pi-Web-Test": "yes" },
      }),
      expect.objectContaining({ id: machine.id }),
    ]);
  });

  it("caches remote runtime errors and clears them after remote updates", async () => {
    let now = new Date("2026-05-25T00:00:00.000Z");
    const body = remoteRuntimeBody();
    const requestJson = vi.fn<MachineClient["requestJson"]>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ statusCode: 200, headers: {}, body });
    const remoteService = new MachineService(new MachineStore(storePath), {
      remoteClientFactory: () => fakeRemoteClient({ requestJson }),
      now: () => now,
      runtimeCacheTtlMs: 10_000,
    });
    const machine = await remoteService.add({ name: "Remote", baseUrl: "https://remote.example.test" });

    const errorRuntime = await remoteService.runtime(machine.id);
    now = new Date("2026-05-25T00:00:01.000Z");
    const cachedErrorRuntime = await remoteService.runtime(machine.id);
    await remoteService.update(machine.id, { name: "Remote Updated" });
    now = new Date("2026-05-25T00:00:02.000Z");
    const refreshedRuntime = await remoteService.runtime(machine.id);

    expect(errorRuntime).toEqual({
      machineId: machine.id,
      ok: false,
      checkedAt: "2026-05-25T00:00:00.000Z",
      error: "network down",
    });
    expect(cachedErrorRuntime).toEqual(errorRuntime);
    expect(refreshedRuntime).toEqual({
      machineId: machine.id,
      ok: true,
      checkedAt: "2026-05-25T00:00:02.000Z",
      packageName: body.packageName,
      generatedAt: body.generatedAt,
      components: body.components,
      capabilities: body.capabilities,
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("does not allow local machine mutation", async () => {
    await expect(service.update("local", { name: "Other" })).rejects.toThrow("Local machine cannot be changed");
    await expect(service.remove("local")).rejects.toThrow("Local machine cannot be deleted");
  });

  it("supports PI_WEB_MACHINES_FILE path overrides", () => {
    const env: NodeJS.ProcessEnv = { PI_WEB_MACHINES_FILE: "data/machines.json" };
    expect(machineStorePath(env, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "data/machines.json"));
  });
});

async function expectOwnerOnlyMachineStore(path: string): Promise<void> {
  if (process.platform === "win32") return;
  expect((await stat(path)).mode & 0o777).toBe(0o600);
}

function remoteRuntimeBody(): PiWebRuntimeResponse {
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt: "2026-05-25T00:00:00.000Z",
    components: {
      web: {
        component: "web",
        label: "Remote Web",
        runtimeVersion: "1.0.0",
        available: true,
        capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.piPackagesManage],
      },
      sessiond: {
        component: "sessiond",
        label: "Remote Session daemon",
        runtimeVersion: "1.0.0",
        available: true,
        capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived],
      },
    },
    capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.piPackagesManage],
  };
}

function fakeRemoteClient(overrides: Partial<MachineClient>): MachineClient {
  return {
    request: () => { throw new Error("HTTP request not configured for test"); },
    requestJson: () => { throw new Error("JSON request not configured for test"); },
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
    ...overrides,
  };
}
