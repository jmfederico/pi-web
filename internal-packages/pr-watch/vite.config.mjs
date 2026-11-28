import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Bundles the public host API values so the installed package needs no PI WEB import path.
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./server-plugin.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "server-plugin.js",
    },
    rolldownOptions: { external: [/^node:/u] },
    target: "node22",
    minify: false,
  },
});
