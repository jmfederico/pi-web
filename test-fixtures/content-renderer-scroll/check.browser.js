// Real Chromium regression: run with playwright-cli run-code --filename=... .
// See serve.mjs for setup. This deliberately tests layout outside happy-dom.
async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.reload();
  const evidence = [];
  const diagram = (id) => page.locator(`#${id}`).locator("img");
  for (const id of ["files", "chat"]) {
    const panel = page.locator(`#${id}`);
    await panel.getByRole("button", { name: "Render", exact: true }).click();
    const image = diagram(id);
    await image.waitFor();
    // The image reserves its final size from explicit dimensions, then decodes a script-free SVG.
    await page.waitForFunction((element) => element.complete && element.naturalWidth > 0, await image.elementHandle());
    const panelBox = await panel.boundingBox();
    const header = page.locator("#files .viewer-header");
    const headerBefore = await header.boundingBox();
    const outerGeometry = () => panel.evaluate((element) => {
      const scroller = element.id === "files" ? element.firstElementChild : element;
      return { top: scroller.scrollTop, height: scroller.clientHeight, scroll: scroller.scrollHeight };
    });
    const checkEnd = async (input) => {
      const outer = await outerGeometry();
      const box = await image.boundingBox();
      assert(outer.scroll > outer.height && outer.top > 0, `${id}/${input}: surrounding viewport must scroll`);
      const endY = box.y + box.height;
      assert(endY > panelBox.y && endY <= panelBox.y + panelBox.height, `${id}/${input}: diagram end must be visible, not clipped by host`);
      if (id === "files") {
        const after = await header.boundingBox();
        assert(Math.abs(after.y - headerBefore.y) < 1 && after.height === headerBefore.height, "Files header must stay pinned and retain its height");
      }
      evidence.push({ surface: id, input, outer, image: { width: box.width, height: box.height }, visibleDiagramEndY: endY });
    };
    // Wheel over the diagram itself, not just the surrounding padding.
    await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
    for (let step = 0; step < 5; step++) {
      await page.mouse.wheel(0, 6000);
      await page.waitForTimeout(150); // let native asynchronous wheel scrolling settle
    }
    await checkEnd("wheel");
    // Reset geometry, then use native keyboard scrolling. No script sets scrollTop to the end under test.
    await panel.evaluate((element) => { (element.id === "files" ? element.firstElementChild : element).scrollTop = 0; });
    const preview = panel.getByLabel("Diagram preview", { exact: true });
    assert(await preview.getAttribute("tabindex") === "0", "Preview must remain keyboard focusable");
    await preview.focus();
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(250);
    await checkEnd("keyboard");
    assert(await page.locator("iframe").count() <= 1, "Diagrams must share at most one engine frame");
    await panel.getByRole("button", { name: "Raw", exact: true }).click();
    assert(await image.count() === 0, `${id}: Raw must remove the preview`);
    await panel.getByRole("button", { name: "Render", exact: true }).click();
    await image.waitFor();
  }
  return evidence;
}
