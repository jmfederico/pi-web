import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginCatalogReadOptions, PluginSessionSelection } from "./pluginCatalogTypes.js";

export interface PluginSessionHistoryPageRequest {
  readonly before?: number;
  readonly limit?: number;
  readonly allowPartialTurn?: boolean;
}

export interface PluginSessionHistoryPage {
  readonly messages: readonly unknown[];
  readonly start: number;
  readonly total: number;
}

export interface PluginSessionHistoryV1 {
  readonly version: 1;
  /** Bounded observational transcript read. The host never opens a cold runtime. */
  readonly readMessages: (
    selection: PluginSessionSelection,
    page?: PluginSessionHistoryPageRequest,
    options?: PluginCatalogReadOptions,
  ) => Promise<PluginSessionHistoryPage>;
}

export const PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY: PluginCapability<PluginSessionHistoryV1, 1> = Object.freeze({
  pluginId: "pi-web.host",
  id: "session-history",
  version: 1,
  parse: snapshotHistory,
});

const DEFAULT_HISTORY_PAGE_SIZE = 100;

function snapshotHistory(value: unknown): PluginSessionHistoryV1 {
  const row = record(value);
  if (row["version"] !== 1 || !isHistoryReader(row["readMessages"])) throw invalid();
  const reader = row["readMessages"];
  return Object.freeze({
    version: 1,
    readMessages: async (selection: PluginSessionSelection, page?: PluginSessionHistoryPageRequest, options?: PluginCatalogReadOptions) => {
      const selected = snapshotSelection(selection);
      const requestedPage = snapshotPage(page ?? { limit: DEFAULT_HISTORY_PAGE_SIZE });
      const result = record(await Reflect.apply(reader, row, [selected, requestedPage, options]));
      if (!Array.isArray(result["messages"])) throw invalid();
      const start = integer(result["start"]);
      const total = integer(result["total"]);
      if (start === undefined || total === undefined || start < 0 || total < 0) throw invalid();
      return Object.freeze({
        messages: Object.freeze(result["messages"].map(snapshotMessage)),
        start,
        total,
      });
    },
  });
}

function snapshotSelection(value: PluginSessionSelection): PluginSessionSelection {
  const row = record(value);
  if (Reflect.ownKeys(row).some((key) => typeof key !== "string" || !["projectId", "workspaceId", "sessionId"].includes(key))) throw invalid();
  return Object.freeze({ projectId: text(row["projectId"]), workspaceId: text(row["workspaceId"]), sessionId: text(row["sessionId"]) });
}

function snapshotPage(value: PluginSessionHistoryPageRequest): PluginSessionHistoryPageRequest {
  const row = record(value);
  if (Reflect.ownKeys(row).some((key) => typeof key !== "string" || !["before", "limit", "allowPartialTurn"].includes(key))) throw invalid();
  const before = boundedInteger(row["before"], 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(row["limit"], 1, 100) ?? DEFAULT_HISTORY_PAGE_SIZE;
  const allowPartialTurn = row["allowPartialTurn"];
  if (allowPartialTurn !== undefined && typeof allowPartialTurn !== "boolean") throw invalid();
  return Object.freeze({ ...(before === undefined ? {} : { before }), limit, ...(allowPartialTurn === true ? { allowPartialTurn } : {}) });
}

function snapshotMessage(value: unknown): unknown {
  return freezeTree(structuredClone(value));
}

function freezeTree<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeTree(child);
  return Object.freeze(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: object | null = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHistoryReader(value: unknown): value is PluginSessionHistoryV1["readMessages"] {
  return typeof value === "function";
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid();
  return value;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid();
  return value;
}

function invalid(): Error {
  return new Error("Invalid PI WEB host session history capability v1 data");
}
