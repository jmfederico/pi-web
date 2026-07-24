import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { promisify } from "node:util";
import { parseJsonString } from "../vcsOutput.js";

const execFileAsync = promisify(execFile);

export interface JjWorkspaceInfo {
  name: string;
  path: string;
  isCurrent: boolean;
}

export async function isJjRepository(path: string): Promise<boolean> {
  const repositoryPath = await findJjMarkerRoot(path);
  if (repositoryPath === undefined) return false;
  try {
    await execFileAsync("jj", ["--ignore-working-copy", "--color=never", "-R", repositoryPath, "workspace", "root"]);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) throw new Error("Jujutsu repository detected, but the jj executable is not available on PI WEB's PATH", { cause: error });
    throw new Error(`Failed to inspect Jujutsu repository: ${commandErrorMessage(error)}`, { cause: error });
  }
}

export async function discoverJjWorkspaces(path: string): Promise<JjWorkspaceInfo[]> {
  const repositoryPath = await findJjMarkerRoot(path);
  if (repositoryPath === undefined) throw new Error("Jujutsu repository metadata not found");
  const args = ["--ignore-working-copy", "--color=never", "-R", repositoryPath];
  const [{ stdout }, { stdout: currentRoot }] = await Promise.all([
    execFileAsync("jj", [...args, "workspace", "list", "-T", 'json(name) ++ "\\0" ++ root ++ "\\0" ++ if(target.current_working_copy(), "1", "0") ++ "\\0"']),
    execFileAsync("jj", [...args, "workspace", "root"]),
  ]);
  return parseJjWorkspaceList(stdout, currentRoot.trim());
}

export function parseJjWorkspaceList(raw: string, currentRoot: string): JjWorkspaceInfo[] {
  const fields = raw.split("\0").filter((field) => field !== "");
  const workspaces: JjWorkspaceInfo[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const encodedName = fields[index];
    const recordedPath = fields[index + 1];
    const isCurrent = fields[index + 2] === "1";
    if (encodedName === undefined || recordedPath === undefined) continue;
    const workspacePath = isCurrent ? currentRoot : recordedPath;
    if (workspacePath.startsWith("<Error:")) continue;
    workspaces.push({ name: parseJsonString(encodedName, "Invalid Jujutsu workspace name"), path: workspacePath, isCurrent });
  }
  return workspaces;
}

export async function resolveJjWorkspaceRoot(repositoryPath: string, workspaceName: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("jj", ["--ignore-working-copy", "--color=never", "-R", repositoryPath, "workspace", "root", "--name", workspaceName]);
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to resolve Jujutsu workspace ${workspaceName}: ${commandErrorMessage(error)}`, { cause: error });
  }
}

async function findJjMarkerRoot(path: string): Promise<string | undefined> {
  let current = path;
  const root = parse(path).root;
  while (current !== root) {
    if (await pathExists(join(current, ".jj"))) return current;
    current = dirname(current);
  }
  return await pathExists(join(root, ".jj")) ? root : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

function commandErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim() !== "") return error.stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
