import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isLogEntry, type LogEntry } from "./browser/protocol.js";

/** Only host-resolved ids enter the scope hash; peer input is never a filesystem path. */
export function logScope(projectId: string, workspaceId: string): string {
  return createHash("sha256").update(JSON.stringify([projectId, workspaceId])).digest("hex");
}

export class LogStore {
  constructor(private readonly dataDirectory: string) {}

  private async directory(scope: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error("Invalid captain scope");
    const directory = join(this.dataDirectory, scope);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error("LogEntry directory must not be a symlink");
    return directory;
  }

  async save(scope: string, captain: LogEntry): Promise<void> {
    if (!isLogEntry(captain)) throw new Error("Invalid captain record");
    const directory = await this.directory(scope);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(captain)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(directory, `${captain.id}.json`));
    } finally { await rm(temporary, { force: true }); }
  }

  async read(scope: string, id: unknown): Promise<LogEntry> {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid captain id");
    const path = join(await this.directory(scope), `${id}.json`);
    // O_NOFOLLOW is not enforced on Windows; reject existing links there too.
    if (!(await lstat(path)).isFile()) throw new Error("Invalid captain file");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 300_000) throw new Error("Invalid captain file");
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!isLogEntry(value) || value.id !== id) throw new Error("Invalid saved captain");
      return value;
    } finally { await file.close(); }
  }

  async list(scope: string): Promise<LogEntry[]> {
    const names = await readdir(await this.directory(scope));
    const captains: LogEntry[] = [];
    for (const name of names) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) captains.push(await this.read(scope, name.slice(0, -5)));
    }
    return captains.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
}
