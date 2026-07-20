import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "pi-web-plugins/**/*.test.ts", "scripts/**/*.test.mjs"],
    // proper-lockfile installs process-exit cleanup. On Windows, thread workers
    // avoid racing that cleanup against Vitest's child-process shutdown IPC.
    pool: process.platform === "win32" ? "threads" : "forks",
  },
});
