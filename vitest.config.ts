import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "pi-web-plugins/**/*.test.ts", "pi-packages/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
