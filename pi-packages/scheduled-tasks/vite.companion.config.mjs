import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Carry the public companion helper, but use Pi\'s host-provided SDK modules.
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./extensions/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "extensions/index.js",
    },
    rollupOptions: { external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"] },
    target: "es2022",
    minify: false,
  },
});
