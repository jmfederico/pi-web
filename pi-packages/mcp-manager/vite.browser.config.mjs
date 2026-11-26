import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./browser/pi-web-plugin.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "pi-web-plugin.js",
    },
    license: { fileName: "pi-web-plugin.licenses.md" },
    target: "es2022",
    minify: true,
  },
});
