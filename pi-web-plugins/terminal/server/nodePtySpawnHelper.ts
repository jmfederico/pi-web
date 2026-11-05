import { accessSync, chmodSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Match node-pty's native-module search, including fallback after a broken build. */
export function ensureNodePtySpawnHelper(require: NodeJS.Require, platform = process.platform, arch = process.arch): void {
  if (platform !== "darwin") return;
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const directory of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    for (const base of [root, join(root, "lib")]) {
      const nativePath = join(base, directory, "pty.node");
      try {
        require(nativePath);
      } catch {
        continue;
      }
      const helperPath = join(base, directory, "spawn-helper");
      try {
        const stat = statSync(helperPath);
        if (!stat.isFile()) throw new Error("not a regular file");
        // node-pty 1.1.0 ships macOS helpers as 0644. Preserve other mode bits.
        if ((stat.mode & 0o111) === 0) chmodSync(helperPath, stat.mode | 0o111);
        accessSync(helperPath, constants.X_OK);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Terminal helper is not executable: ${helperPath}: ${detail}. Run chmod +x '${helperPath.replaceAll("'", "'\\''")}' and retry.`, { cause });
      }
      return;
    }
  }
  throw new Error(`Could not locate node-pty's native module under ${root}`);
}
