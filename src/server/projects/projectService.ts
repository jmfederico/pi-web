import { lstat, mkdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectStore } from "../storage/projectStore.js";
import type { Project } from "../types.js";
import { expandUserPath } from "./directorySuggestions.js";
import { cloneGitRepository, validateGitRepositoryUrl } from "./gitClone.js";

const activeCloneDestinations = new Set<string>();

export class ProjectService {
  constructor(private readonly store: ProjectStore) {}

  list(): Promise<Project[]> {
    return this.store.list();
  }

  async add(input: { name?: string; path: string; create?: boolean }): Promise<Project> {
    // Trim so stray whitespace cannot diverge the stored path from the
    // trimmed key the trust lookup (projectTrustRoutes) previews decisions for.
    const requestedPath = expandUserPath(input.path.trim());
    if (input.create === true) await mkdir(requestedPath, { recursive: true });
    const resolved = await realpath(requestedPath);
    const s = await stat(resolved);
    if (!s.isDirectory()) throw new Error("Project path must be a directory");
    return this.store.add(input.name === undefined ? { path: resolved } : { name: input.name, path: resolved });
  }

  async cloneFromGit(input: { repositoryUrl?: unknown; destinationPath?: unknown } | null | undefined, signal?: AbortSignal): Promise<Project> {
    if (typeof input?.repositoryUrl !== "string" || typeof input.destinationPath !== "string" || input.destinationPath.trim() === "") {
      throw new Error("Repository URL and destination folder are required");
    }
    throwIfCloneCancelled(signal);
    const repositoryUrl = validateGitRepositoryUrl(input.repositoryUrl);
    const destinationPath = resolve(expandUserPath(input.destinationPath.trim()));
    if (destinationPath === dirname(destinationPath) || basename(destinationPath) === "") {
      throw new Error("Choose a project folder below the filesystem root");
    }

    const parentPath = dirname(destinationPath);
    if (activeCloneDestinations.has(destinationPath)) throw new Error("A Git clone is already in progress for this destination");
    activeCloneDestinations.add(destinationPath);
    const stagingPath = join(parentPath, `.pi-web-clone-${randomUUID()}`);
    let missingParents: string[] = [];
    try {
      missingParents = await findMissingDirectories(parentPath);
      await mkdir(parentPath, { recursive: true });
      await ensureDestinationDoesNotExist(destinationPath);
      await cloneGitRepository(repositoryUrl, stagingPath, signal);
      throwIfCloneCancelled(signal);
      // Recheck after cloning in case another process created the destination.
      // The in-process set above prevents competing clone requests from racing.
      await ensureDestinationDoesNotExist(destinationPath);
      throwIfCloneCancelled(signal);
      try {
        await rename(stagingPath, destinationPath);
      } catch (error: unknown) {
        if (isErrorWithCode(error, "EEXIST") || isErrorWithCode(error, "ENOTEMPTY") || isErrorWithCode(error, "ENOTDIR")) {
          throw new Error("Destination already exists", { cause: error });
        }
        throw error;
      }
      return await this.store.add({ path: await realpath(destinationPath) });
    } catch (error: unknown) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      await removeEmptyDirectories(missingParents);
      throw error;
    } finally {
      activeCloneDestinations.delete(destinationPath);
    }
  }

  async close(id: string): Promise<void> {
    if (!(await this.store.remove(id))) throw new Error("Project not found");
  }

  async requireProject(id: string): Promise<Project> {
    const project = await this.store.get(id);
    if (!project) throw new Error("Project not found");
    return project;
  }
}

async function ensureDestinationDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isErrorWithCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("Destination already exists");
}

async function findMissingDirectories(path: string): Promise<string[]> {
  const missing: string[] = [];
  let current = path;
  while (current !== "") {
    try {
      const info = await stat(current);
      if (!info.isDirectory()) throw new Error("Project parent path must be a directory");
      return missing;
    } catch (error: unknown) {
      if (!isErrorWithCode(error, "ENOENT")) throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  throw new Error("Could not resolve project parent directory");
}

function throwIfCloneCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("Git clone was cancelled");
}

function isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function removeEmptyDirectories(paths: readonly string[]): Promise<void> {
  for (const path of paths) await rmdir(path).catch(() => undefined);
}
