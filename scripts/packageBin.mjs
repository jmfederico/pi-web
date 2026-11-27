import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolves an executable script from a package manifest path, as returned by
 * `require.resolve("<package>/package.json")`, so it can run with the current Node.
 */
export function packageBin(manifestPath, binName) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (typeof bin !== "string") throw new Error(`${manifestPath} does not provide the ${binName} executable.`);
  return resolve(dirname(manifestPath), bin);
}
