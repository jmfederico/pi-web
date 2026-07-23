import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { GitDiffResponse, GitFileState, GitStatusFile, GitStatusResponse } from "../../shared/apiTypes.js";
import { normalizeRelativePath } from "../workspaces/pathSafety.js";
import { sanitizedGitEnv } from "./gitEnv.js";

const MAX_OUTPUT = 2 * 1024 * 1024;

/**
 * A submodule row parsed from the superproject status. `git status` reports a
 * submodule as a single path with an `S<c><m><u>` flag field (commit changed /
 * modified tracked content / untracked content) but never lists the files that
 * changed inside it, so we recurse in `expandSubmodules`.
 */
interface SubmoduleRecord {
  path: string;
  index: GitFileState;
  workingTree: GitFileState;
  commitChanged: boolean;
  hasModifiedContent: boolean;
  hasUntrackedContent: boolean;
  headOid: string;
  indexOid: string;
}

interface ParsedStatus {
  isGitRepo: true;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitStatusFile[];
  submodules: SubmoduleRecord[];
}

export async function gitStatus(cwd: string): Promise<GitStatusResponse> {
  const result = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]);
  if (result.code !== 0) return { isGitRepo: false, hash: hash(result.stdout + result.stderr), files: [], submodules: [] };
  const parsed = parseStatus(result.stdout, { deferSubmodules: true });
  return expandSubmodules(cwd, parsed, result.stdout);
}

/**
 * Merge each dirty submodule's own changes into the flat file list. A moved
 * commit pointer becomes a single entry keyed by the submodule path (carrying
 * the short SHAs for display); modified/untracked content is listed as regular
 * entries under `<submodule>/<inner path>`. A plain `-dirty` pointer (commit
 * unchanged) is intentionally not surfaced as a pointer entry.
 */
async function expandSubmodules(cwd: string, parsed: ParsedStatus, topRaw: string): Promise<GitStatusResponse> {
  const files: GitStatusFile[] = [...parsed.files];
  const submodulePaths: string[] = [];
  let extraForHash = "";

  for (const sub of parsed.submodules) {
    submodulePaths.push(sub.path);
    if (sub.commitChanged) {
      files.push({
        path: sub.path,
        index: sub.index,
        workingTree: sub.workingTree,
        submoduleFromCommit: short(sub.headOid),
        submoduleToCommit: short(await resolveSubmoduleToCommit(cwd, sub)),
      });
    }
    if (sub.hasModifiedContent || sub.hasUntrackedContent) {
      const inner = await runGit(join(cwd, sub.path), ["status", "--porcelain=v2", "--untracked-files=all", "-z"]);
      if (inner.code !== 0) continue; // uninitialized / unreadable submodule: skip silently
      extraForHash += `\0${sub.path}\0${inner.stdout}`;
      const innerFiles = parseStatus(inner.stdout, { deferSubmodules: false }).files;
      for (const file of innerFiles) {
        files.push({
          ...file,
          path: `${sub.path}/${file.path}`,
          ...(file.oldPath === undefined ? {} : { oldPath: `${sub.path}/${file.oldPath}` }),
        });
      }
    }
  }

  return {
    isGitRepo: true,
    hash: hash(topRaw + extraForHash),
    ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
    ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
    ...(parsed.ahead === undefined ? {} : { ahead: parsed.ahead }),
    ...(parsed.behind === undefined ? {} : { behind: parsed.behind }),
    files,
    submodules: submodulePaths,
  };
}

async function resolveSubmoduleToCommit(cwd: string, sub: SubmoduleRecord): Promise<string> {
  // Staged pointer moves already expose the new commit as the index OID; an
  // unstaged move only records the old OID, so read the submodule's HEAD.
  if (sub.indexOid !== sub.headOid) return sub.indexOid;
  const head = await runGit(join(cwd, sub.path), ["rev-parse", "HEAD"]);
  const resolved = head.stdout.trim();
  return head.code === 0 && resolved !== "" ? resolved : sub.indexOid;
}

export async function gitDiff(cwd: string, options: { path?: string; staged?: boolean }): Promise<GitDiffResponse> {
  const staged = options.staged === true;
  let path: string | undefined;
  if (options.path !== undefined && options.path !== "") path = normalizeRelativePath(options.path);

  if (path !== undefined) {
    const owner = await submoduleForPath(cwd, path);
    if (owner !== undefined) return submoduleDiff(cwd, owner, path, staged);
  }

  const args = ["diff", "--no-ext-diff", "--color=never"];
  if (staged) args.push("--cached");
  if (path !== undefined) args.push("--", path);

  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff failed");
  if (!staged && path !== undefined && result.stdout === "" && await isUntracked(cwd, path)) {
    const untracked = await runGit(cwd, ["diff", "--no-ext-diff", "--color=never", "--no-index", "/dev/null", "--", path]);
    if (untracked.code !== 0 && untracked.code !== 1) throw new Error(untracked.stderr.trim() || "git diff failed");
    return { path, staged, hash: hash(untracked.stdout), diff: untracked.stdout, truncated: untracked.truncated };
  }
  return { ...(path === undefined ? {} : { path }), staged, hash: hash(result.stdout), diff: result.stdout, truncated: result.truncated };
}

