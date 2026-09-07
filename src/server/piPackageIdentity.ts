import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reads the declared `name` field from the `package.json` at an installed Pi
 * package's path. Returns `undefined` on any read/parse failure or malformed
 * `name` field: identity resolution is best-effort and must never throw into
 * a package-mutation or startup-reconciliation path.
 */
export async function resolveDeclaredPiPackageName(installedPath: string): Promise<string | undefined> {
  try {
    const content = await readFile(join(installedPath, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return undefined;
    const name = parsed["name"];
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
