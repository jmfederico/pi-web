import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { piWebDataDir } from "../../config.js";
import { randomUUID } from "node:crypto";
import type { Project } from "../types.js";

interface ProjectFile {
  projects: Project[];
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseProjectFile(value: unknown): ProjectFile {
  if (!isRecord(value) || !Array.isArray(value["projects"])) throw new Error("Invalid project file");
  return { projects: value["projects"].map(parseProject) };
}

function parseProject(value: unknown): Project {
  if (!isRecord(value)) throw new Error("Invalid project");
  const id = value["id"];
  const name = value["name"];
  const path = value["path"];
  const createdAt = value["createdAt"];
  if (typeof id !== "string" || typeof name !== "string" || typeof path !== "string" || typeof createdAt !== "string") throw new Error("Invalid project");
  return { id, name, path, createdAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function defaultProjectStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "projects.json");
}

export function projectStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_PROJECTS_FILE"];
  if (configured === undefined || configured === "") return defaultProjectStorePath(env, cwd);
  return resolve(cwd, configured);
}

export class ProjectStore {
  constructor(private readonly filePath = projectStorePath()) {}

  async list(): Promise<Project[]> {
    return (await this.read()).projects;
  }

  async add(input: { name?: string; path: string }): Promise<Project> {
    const data = await this.read();
    const path = input.path;
    const existing = data.projects.find((p) => p.path === path);
    if (existing) return existing;

    const trimmedName = input.name?.trim();
    const leafName = path.split("/").filter((part) => part !== "").at(-1);
    const project: Project = {
      id: randomUUID(),
      name: trimmedName !== undefined && trimmedName !== "" ? trimmedName : leafName ?? path,
      path,
      createdAt: new Date().toISOString(),
    };
    data.projects.push(project);
    await this.write(data);
    return project;
  }

  async get(id: string): Promise<Project | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.read();
    const projects = data.projects.filter((p) => p.id !== id);
    if (projects.length === data.projects.length) return false;
    await this.write({ projects });
    return true;
  }

  private async read(): Promise<ProjectFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseProjectFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { projects: [] };
      throw error;
    }
  }

  private async write(data: ProjectFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}
