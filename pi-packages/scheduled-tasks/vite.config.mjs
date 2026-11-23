import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Carry the public host API values for standalone use; Node resolves cron-parser.
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./server-plugin.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "server-plugin.js",
    },
    rollupOptions: { external: [/^node:/u, "cron-parser"] },
    target: "node22",
    minify: false,
  },
});
