import { expect, test } from "@playwright/test";

test("equations have local fonts and shadow-root styles without widening the message", async ({ page }) => {
  const failed: string[] = [];
  page.on("requestfailed", (request) => { failed.push(request.url()); });
  page.on("response", (response) => { if (response.status() >= 400) failed.push(response.url()); });
  await page.goto("/markdown-math.html");
  const formatted = page.locator("formatted-text");
  await expect(formatted.locator(".katex")).toHaveCount(4);
  await expect(formatted.locator(".katex-error")).toHaveCount(0);
  await expect(formatted.locator("code")).toHaveText("$notMath$");
  await expect(formatted).toContainText("prices $5 or $10");

  await page.evaluate(async () => { await document.fonts.ready; });
  expect(await page.evaluate(() => [...document.fonts].some((face) => face.family === "KaTeX_Main" && face.status === "loaded"))).toBe(true);
  const inline = formatted.locator(".katex").first();
  expect(await inline.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("KaTeX_Main");
  expect(await inline.locator(".katex-mathml").evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  expect(await inline.locator(".katex-html").evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(20);

  const wide = formatted.locator(".katex-display").last();
  expect(await wide.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await wide.evaluate((node) => { node.scrollLeft = 100; return node.scrollLeft; })).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // Math inherits readable foreground colors across a live light/dark switch.
  const light = await inline.evaluate((node) => getComputedStyle(node).color);
  await page.evaluate(() => { document.body.classList.add("dark"); });
  await expect.poll(() => inline.evaluate((node) => getComputedStyle(node).color)).not.toBe(light);
  expect(failed).toEqual([]);
});
