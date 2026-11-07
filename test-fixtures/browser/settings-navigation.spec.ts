import { expect, test, type Locator, type Page } from "@playwright/test";

async function isolateRequests(page: Page) {
  // Theme reads are the only HTTP requests not supplied through the fixture's
  // public API objects. Reject unexpected traffic rather than hitting a server.
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/themes") {
      await route.fulfill({ json: { themes: [], themePairs: [] } });
    } else if (new URL(route.request().url()).pathname === "/api/theme") {
      await route.fulfill({ json: { catalog: { themes: [], themePairs: [] }, stylesheets: [] } });
    } else {
      throw new Error(`Unexpected fixture API request: ${route.request().url()}`);
    }
  });
}

async function openSettings(page: Page, query = "") {
  await isolateRequests(page);
  await page.goto(`/settings-navigation.html${query}`);
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", "true");
  const modal = page.getByRole("dialog", { name: "PI WEB settings", exact: true });
  await expect(modal).toBeVisible();
  const content = page.locator("settings-dialog .settings-content");
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(0);
  return { modal, content };
}

async function expectRevealed(content: Locator, group: Locator, control: Locator, focusTarget = control) {
  // No click, focus(), wheel, or scrollIntoView before these assertions: only
  // production navigation may bring the offscreen destination into view.
  await expect(focusTarget).toBeFocused();
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const viewport = await content.boundingBox();
  const target = await group.boundingBox();
  const selector = await control.boundingBox();
  if (!viewport || !target || !selector) throw new Error("Missing Settings target geometry");
  // The destination heading and control must be inside the actual scrollport,
  // not merely inside the browser viewport behind fixed Settings chrome.
  expect(target.y).toBeGreaterThanOrEqual(viewport.y - 1);
  expect(selector.y + selector.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
  expect(selector.x).toBeGreaterThanOrEqual(viewport.x - 1);
  expect(selector.x + selector.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
}

test("routes the gateway warning through existing Notices without a session or workspace", async ({ page }, testInfo) => {
  await isolateRequests(page);
  const sockets: string[] = [];
  page.on("websocket", (socket) => { sockets.push(socket.url()); });
  await page.goto("/settings-navigation.html?notices");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  expect(await page.evaluate(() => window.settingsNavigationFixture.selection())).toEqual({ session: undefined, workspace: undefined });
  await expect(page.locator("[data-host-access-notice]")).toHaveCount(0);

  const noticesNavigation = page.getByRole("button", { name: /^Notices\b/ });
  await expect(noticesNavigation).toBeVisible();
  await expect(noticesNavigation).toHaveAccessibleName(/1/);
  await noticesNavigation.click();
  await expect(noticesNavigation).toHaveAttribute("aria-pressed", "true");
  const notice = page.locator('session-notices-panel [data-notice-id="gateway-host-access"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCount(1);
  await expect(notice.locator(".session-warning-dismiss")).toHaveCount(0);
  const action = notice.getByRole("button", { name: "Open General settings" });
  await expect(action).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("gateway-notices.png") });
  await action.click();
  const modal = page.getByRole("dialog", { name: "PI WEB settings", exact: true });
  await expect(modal).toBeVisible();
  const selector = page.locator('[data-settings-target="host-access"]').getByRole("combobox");
  await expect(selector).toBeFocused();
  await expect(selector).toBeInViewport({ ratio: 1 });
  // Opening the destination cannot acknowledge/dismiss the underlying condition.
  await expect(notice).toHaveCount(1);
  await expect(page.locator("settings-general-panel [data-host-access-notice]")).toHaveCount(0);
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(action).toBeFocused();
  await expect(notice).toBeVisible();

  await action.click();
  await expect(selector).toBeFocused();
  await selector.selectOption("restricted");
  await expect(page.locator("#host-access-list")).toHaveValue("fixture.local");
  await expect(notice).toHaveCount(1);
  await page.getByRole("button", { name: "Save gateway server config", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-save", "pending");
  await page.evaluate(() => window.settingsNavigationFixture.releaseSave());
  await expect(page.locator("body")).toHaveAttribute("data-save", "complete");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(notice).toBeVisible();
  // Saving a restricted policy does not imply that the running gateway enforces it.
  await expect(notice.locator(".session-warning-message")).toContainText(/restart/i);
  await notice.getByRole("button", { name: "Restart web service", exact: true }).click();
  const restart = page.locator("restart-dialog");
  await expect(restart.getByRole("dialog", { name: "Restart PI WEB", exact: true })).toBeVisible();
  await expect(restart.getByRole("radio", { name: "Web service", exact: true })).toBeChecked();
  expect(await page.evaluate(() => window.settingsNavigationFixture.terminalLaunches())).toEqual([]);
  await restart.locator("#restart-confirm").click();
  await expect(restart.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.settingsNavigationFixture.terminalLaunches())).toEqual([
    { command: "pi-web-docker --dev restart-web", title: "Web service" },
  ]);
  // A terminal handoff is not proof that the saved policy is now enforced.
  await expect(notice).toBeVisible();
  await expect(noticesNavigation).toBeVisible();
  expect(sockets).toEqual([]);
});

test("reveals hostname policy after delayed config without stealing focus on rerender or save", async ({ page }, testInfo) => {
  const { content } = await openSettings(page);
  const group = page.locator('[data-settings-target="host-access"]');
  const selector = group.getByRole("combobox");
  await expect(group).toHaveCount(0);
  await page.evaluate(() => window.settingsNavigationFixture.releaseConfig());
  await expectRevealed(content, group, selector);
  await page.screenshot({ path: testInfo.outputPath("host-access-revealed.png") });

  // A real edit and form submit cause panel and dialog updates. Keep another
  // enabled control focused while the asynchronous save is pending and completes.
  const port = page.getByRole("textbox", { name: /^Port\b/ });
  await port.fill("9001");
  await expect(port).toBeFocused();
  const scrollAfterEdit = await content.evaluate((element) => element.scrollTop);
  await page.evaluate(() => window.settingsNavigationFixture.rerender());
  await expect(port).toBeFocused();
  expect(await content.evaluate((element) => element.scrollTop)).toBe(scrollAfterEdit);
  await port.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-save", "pending");
  await expect(port).toBeFocused();
  await page.evaluate(() => window.settingsNavigationFixture.releaseSave());
  await expect(page.locator("body")).toHaveAttribute("data-saved-port", "9001");
  await expect(port).toBeFocused();
  await expect(port).toHaveValue("9001");
});

test("keeps the hostname editor and save action reachable when changing policy", async ({ page }, testInfo) => {
  await openSettings(page);
  await page.evaluate(() => window.settingsNavigationFixture.releaseConfig());
  const policy = page.locator("#host-access");
  const hosts = page.locator("#host-access-list");
  await expect(hosts).toHaveCount(0);
  await policy.selectOption("restricted");
  await expect(hosts).toHaveValue("fixture.local");
  await hosts.fill("pi.example.com\n.example.org");
  await expect(hosts).toBeFocused();
  await expect(hosts).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("restricted-hostnames.png") });
  await policy.selectOption("any");
  await expect(hosts).toHaveCount(0);
  await page.getByRole("button", { name: "Save gateway server config", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-save", "pending");
  await page.evaluate(() => window.settingsNavigationFixture.releaseSave());
  await expect(policy).toHaveValue("any");
  await page.screenshot({ path: testInfo.outputPath("any-hostname.png") });
});

test("confirms a hostname lockout without losing the draft or closing Settings", async ({ page }, testInfo) => {
  const { modal } = await openSettings(page, "?hostname=pi.example.test");
  await page.evaluate(() => window.settingsNavigationFixture.releaseConfig());
  const policy = page.locator("#host-access");
  const hosts = page.locator("#host-access-list");
  const save = page.getByRole("button", { name: "Save gateway server config", exact: true });
  const confirmation = page.locator("settings-dialog confirmation-dialog");
  const prompt = confirmation.getByRole("dialog");
  const draft = "other.example.test\n.trusted.test";
  await policy.selectOption("restricted");
  await hosts.fill(draft);

  for (const dismiss of ["cancel", "escape"]) {
    await save.click();
    await expect(prompt).toBeVisible();
    await expect(confirmation.locator("#confirmation-cancel")).toBeFocused();
    expect(await page.evaluate(() => window.settingsNavigationFixture.configUpdates())).toEqual([]);
    if (dismiss === "cancel") await confirmation.locator("#confirmation-cancel").click();
    else await page.keyboard.press("Escape");
    await expect(prompt).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(save).toBeFocused();
    await expect(policy).toHaveValue("restricted");
    await expect(hosts).toHaveValue(draft);
    expect(await page.evaluate(() => window.settingsNavigationFixture.configUpdates())).toEqual([]);
  }

  await save.click();
  await expect(prompt).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("host-access-confirmation.png") });
  await confirmation.locator("#confirmation-confirm").click();
  await expect(prompt).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-save", "pending");
  const updates = await page.evaluate(() => window.settingsNavigationFixture.configUpdates());
  expect(updates).toHaveLength(1);
  expect(updates[0]?.set?.hostAccess).toEqual({ mode: "restricted", hosts: ["other.example.test", ".trusted.test"] });
  await page.evaluate(() => window.settingsNavigationFixture.releaseSave());
  await expect(page.locator("body")).toHaveAttribute("data-save", "complete");
  await expect(modal).toBeVisible();
  await expect(hosts).toHaveValue(draft);
  expect(await page.evaluate(() => window.settingsNavigationFixture.configUpdates())).toEqual(updates);
});

