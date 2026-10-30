import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/transcript-renderers.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("transcript renderer controls stay clickable inside the host frame and restore original content", async ({ page }) => {
  const chat = page.locator("chat-view");
  const custom = chat.locator('article[data-index="1"] pi-web-transcript-renderer');
  const tool = chat.locator('pi-web-transcript-renderer').nth(1);
  await expect(custom).toBeVisible();
  // Tool presentation remains inside the ordinary host activity disclosure.
  await chat.locator('details[data-index="2"] > summary').click();
  await expect(tool).toBeVisible();
  await expect(tool.getByText("Plugin annotation", { exact: true })).toBeVisible();
  await expect(chat.getByText("Show the result.", { exact: true })).toBeVisible();
  const frame = chat.locator('article[data-index="1"]');
  await expect(frame).toBeVisible();
  const originalFrame = await frame.boundingBox();
  if (!originalFrame) throw new Error("Missing custom message frame");

  await custom.getByRole("button", { name: "Custom preview action", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-custom-clicked", "true");
  await custom.getByRole("button", { name: "Custom card: 0", exact: true }).click();
  await expect(custom.getByRole("button", { name: "Custom card: 1", exact: true })).toBeVisible();
  await custom.getByRole("button", { name: "Default view", exact: true }).click();
  await expect(custom.getByText("Original custom fallback", { exact: true })).toBeVisible();
  await expect(custom.getByRole("button", { name: "Custom preview action", exact: true })).toHaveCount(0);
  await custom.getByRole("button", { name: "Custom view", exact: true }).click();
  await expect(custom.getByRole("button", { name: "Custom preview action", exact: true })).toBeVisible();

  await tool.getByRole("button", { name: "Tool preview action", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-tool-clicked", "true");
  await tool.getByRole("button", { name: "Default view", exact: true }).click();
  await expect(tool.getByText("Plugin annotation", { exact: true })).toHaveCount(0);
  await tool.locator("tool-execution-view summary").click();
  await expect(tool.getByText("Original tool fallback", { exact: true })).toBeVisible();
  await tool.getByRole("button", { name: "Custom view", exact: true }).click();
  await expect(tool.getByText("Plugin annotation", { exact: true })).toBeVisible();
  await expect(tool.getByRole("button", { name: "Tool preview action", exact: true })).toBeVisible();

  const nextFrame = await frame.boundingBox();
  const previewBox = await custom.boundingBox();
  if (!nextFrame || !previewBox) throw new Error("Missing transcript frame geometry");
  expect(nextFrame.x).toBeCloseTo(originalFrame.x, 0);
  expect(nextFrame.width).toBeCloseTo(originalFrame.width, 0);
  expect(previewBox.x).toBeGreaterThanOrEqual(nextFrame.x);
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(nextFrame.x + nextFrame.width + 1);
  expect(await chat.evaluate((element) => {
    const scroller = element.shadowRoot?.querySelector(".chat");
    return scroller !== null && scroller !== undefined && scroller.scrollWidth <= scroller.clientWidth;
  })).toBe(true);
});


test("a tool resolver can wrap the core renderer without replacing its controls", async ({ page }) => {
  const chat = page.locator("chat-view");
  await chat.locator('details[data-index="2"] > summary').click();
  const wrappedCore = chat.locator("pi-web-transcript-renderer").nth(2);
  await expect(wrappedCore.getByText("Core card annotation", { exact: true })).toBeVisible();
  await wrappedCore.locator("tool-execution-view summary").click();
  await expect(wrappedCore.getByText("Core fallback output", { exact: true })).toBeVisible();
  await wrappedCore.getByRole("button", { name: "Default view", exact: true }).click();
  await expect(wrappedCore.getByText("Core card annotation", { exact: true })).toHaveCount(0);
  await expect(wrappedCore.getByText("Core fallback output", { exact: true })).toBeVisible();
  await wrappedCore.getByRole("button", { name: "Custom view", exact: true }).click();
  await expect(wrappedCore.getByText("Core card annotation", { exact: true })).toBeVisible();
  await expect(wrappedCore.getByText("Core fallback output", { exact: true })).toBeVisible();
});

test("transcript renderer host and registered plugin roots receive contributed styles and theme replacements", async ({ page }) => {
  const chat = page.locator("chat-view");
  const inline = chat.getByRole("button", { name: "Custom preview action", exact: true });
  const nested = chat.getByRole("button", { name: "Custom card: 0", exact: true });
  for (const button of [inline, nested]) {
    await expect(button).toHaveCSS("background-color", "rgb(37, 37, 37)");
    await expect(button).toHaveCSS("color", "rgb(238, 238, 238)");
    await expect(button).toHaveCSS("border-top-color", "rgb(170, 187, 255)");
  }
  await page.getByRole("button", { name: "Switch theme", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light");
  for (const button of [inline, nested]) {
    await expect(button).toHaveCSS("background-color", "rgb(238, 238, 238)");
    await expect(button).toHaveCSS("color", "rgb(34, 34, 34)");
    await expect(button).toHaveCSS("border-top-color", "rgb(51, 68, 153)");
  }
  await nested.click();
  await expect(chat.getByRole("button", { name: "Custom card: 1", exact: true })).toBeVisible();
});
