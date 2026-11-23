import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";

export interface PiPackageProvisioning {
  profileDir: string;
  /** Declared package name, independent of version or installation source. */
  packageId: string;
  /** When initial provisioning was considered complete, including migrated dismissals. */
  provisionedAt: string;
}

export function piPackageProvisioningStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "pi-package-provisioning.json");
}

/** Daemon-startup-owned ledger. Callers write sequentially; removal never clears it. */
export class PiPackageProvisioningStore {
  constructor(private readonly filePath = piPackageProvisioningStorePath()) {}

  async has(profileDir: string, packageId: string): Promise<boolean> {
    return (await this.read()).some((entry) => entry.profileDir === profileDir && entry.packageId === packageId);
  }

  /** Preserve the first recorded date, including when repeating legacy dismissal migration. */
  async record(entry: PiPackageProvisioning): Promise<void> {
    const provisioned = await this.read();
    if (provisioned.some((existing) => existing.profileDir === entry.profileDir && existing.packageId === entry.packageId)) return;
    provisioned.push(entry);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ provisioned }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async read(): Promise<PiPackageProvisioning[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value) || !Array.isArray(value["provisioned"])) throw new Error("Invalid Pi package provisioning file");
    return value["provisioned"].map((entry: unknown) => {
      if (!isRecord(entry)
        || typeof entry["profileDir"] !== "string"
        || typeof entry["packageId"] !== "string"
        || typeof entry["provisionedAt"] !== "string") {
        throw new Error("Invalid Pi package provisioning record");
      }
      return { profileDir: entry["profileDir"], packageId: entry["packageId"], provisionedAt: entry["provisionedAt"] };
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
