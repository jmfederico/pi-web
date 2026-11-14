import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createPrivateFile, resolveDestination } from "./destination.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "private-file-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workspace"));
  return root;
}

describe("private file creation", () => {
  it("resolves inside and outside the workspace and preserves exact bytes with private POSIX mode", async () => {
    const root = await fixture();
    const cwd = join(root, "workspace");
    const secret = "  fake-private-value\nsecond line\n";
    for (const input of ["new.txt", "../outside.txt"]) {
      const path = await resolveDestination(input, cwd);
      expect(await createPrivateFile(path, secret, new AbortController().signal)).toEqual({ status: "saved" });
      expect(await readFile(path, "utf8")).toBe(secret);
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("never overwrites files or follows destination symlinks", async () => {
    const root = await fixture();
    const target = join(root, "target");
    await writeFile(target, "original");
    const link = join(root, "link");
    const dangling = join(root, "dangling");
    await symlink(target, link);
    await symlink(join(root, "missing"), dangling);
    for (const path of [target, link, dangling]) {
      expect(await createPrivateFile(path, "new", new AbortController().signal)).toEqual({ status: "failed", failure: "exists" });
    }
    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("requires an existing parent, resolves parent aliases, and rejects a destination whose parent changed", async () => {
    const root = await fixture();
    await symlink(join(root, "workspace"), join(root, "alias"), "dir");
    expect(await resolveDestination("alias/key", root)).toBe(join(root, "workspace", "key"));
    await expect(resolveDestination("missing/key", root)).rejects.toThrow("parent directory");
    expect(await createPrivateFile(join(root, "alias", "key"), "new", new AbortController().signal))
      .toEqual({ status: "failed", failure: "destination_changed" });
  });

  it("admits only one concurrent creator and does not create an already-cancelled write", async () => {
    const root = await fixture();
    const destination = join(root, "race");
    const outcomes = await Promise.all(["one", "two"].map((value) => createPrivateFile(destination, value, new AbortController().signal)));
    expect(outcomes.filter((result) => result.status === "saved")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "failed")).toEqual([{ status: "failed", failure: "exists" }]);
    const controller = new AbortController();
    controller.abort(new Error("fake-secret-abort-reason"));
    expect(await createPrivateFile(join(root, "cancelled"), "new", controller.signal)).toEqual({ status: "failed", failure: "write_failed" });
    await expect(stat(join(root, "cancelled"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
