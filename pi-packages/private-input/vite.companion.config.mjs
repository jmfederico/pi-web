import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./extensions/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "extensions/index.js",
    },
    rollupOptions: { external: [/^node:/u, "typebox", "@earendil-works/pi-coding-agent"] },
    target: "node22",
    minify: false,
  },
});
