import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 1000 });
  await page.goto("/markdown-extensions.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("shared Markdown preserves literal code and native math/vector markup through streaming and disablement", async ({ page }) => {
  const chat = page.locator("#chat");
  const documentPreview = page.locator("#document");
  await expect(documentPreview.locator(".fixture-expression")).toBeVisible();
  // Wait for actual Markdown conversion, not the initial escaped-source frame.
  await expect(chat.locator("p").last()).toHaveText("Streaming [[math:x");
  await expect(chat.locator(".fixture-expression")).toHaveCount(0);
  await page.getByRole("button", { name: "Complete stream", exact: true }).click();

  for (const surface of [chat, documentPreview]) {
    await expect(surface.locator(".fixture-expression")).toHaveCount(1);
    await expect(surface.locator(".fixture-expression strong")).toHaveText("Equation");
    await expect(surface.locator("p > code")).toHaveText("[[math:x]]");
    await expect(surface.locator("pre code")).toHaveText("[[math:x]]");
    await expect(surface.locator("code .fixture-expression")).toHaveCount(0);
    expect(await surface.locator("math, math mi, svg, svg path").evaluateAll((elements) => elements.map((element) => ({
      name: element.localName, namespace: element.namespaceURI,
    })))).toEqual([
      { name: "math", namespace: "http://www.w3.org/1998/Math/MathML" },
      { name: "mi", namespace: "http://www.w3.org/1998/Math/MathML" },
      { name: "svg", namespace: "http://www.w3.org/2000/svg" },
      { name: "path", namespace: "http://www.w3.org/2000/svg" },
    ]);
  }

  // Keep both original elements mounted: document invalidation must come from
  // the retained host capability, while chat receives a fresh registry snapshot.
  await page.getByRole("button", { name: "Disable extension", exact: true }).click();
  for (const surface of [chat, documentPreview]) {
    await expect(surface.locator(".fixture-expression, math, svg")).toHaveCount(0);
    await expect(surface.locator("p").last()).toHaveText("Streaming [[math:x]]");
    await expect(surface.locator("pre code")).toHaveText("[[math:x]]");
  }
});

test("contributed styles constrain wide extension output within both narrow shadow roots", async ({ page }) => {
  await page.getByRole("button", { name: "Complete stream", exact: true }).click();
  for (const id of ["chat", "document"]) {
    const surface = page.locator(`#${id}`);
    const expression = surface.locator(".fixture-expression");
    await expect(expression).toBeVisible();
    await expect(expression).toHaveCSS("border-top-color", "rgb(42, 97, 133)");
    await expect(expression).toHaveCSS("overflow-x", "auto");
    expect(await expression.evaluate((element) => {
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host.id : undefined;
    })).toBe(id);
    const expressionBounds = await expression.boundingBox();
    const surfaceBounds = await surface.boundingBox();
    if (!expressionBounds || !surfaceBounds) throw new Error("Missing Markdown surface geometry");
    expect(expressionBounds.x).toBeGreaterThanOrEqual(surfaceBounds.x);
    expect(expressionBounds.x + expressionBounds.width).toBeLessThanOrEqual(surfaceBounds.x + surfaceBounds.width + 1);
    // The wide content is genuinely scrollable, not clipped or squeezed until
    // overflow disappears; scrolling stays inside the extension's own region.
    expect(await expression.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expression.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    expect(await expression.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
