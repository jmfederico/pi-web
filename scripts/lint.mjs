// Lints each area project in its own Oxlint process.
// Usage: node scripts/lint.mjs [oxlint options...]
// Options such as --fix are passed to every Oxlint run; give option values as
// --option=value. To lint specific files, run `npm exec -- oxlint <files...>`.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { packageBin } from "./packageBin.mjs";
import { lintBatches, readTypeScriptAreas } from "./typescriptAreas.mjs";

const require = createRequire(import.meta.url);
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const options = process.argv.slice(2);
const positional = options.filter((option) => !option.startsWith("-"));
if (positional.length > 0) {
  console.error(`lint.mjs lints every area and accepts only Oxlint options. To lint specific files, run: npm exec -- oxlint ${positional.join(" ")}`);
  process.exit(2);
}

const oxlint = packageBin(require.resolve("oxlint/package.json"), "oxlint");
const failed = new Set();
for (const batch of lintBatches(readTypeScriptAreas(rootDir))) {
  console.log(`lint: ${batch.area} (${String(batch.files.length)} files)`);
  const result = spawnSync(process.execPath, [oxlint, ...options, ...batch.files], { cwd: rootDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) failed.add(batch.area);
}

if (failed.size > 0) {
  console.error(`lint failed: ${[...failed].join(", ")}`);
  process.exit(1);
}
