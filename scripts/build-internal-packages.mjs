#!/usr/bin/env node
// Builds development-only Pi packages under internal-packages/ in place.
// Their output stays in each package's own dist/ directory, outside the
// published `files` allowlist, so these packages never ship with PI WEB.
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "vite";

const root = resolve("internal-packages");
const alias = { "@jmfederico/pi-web/server-plugin-api": resolve("src/server-plugin-api.ts") };

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDir = join(root, entry.name);
  const configs = (await readdir(packageDir)).filter((name) => /^vite(?:\.[a-z]+)?\.config\.mjs$/u.test(name)).sort();
  if (configs.length === 0) continue;
  await rm(join(packageDir, "dist"), { recursive: true, force: true });
  for (const config of configs) {
    await build({ configFile: join(packageDir, config), logLevel: "warn", resolve: { alias } });
  }
  console.log(`[internal-packages] built ${entry.name} into ${join("internal-packages", entry.name, "dist")}`);
}