test("saves without confirmation when the policy allows the current hostname", async ({ page }) => {
  await openSettings(page, "?hostname=pi.example.test");
  await page.evaluate(() => window.settingsNavigationFixture.releaseConfig());
  await page.locator("#host-access").selectOption("restricted");
  await page.locator("#host-access-list").fill(".example.test");
  await page.getByRole("button", { name: "Save gateway server config", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-save", "pending");
  await expect(page.locator("confirmation-dialog").getByRole("dialog")).toHaveCount(0);
  const updates = await page.evaluate(() => window.settingsNavigationFixture.configUpdates());
  expect(updates).toHaveLength(1);
  expect(updates[0]?.set?.hostAccess).toEqual({ mode: "restricted", hosts: [".example.test"] });
  await page.evaluate(() => window.settingsNavigationFixture.releaseSave());
  await expect(page.locator("body")).toHaveAttribute("data-save", "complete");
});

test("reveals an arbitrary named destination inside a slotted panel shadow root", async ({ page }) => {
  const { content } = await openSettings(page, "?target=fixture-preference");
  const group = page.getByRole("group", { name: "Fixture preference", exact: true });
  await expect(group).toHaveCount(0);
  await page.evaluate(() => window.settingsNavigationFixture.releaseConfig());
  const selector = group.getByRole("combobox", { name: "Fixture preference" });
  await expectRevealed(content, group, selector);
  await selector.selectOption({ label: "Second" });
  await expect(selector).toHaveValue("Second");
});

test("a missing target leaves initial focus and ordinary dialog navigation intact", async ({ page }) => {
  const { modal, content } = await openSettings(page, "?target=not-a-setting");
  await expect(modal).toBeFocused();
  await page.evaluate(() => window.settingsNavigationFixture.releaseConfig());
  await expect(page.locator("#host-access")).toHaveCount(1);
  await page.evaluate(() => window.settingsNavigationFixture.rerender());
  await expect(modal).toBeFocused();
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
  const shortcuts = page.getByRole("button", { name: /Keyboard shortcuts/ });
  await shortcuts.click();
  await expect(shortcuts).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open settings" })).toBeFocused();
});

test("a policy-locked hostname selector reveals and focuses its group fallback", async ({ page }) => {
  const { content } = await openSettings(page, "?locked");
  const group = page.locator('[data-settings-target="host-access"]');
  await expect(group).toHaveCount(0);
  await page.evaluate(() => window.settingsNavigationFixture.releaseConfig());
  const selector = group.getByRole("combobox");
  await expect(selector).toBeDisabled();
  // A locked group receives focus, but the heading and actual control are the
  // reveal targets; the group also contains a list and potentially long help.
  await expectRevealed(content, group, selector, group);
  await expect(group).toHaveAttribute("tabindex", "-1");
  // Non-tabstop fallback focus re-enters ModalSurface's tab cycle at its start.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close settings" })).toBeFocused();
});