/**
 * Run the diff inside the owning submodule's working tree, since `git diff` at
 * the superproject root never shows content changes below a submodule boundary.
 * The response path stays the full superproject-relative path so the viewer and
 * the selected row line up.
 */
async function submoduleDiff(cwd: string, owner: string, path: string, staged: boolean): Promise<GitDiffResponse> {
  const subCwd = join(cwd, owner);
  const rel = normalizeRelativePath(path.slice(owner.length + 1));

  const args = ["diff", "--no-ext-diff", "--color=never"];
  if (staged) args.push("--cached");
  args.push("--", rel);

  const result = await runGit(subCwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff failed");
  if (!staged && result.stdout === "" && await isUntracked(subCwd, rel)) {
    const untracked = await runGit(subCwd, ["diff", "--no-ext-diff", "--color=never", "--no-index", "/dev/null", "--", rel]);
    if (untracked.code !== 0 && untracked.code !== 1) throw new Error(untracked.stderr.trim() || "git diff failed");
    return { path, staged, hash: hash(untracked.stdout), diff: untracked.stdout, truncated: untracked.truncated };
  }
  return { path, staged, hash: hash(result.stdout), diff: result.stdout, truncated: result.truncated };
}

async function isUntracked(cwd: string, path: string): Promise<boolean> {
  const result = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
  return result.code === 0 && result.stdout.split("\0").includes(path);
}

/** Configured direct-submodule paths (depth 1), read from `.gitmodules`. */
async function submodulePaths(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..+\\.path$"]);
  if (result.code !== 0) return [];
  const paths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const spaceAt = trimmed.indexOf(" ");
    if (spaceAt === -1) continue;
    paths.push(trimmed.slice(spaceAt + 1));
  }
  return paths;
}

/** The submodule that strictly contains `path`, if any (longest match wins). */
async function submoduleForPath(cwd: string, path: string): Promise<string | undefined> {
  const subs = await submodulePaths(cwd);
  let best: string | undefined;
  for (const sub of subs) {
    if (sub !== "" && path.startsWith(`${sub}/`) && (best === undefined || sub.length > best.length)) best = sub;
  }
  return best;
}

function parseStatus(raw: string, options: { deferSubmodules: boolean }): ParsedStatus {
  const records = raw.split("\0").filter((record) => record !== "");
  const files: GitStatusFile[] = [];
  const submodules: SubmoduleRecord[] = [];
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined) continue;
    if (record.startsWith("# branch.head ")) branch = normalizeBranch(record.slice("# branch.head ".length));
    else if (record.startsWith("# branch.upstream ")) upstream = record.slice("# branch.upstream ".length);
    else if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (record.startsWith("? ")) files.push({ path: record.slice(2), index: "untracked", workingTree: "untracked" });
    else if (record.startsWith("! ")) files.push({ path: record.slice(2), index: "ignored", workingTree: "ignored" });
    else if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      const sub = parts[2];
      const path = parts.slice(8).join(" ");
      if (options.deferSubmodules && sub?.startsWith("S") === true) {
        submodules.push({
          path,
          index: stateFor(parts[1]?.[0]),
          workingTree: stateFor(parts[1]?.[1]),
          commitChanged: sub[1] === "C",
          hasModifiedContent: sub[2] === "M",
          hasUntrackedContent: sub[3] === "U",
          headOid: parts[6] ?? "",
          indexOid: parts[7] ?? "",
        });
      } else {
        files.push({ path, index: stateFor(parts[1]?.[0]), workingTree: stateFor(parts[1]?.[1]) });
      }
    } else if (record.startsWith("2 ")) {
      const parts = record.split(" ");
      const path = parts.slice(9).join(" ");
      const oldPath = records[i + 1];
      i += 1;
      files.push({ path, ...(oldPath === undefined ? {} : { oldPath }), index: stateFor(parts[1]?.[0]), workingTree: stateFor(parts[1]?.[1]) });
    } else if (record.startsWith("u ")) {
      const parts = record.split(" ");
      files.push({ path: parts.slice(10).join(" "), index: "conflicted", workingTree: "conflicted" });
    }
  }

  return { isGitRepo: true, ...(branch === undefined ? {} : { branch }), ...(upstream === undefined ? {} : { upstream }), ...(ahead === undefined ? {} : { ahead }), ...(behind === undefined ? {} : { behind }), files, submodules };
}

function stateFor(code: string | undefined): GitFileState {
  if (code === undefined) return "unmodified";
  switch (code) {
    case ".": return "unmodified";
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "U": return "conflicted";
    default: return "unmodified";
  }
}

function normalizeBranch(value: string): string | undefined {
  return value === "(detached)" ? undefined : value;
}

function short(oid: string): string {
  return oid.slice(0, 7);
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

async function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: sanitizedGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10000);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT) truncated = true;
      if (stdout.length < MAX_OUTPUT) stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX_OUTPUT);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(0, 64 * 1024); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated }); });
  });
}
