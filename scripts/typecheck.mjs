// Type-checks each area project in its own TypeScript 7 process.
// Usage: node scripts/typecheck.mjs [--cached]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { packageBin, readTypeScriptAreas } from "./typescriptAreas.mjs";

// Two checkers keep the largest area near 1.2 GB; the TypeScript 7 default of
// four checkers needs about 1.5 GB for little time saved.
const CHECKERS = "2";
const CACHE_DIR = "node_modules/.cache/pi-web/typecheck";

const require = createRequire(import.meta.url);
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const options = process.argv.slice(2);
const unknown = options.filter((option) => option !== "--cached");
if (unknown.length > 0) {
  console.error(`Unknown option: ${unknown.join(" ")}. Usage: node scripts/typecheck.mjs [--cached]`);
  process.exit(2);
}
const cached = options.includes("--cached");

const tsc = packageBin(require.resolve("@typescript/native/package.json"), "tsc");
const failed = [];
for (const area of readTypeScriptAreas(rootDir)) {
  console.log(`typecheck: ${area.configPath}`);
  const args = [tsc, "-p", area.configPath, "--noEmit", "--checkers", CHECKERS];
  if (cached) args.push("--incremental", "--tsBuildInfoFile", `${CACHE_DIR}/${area.name}.tsbuildinfo`);
  const result = spawnSync(process.execPath, args, { cwd: rootDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) failed.push(area.configPath);
}

if (failed.length > 0) {
  console.error(`typecheck failed: ${failed.join(", ")}`);
  process.exit(1);
}
