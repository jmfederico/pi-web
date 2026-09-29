import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production client build contents", () => {
  it("emits deployment-relative HTML and PWA URLs", async () => {
    const outDir = join(repoRoot, "dist/client");
    const html = await readFile(join(outDir, "index.html"), "utf8");
    const references = htmlAssetReferences(html);
    expect(references).toContain("./favicon.svg");
    expect(references).toContain("./apple-touch-icon.png");
    expect(references).toContain("./manifest.webmanifest");
    const manifestLink = /<link\b[^>]*\brel="manifest"[^>]*>/.exec(html)?.[0];
    expect(manifestLink).toBeDefined();
    expect(manifestLink).toContain('crossorigin="use-credentials"');
    expect(references).toContainEqual(expect.stringMatching(/^\.\/assets\/index-[^/]+\.js$/));
    expect(references.filter((reference) => reference.startsWith("/"))).toEqual([]);

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({
      start_url: "./",
      scope: "./",
      icons: [
        { src: "./pwa-icon-192.png" },
        { src: "./pwa-icon-512.png" },
      ],
    });
  });

  it("ships the push service worker as a minimal, fetch-free script", async () => {
    const serviceWorker = await readFile(join(repoRoot, "dist/client/sw.js"), "utf8");
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
  });
});

function htmlAssetReferences(html) {
  return Array.from(html.matchAll(/\b(?:href|src)="([^"]+)"/g), (match) => match[1] ?? "");
}
