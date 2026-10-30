import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Exercise built components without a daemon, user config, HMR, or dev-server
// dependency optimization. Keep test output separate from the published app.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("../../node_modules/.cache/pi-web/browser-fixture", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlays: fileURLToPath(new URL("overlays.html", import.meta.url)),
        viewport: fileURLToPath(new URL("viewport.html", import.meta.url)),
        cleanup: fileURLToPath(new URL("cleanup.html", import.meta.url)),
        navigation: fileURLToPath(new URL("navigation.html", import.meta.url)),
        terminal: fileURLToPath(new URL("terminal.html", import.meta.url)),
        localization: fileURLToPath(new URL("localization.html", import.meta.url)),
        themes: fileURLToPath(new URL("themes.html", import.meta.url)),
        recovery: fileURLToPath(new URL("recovery.html", import.meta.url)),
        filePreviews: fileURLToPath(new URL("file-previews.html", import.meta.url)),
      },
    },
  },
});
