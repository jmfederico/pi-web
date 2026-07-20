import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "pi-web-plugins/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
