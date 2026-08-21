import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { piWebDataDir } from "../../config.js";

/** A user-initiated removal of a known auto-installable Pi package, recorded so PI WEB does not reinstall it automatically. */
export interface PiPackageDismissal {
  /** Active agent profile directory the dismissal applies to (per-profile, not global). */
  profileDir: string;
  /** Declared package name (e.g. `@jmfederico/pi-relay`), not an install-source string. */
  packageId: string;
  dismissedAt: string;
}

interface PiPackageDismissalFile {
  dismissals: PiPackageDismissal[];
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDismissalFile(value: unknown): PiPackageDismissalFile {
  if (!isRecord(value) || !Array.isArray(value["dismissals"])) throw new Error("Invalid Pi package dismissal file");
  return { dismissals: value["dismissals"].map(parseDismissal) };
}

function parseDismissal(value: unknown): PiPackageDismissal {
  if (!isRecord(value)) throw new Error("Invalid Pi package dismissal");
  const profileDir = value["profileDir"];
  const packageId = value["packageId"];
  const dismissedAt = value["dismissedAt"];
  if (typeof profileDir !== "string" || typeof packageId !== "string" || typeof dismissedAt !== "string") {
    throw new Error("Invalid Pi package dismissal");
  }
  return { profileDir, packageId, dismissedAt };
}

export function defaultPiPackageDismissalStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "pi-package-dismissals.json");
}

export function piPackageDismissalStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEB_PI_PACKAGE_DISMISSALS_FILE"];
  if (configured === undefined || configured === "") return defaultPiPackageDismissalStorePath(env, cwd);
  return resolve(cwd, configured);
}

/**
 * Data-directory-backed record of which known auto-installable Pi packages a
 * user has dismissed (removed on purpose) per active agent profile directory.
 * This is state, not user-editable configuration, so it lives under
 * `$PI_WEB_DATA_DIR` alongside `projects.json`/`machines.json` rather than in
 * `$PI_WEB_CONFIG`.
 */
export class PiPackageDismissalStore {
  constructor(private readonly filePath = piPackageDismissalStorePath()) {}

  async list(): Promise<PiPackageDismissal[]> {
    return (await this.read()).dismissals;
  }

  async isDismissed(profileDir: string, packageId: string): Promise<boolean> {
    const dismissals = await this.list();
    return dismissals.some((dismissal) => dismissal.profileDir === profileDir && dismissal.packageId === packageId);
  }

  /** Idempotent: dismissing an already-dismissed package for the same profile does not add a duplicate entry. */
  async dismiss(profileDir: string, packageId: string): Promise<void> {
    const data = await this.read();
    const alreadyDismissed = data.dismissals.some((dismissal) => dismissal.profileDir === profileDir && dismissal.packageId === packageId);
    if (alreadyDismissed) return;

    data.dismissals.push({ profileDir, packageId, dismissedAt: new Date().toISOString() });
    await this.write(data);
  }

  private async read(): Promise<PiPackageDismissalFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseDismissalFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { dismissals: [] };
      throw error;
    }
  }

  private async write(data: PiPackageDismissalFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}
