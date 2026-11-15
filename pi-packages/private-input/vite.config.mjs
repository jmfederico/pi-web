import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./server-plugin.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "server-plugin.js",
    },
    rollupOptions: { external: [/^node:/u] },
    target: "node22",
    minify: false,
  },
});
