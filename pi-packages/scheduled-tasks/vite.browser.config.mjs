import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The browser-public root contains only the self-contained dashboard bundle.
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
