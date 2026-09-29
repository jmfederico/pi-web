// Browser-only regression check (happy-dom cannot measure layout).
// Start Vite with: npx vite --host 127.0.0.1 --port 8517
// Then invoke using an externally installed Playwright (not needed by the unit suite):
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test-fixtures/mobile-dialog-layout.mjs
// Optional: CLIENT_URL, CHROMIUM_EXECUTABLE_PATH.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
});
try {
  const page = await browser.newPage();
  page.on("pageerror", error => console.error(error));
  page.on("response", response => { if (response.status() >= 400) console.error(response.status(), response.url()); });
  const url = process.env.CLIENT_URL ?? "http://127.0.0.1:8517";
  // Load only the real components, not the app or a live session/API server.
  await page.route(`${url}/layout-test`, route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body></body>',
  }));
  await page.goto(`${url}/layout-test`);
  await page.evaluate(async () => {
    const { api, trustApi } = await import("/src/api.ts");
    trustApi.projectTrust = async path => ({ path, decision: null, trusted: false });
    api.projectDirectories = async () => Array.from({ length: 30 }, (_, i) => ({ path: `/home/demo/folder-${i}`, name: `folder-${i}` }));
    await Promise.all(["ProjectDialog", "MachineDialog", "CommandPicker", "ModelPicker", "AuthDialog"].map(name => import(`/src/components/${name}.ts`)));
  });
  for (const viewport of [{ width: 390, height: 664 }, { width: 390, height: 500 }, { width: 844, height: 390 }, { width: 1440, height: 900 }, { width: 390, height: 844, availableHeight: 500 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Also prove caps follow the containing backdrop rather than layout-vh.
    // This is a geometry test, not an emulation of Safari's software keyboard.
    const availableHeight = viewport.availableHeight ?? viewport.height;
    for (const tag of ["project-dialog", "machine-dialog", "command-picker", "model-picker", "auth-dialog"]) {
      await page.evaluate(async ({ tag, availableHeight }) => {
        document.body.replaceChildren();
        const dialog = document.createElement(tag);
        dialog.style.bottom = `${innerHeight - availableHeight}px`;
        dialog.onCancel = () => dialog.remove();
        dialog.onSubmit = path => { dialog.dataset.submittedPath = path; };
        if (tag === "auth-dialog") dialog.state = {
          step: "providers",
          providers: Array.from({ length: 30 }, (_, i) => ({ id: `provider-${i}`, name: `Provider ${i}`, authType: "api_key", status: {} })),
        };
        dialog.options = Array.from({ length: 30 }, (_, i) => ({ value: String(i), label: `Option ${i}` }));
        document.body.append(dialog);
        await dialog.updateComplete;
        await dialog.updateComplete;
      }, { tag, availableHeight });
      if (tag === "project-dialog") {
        await page.locator(`${tag} input:not([type])`).fill("/home/demo/project");
        await page.locator(`${tag} .suggestions button`).first().waitFor();
      }
      const surface = page.locator(`${tag} section[role=dialog]`);
      await surface.waitFor();
      const box = await surface.boundingBox();
      assert(box && box.y >= 0 && box.y + box.height <= availableHeight - 19, `${tag} overflows ${JSON.stringify(viewport)}: ${JSON.stringify(box)}`);
      if (tag === "project-dialog" || tag === "machine-dialog") {
        for (const button of await page.locator(`${tag} footer button`).all()) {
          // Trial clicks perform real hit testing without submitting anything.
          if (await button.isEnabled()) await button.click({ trial: true, timeout: 2000 });
          const rect = await button.boundingBox();
          assert(rect && rect.y + rect.height <= availableHeight, "Footer action is clipped");
        }
        if (tag === "project-dialog") {
          const scroll = await page.locator(`${tag} .body`).evaluate(body => {
            body.scrollTop = body.scrollHeight;
            return { top: body.scrollTop, height: body.clientHeight, content: body.scrollHeight };
          });
          if (scroll.content > scroll.height) assert(scroll.top > 0, "Project body must scroll");
          await page.locator(`${tag} footer`).getByRole("button", { name: "Add project", exact: true }).click();
          assert.equal(await page.locator(tag).getAttribute("data-submitted-path"), "/home/demo/project");
        }
        await page.locator(`${tag} footer`).getByRole("button", { name: "Cancel", exact: true }).click();
      } else {
        await page.locator(`${tag}`).getByRole("button", { name: "Close", exact: true }).click();
      }
      assert.equal(await page.locator(tag).count(), 0, "Close must dismiss the dialog");
      console.log(`PASS ${tag} ${viewport.width}x${viewport.height}, available height ${availableHeight}`);
    }
  }
} finally {
  await browser.close();
}
