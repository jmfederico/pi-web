import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: packageDir,
  base: "./",
  publicDir: false,
  build: {
    outDir: "dist/browser",
    // Retain the transpiled filenames for existing package/install consumers.
    emptyOutDir: false,
    copyPublicDir: false,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("src/browser/index.ts", import.meta.url)),
      preserveEntrySignatures: "strict",
      output: {
        format: "es",
        entryFileNames: "index.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
