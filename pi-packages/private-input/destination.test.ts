import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
      const before = await readdir(dirname(path));
      expect(await createPrivateFile(path, secret, new AbortController().signal)).toEqual({ status: "saved" });
      expect(await readFile(path, "utf8")).toBe(secret);
      expect((await readdir(dirname(path))).sort()).toEqual([...before, basename(path)].sort());
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it.each(["file", "symlink", "dangling symlink"])("rejects an existing %s without changing it or leaving temporary files", async (kind) => {
    const root = await fixture();
    const target = join(root, "target");
    const missing = join(root, "missing");
    await writeFile(target, "original");
    const destination = kind === "file" ? target : join(root, "link");
    if (kind !== "file") await symlink(kind === "symlink" ? target : missing, destination);
    const before = await readdir(root);
    expect(await createPrivateFile(destination, "new", new AbortController().signal)).toEqual({ status: "failed", failure: "exists" });
    expect(await readFile(target, "utf8")).toBe("original");
    if (kind !== "file") expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual(before);
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
    expect((await readdir(root)).sort()).toEqual(["race", "workspace"]);
  });
});
