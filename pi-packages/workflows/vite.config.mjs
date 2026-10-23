import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Bundle the public host capability tokens so the shipped package does not
// require a second installed copy of PI WEB at runtime.
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./server-plugin.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "server-plugin.js",
    },
    target: "node22",
    minify: false,
  },
});
