import { isAbsolute, resolve } from "node:path";
import type { JsonObject, ProjectInput } from "../../server-plugin-api.js";
import type { ProjectService } from "../projects/projectService.js";
import { loadProjectPiWebConfig, snapshotPluginSettings, type LoadedProjectPiWebConfig } from "../workspaces/projectPiWebConfig.js";

interface ProjectPluginSettingsSnapshotOptions {
  readonly timeoutMs?: number;
  readonly loadConfig?: (projectPath: string, signal: AbortSignal) => Promise<LoadedProjectPiWebConfig>;
}

type ScopeSnapshot =
  | { readonly settings: Readonly<Record<string, JsonObject>> }
  | { readonly error: unknown };

/**
 * Daemon-lifetime project overrides, including absent files and scope errors.
 * Only a new instance observes edits; each invocation supplies its own global base.
 */
export class ProjectPluginSettingsSnapshots {
  private readonly scopes = new Map<string, Promise<ScopeSnapshot>>();
  private readonly timeoutMs: number;
  private readonly loadConfig: NonNullable<ProjectPluginSettingsSnapshotOptions["loadConfig"]>;

  constructor(
    private readonly projects: Pick<ProjectService, "requireProject">,
    { timeoutMs = 5_000, loadConfig = loadProjectPiWebConfig }: ProjectPluginSettingsSnapshotOptions = {},
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Project config timeoutMs must be a positive integer");
    this.timeoutMs = timeoutMs;
    this.loadConfig = loadConfig;
  }

  /** Optional startup preload. Bad or timed-out scopes are retained without rejecting startup. */
  async initialize(projects: readonly ProjectInput[]): Promise<void> {
    await Promise.all(projects.map(async ({ id }) => {
      const registered = await this.requireProject(id);
      await this.scopeSnapshot(registered);
    }));
  }

  async resolve(
    pluginId: string,
    globalSettings: JsonObject,
    project: ProjectInput,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted();
    // Capture before yielding: callers cannot change the base during project I/O.
    const base = snapshotPluginSettings(globalSettings, `Global settings for server plugin ${pluginId}`);
    try {
      const registered = await this.requireProject(project.id);
      signal.throwIfAborted();
      const snapshot = await this.scopeSnapshot(registered);
      signal.throwIfAborted();
      if ("error" in snapshot) throw snapshot.error;
      const overrides = Object.hasOwn(snapshot.settings, pluginId) ? snapshot.settings[pluginId] : undefined;
      return snapshotPluginSettings({ ...base, ...overrides }, `Project settings for server plugin ${pluginId}`);
    } finally {
      signal.throwIfAborted();
    }
  }

  private async requireProject(id: string): Promise<Pick<ProjectInput, "id" | "path">> {
    if (id === "") throw new Error("PI WEB plugin settings require a registered project id");
    const project = await this.projects.requireProject(id);
    if (project.id !== id) throw new Error("PI WEB plugin settings resolved a mismatched project id");
    if (!isAbsolute(project.path)) throw new Error("PI WEB plugin settings require an absolute registered project path");
    // Never read a caller-supplied path, even for an already cached id.
    return { id, path: resolve(project.path) };
  }

  private scopeSnapshot(project: Pick<ProjectInput, "id" | "path">): Promise<ScopeSnapshot> {
    const key = JSON.stringify([project.id, project.path]);
    let snapshot = this.scopes.get(key);
    if (snapshot === undefined) {
      snapshot = this.loadScope(project);
      this.scopes.set(key, snapshot);
    }
    return snapshot;
  }

  private async loadScope(project: Pick<ProjectInput, "id" | "path">): Promise<ScopeSnapshot> {
    // This deadline belongs to the shared snapshot, not to any one caller.
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`Project config read timed out after ${String(this.timeoutMs)}ms`);
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
      timeout.unref();
    });
    try {
      // Race as well as abort: stat/open and an uncooperative reader may not
      // settle on cancellation. A late result must never replace this snapshot.
      const loaded = await Promise.race([
        Promise.resolve().then(() => this.loadConfig(project.path, controller.signal)),
        deadline,
      ]);
      const settings = Object.freeze(Object.fromEntries(Object.entries(loaded.config.plugins ?? {})
        .flatMap(([pluginId, config]) => config.settings === undefined ? [] : [[pluginId, config.settings]])));
      return Object.freeze({ settings });
    } catch (error) {
      // Fulfilled error snapshots avoid unhandled preload rejections and fail only
      // consumers of this project. They must not fall back to global settings.
      const message = error instanceof Error ? error.message : String(error);
      return Object.freeze({ error: new Error(
        `PI WEB plugin settings for project ${project.id} (${project.path}) could not be loaded: ${message}`,
        { cause: error },
      ) });
    } finally {
      clearTimeout(timeout);
    }
  }
}
