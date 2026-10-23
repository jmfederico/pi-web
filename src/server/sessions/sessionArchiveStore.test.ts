import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionArchiveDirectory } from "../../config.js";
import { defaultSessionArchiveFilePath, SessionArchiveStore } from "./sessionArchiveStore.js";

const tempRoots: string[] = [];

describe("defaultSessionArchiveFilePath", () => {
  it("uses PI_WEB_DATA_DIR when configured", () => {
    expect(defaultSessionArchiveFilePath({ PI_WEB_DATA_DIR: "managed-state" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "managed-state", "archived-sessions.json"));
  });

  it("preserves the ~/.pi-web default when PI_WEB_DATA_DIR is unset", () => {
    expect(defaultSessionArchiveFilePath({}, "/tmp/pi-web")).toBe(join(homedir(), ".pi-web", "archived-sessions.json"));
  });
});

describe("SessionArchiveStore", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("stores its default index and archived files under PI_WEB_DATA_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-archive-data-dir-"));
    tempRoots.push(root);
    const dataDir = join(root, "managed-state");
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourcePath = join(activeDir, "2026-01-01_managed.jsonl");
    await writeFile(sourcePath, "session contents\n", "utf8");
    vi.stubEnv("PI_WEB_DATA_DIR", dataDir);

    const store = new SessionArchiveStore();
    const record = await store.archive({
      sessionId: "managed",
      cwd: "/workspace",
      path: sourcePath,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 1,
      firstMessage: "hello",
    });

    const archivePath = join(dataDir, "archived-sessions", "2026-01-01_managed.jsonl");
    expect(record.archivePath).toBe(archivePath);
    await expect(readFile(archivePath, "utf8")).resolves.toBe("session contents\n");
    await expect(readFile(join(dataDir, "archived-sessions.json"), "utf8")).resolves.toContain('"sessionId": "managed"');
  });

  it("keeps old and new archives in the same index when the destination changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-archive-destination-"));
    tempRoots.push(root);
    const env = { PI_WEB_DATA_DIR: join(root, "state") };
    const indexPath = defaultSessionArchiveFilePath(env);
    const oldStore = new SessionArchiveStore(indexPath, sessionArchiveDirectory(env));
    const archiveInput = (sessionId: string) => ({
      sessionId, cwd: root, path: join(root, `${sessionId}.jsonl`),
      created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z",
      messageCount: 1, firstMessage: "hello",
    });
    const oldInput = archiveInput("old");
    await writeFile(oldInput.path, "old transcript\n");
    const oldRecord = await oldStore.archive(oldInput);
    const newDirectory = join(root, "external-archives");
    const newStore = new SessionArchiveStore(indexPath, sessionArchiveDirectory({ ...env, PI_WEB_SESSION_ARCHIVE_DIR: newDirectory }));
    const newInput = archiveInput("new");
    await writeFile(newInput.path, "new transcript\n");
    const newRecord = await newStore.archive(newInput);

    expect(oldRecord.archivePath).toBe(join(env.PI_WEB_DATA_DIR, "archived-sessions", "old.jsonl"));
    expect(newRecord.archivePath).toBe(join(newDirectory, "new.jsonl"));
    await expect(newStore.list()).resolves.toEqual([oldRecord, newRecord]);
    await expect(readFile(indexPath, "utf8")).resolves.toContain('"sessionId": "old"');
    await expect(readFile(join(env.PI_WEB_DATA_DIR, "archived-sessions", "old.jsonl"), "utf8")).resolves.toBe("old transcript\n");
    await newStore.restore("old");
    await newStore.restore("new");
    await expect(readFile(oldInput.path, "utf8")).resolves.toBe("old transcript\n");
    await expect(readFile(newInput.path, "utf8")).resolves.toBe("new transcript\n");
    await expect(newStore.list()).resolves.toEqual([]);
  });

  it("moves archived session files out of the active session directory and restores them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-archive-"));
    tempRoots.push(root);
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourcePath = join(activeDir, "2026-01-01_s1.jsonl");
    await writeFile(sourcePath, "session contents\n", "utf8");

    const store = new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archived-files"));
    const record = await store.archive({
      sessionId: "s1",
      cwd: "/workspace",
      path: sourcePath,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 2,
      firstMessage: "hello",
    });

    expect(await exists(sourcePath)).toBe(false);
    expect(record.originalPath).toBe(sourcePath);
    expect(record.archivePath).toBeDefined();
    if (record.archivePath === undefined) throw new Error("Expected archive path");
    expect(await readFile(record.archivePath, "utf8")).toBe("session contents\n");
    await expect(store.list()).resolves.toMatchObject([{ sessionId: "s1", originalPath: sourcePath, archivePath: record.archivePath, messageCount: 2 }]);

    await store.restore("s1");

    expect(await readFile(sourcePath, "utf8")).toBe("session contents\n");
    expect(await exists(record.archivePath)).toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("permanently deletes archived session files and records", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-archive-delete-"));
    tempRoots.push(root);
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourcePath = join(activeDir, "2026-01-01_s1.jsonl");
    await writeFile(sourcePath, "session contents\n", "utf8");

    const store = new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archived-files"));
    const record = await store.archive({
      sessionId: "s1",
      cwd: "/workspace",
      path: sourcePath,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 2,
      firstMessage: "hello",
    });

    if (record.archivePath === undefined) throw new Error("Expected archive path");
    await store.deleteArchived("s1");

    expect(await exists(sourcePath)).toBe(false);
    expect(await exists(record.archivePath)).toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("archives and permanently deletes sessions in batches", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-archive-batch-"));
    tempRoots.push(root);
    const activeDir = join(root, "active");
    await mkdir(activeDir, { recursive: true });
    const sourceA = join(activeDir, "2026-01-01_a.jsonl");
    const sourceB = join(activeDir, "2026-01-01_b.jsonl");
    await writeFile(sourceA, "a\n", "utf8");
    await writeFile(sourceB, "b\n", "utf8");

    const store = new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archived-files"));
    const records = await store.archiveMany([
      {
        sessionId: "a",
        cwd: "/workspace",
        path: sourceA,
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:01:00.000Z",
        messageCount: 1,
        firstMessage: "a",
      },
      {
        sessionId: "b",
        cwd: "/workspace",
        path: sourceB,
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:02:00.000Z",
        messageCount: 2,
        firstMessage: "b",
      },
    ]);

    expect(records.map((record) => record.sessionId)).toEqual(["a", "b"]);
    expect(await exists(sourceA)).toBe(false);
    expect(await exists(sourceB)).toBe(false);
    await expect(store.list()).resolves.toMatchObject([{ sessionId: "a" }, { sessionId: "b" }]);

    const archivePaths = records.map((record) => record.archivePath);
    if (archivePaths.some((path) => path === undefined)) throw new Error("Expected archive paths");
    await expect(store.deleteArchivedMany(["a", "b", "missing"])).resolves.toEqual(["a", "b"]);
    for (const archivePath of archivePaths) {
      if (archivePath === undefined) throw new Error("Expected archive path");
      expect(await exists(archivePath)).toBe(false);
    }
    await expect(store.list()).resolves.toEqual([]);
  });

  it("requires exact persisted session IDs and canonicalizes stored cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-archive-prefix-"));
    tempRoots.push(root);
    const archiveFile = join(root, "archived-sessions.json");
    const rawCwd = join(root, "workspace", "..", "workspace");
    await writeFile(archiveFile, JSON.stringify({
      sessions: [
        {
          sessionId: "abc123",
          cwd: rawCwd,
          archivedAt: "2026-01-01T00:00:00.000Z",
          originalPath: "/sessions/abc123.jsonl",
          archivePath: "/archive/abc123.jsonl",
          messageCount: 3,
          firstMessage: "prefix",
          name: "Prefix match",
          parentSessionPath: "/sessions/root.jsonl",
        },
        {
          sessionId: "abc",
          cwd: rawCwd,
          archivedAt: "2026-01-01T00:00:00.000Z",
          originalPath: "/sessions/abc.jsonl",
          archivePath: "/archive/abc.jsonl",
          messageCount: 1,
          firstMessage: "exact",
        },
      ],
    }), "utf8");

    const store = new SessionArchiveStore(archiveFile, join(root, "archived-files"));

    await expect(store.get("abc")).resolves.toMatchObject({
      sessionId: "abc",
      cwd: resolve(rawCwd),
      firstMessage: "exact",
    });
    await expect(store.get("abc123")).resolves.toMatchObject({
      sessionId: "abc123",
      cwd: resolve(rawCwd),
      firstMessage: "prefix",
      name: "Prefix match",
      parentSessionPath: "/sessions/root.jsonl",
    });
    await expect(store.get("abc1")).resolves.toBeUndefined();
    await expect(store.get("")).resolves.toBeUndefined();
    await expect(store.isArchived("abc1")).resolves.toBe(false);
    await expect(store.isArchived("abc123")).resolves.toBe(true);
    await expect(store.isArchived("missing")).resolves.toBe(false);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
