import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// A remote plugin has only its package-local browser files. The host document
// renderer isn't interchangeable: it omits images and strips fragment links.
export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./markdownDocument.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "markdownDocument.js",
    },
    license: { fileName: "markdownDocument.licenses.md" },
    target: "es2022",
    minify: true,
  },
});
