import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production client build contents", () => {
  // A real production build runs inside this test; allow slow cold-cache machines without a suite-wide timeout bump.
  it("emits deployment-relative HTML and PWA URLs", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "pi-web-client-build-"));
    try {
      await build({
        configFile: join(repoRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });

      const html = await readFile(join(outDir, "index.html"), "utf8");
      const references = htmlAssetReferences(html);
      expect(references).toContain("./favicon.svg");
      expect(references).toContain("./apple-touch-icon.png");
      expect(references).toContain("./manifest.webmanifest");
      expect(references).toContainEqual(expect.stringMatching(/^\.\/assets\/index-[^/]+\.js$/));
      expect(references.filter((reference) => reference.startsWith("/"))).toEqual([]);

      const manifest: unknown = JSON.parse(await readFile(join(outDir, "manifest.webmanifest"), "utf8"));
      expect(manifest).toMatchObject({
        start_url: "./",
        scope: "./",
        icons: [
          { src: "./pwa-icon-192.png" },
          { src: "./pwa-icon-512.png" },
        ],
      });

      const serviceWorker = await readFile(join(outDir, "sw.js"), "utf8");
      expect(serviceWorker).toContain("skipWaiting");
      expect(serviceWorker).toContain("clients.claim()");
      // Push substrate: render server-pushed notifications and deep-link clicks back into the session.
      expect(serviceWorker).toContain('addEventListener("push"');
      expect(serviceWorker).toContain("showNotification");
      // Per-session tag: the latest notification replaces its predecessor instead of stacking.
      expect(serviceWorker).toContain("tag:");
      expect(serviceWorker).toContain('addEventListener("notificationclick"');
      // Foreground hygiene: skip pushes while a window is visible and clear shown ones on return.
      expect(serviceWorker).toContain("visibilityState");
      expect(serviceWorker).toContain('addEventListener("message"');
      expect(serviceWorker).toContain("clear-push-notifications");
      expect(serviceWorker).toContain("getNotifications");
      // Deep links route in-app when the page acks; navigation stays the fallback for old pages.
      expect(serviceWorker).toContain("pi-web:open-session");
      expect(serviceWorker).toContain("open-session-ack");
      // The cwd rides along so cold starts can resolve the session's project and workspace.
      expect(serviceWorker).toContain('set("cwd"');
      // When the daemon resolves the route, the worker links the canonical app URL directly.
      expect(serviceWorker).toContain('set("project"');
      expect(serviceWorker).toContain('set("workspace"');
      expect(serviceWorker).toContain('set("view", "chat")');
      // Intentionally minimal on fetches: the app streams live session data, so the worker must never intercept it.
      expect(serviceWorker).not.toContain('addEventListener("fetch"');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

function htmlAssetReferences(html: string): string[] {
  return Array.from(html.matchAll(/\b(?:href|src)="([^"]+)"/g), (match) => match[1] ?? "");
}
