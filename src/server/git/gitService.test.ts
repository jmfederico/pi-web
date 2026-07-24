import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { gitDiff, gitStatus, jjDiff, jjStatus } from "./gitService.js";

// Isolate from any global/system git config and force a deterministic identity;
// `protocol.file.allow` is required for `submodule add` from a local path.
const GIT_FLAGS = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false"];
// Strip all GIT_* variables (e.g. GIT_DIR/GIT_INDEX_FILE, set by git hooks such
// as this repo's pre-commit verify run) so fixture commands never pick up an
// outer repository's environment, then pin the handful we rely on.
const GIT_ENV = Object.fromEntries([
  ...Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ["GIT_CONFIG_GLOBAL", "/dev/null"],
  ["GIT_CONFIG_SYSTEM", "/dev/null"],
  ["GIT_TERMINAL_PROMPT", "0"],
]);

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

/** Superproject at `dir` whose only submodule lives at the spaced path
 * `my sub`; the submodule origin has a single commit (a.txt=v1). */
function createSpacedPathFixture(): { dir: string } {
  const base = mkdtempSync(join(tmpdir(), "pi-web-sub-space-"));
  created.push(base);
  const origin = join(base, "origin");
  const sup = join(base, "sup");

  git(base, ["init", "-b", "main", origin]);
  writeFileSync(join(origin, "a.txt"), "v1\n");
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-m", "c1"]);

  git(base, ["init", "-b", "main", sup]);
  git(sup, ["submodule", "add", origin, "my sub"]);
  writeFileSync(join(sup, "root.txt"), "root\n");
  git(sup, ["add", "-A"]);
  git(sup, ["commit", "-m", "init"]);
  return { dir: sup };
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

  it("surfaces a staged pointer move with the recorded OID as from and the staged OID as to", async () => {
    const { dir, c1, c2 } = createFixture();
    git(join(dir, "HARL"), ["checkout", c1]); // move the pointer
    git(dir, ["add", "HARL"]); // stage the move: porcelain `1 M. S... <c2> <c1> HARL`

    const status = await gitStatus(dir);
    expect(status.submodules).toContain("HARL");
    const pointer = status.files.find((file) => file.path === "HARL");
    expect(pointer?.index).toBe("modified");
    expect(pointer?.workingTree).toBe("unmodified");
    expect(pointer?.submoduleFromCommit).toBe(c2.slice(0, 7));
    expect(pointer?.submoduleToCommit).toBe(c1.slice(0, 7));
  });

  it("reports both the pointer entry and inner files for a staged move with dirty content", async () => {
    const { dir, c1, c2 } = createFixture();
    git(join(dir, "HARL"), ["checkout", c1]);
    git(dir, ["add", "HARL"]);
    writeFileSync(join(dir, "HARL", "a.txt"), "v1\ndirty\n"); // combined `1 MM S.M.`

    const status = await gitStatus(dir);
    const pointer = status.files.find((file) => file.path === "HARL");
    expect(pointer?.index).toBe("modified");
    expect(pointer?.workingTree).toBe("modified");
    expect(pointer?.submoduleFromCommit).toBe(c2.slice(0, 7));
    expect(pointer?.submoduleToCommit).toBe(c1.slice(0, 7));
    const inner = status.files.find((file) => file.path === "HARL/a.txt");
    expect(inner?.workingTree).toBe("modified");
  });

  it("reports a deleted submodule as a plain deleted row", async () => {
    const { dir } = createFixture();
    rmSync(join(dir, "HARL"), { recursive: true, force: true }); // unstaged deletion: `1 .D S...`

    const status = await gitStatus(dir);
    const row = status.files.find((file) => file.path === "HARL");
    expect(row?.workingTree).toBe("deleted");
    expect(row?.submoduleFromCommit).toBeUndefined();
    expect(status.submodules).not.toContain("HARL");
    expect(status.files.some((file) => file.path.startsWith("HARL/"))).toBe(false);
  });

  it("reports a staged submodule deletion as a plain deleted row, not a pointer move", async () => {
    const { dir } = createFixture();
    git(dir, ["rm", "-q", "HARL"]); // staged deletion: `1 D. S...` with a zero index OID

    const status = await gitStatus(dir);
    const row = status.files.find((file) => file.path === "HARL");
    expect(row?.index).toBe("deleted");
    expect(row?.submoduleFromCommit).toBeUndefined();
    expect(status.submodules).not.toContain("HARL");
  });

  it("renders a newly staged submodule pointer as new → <sha> (zero head OID)", async () => {
    const { dir, c2 } = createFixture();
    git(dir, ["submodule", "add", join(dir, "..", "origin"), "NEWSUB"]); // staged add: `1 A. S...` with a zero head OID

    const status = await gitStatus(dir);
    const pointer = status.files.find((file) => file.path === "NEWSUB");
    expect(pointer?.index).toBe("added");
    expect(pointer?.submoduleFromCommit).toBe("new");
    expect(pointer?.submoduleToCommit).toBe(c2.slice(0, 7));
    expect(status.submodules).toContain("NEWSUB");
  });

  it("prefixes oldPath with the submodule path for renames inside a submodule", async () => {
    const { dir } = createFixture();
    git(join(dir, "HARL"), ["mv", "a.txt", "renamed.txt"]);

    const status = await gitStatus(dir);
    const renamed = status.files.find((file) => file.path === "HARL/renamed.txt");
    expect(renamed?.index).toBe("renamed");
    expect(renamed?.oldPath).toBe("HARL/a.txt");
  });

  it("keeps inner filenames with spaces intact through expansion", async () => {
    const { dir } = createFixture();
    writeFileSync(join(dir, "HARL", "my file.txt"), "tracked\n");
    git(join(dir, "HARL"), ["add", "my file.txt"]);
    git(join(dir, "HARL"), ["commit", "-m", "track spaced file"]);
    git(dir, ["add", "HARL"]);
    git(dir, ["commit", "-m", "record new pointer"]); // HARL clean at the new recorded commit
    writeFileSync(join(dir, "HARL", "my file.txt"), "tracked\nchanged\n");
    writeFileSync(join(dir, "HARL", "untracked file.txt"), "new\n");

    const status = await gitStatus(dir);
    expect(status.files.find((file) => file.path === "HARL/my file.txt")?.workingTree).toBe("modified");
    expect(status.files.some((file) => file.path === "HARL/untracked file.txt")).toBe(true);
    expect(status.files.find((file) => file.path === "HARL")).toBeUndefined(); // pointer unchanged
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

describe("submodule paths containing spaces", () => {
  it("expands status and routes diffs into the space-named submodule", async () => {
    const { dir } = createSpacedPathFixture();
    writeFileSync(join(dir, "my sub", "a.txt"), "v1\nchanged\n");

    const status = await gitStatus(dir);
    expect(status.submodules).toContain("my sub");
    expect(status.files.some((file) => file.path === "my sub/a.txt")).toBe(true);

    const diff = await gitDiff(dir, { path: "my sub/a.txt" });
    expect(diff.path).toBe("my sub/a.txt");
    expect(diff.diff).toContain("@@");
    expect(diff.diff).toContain("changed");
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

const result = (stdout: string) => ({ code: 0, stdout, stderr: "", truncated: false });

describe("Jujutsu workspace changes", () => {
  it("maps the working-copy summary into the existing changes contract", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result(["M", '"src/main.ts"', "0", "A", '"new file.txt"', "0", "D", '"old.ts"', "0", "M", '"conflicted.ts"', "1", ""].join("\0")))
      .mockResolvedValueOnce(result("abcdefgh\0describe jj support"));

    const status = await jjStatus("/repo", false, run);

    expect(status).toMatchObject({
      isGitRepo: false,
      vcs: "jj",
      branch: "abcdefgh · describe jj support",
      files: [
        { path: "src/main.ts", index: "unmodified", workingTree: "modified" },
        { path: "new file.txt", index: "unmodified", workingTree: "added" },
        { path: "old.ts", index: "unmodified", workingTree: "deleted" },
        { path: "conflicted.ts", index: "unmodified", workingTree: "conflicted" },
      ],
    });
    expect(status.hash).not.toBe("");
    expect(run).toHaveBeenNthCalledWith(1, "/repo", ["diff", "--color=never", "-T", 'status_char ++ "\\0" ++ json(path) ++ "\\0" ++ if(target.conflict(), "1", "0") ++ "\\0"']);
  });

  it("rejects a truncated Jujutsu status before parsing a partial path record", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'M\0"partial', stderr: "", truncated: true });

    await expect(jjStatus("/repo", false, run)).rejects.toThrow("exceeds the 2 MiB output limit");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns a Git-format working-copy diff and an empty staged diff", async () => {
    const run = vi.fn().mockResolvedValue(result("diff --git a/file.ts b/file.ts\n"));

    await expect(jjDiff("/repo", { path: "file (1).ts" }, run)).resolves.toMatchObject({ vcs: "jj", staged: false, diff: "diff --git a/file.ts b/file.ts\n" });
    await expect(jjDiff("/repo", { path: "file (1).ts", staged: true }, run)).resolves.toMatchObject({ vcs: "jj", staged: true, diff: "" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/repo", ["diff", "--git", "--color=never", "--", 'root-file:"file (1).ts"']);
  });
});
