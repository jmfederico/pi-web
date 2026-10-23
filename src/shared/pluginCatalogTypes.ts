import type { JsonValue, PluginCapability, SessionUiMetadata, WorkspaceProviderMetadata, WorkspaceRemovalPresentation } from "./pluginApiTypes.js";

export interface PluginCatalogProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}
export interface PluginCatalogWorkspace {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly label: string;
  readonly isMain: boolean;
  readonly provider?: WorkspaceProviderMetadata;
  readonly removal?: WorkspaceRemovalPresentation;
}
export interface PluginSessionSnapshot {
  readonly id: string;
  readonly cwd: string;
  readonly name?: string;
  readonly metadata?: SessionUiMetadata;
  readonly archived: boolean;
  readonly runtime: "not-hosted" | "idle" | "busy";
}
export interface PluginWorkspaceSelection {
  readonly projectId: string;
  readonly workspaceId: string;
}
export interface PluginSessionSelection extends PluginWorkspaceSelection {
  readonly sessionId: string;
}
export interface PluginCatalogReadOptions { readonly signal?: AbortSignal }
export interface PluginCatalogV1 {
  readonly version: 1;
  readonly projects: {
    readonly list: (options?: PluginCatalogReadOptions) => Promise<readonly PluginCatalogProject[]>;
    readonly get: (projectId: string, options?: PluginCatalogReadOptions) => Promise<PluginCatalogProject>;
  };
  readonly workspaces: {
    readonly list: (projectId: string, options?: PluginCatalogReadOptions) => Promise<readonly PluginCatalogWorkspace[]>;
    readonly get: (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => Promise<PluginCatalogWorkspace>;
  };
  readonly sessions: {
    readonly list: (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => Promise<readonly PluginSessionSnapshot[]>;
    readonly get: (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => Promise<PluginSessionSnapshot>;
  };
}

export const PI_WEB_HOST_CATALOG_CAPABILITY: PluginCapability<PluginCatalogV1, 1> = Object.freeze({
  pluginId: "pi-web.host",
  id: "catalog",
  version: 1,
  parse: snapshotCatalog,
});

function snapshotCatalog(value: unknown): PluginCatalogV1 {
  const catalog = record(value);
  if (catalog["version"] !== 1) throw invalid();
  const projects = methods(catalog["projects"]);
  const workspaces = methods(catalog["workspaces"]);
  const sessions = methods(catalog["sessions"]);
  return Object.freeze({
    version: 1,
    projects: Object.freeze({
      list: async (options?: PluginCatalogReadOptions) => array(await projects.list(options), snapshotProject),
      get: async (projectId: string, options?: PluginCatalogReadOptions) => {
        const id = text(projectId);
        const result = snapshotProject(await projects.get(id, options));
        if (result.id !== id) throw invalid();
        return result;
      },
    }),
    workspaces: Object.freeze({
      list: async (projectId: string, options?: PluginCatalogReadOptions) => {
        const id = text(projectId);
        return array(await workspaces.list(id, options), (row) => workspaceFor(row, id));
      },
      get: async (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => {
        const requested = snapshotSelection(selection);
        const result = workspaceFor(await workspaces.get(requested, options), requested.projectId);
        if (result.id !== requested.workspaceId) throw invalid();
        return result;
      },
    }),
    sessions: Object.freeze({
      list: async (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) =>
        array(await sessions.list(snapshotSelection(selection), options), snapshotSession),
      get: async (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => {
        const requested = snapshotSelection(selection, true);
        const result = snapshotSession(await sessions.get(requested, options));
        if (result.id !== requested.sessionId) throw invalid();
        return result;
      },
    }),
  });
}

function methods(value: unknown) {
  const owner = record(value);
  const list = owner["list"];
  const get = owner["get"];
  if (typeof list !== "function" || typeof get !== "function") throw invalid();
  return {
    list: (...args: unknown[]): Promise<unknown> => Promise.resolve(Reflect.apply(list, owner, args)),
    get: (...args: unknown[]): Promise<unknown> => Promise.resolve(Reflect.apply(get, owner, args)),
  };
}
function snapshotProject(value: unknown): PluginCatalogProject {
  const row = record(value);
  return Object.freeze({ id: text(row["id"]), name: text(row["name"]), path: text(row["path"]) });
}
function workspaceFor(value: unknown, projectId: string): PluginCatalogWorkspace {
  const row = record(value);
  if (row["projectId"] !== projectId || typeof row["isMain"] !== "boolean") throw invalid();
  let provider: WorkspaceProviderMetadata | undefined;
  if (row["provider"] !== undefined) {
    const source = record(row["provider"]);
    const capabilities = record(source["capabilities"]);
    if (typeof capabilities["remove"] !== "boolean") throw invalid();
    provider = Object.freeze({
      pluginId: text(source["pluginId"]),
      capabilities: Object.freeze({ remove: capabilities["remove"] }),
      ...(source["metadata"] === undefined ? {} : { metadata: jsonObject(source["metadata"]) }),
    });
  }
  const removal = row["removal"] === undefined ? undefined : record(row["removal"]);
  return Object.freeze({
    id: text(row["id"]), projectId, path: text(row["path"]), label: text(row["label"]), isMain: row["isMain"],
    ...(provider === undefined ? {} : { provider }),
    ...(removal === undefined ? {} : { removal: Object.freeze({ actionLabel: text(removal["actionLabel"]), confirmation: text(removal["confirmation"]) }) }),
  });
}
function snapshotSession(value: unknown): PluginSessionSnapshot {
  const row = record(value);
  const runtime = row["runtime"];
  if (typeof row["archived"] !== "boolean" || (runtime !== "not-hosted" && runtime !== "idle" && runtime !== "busy")) throw invalid();
  let metadata: SessionUiMetadata | undefined;
  if (row["metadata"] !== undefined) {
    metadata = Object.freeze(Object.fromEntries(Object.entries(record(row["metadata"])).map(([key, data]) => [key, jsonObject(data)])));
  }
  if (row["name"] !== undefined && typeof row["name"] !== "string") throw invalid();
  return Object.freeze({
    id: text(row["id"]), cwd: text(row["cwd"]), archived: row["archived"], runtime,
    ...(row["name"] === undefined ? {} : { name: row["name"] }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}
function snapshotSelection(value: unknown): PluginWorkspaceSelection;
function snapshotSelection(value: unknown, session: true): PluginSessionSelection;
function snapshotSelection(value: unknown, session = false): PluginWorkspaceSelection | PluginSessionSelection {
  const row = record(value);
  const keys = session ? ["projectId", "workspaceId", "sessionId"] : ["projectId", "workspaceId"];
  if (Reflect.ownKeys(row).some((key) => typeof key !== "string" || !keys.includes(key))) throw invalid();
  return Object.freeze({ projectId: text(row["projectId"]), workspaceId: text(row["workspaceId"]), ...(session ? { sessionId: text(row["sessionId"]) } : {}) });
}
function array<T>(value: unknown, snapshot: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw invalid();
  return Object.freeze(value.map(snapshot));
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid();
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid();
  return value;
}
function jsonObject(value: unknown, ancestors = new Set<object>()): Readonly<Record<string, JsonValue>> {
  const source = record(value);
  if (ancestors.has(source)) throw invalid();
  ancestors.add(source);
  const result = Object.freeze(Object.fromEntries(Object.entries(source).map(([key, data]) => [key, json(data, ancestors)])));
  ancestors.delete(source);
  return result;
}
function json(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw invalid();
    ancestors.add(value);
    const result = Object.freeze(value.map((item: unknown) => json(item, ancestors)));
    ancestors.delete(value);
    return result;
  }
  return jsonObject(value, ancestors);
}
function invalid(): Error { return new Error("Invalid PI WEB host catalog capability v1 data"); }
