import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDeclaredPiPackageName } from "./piPackageIdentity.js";

describe("resolveDeclaredPiPackageName", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-web-pi-package-identity-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads the declared name from an installed package's package.json", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ name: "@jmfederico/pi-relay", version: "0.1.0" }), "utf8");

    await expect(resolveDeclaredPiPackageName(tempDir)).resolves.toBe("@jmfederico/pi-relay");
  });

  it("resolves undefined when the installed path has no package.json", async () => {
    await expect(resolveDeclaredPiPackageName(join(tempDir, "missing"))).resolves.toBeUndefined();
  });

  it("resolves undefined when package.json is not valid JSON", async () => {
    await writeFile(join(tempDir, "package.json"), "{ not json", "utf8");

    await expect(resolveDeclaredPiPackageName(tempDir)).resolves.toBeUndefined();
  });

  it("resolves undefined when package.json has no string name field", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");

    await expect(resolveDeclaredPiPackageName(tempDir)).resolves.toBeUndefined();
  });
});
