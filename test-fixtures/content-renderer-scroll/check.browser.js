// Real Chromium regression: run with playwright-cli run-code --filename=... .
// See serve.mjs for setup. This deliberately tests layout outside happy-dom.
async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.reload();
  const evidence = [];
  for (const id of ["files", "chat"]) {
    const panel = page.locator(`#${id}`);
    await panel.getByRole("button", { name: "Render", exact: true }).click();
    const frame = panel.locator("iframe");
    const document = frame.contentFrame().locator("html");
    await document.locator("svg").waitFor();
    // Wait for Mermaid's postMessage sizing to reach the host.
    await page.waitForFunction((id) => {
      const root = document.querySelector(`#${id}`).firstElementChild.shadowRoot;
      const host = root.querySelector("pi-web-content-renderer");
      const preview = host?.shadowRoot.querySelector("scroll-mermaid-preview");
      return preview?.shadowRoot.querySelector("iframe")?.style.height !== "300px";
    }, id);
    const panelBox = await panel.boundingBox();
    const header = page.locator("#files .viewer-header");
    const headerBefore = await header.boundingBox();
    const outerGeometry = () => panel.evaluate((element) => {
      const scroller = element.id === "files" ? element.firstElementChild : element;
      return { top: scroller.scrollTop, height: scroller.clientHeight, scroll: scroller.scrollHeight };
    });
    const checkEnd = async (input) => {
      const outer = await outerGeometry();
      const inner = await document.evaluate((element) => ({
        top: element.scrollTop, height: element.clientHeight, scroll: element.scrollHeight,
        svgBottom: element.querySelector("svg").getBoundingClientRect().bottom,
      }));
      const box = await frame.boundingBox();
      assert(outer.scroll > outer.height && outer.top > 0, `${id}/${input}: surrounding viewport must scroll`);
      assert(inner.svgBottom <= inner.height + 1, `${id}/${input}: diagram end must be reachable inside capped iframe`);
      const endY = box.y + inner.svgBottom;
      assert(endY > panelBox.y && endY <= panelBox.y + panelBox.height, `${id}/${input}: diagram end must be visible, not clipped by host`);
      if (id === "files") {
        const after = await header.boundingBox();
        assert(Math.abs(after.y - headerBefore.y) < 1 && after.height === headerBefore.height, "Files header must stay pinned and retain its height");
      }
      evidence.push({ surface: id, input, outer, inner, visibleDiagramEndY: endY });
    };
    // Wheel OVER the sandboxed iframe, not just on the surrounding padding.
    await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
    for (let step = 0; step < 5; step++) {
      await page.mouse.wheel(0, 6000);
      await page.waitForTimeout(150); // let native asynchronous wheel scrolling settle
    }
    await checkEnd("wheel");
    // Reset geometry, then use native keyboard scrolling in both focusable
    // contexts. No script sets scrollTop to the end under test.
    await document.evaluate((element) => { element.scrollTop = 0; });
    await panel.evaluate((element) => { (element.id === "files" ? element.firstElementChild : element).scrollTop = 0; });
    await frame.focus();
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(250);
    const preview = panel.getByLabel("Diagram preview", { exact: true });
    assert(await preview.getAttribute("tabindex") === "0", "Preview must remain keyboard focusable");
    await preview.focus();
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(250);
    await checkEnd("keyboard");
    assert(await frame.getAttribute("sandbox") === "allow-scripts", "Mermaid must retain its opaque-origin sandbox");
    await panel.getByRole("button", { name: "Raw", exact: true }).click();
    assert(await frame.count() === 0, `${id}: Raw must remove the preview`);
    await panel.getByRole("button", { name: "Render", exact: true }).click();
    await frame.contentFrame().locator("svg").waitFor();
  }
  return evidence;
}
