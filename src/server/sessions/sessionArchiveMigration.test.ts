import { constants } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  link as createHardLink,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectLegacySessionArchiveMigration,
  migrateLegacySessionArchive,
  type LegacySessionArchiveMigrationOptions,
} from "./sessionArchiveMigration.js";

const tempRoots: string[] = [];

describe("legacy session archive migration preflight", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("proves the ordinary legacy layout eligible without creating destination state", async () => {
    const fixture = await createLegacyArchiveFixture();

    await expect(inspectLegacySessionArchiveMigration(fixture.options)).resolves.toEqual({
      status: "eligible",
      legacyIndexPath: fixture.legacyIndexPath,
      destinationIndexPath: fixture.destinationIndexPath,
      archiveFileCount: 1,
    });
    expect(await exists(fixture.destinationRoot)).toBe(false);
    await expect(readFile(fixture.legacyFilePath, "utf8")).resolves.toBe("legacy session\n");
  });

  it("skips when PI_WEB_DATA_DIR is not explicitly configured", async () => {
    const fixture = await createLegacyArchiveFixture();

    await expect(migrateLegacySessionArchive({ ...fixture.options, env: {} })).resolves.toEqual({
      status: "skipped",
      reason: "data-dir-not-configured",
    });
    await expectLegacyStateUntouched(fixture);
    expect(await exists(fixture.destinationRoot)).toBe(false);
  });

  it("skips when the configured data root resolves to the legacy root", async () => {
    const fixture = await createLegacyArchiveFixture();

    await expect(migrateLegacySessionArchive({
      ...fixture.options,
      env: { PI_WEB_DATA_DIR: fixture.legacyRoot },
    })).resolves.toEqual({ status: "skipped", reason: "data-dir-not-distinct" });
    await expectLegacyStateUntouched(fixture);
  });

  it("skips when no legacy index exists without adopting loose legacy files", async () => {
    const fixture = await createLegacyArchiveFixture();
    await unlink(fixture.legacyIndexPath);

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "skipped",
      reason: "legacy-index-missing",
    });
    await expect(readFile(fixture.legacyFilePath, "utf8")).resolves.toBe("legacy session\n");
    await expect(readFile(fixture.activeFilePath, "utf8")).resolves.toBe("active session\n");
    expect(await exists(fixture.destinationRoot)).toBe(false);
  });

  it("skips malformed legacy indexes without creating destination state", async () => {
    const fixture = await createLegacyArchiveFixture();
    await writeFile(fixture.legacyIndexPath, "not json\n", "utf8");

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "skipped",
      reason: "legacy-index-invalid",
    });
    await expect(readFile(fixture.legacyIndexPath, "utf8")).resolves.toBe("not json\n");
    expect(await exists(fixture.destinationRoot)).toBe(false);
  });

  it("treats inconclusive filesystem inspection as a mutation-free skip", async () => {
    const fixture = await createLegacyArchiveFixture();
    const inspectionError = Object.assign(new Error("inspection denied"), { code: "EACCES" });

    const result = await migrateLegacySessionArchive({
      ...fixture.options,
      fileSystem: {
        lstat: (path) => path === fixture.destinationIndexPath
          ? Promise.reject(inspectionError)
          : lstat(path),
      },
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "inspection-failed",
      error: inspectionError,
    });
    await expectLegacyStateUntouched(fixture);
    expect(await exists(fixture.destinationRoot)).toBe(false);
  });

  it("does not merge with or overwrite an existing destination index", async () => {
    const fixture = await createLegacyArchiveFixture();
    await mkdir(fixture.destinationRoot, { recursive: true });
    await writeFile(fixture.destinationIndexPath, "destination owner\n", "utf8");

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "skipped",
      reason: "destination-index-exists",
    });
    await expect(readFile(fixture.destinationIndexPath, "utf8")).resolves.toBe("destination owner\n");
    await expectLegacyStateUntouched(fixture);
  });

  it("leaves an interrupted pre-commit file untouched instead of adopting a non-empty destination archive", async () => {
    const fixture = await createLegacyArchiveFixture({ createDestinationArchive: true });
    await writeFile(fixture.destinationFilePath, "partial destination copy\n", "utf8");

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "skipped",
      reason: "destination-archive-not-empty-or-invalid",
    });
    await expect(readFile(fixture.destinationFilePath, "utf8")).resolves.toBe("partial destination copy\n");
    await expectLegacyStateUntouched(fixture);
  });

  it("skips archive paths that are not direct regular files in the legacy archive directory", async () => {
    const fixture = await createLegacyArchiveFixture();
    const outsidePath = join(fixture.root, "outside.jsonl");
    await writeFile(outsidePath, "outside\n", "utf8");
    const firstRecord = requiredRecord(fixture.document.sessions, 0);
    const changedDocument = {
      ...fixture.document,
      sessions: [{ ...firstRecord, archivePath: outsidePath }, ...fixture.document.sessions.slice(1)],
    };
    await writeArchiveIndex(fixture.legacyIndexPath, changedDocument);

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "skipped",
      reason: "legacy-archive-layout-invalid",
    });
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside\n");
    await expect(readFile(fixture.legacyFilePath, "utf8")).resolves.toBe("legacy session\n");
    expect(await exists(fixture.destinationRoot)).toBe(false);
  });

  it("uses Windows case-insensitive path semantics without weakening Linux containment", async () => {
    const fixture = await createLegacyArchiveFixture();
    const casedArchivePath = resolve(fixture.legacyFilePath.toUpperCase());
    const firstRecord = requiredRecord(fixture.document.sessions, 0);
    await writeArchiveIndex(fixture.legacyIndexPath, {
      ...fixture.document,
      sessions: [
        { ...firstRecord, archivePath: casedArchivePath },
        ...fixture.document.sessions.slice(1),
      ],
    });
    const mapCaseVariant = (path: string): string => path.toLowerCase() === casedArchivePath.toLowerCase()
      ? fixture.legacyFilePath
      : path;
    const fileSystem = {
      lstat: (path: string) => lstat(mapCaseVariant(path)),
      realpath: (path: string) => realpath(mapCaseVariant(path)),
    };

    await expect(inspectLegacySessionArchiveMigration({
      ...fixture.options,
      platform: "linux",
      fileSystem,
    })).resolves.toEqual({ status: "skipped", reason: "legacy-archive-layout-invalid" });
    await expect(inspectLegacySessionArchiveMigration({
      ...fixture.options,
      platform: "win32",
      fileSystem,
    })).resolves.toEqual({
      status: "eligible",
      legacyIndexPath: fixture.legacyIndexPath,
      destinationIndexPath: fixture.destinationIndexPath,
      archiveFileCount: 1,
    });
  });

  it("skips legacy directories containing unindexed entries", async () => {
    const fixture = await createLegacyArchiveFixture();
    const unexpectedPath = join(fixture.legacyArchiveDir, "unexpected.tmp");
    await writeFile(unexpectedPath, "unexpected\n", "utf8");

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "skipped",
      reason: "legacy-archive-layout-invalid",
    });
    await expect(readFile(unexpectedPath, "utf8")).resolves.toBe("unexpected\n");
    await expectLegacyStateUntouched(fixture);
    expect(await exists(fixture.destinationRoot)).toBe(false);
  });

  it("skips duplicate session IDs", async () => {
    const fixture = await createLegacyArchiveFixture();
    const firstRecord = requiredRecord(fixture.document.sessions, 0);
    const secondRecord = requiredRecord(fixture.document.sessions, 1);
    await writeArchiveIndex(fixture.legacyIndexPath, {
      ...fixture.document,
      sessions: [firstRecord, { ...secondRecord, sessionId: firstRecord["sessionId"] }],
    });

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "skipped",
      reason: "archive-record-conflict",
    });
    await expect(readFile(fixture.legacyFilePath, "utf8")).resolves.toBe("legacy session\n");
    expect(await exists(fixture.destinationRoot)).toBe(false);
  });

  it("skips duplicate source and destination file mappings", async () => {
    const fixture = await createLegacyArchiveFixture();
    const firstRecord = requiredRecord(fixture.document.sessions, 0);
    await writeArchiveIndex(fixture.legacyIndexPath, {
      ...fixture.document,
      sessions: [firstRecord, { ...firstRecord, sessionId: "second-file-record" }],
    });

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "skipped",
      reason: "archive-record-conflict",
    });
    await expectLegacyStateUntouched({
      ...fixture,
      sourceIndexContents: await readFile(fixture.legacyIndexPath, "utf8"),
    });
    expect(await exists(fixture.destinationRoot)).toBe(false);
  });
});

