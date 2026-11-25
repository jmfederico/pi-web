import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";
import { canonicalizeStoredCwd } from "../workingDirectory.js";
import type { SessionUiMetadata } from "../../shared/pluginApiTypes.js";
import { requireSessionUiMetadata } from "./sessionMetadata.js";
import { readSessionHeaderSummary } from "./sessionFileHeader.js";

export interface ArchiveSessionInput {
  sessionId: string;
  cwd: string;
  path: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  metadata?: SessionUiMetadata;
  name?: string;
  parentSessionPath?: string;
}

export interface ArchivedSessionRecord {
  sessionId: string;
  cwd: string;
  archivedAt: string;
  originalPath?: string;
  archivePath?: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstMessage?: string;
  metadata?: SessionUiMetadata;
  name?: string;
  parentSessionPath?: string;
}

export interface SessionArchiveFile {
  sessions: ArchivedSessionRecord[];
}

export function defaultSessionArchiveFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "archived-sessions.json");
}

export class SessionArchiveStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = defaultSessionArchiveFilePath(),
    private readonly archiveDir = join(dirname(filePath), "archived-sessions"),
  ) {}

  async list(): Promise<ArchivedSessionRecord[]> {
    return (await this.read()).sessions;
  }

  async get(sessionId: string): Promise<ArchivedSessionRecord | undefined> {
    const sessions = (await this.read()).sessions;
    return sessions.find((session) => session.sessionId === sessionId);
  }

  async archive(session: ArchiveSessionInput): Promise<ArchivedSessionRecord> {
    const [record] = await this.archiveMany([session]);
    if (record === undefined) throw new Error("Archive operation did not produce a record");
    return record;
  }

  async archiveMany(sessions: readonly ArchiveSessionInput[]): Promise<ArchivedSessionRecord[]> {
    if (sessions.length === 0) return [];
    return this.exclusive(async () => {
      const data = await this.read();
      const records: ArchivedSessionRecord[] = [];
      const filesToRemove: { session: ArchiveSessionInput; archivePath: string; created: boolean }[] = [];

      for (const session of sessions) {
        const existingIndex = data.sessions.findIndex((record) => record.sessionId === session.sessionId);
        const existing = existingIndex === -1 ? undefined : data.sessions[existingIndex];
        if (existing?.originalPath !== undefined && existing.originalPath !== session.path) {
          throw new Error(`Cannot archive session ${session.sessionId} from ${session.path}: it was archived from ${existing.originalPath}`);
        }
        const archivePath = existing?.archivePath ?? this.archivePathFor(session);
        const owner = data.sessions.find((record) => record.archivePath === archivePath && record.sessionId !== session.sessionId);
        if (owner !== undefined) {
          throw new Error(`Cannot archive session ${session.sessionId} from ${session.path}: destination ${archivePath} belongs to session ${owner.sessionId}`);
        }
        const record = archiveRecordFromInput(session, {
          archivedAt: existing?.archivedAt ?? new Date().toISOString(),
          originalPath: existing?.originalPath ?? session.path,
          archivePath,
        });

        await copySessionFileToArchive(session, archivePath, existing !== undefined);

        if (existingIndex === -1) data.sessions.push(record);
        else data.sessions[existingIndex] = record;
        records.push(record);
        filesToRemove.push({ session, archivePath, created: existing === undefined });
      }

      await this.write(data);
      const failures: { file: (typeof filesToRemove)[number]; error: unknown }[] = [];
      for (const file of filesToRemove) {
        try {
          await removeArchivedSource(file.session, file.archivePath);
        } catch (error: unknown) {
          failures.push({ file, error });
        }
      }
      if (failures.length === 0) return records;
      throw await this.rollBackUnfinishedArchives(data, failures);
    });
  }

  /**
   * A failed cleanup always leaves the original in place. Unindex sessions this
   * operation archived so they stay active; records that existed before stay
   * indexed until a retry finishes them or a restore keeps the original.
   */
  private async rollBackUnfinishedArchives(
    data: SessionArchiveFile,
    failures: readonly { file: { session: ArchiveSessionInput; archivePath: string; created: boolean }; error: unknown }[],
  ): Promise<Error> {
    const rollBackIds = new Set(failures.filter(({ file }) => file.created).map(({ file }) => file.session.sessionId));
    let rolledBack = false;
    if (rollBackIds.size > 0) {
      try {
        await this.write({ sessions: data.sessions.filter((record) => !rollBackIds.has(record.sessionId)) });
        rolledBack = true;
        for (const { file } of failures) {
          if (rollBackIds.has(file.session.sessionId)) await unlink(file.archivePath).catch(() => undefined);
        }
      } catch {
        // Keep the indexed archive; retrying archival completes or reports it.
      }
    }
    const errors = failures.map(({ file, error }) => {
      const { sessionId, path } = file.session;
      return rolledBack && rollBackIds.has(sessionId)
        ? new Error(`Could not archive session ${sessionId}: ${errorMessage(error)}. It was left unarchived`, { cause: error })
        : new Error(`Session ${sessionId} is archived, but its original at ${path} was kept: ${errorMessage(error)}`, { cause: error });
    });
    const [only] = errors;
    return errors.length === 1 && only !== undefined ? only : new AggregateError(errors, errors.map(errorMessage).join("; "));
  }

  async restore(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const data = await this.read();
      const record = data.sessions.find((session) => session.sessionId === sessionId);
      if (record === undefined) return;

      const replacedArchive = record.archivePath !== undefined && record.originalPath !== undefined
        ? await restoreSessionFile(record.archivePath, record.originalPath)
        : undefined;

      const sessions = data.sessions.filter((session) => session.sessionId !== sessionId);
      await this.write({ sessions });
      // Keep the archive copy until the record is gone, so a failed write can be
      // retried. The restore has then succeeded; a leftover copy is an older
      // prefix that a later archive of this session refreshes.
      if (replacedArchive !== undefined) await unlink(replacedArchive).catch(() => undefined);
    });
  }

  async deleteArchived(sessionId: string): Promise<void> {
    await this.deleteArchivedMany([sessionId]);
  }

  async deleteArchivedMany(sessionIds: readonly string[]): Promise<string[]> {
    const targetIds = uniqueStrings(sessionIds);
    if (targetIds.length === 0) return [];
    return this.exclusive(async () => {
      const data = await this.read();
      const targetIdSet = new Set(targetIds);
      const records = data.sessions.filter((session) => targetIdSet.has(session.sessionId));
      if (records.length === 0) return [];

      for (const record of records) {
        if (record.archivePath !== undefined && await pathExists(record.archivePath)) await unlink(record.archivePath);
      }
      const sessions = data.sessions.filter((session) => !targetIdSet.has(session.sessionId));
      await this.write({ sessions });
      const deletedIds = new Set(records.map((record) => record.sessionId));
      return targetIds.filter((sessionId) => deletedIds.has(sessionId));
    });
  }

  async isArchived(sessionId: string): Promise<boolean> {
    return (await this.get(sessionId)) !== undefined;
  }

  private archivePathFor(session: ArchiveSessionInput): string {
    const sourceName = basename(session.path);
    const fileName = sourceName === "" ? `${safeFileName(session.sessionId)}.jsonl` : sourceName;
    return join(this.archiveDir, fileName);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async read(): Promise<SessionArchiveFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseSessionArchiveFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { sessions: [] };
      throw error;
    }
  }

  private async write(data: SessionArchiveFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = join(dirname(this.filePath), `.${basename(this.filePath)}.${String(process.pid)}.${Date.now().toString()}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error: unknown) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

function archiveRecordFromInput(session: ArchiveSessionInput, archive: { archivedAt: string; originalPath: string; archivePath: string }): ArchivedSessionRecord {
  return {
    sessionId: session.sessionId,
    cwd: canonicalizeStoredCwd(session.cwd),
    archivedAt: archive.archivedAt,
    originalPath: archive.originalPath,
    archivePath: archive.archivePath,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    ...(session.metadata === undefined ? {} : { metadata: requireSessionUiMetadata(session.metadata) }),
    ...(session.name === undefined ? {} : { name: session.name }),
    ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
  };
}

async function copySessionFileToArchive(session: ArchiveSessionInput, archivePath: string, committed: boolean): Promise<void> {
  const source = session.path;
  if (source === archivePath) return;
  await mkdir(dirname(archivePath), { recursive: true });
  if (!await pathExists(archivePath)) {
    // Do not overwrite a destination that appeared after the existence check.
    await copyFile(source, archivePath, constants.COPYFILE_EXCL);
    return;
  }

  const conflict = (reason: string): Error => new Error(`Cannot archive session ${session.sessionId} from ${source}: destination ${archivePath} conflicts (${reason}); both files were preserved`);
  const [sourceHeader, archiveHeader] = await Promise.all([
    readSessionHeaderSummary(source), readSessionHeaderSummary(archivePath),
  ]);
  if (sourceHeader?.id !== session.sessionId || archiveHeader?.id !== session.sessionId) {
    throw conflict(`source session ${sourceHeader?.id ?? "unknown"}, destination session ${archiveHeader?.id ?? "unknown"}`);
  }
  const [sourceContent, archiveContent] = await Promise.all([readFile(source), readFile(archivePath)]);
  if (sourceContent.equals(archiveContent)) return;
  // A failed batch can leave an uncommitted copy. Refresh only an older prefix
  // of this session, never a divergent transcript or a committed archive.
  if (committed || !startsWith(sourceContent, archiveContent)) {
    throw conflict("transcript contents differ");
  }
  await copyFile(source, archivePath);
}

/**
 * Delete the original only while it still matches the archive copy. Another
 * writer is not supported, so this guards the archive operation's own window.
 */
async function removeArchivedSource(session: ArchiveSessionInput, archivePath: string): Promise<void> {
  const source = session.path;
  if (source === archivePath) return;
  let original: Buffer;
  try {
    original = await readFile(source);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) return;
    throw error;
  }
  if (!original.equals(await readFile(archivePath))) throw new Error("its transcript changed during archival");
  await unlink(source);
}

/**
 * Put the transcript back at its original path. Returns an archive copy that
 * is superseded by the original and can be deleted once the record is removed.
 */
async function restoreSessionFile(archivePath: string, originalPath: string): Promise<string | undefined> {
  if (archivePath === originalPath) return undefined;
  if (await pathExists(originalPath)) {
    // An interrupted restore already moved the archive copy back.
    if (!await pathExists(archivePath)) return undefined;
    // Interrupted archive cleanup can leave the original behind. When it still
    // holds the whole archived transcript, it is the current copy.
    const [original, archived] = await Promise.all([readFile(originalPath), readFile(archivePath)]);
    if (archived.length === 0 || !startsWith(original, archived)) {
      throw new Error(`Cannot restore archived session because a session already exists at ${originalPath}`);
    }
    return archivePath;
  }
  await mkdir(dirname(originalPath), { recursive: true });
  await moveFile(archivePath, originalPath);
  return undefined;
}

function startsWith(content: Buffer, prefix: Buffer): boolean {
  return content.length >= prefix.length && content.subarray(0, prefix.length).equals(prefix);
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error: unknown) {
    if (!isNodeErrorWithCode(error, "EXDEV")) throw error;
    await copyFile(source, destination);
    await unlink(source);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
}

export function parseSessionArchiveFile(value: unknown): SessionArchiveFile {
  if (!isRecord(value) || !Array.isArray(value["sessions"])) throw new Error("Invalid archive file");
  return { sessions: value["sessions"].map(parseArchivedSessionRecord) };
}

function parseArchivedSessionRecord(value: unknown): ArchivedSessionRecord {
  if (!isRecord(value)) throw new Error("Invalid archived session record");
  const sessionId = value["sessionId"];
  const cwd = value["cwd"];
  const archivedAt = value["archivedAt"];
  if (typeof sessionId !== "string" || typeof cwd !== "string" || typeof archivedAt !== "string") throw new Error("Invalid archived session record");
  const canonicalCwd = canonicalizeStoredCwd(cwd);
  const originalPath = optionalString(value, "originalPath");
  const archivePath = optionalString(value, "archivePath");
  const created = optionalString(value, "created");
  const modified = optionalString(value, "modified");
  const messageCount = optionalNumber(value, "messageCount");
  const firstMessage = optionalString(value, "firstMessage");
  const name = optionalString(value, "name");
  const parentSessionPath = optionalString(value, "parentSessionPath");
  const metadata = value["metadata"] === undefined ? undefined : requireSessionUiMetadata(value["metadata"]);
  return {
    sessionId,
    cwd: canonicalCwd,
    archivedAt,
    ...(originalPath === undefined ? {} : { originalPath }),
    ...(archivePath === undefined ? {} : { archivePath }),
    ...(created === undefined ? {} : { created }),
    ...(modified === undefined ? {} : { modified }),
    ...(messageCount === undefined ? {} : { messageCount }),
    ...(firstMessage === undefined ? {} : { firstMessage }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(name === undefined ? {} : { name }),
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Invalid archived session record");
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error("Invalid archived session record");
  return value;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "session";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
