// Runs the TypeScript 7 compiler with the given arguments.
// The TypeScript 6 compatibility package also installs a `tsc` executable, and
// npm can link either one, so scripts call this instead of a bare `tsc`.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { packageBin } from "./packageBin.mjs";

const require = createRequire(import.meta.url);
const tsc = packageBin(require.resolve("@typescript/native/package.json"), "tsc");
const result = spawnSync(process.execPath, [tsc, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