describe("legacy session archive migration execution", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("copies across the source boundary, atomically publishes the rewritten index, then removes legacy state", async () => {
    const fixture = await createLegacyArchiveFixture({ createDestinationArchive: true });
    const copies: { source: string; destination: string; mode: number }[] = [];
    const links: { source: string; destination: string }[] = [];

    await expect(migrateLegacySessionArchive({
      ...fixture.options,
      fileSystem: {
        copyFile: async (source, destination, mode) => {
          copies.push({ source, destination, mode });
          await copyFile(source, destination, mode);
        },
        link: async (source, destination) => {
          links.push({ source, destination });
          await createHardLink(source, destination);
        },
        unlink: async (path) => {
          if (path === fixture.legacyFilePath || path === fixture.legacyIndexPath) {
            expect(await exists(fixture.destinationIndexPath)).toBe(true);
          }
          await unlink(path);
        },
      },
    })).resolves.toEqual({ status: "migrated", archiveFileCount: 1, cleanup: "complete" });

    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({ source: fixture.legacyFilePath, mode: constants.COPYFILE_EXCL });
    expect(copies[0]?.destination).toContain(".archived-sessions-migration-test-attempt");
    expect(copies[1]).toMatchObject({ destination: fixture.destinationFilePath, mode: constants.COPYFILE_EXCL });
    expect(links).toEqual([{
      source: join(fixture.destinationRoot, ".archived-sessions-migration-test-attempt", "archived-sessions.json"),
      destination: fixture.destinationIndexPath,
    }]);
    await expect(readFile(fixture.destinationFilePath, "utf8")).resolves.toBe("legacy session\n");

    const migratedDocument: unknown = JSON.parse(await readFile(fixture.destinationIndexPath, "utf8"));
    const firstRecord = requiredRecord(fixture.document.sessions, 0);
    expect(migratedDocument).toEqual({
      ...fixture.document,
      sessions: [
        { ...firstRecord, archivePath: fixture.destinationFilePath },
        requiredRecord(fixture.document.sessions, 1),
      ],
    });
    expect(await exists(fixture.legacyIndexPath)).toBe(false);
    expect(await exists(fixture.legacyFilePath)).toBe(false);
    expect(await exists(fixture.legacyArchiveDir)).toBe(false);
    await expect(readFile(fixture.activeFilePath, "utf8")).resolves.toBe("active session\n");
    expect(new Set(await readdir(fixture.destinationRoot))).toEqual(new Set([
      "archived-sessions",
      "archived-sessions.json",
    ]));
  });

  it("retries safely when an interrupted staging-only attempt left an unowned sibling tree", async () => {
    const fixture = await createLegacyArchiveFixture();
    const abandonedFile = join(
      fixture.destinationRoot,
      ".archived-sessions-migration-interrupted-attempt",
      "files",
      "abandoned.jsonl",
    );
    await mkdir(dirname(abandonedFile), { recursive: true });
    await writeFile(abandonedFile, "unowned staging data\n", "utf8");

    await expect(migrateLegacySessionArchive(fixture.options)).resolves.toEqual({
      status: "migrated",
      archiveFileCount: 1,
      cleanup: "complete",
    });

    await expect(readFile(abandonedFile, "utf8")).resolves.toBe("unowned staging data\n");
    await expect(readFile(fixture.destinationFilePath, "utf8")).resolves.toBe("legacy session\n");
    expect(await exists(fixture.destinationIndexPath)).toBe(true);
    expect(await exists(fixture.legacyIndexPath)).toBe(false);
  });

  it("rolls back destination artifacts and preserves all legacy state when staged-copy verification fails", async () => {
    const fixture = await createLegacyArchiveFixture();

    const result = await migrateLegacySessionArchive({
      ...fixture.options,
      fileSystem: {
        copyFile: async (source, destination, mode) => {
          await copyFile(source, destination, mode);
          if (source === fixture.legacyFilePath) await appendFile(destination, "corrupt", "utf8");
        },
      },
    });

    expect(result).toMatchObject({ status: "failed", phase: "stage", rollbackErrors: [] });
    await expectLegacyStateUntouched(fixture);
    expect(await exists(fixture.destinationIndexPath)).toBe(false);
    await expect(readdir(fixture.destinationRoot)).resolves.toEqual([]);
  });

  it("revalidates source files before commit and rolls back if one changes during migration", async () => {
    const fixture = await createLegacyArchiveFixture();

    const result = await migrateLegacySessionArchive({
      ...fixture.options,
      fileSystem: {
        copyFile: async (source, destination, mode) => {
          await copyFile(source, destination, mode);
          if (destination === fixture.destinationFilePath) {
            await appendFile(fixture.legacyFilePath, "changed during migration\n", "utf8");
          }
        },
      },
    });

    expect(result).toMatchObject({ status: "failed", phase: "commit-index", rollbackErrors: [] });
    await expect(readFile(fixture.legacyIndexPath, "utf8")).resolves.toBe(fixture.sourceIndexContents);
    await expect(readFile(fixture.legacyFilePath, "utf8")).resolves.toBe(
      "legacy session\nchanged during migration\n",
    );
    await expect(readFile(fixture.activeFilePath, "utf8")).resolves.toBe("active session\n");
    expect(await exists(fixture.destinationIndexPath)).toBe(false);
    expect(await exists(fixture.destinationArchiveDir)).toBe(false);
  });

  it("rolls back published files but never source state when atomic index publication fails", async () => {
    const fixture = await createLegacyArchiveFixture();
    const publicationError = Object.assign(new Error("link failed"), { code: "EIO" });

    const result = await migrateLegacySessionArchive({
      ...fixture.options,
      fileSystem: {
        link: () => Promise.reject(publicationError),
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      phase: "commit-index",
      error: publicationError,
      rollbackErrors: [],
    });
    await expectLegacyStateUntouched(fixture);
    expect(await exists(fixture.destinationIndexPath)).toBe(false);
    expect(await exists(fixture.destinationArchiveDir)).toBe(false);
    await expect(readdir(fixture.destinationRoot)).resolves.toEqual([]);
  });

  it("does not overwrite a destination index that appears at the atomic commit boundary", async () => {
    const fixture = await createLegacyArchiveFixture();
    const publicationError = Object.assign(new Error("destination index won the race"), { code: "EEXIST" });

    const result = await migrateLegacySessionArchive({
      ...fixture.options,
      fileSystem: {
        link: async (_source, destination) => {
          await writeFile(destination, "destination owner\n", { encoding: "utf8", flag: "wx" });
          throw publicationError;
        },
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      phase: "commit-index",
      error: publicationError,
      rollbackErrors: [],
    });
    await expect(readFile(fixture.destinationIndexPath, "utf8")).resolves.toBe("destination owner\n");
    expect(await exists(fixture.destinationArchiveDir)).toBe(false);
    await expectLegacyStateUntouched(fixture);
  });

  it("keeps the committed destination authoritative when legacy cleanup fails", async () => {
    const fixture = await createLegacyArchiveFixture();
    const cleanupError = Object.assign(new Error("source cleanup failed"), { code: "EACCES" });

    const result = await migrateLegacySessionArchive({
      ...fixture.options,
      fileSystem: {
        unlink: async (path) => {
          if (path === fixture.legacyFilePath) throw cleanupError;
          await unlink(path);
        },
      },
    });

    expect(result).toMatchObject({
      status: "migrated",
      cleanup: "incomplete",
      cleanupErrors: [cleanupError],
    });
    await expect(readFile(fixture.destinationFilePath, "utf8")).resolves.toBe("legacy session\n");
    expect(await exists(fixture.destinationIndexPath)).toBe(true);
    await expectLegacyStateUntouched(fixture);
  });
});

interface LegacyArchiveFixture {
  root: string;
  legacyRoot: string;
  legacyIndexPath: string;
  legacyArchiveDir: string;
  legacyFilePath: string;
  activeFilePath: string;
  destinationRoot: string;
  destinationIndexPath: string;
  destinationArchiveDir: string;
  destinationFilePath: string;
  sourceIndexContents: string;
  document: { marker: string; sessions: Record<string, unknown>[] };
  options: LegacySessionArchiveMigrationOptions;
}

async function createLegacyArchiveFixture(
  setup: { createDestinationArchive?: boolean } = {},
): Promise<LegacyArchiveFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-archive-migration-"));
  tempRoots.push(root);
  const homeDir = join(root, "home");
  const legacyRoot = join(homeDir, ".pi-web");
  const legacyIndexPath = join(legacyRoot, "archived-sessions.json");
  const legacyArchiveDir = join(legacyRoot, "archived-sessions");
  const legacyFilePath = join(legacyArchiveDir, "2026-01-01_file-session.jsonl");
  const activeFilePath = join(root, "active", "2026-01-01_file-session.jsonl");
  const destinationRoot = join(root, "managed-state");
  const destinationIndexPath = join(destinationRoot, "archived-sessions.json");
  const destinationArchiveDir = join(destinationRoot, "archived-sessions");
  const destinationFilePath = join(destinationArchiveDir, "2026-01-01_file-session.jsonl");
  const document = {
    marker: "preserve root metadata",
    sessions: [
      {
        sessionId: "file-session",
        cwd: `${join(root, "workspace")}${sep}..${sep}workspace`,
        archivedAt: "2026-01-01T00:02:00.000Z",
        originalPath: activeFilePath,
        archivePath: legacyFilePath,
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:01:00.000Z",
        messageCount: 2,
        firstMessage: "hello",
        name: "Legacy file session",
        customMetadata: { preserved: true },
      },
      {
        sessionId: "metadata-only",
        cwd: "/workspace",
        archivedAt: "2026-01-02T00:00:00.000Z",
        name: "Metadata only",
      },
    ],
  };

  await mkdir(legacyArchiveDir, { recursive: true });
  await mkdir(join(root, "active"), { recursive: true });
  await writeFile(legacyFilePath, "legacy session\n", "utf8");
  await writeFile(activeFilePath, "active session\n", "utf8");
  const sourceIndexContents = await writeArchiveIndex(legacyIndexPath, document);
  if (setup.createDestinationArchive === true) await mkdir(destinationArchiveDir, { recursive: true });

  return {
    root,
    legacyRoot,
    legacyIndexPath,
    legacyArchiveDir,
    legacyFilePath,
    activeFilePath,
    destinationRoot,
    destinationIndexPath,
    destinationArchiveDir,
    destinationFilePath,
    sourceIndexContents,
    document,
    options: {
      env: { PI_WEB_DATA_DIR: destinationRoot },
      cwd: root,
      homeDir,
      createAttemptId: () => "test-attempt",
    },
  };
}

async function writeArchiveIndex(path: string, document: unknown): Promise<string> {
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(path, contents, "utf8");
  return contents;
}

async function expectLegacyStateUntouched(fixture: LegacyArchiveFixture): Promise<void> {
  await expect(readFile(fixture.legacyIndexPath, "utf8")).resolves.toBe(fixture.sourceIndexContents);
  await expect(readFile(fixture.legacyFilePath, "utf8")).resolves.toBe("legacy session\n");
  await expect(readFile(fixture.activeFilePath, "utf8")).resolves.toBe("active session\n");
}

function requiredRecord(records: Record<string, unknown>[], index: number): Record<string, unknown> {
  const record = records[index];
  if (record === undefined) throw new Error(`Missing fixture record ${index.toString()}`);
  return record;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
