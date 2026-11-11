import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiPackageProvisioningStore, piPackageProvisioningStorePath } from "./piPackageProvisioningStore.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

let root: string;
let file: string;
let store: PiPackageProvisioningStore;
const entry = { profileDir: "/agent", packageId: "@example/package", provisionedAt: "2026-11-12T10:00:00.000Z" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-provisioning-store-"));
  file = join(root, "provisioning.json");
  store = new PiPackageProvisioningStore(file);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("PiPackageProvisioningStore", () => {
  it("keeps the ledger under the selected PI WEB data directory", () => {
    expect(piPackageProvisioningStorePath({ PI_WEB_DATA_DIR: "data" }, "/project")).toBe(resolve("/project", "data", "pi-package-provisioning.json"));
  });

  it("persists separate profile/package identities and preserves the first date", async () => {
    expect(await store.has(entry.profileDir, entry.packageId)).toBe(false);
    await store.record(entry);
    await store.record({ ...entry, provisionedAt: "2026-12-01T10:00:00.000Z" });
    expect(await store.has("/other", entry.packageId)).toBe(false);
    expect(await store.has(entry.profileDir, "@example/other")).toBe(false);
    await store.record({ ...entry, profileDir: "/other" });
    await store.record({ ...entry, packageId: "@example/other" });
    expect(await new PiPackageProvisioningStore(file).has(entry.profileDir, entry.packageId)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ provisioned: [entry, { ...entry, profileDir: "/other" }, { ...entry, packageId: "@example/other" }] });
  });

  it.each(["{broken", "{}", JSON.stringify({ provisioned: [{ profileDir: "/agent" }] })])("does not replace invalid state: %s", async (contents) => {
    await writeFile(file, contents);
    await expect(store.has(entry.profileDir, entry.packageId)).rejects.toThrow();
    await expect(store.record(entry)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  it("preserves the previous ledger and cleans up when atomic replacement fails", async () => {
    await store.record(entry);
    const saved = await readFile(file, "utf8");
    vi.mocked(rename).mockRejectedValueOnce(new Error("replacement failed"));
    await expect(store.record({ ...entry, packageId: "@example/other" })).rejects.toThrow("replacement failed");
    expect(await readFile(file, "utf8")).toBe(saved);
    expect(await readdir(root)).toEqual(["provisioning.json"]);
    await store.record({ ...entry, packageId: "@example/other" });
    expect(await store.has(entry.profileDir, "@example/other")).toBe(true);
  });
});
