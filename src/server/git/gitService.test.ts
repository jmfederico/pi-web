import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitDiff, gitStatus } from "./gitService.js";

// Isolate from any global/system git config and force a deterministic identity;
// `protocol.file.allow` is required for `submodule add` from a local path.
const GIT_FLAGS = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false"];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

const created: string[] = [];
afterAll(() => { for (const dir of created) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...GIT_FLAGS, ...args], { cwd, encoding: "utf8", env: GIT_ENV });
}

/** Superproject at `dir` with a submodule `HARL` recorded at commit `c2`; the
 * submodule origin has two commits `c1` (a.txt=v1) then `c2` (a.txt=v2). */
function createFixture(): { dir: string; c1: string; c2: string } {
  const base = mkdtempSync(join(tmpdir(), "pi-web-sub-"));
  created.push(base);
  const origin = join(base, "origin");
  const sup = join(base, "sup");

  git(base, ["init", "-b", "main", origin]);
  writeFileSync(join(origin, "a.txt"), "v1\n");
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-m", "c1"]);
  const c1 = git(origin, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(origin, "a.txt"), "v2\n");
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-m", "c2"]);
  const c2 = git(origin, ["rev-parse", "HEAD"]).trim();

  git(base, ["init", "-b", "main", sup]);
  git(sup, ["submodule", "add", origin, "HARL"]);
  writeFileSync(join(sup, "root.txt"), "root\n");
  git(sup, ["add", "-A"]);
  git(sup, ["commit", "-m", "init"]);
  return { dir: sup, c1, c2 };
}

describe("gitStatus with submodules", () => {
  it("surfaces a moved commit pointer with short SHAs and no inner files", async () => {
    const { dir, c1, c2 } = createFixture();
    git(join(dir, "HARL"), ["checkout", c1]); // move the pointer, leave the tree clean

    const status = await gitStatus(dir);
    expect(status.submodules).toContain("HARL");
    const pointer = status.files.find((file) => file.path === "HARL");
    expect(pointer?.submoduleFromCommit).toBe(c2.slice(0, 7));
    expect(pointer?.submoduleToCommit).toBe(c1.slice(0, 7));
    expect(status.files.some((file) => file.path.startsWith("HARL/"))).toBe(false);
  });

  it("lists modified and untracked inner files and omits the pointer when the commit is unchanged", async () => {
    const { dir } = createFixture();
    writeFileSync(join(dir, "HARL", "a.txt"), "v2\nchanged\n");
    writeFileSync(join(dir, "HARL", "new.txt"), "brand-new\n");

    const status = await gitStatus(dir);
    expect(status.submodules).toContain("HARL");
    expect(status.files.find((file) => file.path === "HARL")).toBeUndefined();
    const inner = status.files.filter((file) => file.path.startsWith("HARL/")).map((file) => file.path);
    expect(inner).toContain("HARL/a.txt");
    expect(inner).toContain("HARL/new.txt");
  });

  it("skips inner recursion without throwing when the submodule repo is unreadable", async () => {
    const { dir } = createFixture();
    writeFileSync(join(dir, "HARL", "new.txt"), "brand-new\n"); // untracked → would trigger recursion
    renameSync(join(dir, "HARL", ".git"), join(dir, "HARL", ".git.bak")); // break the inner repo

    const status = await gitStatus(dir);
    expect(status.isGitRepo).toBe(true);
    expect(status.files.some((file) => file.path.startsWith("HARL/"))).toBe(false);
  });
});

describe("gitDiff routing into submodules", () => {
  it("returns real content for a tracked file inside the submodule", async () => {
    const { dir } = createFixture();
    writeFileSync(join(dir, "HARL", "a.txt"), "v2\nchanged\n");

    const diff = await gitDiff(dir, { path: "HARL/a.txt" });
    expect(diff.path).toBe("HARL/a.txt");
    expect(diff.diff).toContain("@@");
    expect(diff.diff).toContain("changed");
  });

  it("produces an untracked-file diff inside the submodule via --no-index", async () => {
    const { dir } = createFixture();
    writeFileSync(join(dir, "HARL", "new.txt"), "brand-new\n");

    const diff = await gitDiff(dir, { path: "HARL/new.txt" });
    expect(diff.path).toBe("HARL/new.txt");
    expect(diff.diff).toContain("brand-new");
  });

  it("diffs the submodule path itself against the superproject pointer", async () => {
    const { dir, c1 } = createFixture();
    git(join(dir, "HARL"), ["checkout", c1]);

    const diff = await gitDiff(dir, { path: "HARL" });
    expect(diff.path).toBe("HARL");
    expect(diff.diff).toContain("Subproject commit");
  });
});
