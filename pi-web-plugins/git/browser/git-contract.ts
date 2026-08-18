export const GIT_STATUS_OPERATION = "status";
export const GIT_DIFF_OPERATION = "diff";

export type GitFileState = "unmodified" | "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted";

export interface GitStatusFile {
  path: string;
  oldPath?: string;
  index: GitFileState;
  workingTree: GitFileState;
  submoduleFromCommit?: string;
  submoduleToCommit?: string;
}

export interface GitStatusResponse {
  isGitRepo: boolean;
  hash: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitStatusFile[];
  submodules: string[];
}

export interface GitDiffResponse {
  path?: string;
  staged: boolean;
  hash: string;
  diff: string;
  truncated: boolean;
}

export function parseGitStatusResponse(value: unknown): GitStatusResponse {
  const record = requireRecord(value, "Git status response");
  const branch = optionalString(record, "branch");
  const upstream = optionalString(record, "upstream");
  const ahead = optionalNumber(record, "ahead");
  const behind = optionalNumber(record, "behind");
  return {
    isGitRepo: requireBoolean(record, "isGitRepo"),
    hash: requireString(record, "hash"),
    ...(branch === undefined ? {} : { branch }),
    ...(upstream === undefined ? {} : { upstream }),
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    files: requireArray(record, "files").map(parseGitStatusFile),
    submodules: record["submodules"] === undefined ? [] : requireStringArray(record["submodules"], "submodules"),
  };
}

export function parseGitDiffResponse(value: unknown): GitDiffResponse {
  const record = requireRecord(value, "Git diff response");
  const path = optionalString(record, "path");
  return {
    ...(path === undefined ? {} : { path }),
    staged: requireBoolean(record, "staged"),
    hash: requireString(record, "hash"),
    diff: requireString(record, "diff"),
    truncated: requireBoolean(record, "truncated"),
  };
}

function parseGitStatusFile(value: unknown): GitStatusFile {
  const record = requireRecord(value, "Git status file");
  const oldPath = optionalString(record, "oldPath");
  const submoduleFromCommit = optionalString(record, "submoduleFromCommit");
  const submoduleToCommit = optionalString(record, "submoduleToCommit");
  return {
    path: requireString(record, "path"),
    ...(oldPath === undefined ? {} : { oldPath }),
    index: parseGitFileState(record["index"]),
    workingTree: parseGitFileState(record["workingTree"]),
    ...(submoduleFromCommit === undefined ? {} : { submoduleFromCommit }),
    ...(submoduleToCommit === undefined ? {} : { submoduleToCommit }),
  };
}

function parseGitFileState(value: unknown): GitFileState {
  switch (value) {
    case "unmodified":
    case "modified":
    case "added":
    case "deleted":
    case "renamed":
    case "copied":
    case "untracked":
    case "ignored":
    case "conflicted":
      return value;
    default:
      throw new Error("Invalid Git file state");
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`Expected array field: ${key}`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected number field: ${key}`);
  return value;
}

function requireStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`Expected string array field: ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
