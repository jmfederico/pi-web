import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The loader works without PI WEB installed or running. Only Pi's public SDK
// and Node builtins remain external; generic session-state helpers are bundled.
// Keep a TypeScript entry so Pi's loader transforms public SDK imports through
// its host module mapping instead of native ESM resolving a second SDK copy.
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./extensions/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "extensions/index.ts",
    },
    rollupOptions: { external: [/^node:/u, "@earendil-works/pi-coding-agent"] },
    target: "node22",
    minify: false,
  },
});
