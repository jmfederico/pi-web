import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

// Build the isolated fixtures first with Vite's test-fixtures/browser/vite.config.ts.
// No daemon, live transcript, or installed user plugin is involved.
const output = resolve(process.argv[2] ?? "/tmp/pi-web-transcript-example");
await mkdir(output, { recursive: true });
const url = "http://127.0.0.1:8526/transcript-example.html";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--config", "test-fixtures/browser/vite.config.ts", "--host", "127.0.0.1", "--port", "8526", "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Fixture preview failed: ${serverOutput}`);
    try { ready = serverOutput.includes("http://127.0.0.1:8526/") && (await fetch(url)).ok; } catch { /* Server not listening yet. */ }
    if (ready) break;
    await delay(100);
  }
  if (!ready) throw new Error(`Fixture preview did not become ready: ${serverOutput}`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(url);
  await page.locator('body[data-ready="true"]').waitFor();
  await page.getByRole("heading", { name: "Workspace checks", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(output, "dark.png"), fullPage: true });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.locator('body[data-theme="light"]').waitFor();
  await page.locator(".example-checks-details > summary").click();
  await page.screenshot({ path: resolve(output, "light-expanded.png"), fullPage: true });
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.locator('body[data-theme="dark"]').waitFor();
  const defaults = page.getByRole("button", { name: "Default view", exact: true });
  for (let remaining = await defaults.count(); remaining > 0; remaining--) await defaults.first().click();
  await page.screenshot({ path: resolve(output, "default-fallback.png"), fullPage: true });
  await page.setViewportSize({ width: 412, height: 1000 });
  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await page.getByRole("heading", { name: "Workspace checks", exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, "mobile-dark.png"), fullPage: true });
  if (errors.length > 0) throw new AggregateError(errors, "Example browser errors");
  console.log(`Captured dark.png, light-expanded.png, default-fallback.png, mobile-dark.png in ${output}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
