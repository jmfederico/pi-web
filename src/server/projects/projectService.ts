import { mkdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectStore } from "../storage/projectStore.js";
import type { Project } from "../types.js";
import { expandUserPath } from "./directorySuggestions.js";
import { cloneGitRepository, validateGitRepositoryUrl } from "./gitClone.js";

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

  async cloneFromGit(input: { repositoryUrl: string; destinationPath: string }, signal?: AbortSignal): Promise<Project> {
    if (typeof input?.repositoryUrl !== "string" || typeof input.destinationPath !== "string" || input.destinationPath.trim() === "") {
      throw new Error("Repository URL and destination folder are required");
    }
    const repositoryUrl = validateGitRepositoryUrl(input.repositoryUrl);
    const destinationPath = resolve(expandUserPath(input.destinationPath.trim()));
    if (destinationPath === dirname(destinationPath) || basename(destinationPath) === "") {
      throw new Error("Choose a project folder below the filesystem root");
    }

    const parentPath = dirname(destinationPath);
    await mkdir(parentPath, { recursive: true });
    const stagingPath = join(parentPath, `.pi-web-clone-${randomUUID()}`);
    let destinationReserved = false;
    try {
      // Reserve the requested path up front so two clone requests cannot
      // silently race to replace the same project directory.
      await mkdir(destinationPath);
      destinationReserved = true;
      await cloneGitRepository(repositoryUrl, stagingPath, signal);
      await rmdir(destinationPath);
      destinationReserved = false;
      await rename(stagingPath, destinationPath);
      return this.store.add({ path: await realpath(destinationPath) });
    } catch (error: unknown) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      if (destinationReserved) await rmdir(destinationPath).catch(() => undefined);
      throw error;
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
