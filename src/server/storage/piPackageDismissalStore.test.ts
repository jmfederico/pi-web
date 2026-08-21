import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiPackageDismissalStore, piPackageDismissalStorePath } from "./piPackageDismissalStore.js";

describe("piPackageDismissalStorePath", () => {
  it("uses PI_WEB_DATA_DIR by default", () => {
    expect(piPackageDismissalStorePath({ PI_WEB_DATA_DIR: "demo-data" }, "/tmp/pi-web")).toBe(
      resolve("/tmp/pi-web", "demo-data", "pi-package-dismissals.json"),
    );
  });

  it("uses PI_WEB_PI_PACKAGE_DISMISSALS_FILE when configured", () => {
    expect(piPackageDismissalStorePath({ PI_WEB_PI_PACKAGE_DISMISSALS_FILE: "demo/dismissals.json" }, "/tmp/pi-web")).toBe(
      resolve("/tmp/pi-web", "demo/dismissals.json"),
    );
  });
});

describe("PiPackageDismissalStore", () => {
  let tempDir: string;
  let storePath: string;
  let store: PiPackageDismissalStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-web-pi-package-dismissals-test-"));
    storePath = join(tempDir, "pi-package-dismissals.json");
    store = new PiPackageDismissalStore(storePath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reports nothing dismissed before the file exists", async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.isDismissed("/home/user/.pi", "@jmfederico/pi-relay")).toBe(false);
  });

  it("records a dismissal for a profile directory and package id", async () => {
    await store.dismiss("/home/user/.pi", "@jmfederico/pi-relay");

    expect(await store.isDismissed("/home/user/.pi", "@jmfederico/pi-relay")).toBe(true);
    const dismissals = await store.list();
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0]).toMatchObject({ profileDir: "/home/user/.pi", packageId: "@jmfederico/pi-relay" });
    expect(typeof dismissals[0]?.dismissedAt).toBe("string");

    const raw: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(raw).toMatchObject({ dismissals: [{ profileDir: "/home/user/.pi", packageId: "@jmfederico/pi-relay" }] });
  });

  it("is idempotent: dismissing the same profile/package twice keeps a single entry", async () => {
    await store.dismiss("/home/user/.pi", "@jmfederico/pi-relay");
    await store.dismiss("/home/user/.pi", "@jmfederico/pi-relay");

    expect(await store.list()).toHaveLength(1);
  });

  it("tracks dismissals independently per profile directory and per package id", async () => {
    await store.dismiss("/home/user/.pi", "@jmfederico/pi-relay");

    expect(await store.isDismissed("/home/other/.pi", "@jmfederico/pi-relay")).toBe(false);
    expect(await store.isDismissed("/home/user/.pi", "@acme/other-package")).toBe(false);
  });

  it("rejects a malformed dismissal file instead of silently ignoring it", async () => {
    await writeFile(storePath, `${JSON.stringify({ dismissals: [{ profileDir: "/home/user/.pi" }] })}\n`, "utf8");

    await expect(store.list()).rejects.toThrow("Invalid Pi package dismissal");
  });
});
