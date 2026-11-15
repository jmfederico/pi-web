import { expect, test } from "@playwright/test";

// Deliberately synthetic; traces and assertion failures must never contain a real secret.
const sentinel = "synthetic-private-browser-sentinel\nsecond line\n";
const record = {
  requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionId: "conversation",
  destination: `/outside/workspace/${"long-directory-".repeat(12)}/token`,
  purpose: "Configure private access for the example service.", status: "waiting",
};

test("private capture fits the transcript and keeps its value out of drafts, errors and default view", async ({ page }) => {
  const messages: string[] = [];
  const calls: { url: string; body: unknown }[] = [];
  page.on("console", (message) => { messages.push(message.text()); });
  page.on("pageerror", (error) => { messages.push(error.message); });
  let saved = false;
  await page.route("**/api/machines/origin/paired-plugin-backends/private-input/**", async (route) => {
    const request = route.request();
    const url = request.url();
    const body: unknown = request.postDataJSON();
    calls.push({ url, body });
    if (url.endsWith("/submit")) {
      expect(body).toMatchObject({ input: { secret: sentinel, confirmedDestination: record.destination } });
      saved = true;
      // Simulate a lost response after a successful write. Its untrusted error
      // text includes the sentinel to prove the plugin never forwards it.
      await route.fulfill({ status: 503, json: { error: sentinel } });
    } else {
      await route.fulfill({ json: { record: { ...record, status: saved ? "saved" : "waiting" },
        ...(url.endsWith("/notify") ? { delivered: true } : { active: false }) } });
    }
  });
  await page.goto("/private-input.html");
  const form = page.locator("pi-web-private-input");
  const input = form.getByLabel("Secret", { exact: true });
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  // 16px is the iOS focus-zoom threshold, not an incidental visual dimension.
  expect(await input.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  // No fixture expansion: the plugin must appear outside ordinary collapsed activity.
  const frame = page.locator("pi-web-transcript-renderer");
  expect(await frame.evaluate((node) => node.closest("details") === null)).toBe(true);
  await expect(input).toHaveAttribute("type", "password");
  await expect(form.getByRole("checkbox")).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Check status", exact: true })).toHaveCount(0);
  await expect(form.getByText(record.destination, { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("private-input-default.png"), fullPage: true });
  await input.fill("synthetic-single-line");
  await form.getByRole("button", { name: "Show secret", exact: true }).click();
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toHaveValue("synthetic-single-line");
  await form.getByRole("button", { name: "Hide secret", exact: true }).click();
  await expect(input).toHaveAttribute("type", "password");
  await form.getByRole("button", { name: "Use multiline", exact: true }).click();
  await expect(input).toHaveValue("synthetic-single-line");
  expect(await input.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await input.evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-text-security"))).toBe("disc");
  const save = form.getByRole("button", { name: "Save file", exact: true });
  await expect(save).toBeEnabled();
  await input.fill(sentinel);
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByRole("button", { name: "Show secret", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByRole("button", { name: "Use single line", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  await expect(form.getByText(record.destination, { exact: true })).toBeVisible();
  expect(await form.evaluate((node) => {
    const root = node.shadowRoot;
    return root !== null && [...root.querySelectorAll("section, textarea, .actions")].every((element) => element.scrollWidth <= element.clientWidth + 1);
  })).toBe(true);
  await page.screenshot({ path: test.info().outputPath("private-input-masked.png"), fullPage: true });
  await form.getByRole("button", { name: "Show secret", exact: true }).click();
  expect(await input.evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-text-security"))).toBe("none");
  await expect(input).toHaveValue(sentinel);
  await page.screenshot({ path: test.info().outputPath("private-input-visible.png"), fullPage: true });
  await form.getByRole("button", { name: "Hide secret", exact: true }).click();
  // A format change must not strip multiline content or reveal it.
  await form.getByRole("button", { name: "Use single line", exact: true }).click();
  await expect(form.getByRole("button", { name: "Use single line", exact: true })).toBeVisible();
  await expect(input).toHaveValue(sentinel);
  await expect(form.getByRole("alert")).toBeVisible();
  expect(await input.evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-text-security"))).toBe("disc");

  // Default-view switching unmounts the plugin. Returning must not restore a draft.
  await frame.getByRole("button", { name: "Default view", exact: true }).click();
  await expect(form).toHaveCount(0);
  await frame.getByRole("button", { name: "Custom view", exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("type", "password");
  await form.getByRole("button", { name: "Use multiline", exact: true }).click();
  await input.fill(sentinel);
  await save.click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(form).not.toContainText(sentinel);
  await form.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(input).toHaveCount(0);
  await form.getByRole("button", { name: "Notify agent", exact: true }).click();
  await expect(form.getByRole("button", { name: "Notify agent", exact: true })).toHaveCount(0);
  expect(calls.filter((call) => call.url.endsWith("/submit"))).toHaveLength(1);
  expect(calls.every((call) => !call.url.includes("sentinel"))).toBe(true);
  expect(calls.filter((call) => !call.url.endsWith("/submit")).every((call) => !JSON.stringify(call.body).includes("synthetic-private-browser-sentinel"))).toBe(true);
  expect(messages.join("\n")).not.toContain(sentinel);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage].map((storage) => Object.keys(storage).map((key) => [key, storage.getItem(key)]))))).not.toContain("synthetic-private-browser-sentinel");
});

test("unsupported multiline masking requires consent to show, and can hide the editor again", async ({ page }) => {
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (property: string, value?: string) => property === "-webkit-text-security" ? false
      : value === undefined ? supports(property) : supports(property, value);
  });
  await page.route("**/api/machines/origin/paired-plugin-backends/private-input/**", (route) => route.fulfill({ json: { record, active: false } }));
  await page.goto("/private-input.html");
  const form = page.locator("pi-web-private-input");
  const input = form.getByLabel("Secret", { exact: true });
  await expect(input).toBeEnabled();
  await input.fill("synthetic-hidden-transfer");
  await form.getByRole("button", { name: "Use multiline", exact: true }).click();
  await expect(input).toBeHidden();
  await expect(form.getByText("Multiline text is visible while editing in this browser.", { exact: false })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("private-input-unsupported.png"), fullPage: true });
  await form.getByRole("button", { name: "Show secret", exact: true }).click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("synthetic-hidden-transfer");
  await input.fill(sentinel);
  await form.getByRole("button", { name: "Hide secret", exact: true }).click();
  await expect(input).toBeHidden();
  await form.getByRole("button", { name: "Use single line", exact: true }).click();
  await expect(form.getByRole("button", { name: "Use single line", exact: true })).toBeVisible();
  await expect(input).toBeHidden();
  await expect(input).toHaveValue(sentinel);
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(input).toHaveValue("");
});
