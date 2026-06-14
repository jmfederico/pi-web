import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * node-pty 1.1.0 ships macOS prebuilds with `spawn-helper` files at 644
 * instead of 755, causing `posix_spawnp failed` at runtime. This script
 * fixes permissions after install on Darwin platforms.
 */
function fixNodePtyPermissions() {
  if (process.platform === "win32") return;
  const prebuildsDir = join("node_modules", "node-pty", "prebuilds");
  let entries;
  try {
    entries = readdirSync(prebuildsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const helper = join(prebuildsDir, entry.name, "spawn-helper");
    let stats;
    try {
      stats = statSync(helper);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    // 0o100 = regular file, 0o111 = owner/group/other execute
    if ((stats.mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
    }
  }
}

fixNodePtyPermissions();
