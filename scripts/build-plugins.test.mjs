import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDirectory } from "./build-plugins.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-build-plugins-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("buildDirectory", () => {
  it("materializes a symlinked file as a real file", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "target.txt"), "linked content");
    await symlink(join(source, "target.txt"), join(source, "link.txt"));

    const target = join(tempDir, "out");
    await buildDirectory(source, target);

    await expect(readFile(join(target, "link.txt"), "utf8")).resolves.toBe("linked content");
    expect((await lstat(join(target, "link.txt"))).isSymbolicLink()).toBe(false);
  });

  it("materializes a symlinked directory as a real directory tree", async () => {
    const linkedDir = join(tempDir, "external-dir");
    await mkdir(linkedDir, { recursive: true });
    await writeFile(join(linkedDir, "nested.txt"), "nested content");

    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await symlink(linkedDir, join(source, "link-dir"));

    const target = join(tempDir, "out");
    await buildDirectory(source, target);

    await expect(readFile(join(target, "link-dir", "nested.txt"), "utf8")).resolves.toBe("nested content");
    expect((await lstat(join(target, "link-dir"))).isSymbolicLink()).toBe(false);
  });

  it("fails the build on a broken symlink instead of silently dropping it", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await symlink(join(tempDir, "does-not-exist.txt"), join(source, "broken.txt"));

    await expect(buildDirectory(source, join(tempDir, "out"))).rejects.toThrow();
  });

  it("guards against a symlinked directory cycling back into an ancestor", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "marker.txt"), "marker content");
    // A directory symlinking into itself (or any ancestor) previously made
    // buildDirectory recurse on an ever-lengthening synthetic path
    // (source/self/self/self/...) with no termination condition.
    await symlink(source, join(source, "self"));

    const target = join(tempDir, "out");
    await expect(buildDirectory(source, target)).resolves.toEqual({ copied: 1, transpiled: 0 });

    expect(await readdir(target)).toEqual(["marker.txt"]);
  });
});
