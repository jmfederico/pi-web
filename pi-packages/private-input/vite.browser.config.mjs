import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Expose only the self-contained browser bundle, not the companion or server code.
export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./browser/pi-web-plugin.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "pi-web-plugin.js",
    },
    target: "es2022",
    minify: true,
  },
});
