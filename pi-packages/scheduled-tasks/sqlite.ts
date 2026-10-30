import { createRequire } from "node:module";

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: (string | number | null)[]): unknown;
    get(...values: (string | number | null)[]): Record<string, unknown> | undefined | null;
    all(...values: (string | number | null)[]): Record<string, unknown>[];
  };
  close(): void;
}

/** Both supported runtimes provide SQLite; no native npm addon or external service is needed. */
export function openSqlite(path: string): SqliteDatabase {
  const require = createRequire(import.meta.url);
  const bun = process.versions["bun"] !== undefined;
  const loaded: unknown = require(bun ? "bun:sqlite" : "node:sqlite");
  const name = bun ? "Database" : "DatabaseSync";
  if (!isSqliteModule(loaded, name)) throw new Error("Runtime does not provide SQLite");
  const Database = loaded[name];
  if (Database === undefined) throw new Error("SQLite constructor unavailable");
  return new Database(path);
}

function isSqliteModule(value: unknown, name: string): value is Record<string, new (path: string) => SqliteDatabase> {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, name) === "function";
}
