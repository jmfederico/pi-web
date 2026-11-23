import { constants, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export interface ConfigDocument { content: string | undefined; record: Record<string, unknown> }

export function readConfigDocument(path: string): ConfigDocument {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return { content: undefined, record: {} };
    throw error;
  }
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`PI WEB config must be a regular file: ${path}`);
    const content = readFileSync(descriptor, "utf8");
    let record: unknown;
    try { record = JSON.parse(content.replace(/^\uFEFF/, "")); }
    catch { throw new Error(`PI WEB config contains invalid JSON: ${path}`); }
    if (!isRecord(record)) throw new Error(`PI WEB config must be a JSON object: ${path}`);
    return { content, record };
  } finally { closeSync(descriptor); }
}

export function canonicalConfigPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(existsSync(dirname(path)) ? realpathSync(dirname(path)) : resolve(dirname(path)), basename(path));
}

/**
 * Serialize cooperating writers across processes; publish only after checking for external edits.
 * Editors that ignore this lock can still race the final check/rename: no filesystem CAS exists.
 * An abandoned lock fails visibly rather than risking a live writer's data.
 */
export function updateConfigDocument(path: string, update: (document: ConfigDocument) => Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const destination = canonicalConfigPath(path);
  const lock = `${destination}.pi-web-lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (hasCode(error, "EEXIST")) throw new Error(`PI WEB config is being updated; retry or remove an abandoned lock: ${lock}`, { cause: error });
    throw error;
  }
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    const before = readConfigDocument(destination);
    const next = update(before);
    const mode = existsSync(destination) ? statSync(destination).mode & 0o777 : 0o600;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode, flag: "wx" });
    chmodSync(temporary, mode);
    if (canonicalConfigPath(path) !== destination || readConfigDocument(destination).content !== before.content) throw new Error(`PI WEB config changed during update; reload and retry: ${path}`);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
