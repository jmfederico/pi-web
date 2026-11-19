import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The Pi extension loader provides the SDK modules and their matching TypeBox.
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./extensions/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "extensions/index.js",
    },
    rollupOptions: { external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"] },
    target: "es2022",
    minify: false,
  },
});
