import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";

export interface ArchiveSessionInput {
  sessionId: string;
  cwd: string;
  path: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
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
  name?: string;
  parentSessionPath?: string;
}

interface ArchiveFile {
  sessions: ArchivedSessionRecord[];
}

export class SessionArchiveStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = join(homedir(), ".pi-web", "archived-sessions.json"),
    private readonly archiveDir = join(dirname(filePath), "archived-sessions"),
  ) {}

  async list(): Promise<ArchivedSessionRecord[]> {
    return (await this.read()).sessions;
  }

  async get(sessionId: string): Promise<ArchivedSessionRecord | undefined> {
    const sessions = (await this.read()).sessions;
    return sessions.find((session) => session.sessionId === sessionId) ?? sessions.find((session) => session.sessionId.startsWith(sessionId));
  }

  async archive(session: ArchiveSessionInput): Promise<ArchivedSessionRecord> {
    return this.exclusive(async () => {
      const data = await this.read();
      const existingIndex = data.sessions.findIndex((record) => record.sessionId === session.sessionId);
      const existing = existingIndex === -1 ? undefined : data.sessions[existingIndex];
      const archivePath = existing?.archivePath ?? this.archivePathFor(session);
      const record = archiveRecordFromInput(session, {
        archivedAt: existing?.archivedAt ?? new Date().toISOString(),
        originalPath: existing?.originalPath ?? session.path,
        archivePath,
      });

      await copySessionFileToArchive(session.path, archivePath);

      if (existingIndex === -1) data.sessions.push(record);
      else data.sessions[existingIndex] = record;
      await this.write(data);
      await removeActiveSessionFile(session.path, archivePath);
      return record;
    });
  }

  async restore(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const data = await this.read();
      const record = data.sessions.find((session) => session.sessionId === sessionId);
      if (record === undefined) return;

      if (record.archivePath !== undefined && record.originalPath !== undefined) {
        await restoreSessionFile(record.archivePath, record.originalPath);
      }

      const sessions = data.sessions.filter((session) => session.sessionId !== sessionId);
      await this.write({ sessions });
    });
  }

  async deleteArchived(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const data = await this.read();
      const record = data.sessions.find((session) => session.sessionId === sessionId);
      if (record === undefined) return;

      if (record.archivePath !== undefined && await pathExists(record.archivePath)) await unlink(record.archivePath);
      const sessions = data.sessions.filter((session) => session.sessionId !== sessionId);
      await this.write({ sessions });
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

  private async read(): Promise<ArchiveFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseArchiveFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { sessions: [] };
      throw error;
    }
  }

  private async write(data: ArchiveFile): Promise<void> {
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
    cwd: session.cwd,
    archivedAt: archive.archivedAt,
    originalPath: archive.originalPath,
    archivePath: archive.archivePath,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    ...(session.name === undefined ? {} : { name: session.name }),
    ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
  };
}

async function copySessionFileToArchive(source: string, archivePath: string): Promise<void> {
  if (source === archivePath) return;
  await mkdir(dirname(archivePath), { recursive: true });
  if (await pathExists(archivePath)) return;
  await streamCopyFile(source, archivePath);
}

async function removeActiveSessionFile(source: string, archivePath: string): Promise<void> {
  if (source === archivePath) return;
  if (await pathExists(source)) await unlink(source);
}

async function restoreSessionFile(archivePath: string, originalPath: string): Promise<void> {
  if (archivePath === originalPath) return;
  if (await pathExists(originalPath)) throw new Error(`Cannot restore archived session because a session already exists at ${originalPath}`);
  await mkdir(dirname(originalPath), { recursive: true });
  await moveFile(archivePath, originalPath);
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error: unknown) {
    if (!isNodeErrorWithCode(error, "EXDEV")) throw error;
    await streamCopyFile(source, destination);
    await unlink(source);
  }
}

/**
 * Copy a file using streams (read + write) rather than `fs.copyFile`.
 *
 * `fs.copyFile` invokes Linux's `copy_file_range(2)` syscall, which fails
 * with EPERM on some filesystems — notably virtiofs (used by Kata
 * Containers) when the underlying export is NFS, and certain NFS server
 * configurations directly. Node only falls back to read+write on
 * EOPNOTSUPP/EXDEV, not EPERM, so the operation surfaces to the caller.
 *
 * Using a pipeline of createReadStream → createWriteStream forces the
 * userspace read+write path that works across these filesystems. The
 * trade-off is throughput on local fast disks (slightly slower than the
 * kernel-level copy), but archive operations move small JSONL files so
 * the impact is negligible.
 *
 * Background: https://github.com/jmfederico/pi-web/issues/... (filed
 * alongside this PR).
 */
async function streamCopyFile(source: string, destination: string): Promise<void> {
  await pipeline(createReadStream(source), createWriteStream(destination));
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

function parseArchiveFile(value: unknown): ArchiveFile {
  if (!isRecord(value) || !Array.isArray(value["sessions"])) throw new Error("Invalid archive file");
  return { sessions: value["sessions"].map(parseArchivedSessionRecord) };
}

function parseArchivedSessionRecord(value: unknown): ArchivedSessionRecord {
  if (!isRecord(value)) throw new Error("Invalid archived session record");
  const sessionId = value["sessionId"];
  const cwd = value["cwd"];
  const archivedAt = value["archivedAt"];
  if (typeof sessionId !== "string" || typeof cwd !== "string" || typeof archivedAt !== "string") throw new Error("Invalid archived session record");
  const originalPath = optionalString(value, "originalPath");
  const archivePath = optionalString(value, "archivePath");
  const created = optionalString(value, "created");
  const modified = optionalString(value, "modified");
  const messageCount = optionalNumber(value, "messageCount");
  const firstMessage = optionalString(value, "firstMessage");
  const name = optionalString(value, "name");
  const parentSessionPath = optionalString(value, "parentSessionPath");
  return {
    sessionId,
    cwd,
    archivedAt,
    ...(originalPath === undefined ? {} : { originalPath }),
    ...(archivePath === undefined ? {} : { archivePath }),
    ...(created === undefined ? {} : { created }),
    ...(modified === undefined ? {} : { modified }),
    ...(messageCount === undefined ? {} : { messageCount }),
    ...(firstMessage === undefined ? {} : { firstMessage }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
