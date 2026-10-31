import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface LegacySource {
  path: string;
  record: Record<string, unknown>;
}

/** One-way file compatibility only; naming semantics belong to the Pi package. */
export function migrateSessionNamingConfig(options: {
  agentDir: string;
  saved: LegacySource;
  defaults?: LegacySource;
  cleanup: () => void;
}): void {
  const sources = [options.defaults, options.saved].filter((source): source is LegacySource => source !== undefined && Object.hasOwn(source.record, "sessionNaming"));
  if (sources.length === 0) return;
  const destination = join(options.agentDir, "session-naming", "config.json");
  const sourcePaths = sources.map((source) => source.path).join(", ");
  if (options.defaults !== undefined && Object.hasOwn(options.defaults.record, "sessionNaming")) {
    console.error(`Obsolete sessionNaming in deployment defaults ${options.defaults.path}; remove this key manually after checking ${destination}. Deployment defaults are never modified.`);
  }
  try {
    let merged: Record<string, unknown> = {};
    for (const source of sources) {
      const value = source.record["sessionNaming"];
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`sessionNaming must be a JSON object: ${source.path}`);
      }
      merged = { ...merged, ...value };
    }
    publishIfAbsent(destination, merged);
    if (Object.hasOwn(options.saved.record, "sessionNaming")) options.cleanup();
  } catch (error) {
    console.error(`Session naming migration failed from ${sourcePaths} to ${destination}; legacy keys retained for retry on next config load.`, error);
  }
}

function publishIfAbsent(path: string, value: Record<string, unknown>): void {
  try {
    // A readable existing file is authoritative, including an explicit empty reset.
    // Directories and broken symlinks must not authorize deleting the source data.
    readFileSync(path);
    return;
  } catch (error) {
    if (!isFileError(error, "ENOENT")) throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      // Publish complete contents without replacing a concurrently created file.
      linkSync(temporary, path);
    } catch (error) {
      if (!isFileError(error, "EEXIST")) throw error;
      readFileSync(path);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
