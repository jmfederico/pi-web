import { expect, test } from "@playwright/test";

test("cleanup keeps rules and project selection reachable without clipping at desktop and narrow widths", async ({ page }) => {
  await page.goto("/cleanup.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  for (const width of [1000, 360]) {
    await page.setViewportSize({ width, height: 720 });
    const pinned = page.getByRole("checkbox", { name: "Skip pinned sessions" });
    await expect(pinned).toBeChecked();
    // Click the label text rather than only the tiny native checkbox target.
    await page.getByText("Skip pinned sessions", { exact: true }).click();
    await expect(pinned).not.toBeChecked();
    await page.getByText("Skip pinned sessions", { exact: true }).click();
    const preview = page.getByRole("button", { name: "Preview cleanup", exact: true });
    await expect(page.getByRole("button", { name: "Run cleanup", exact: true })).toHaveCount(0);
    await preview.click();
    await expect(preview).toHaveCount(0);
    await expect(page.locator("#step-heading")).toBeFocused();
    await expect(page.getByRole("checkbox", { name: "Skip pinned sessions" })).toHaveCount(0);
    const run = page.getByRole("button", { name: "Run cleanup", exact: true });
    await expect(run).toBeEnabled();
    await expect(run).not.toBeInViewport();
    await expect(page.getByRole("button", { name: "Close cleanup", exact: true })).toBeInViewport();
    const lastProject = page.getByRole("checkbox", { name: /Clean up \/projects/ }).last();
    await lastProject.click();
    await expect(lastProject).not.toBeChecked();
    const overflow = await page.locator("session-cleanup-dialog .body").evaluate((body) => body.scrollWidth > body.clientWidth + 1);
    expect(overflow).toBe(false);
    await run.click({ trial: true });
    await expect(page.locator("tfoot")).toBeInViewport();
    const bounds = await run.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds === null) throw new Error("Missing cleanup action");
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
    const totals = await page.locator("tfoot").boundingBox();
    if (totals === null) throw new Error("Missing selected totals");
    expect(bounds.y).toBeGreaterThanOrEqual(totals.y + totals.height);
    await page.locator("session-cleanup-dialog .body").evaluate((body) => { body.scrollTop = 0; });
    await expect(run).not.toBeInViewport();
    await expect(page.getByRole("button", { name: "Close cleanup", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(run).toHaveCount(0);
    await expect(preview).toBeVisible();
    await expect(page.locator("#step-heading")).toBeFocused();
    await expect(pinned).toBeChecked();
  }
});
