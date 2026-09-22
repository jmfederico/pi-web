import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Filesystem-symlink fixtures and Windows privileges.
 *
 * Creating a file symlink on Windows requires Developer Mode or an elevated
 * process; without it `symlink()` fails with EPERM. These fixtures assert
 * traversal/exclusion behavior that only a real symlink can express, so the
 * affected tests skip with an actionable note instead of failing on machines
 * that cannot create them. Directory "junction" links work unelevated and do
 * not need this guard.
 */
export interface SkipCapableContext {
  skip(note?: string): never;
}

const PERMISSION_CODES = new Set(["EPERM", "EACCES", "EPERM"]);
let supportProbe: Promise<boolean> | undefined;

/** Skips the current test when this user cannot create file symlinks. */
export async function requireFileSymlinkSupport(context: SkipCapableContext): Promise<void> {
  supportProbe ??= probeFileSymlinkSupport();
  if (await supportProbe) return;
  context.skip("File symlinks are not permitted for this user. Enable Windows Developer Mode or run the tests as administrator to execute symlink fixtures.");
}

async function probeFileSymlinkSupport(): Promise<boolean> {
  const probeRoot = await mkdtemp(join(tmpdir(), "pi-web-symlink-probe-"));
  const target = join(probeRoot, "target.txt");
  const link = join(probeRoot, "link.txt");
  try {
    await writeFile(target, "probe\n");
    await symlink(target, link);
    return true;
  } catch (error) {
    return !isPermissionError(error);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

function isPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && PERMISSION_CODES.has(code);
}
