import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ServerPluginActivationContext, ServerPluginExecFileResult } from "@jmfederico/pi-web/server-plugin-api";
import { createServerPluginExecFile } from "../../src/server/plugins/serverPluginExec.js";
import { gitDiff as requestGitDiff, gitStatus as requestGitStatus } from "./git-backend.js";

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

const backendContext: ServerPluginActivationContext = {
  apiVersion: 1,
  pluginId: "git",
  packageRoot: "pi-web-plugins/git",
  logger: {
    debug() { /* no-op */ },
    info() { /* no-op */ },
    warn() { /* no-op */ },
    error() { /* no-op */ },
  },
  settings: {},
  execFile: createServerPluginExecFile({ env: GIT_ENV }),
  signal: new AbortController().signal,
};

const created: string[] = [];
afterAll(() => { for (const dir of created) rmSync(dir, { recursive: true, force: true }); });

function gitStatus(cwd: string) {
  return requestGitStatus(backendContext, cwd, new AbortController().signal);
}

function gitDiff(cwd: string, options: { path?: string; staged?: boolean }) {
  return requestGitDiff(backendContext, cwd, options, new AbortController().signal);
}

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

describe("Git changes backend", () => {
  it("preserves staged, unstaged, and untracked file behavior", async () => {
    const { dir } = createFixture();
    writeFileSync(join(dir, "root.txt"), "root\nstaged\n");
    git(dir, ["add", "root.txt"]);
    writeFileSync(join(dir, "root.txt"), "root\nstaged\nunstaged\n");
    writeFileSync(join(dir, "untracked.txt"), "new\n");

    const status = await gitStatus(dir);
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "root.txt", index: "modified", workingTree: "modified" }),
      expect.objectContaining({ path: "untracked.txt", index: "untracked", workingTree: "untracked" }),
    ]));

    const [staged, unstaged, untracked] = await Promise.all([
      gitDiff(dir, { path: "root.txt", staged: true }),
      gitDiff(dir, { path: "root.txt" }),
      gitDiff(dir, { path: "untracked.txt" }),
    ]);
    expect(staged.diff).toContain("+staged");
    expect(staged.diff).not.toContain("+unstaged");
    expect(unstaged.diff).toContain("+unstaged");
    expect(untracked.diff).toContain("+new");
  });

  it("rejects absolute and traversing diff paths before invoking Git", async () => {
    const { dir } = createFixture();

    await expect(gitDiff(dir, { path: "/outside" })).rejects.toThrow("Absolute paths are not allowed");
    await expect(gitDiff(dir, { path: "../outside" })).rejects.toThrow("Path traversal is not allowed");
  });
});

describe("Git command failures", () => {
  it("preserves a signaled status command as an error", async () => {
    const context: ServerPluginActivationContext = {
      ...backendContext,
      execFile: () => Promise.resolve(commandResult({ exitCode: null, signal: "SIGKILL" })),
    };

    await expect(requestGitStatus(context, "/repo", new AbortController().signal))
      .rejects.toThrow("ended from signal SIGKILL");
  });

  it("preserves a command timeout rejection as an error", async () => {
    const timeout = Object.assign(new Error("Server plugin command timed out after 10ms"), { name: "TimeoutError" });
    const context: ServerPluginActivationContext = {
      ...backendContext,
      execFile: () => Promise.reject(timeout),
    };

    await expect(requestGitStatus(context, "/repo", new AbortController().signal)).rejects.toBe(timeout);
  });
});

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

  it.skipIf(process.platform === "win32")("does not follow a gitlink checkout symlink outside the workspace", async () => {
    const { dir } = createFixture();
    const outside = join(dir, "..", "origin");
    rmSync(join(dir, "HARL"), { recursive: true, force: true });
    symlinkSync(outside, join(dir, "HARL"), "dir");
    writeFileSync(join(outside, "a.txt"), "v2\noutside secret\n");

    const diff = await gitDiff(dir, { path: "HARL/a.txt" });

    expect(diff.diff).toBe("");
    expect(diff.diff).not.toContain("outside secret");
  });

  it("does not treat a configured nested repository as a submodule without an index gitlink", async () => {
    const { dir } = createFixture();
    const nested = join(dir, "nested");
    mkdirSync(nested);
    git(nested, ["init", "-b", "main"]);
    writeFileSync(join(nested, "inside.txt"), "tracked\n");
    git(nested, ["add", "inside.txt"]);
    git(nested, ["commit", "-m", "nested initial"]);
    writeFileSync(join(nested, "inside.txt"), "tracked\nnested secret\n");
    git(dir, ["config", "--file", ".gitmodules", "submodule.nested.path", "nested"]);

    const diff = await gitDiff(dir, { path: "nested/inside.txt" });

    expect(diff.diff).toBe("");
    expect(diff.diff).not.toContain("nested secret");
  });
});

function commandResult(overrides: Partial<ServerPluginExecFileResult> = {}): ServerPluginExecFileResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}
