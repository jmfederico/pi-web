import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";
import type { NavigationPreference, NavigationPreferenceWrite } from "../../shared/navigationPreferences.js";

export type NavigationPreferenceScope =
  | { kind: "projects" }
  | { kind: "workspaces"; projectId: string }
  | { kind: "session-pins"; projectId: string; workspaceId: string };

interface PreferenceEntry extends NavigationPreference {
  scope: NavigationPreferenceScope;
}
interface PreferenceFile {
  version: 1;
  entries: PreferenceEntry[];
}

export function navigationPreferenceStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "navigation-preferences.json");
}

export class InvalidNavigationPreferenceError extends Error {}
export class NavigationPreferenceConflictError extends Error {
  constructor(readonly current: NavigationPreference) {
    super("Navigation preference revision conflict");
  }
}

export function parseNavigationPreference(value: unknown): NavigationPreferenceWrite {
  if (!isRecord(value) || !Array.isArray(value["ids"])) {
    throw new InvalidNavigationPreferenceError("Navigation preference must contain an ids array");
  }
  const ids: unknown[] = value["ids"];
  if (!ids.every((id): id is string => typeof id === "string" && id.trim() !== "")) {
    throw new InvalidNavigationPreferenceError("Navigation IDs must be non-empty strings");
  }
  if (new Set(ids).size !== ids.length) {
    throw new InvalidNavigationPreferenceError("Navigation IDs must be unique");
  }
  const revision = value["revision"];
  if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
    throw new InvalidNavigationPreferenceError("Navigation revision must be a non-negative safe integer");
  }
  return { ids: [...ids], ...(revision === undefined ? {} : { revision }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseScope(value: unknown): NavigationPreferenceScope {
  if (isRecord(value)) {
    if (value["kind"] === "projects") return { kind: "projects" };
    const projectId = value["projectId"];
    if (typeof projectId === "string" && projectId !== "") {
      if (value["kind"] === "workspaces") return { kind: "workspaces", projectId };
      const workspaceId = value["workspaceId"];
      if (value["kind"] === "session-pins" && typeof workspaceId === "string" && workspaceId !== "") {
        return { kind: "session-pins", projectId, workspaceId };
      }
    }
  }
  throw new Error("Invalid navigation preference scope in state file");
}

function scopeKey(scope: NavigationPreferenceScope): string {
  // Tuple encoding avoids collisions for opaque IDs containing separators.
  return JSON.stringify(scope.kind === "projects" ? [scope.kind]
    : scope.kind === "workspaces" ? [scope.kind, scope.projectId]
      : [scope.kind, scope.projectId, scope.workspaceId]);
}

/** Web/API-owned managed state. IDs are opaque: do not query sessiond or prune offline/stale entries. */
export class NavigationPreferenceStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = navigationPreferenceStorePath()) {}

  async get(scope: NavigationPreferenceScope): Promise<NavigationPreference> {
    await this.writes;
    const entry = (await this.read()).entries.find((entry) => scopeKey(entry.scope) === scopeKey(scope));
    return { ids: [...(entry?.ids ?? [])], revision: entry?.revision ?? 0 };
  }

  async put(scope: NavigationPreferenceScope, value: NavigationPreferenceWrite): Promise<NavigationPreference> {
    const preference = parseNavigationPreference(value);
    let revision = 0;
    const operation = this.writes.then(async () => {
      const data = await this.read();
      const current = data.entries.find((entry) => scopeKey(entry.scope) === scopeKey(scope));
      const currentRevision = current?.revision ?? 0;
      if (preference.revision !== undefined && preference.revision !== currentRevision) {
        throw new NavigationPreferenceConflictError({ ids: [...(current?.ids ?? [])], revision: currentRevision });
      }
      revision = currentRevision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("Navigation preference revision exhausted");
      data.entries = data.entries.filter((entry) => scopeKey(entry.scope) !== scopeKey(scope));
      // Keep cleared entries so stale conditional writes cannot resurrect old preferences.
      data.entries.push({ scope, ids: preference.ids, revision });
      await this.write(data);
    });
    // A failed write must reach its caller without poisoning later operations.
    this.writes = operation.catch(() => undefined);
    await operation;
    return { ids: [...preference.ids], revision };
  }

  private async read(): Promise<PreferenceFile> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, entries: [] };
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["entries"])) {
      throw new Error("Invalid navigation preference state file");
    }
    const entries: PreferenceEntry[] = value["entries"].map((entry: unknown) => {
      if (!isRecord(entry)) throw new Error("Invalid navigation preference entry");
      // Disk corruption is a server error, not a client validation failure.
      try {
        const preference = parseNavigationPreference(entry);
        if (preference.revision === undefined) throw new Error("Missing navigation preference revision");
        return { scope: parseScope(entry["scope"]), ids: preference.ids, revision: preference.revision };
      } catch (error) {
        throw new Error("Invalid navigation preference state file", { cause: error });
      }
    });
    if (new Set(entries.map((entry) => scopeKey(entry.scope))).size !== entries.length) {
      throw new Error("Duplicate navigation preference scopes in state file");
    }
    return { version: 1, entries };
  }

  private async write(data: PreferenceFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
