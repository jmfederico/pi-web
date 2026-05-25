import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  });

  it("adds remote machines and omits secrets from public responses", async () => {
    const machine = await service.add({ name: " Dev Box ", baseUrl: "https://devbox.example.test/", token: "secret" });

    expect(machine).toMatchObject({ name: "Dev Box", kind: "remote", baseUrl: "https://devbox.example.test" });
    expect(machine).not.toHaveProperty("token");
    expect(await service.list()).toEqual([expect.objectContaining({ id: "local", kind: "local" }), machine]);

    const raw: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(raw).toMatchObject({ machines: [expect.objectContaining({ kind: "remote", token: "secret" })] });
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

  it("does not allow local machine mutation", async () => {
    await expect(service.update("local", { name: "Other" })).rejects.toThrow("Local machine cannot be changed");
    await expect(service.remove("local")).rejects.toThrow("Local machine cannot be deleted");
  });

  it("supports PI_WEB_MACHINES_FILE path overrides", () => {
    const env: NodeJS.ProcessEnv = { PI_WEB_MACHINES_FILE: "data/machines.json" };
    expect(machineStorePath(env, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "data/machines.json"));
  });
});
