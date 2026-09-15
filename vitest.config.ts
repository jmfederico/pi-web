import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Standalone examples consume the public entry, without requiring a prior build.
  resolve: {
    alias: { "@jmfederico/pi-web/server-plugin-api": fileURLToPath(new URL("./src/server-plugin-api.ts", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "pi-web-plugins/**/*.test.ts", "pi-packages/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
