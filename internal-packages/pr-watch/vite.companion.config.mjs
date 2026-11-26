import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The Pi extension loader provides the SDK modules and their matching TypeBox.
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./extensions/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "extensions/index.js",
    },
    rollupOptions: { external: [/^node:/u, "@earendil-works/pi-coding-agent", "typebox"] },
    target: "es2022",
    minify: false,
  },
});
