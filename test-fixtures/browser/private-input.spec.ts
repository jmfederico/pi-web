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
  const input = form.getByRole("textbox", { name: "Private value", exact: true });
  await expect(input).toBeEnabled();
  const save = form.getByRole("button", { name: "Save file", exact: true });
  await expect(save).toBeDisabled();
  await input.fill(sentinel);
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  const confirm = form.getByRole("checkbox");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Space");
  await expect(save).toBeEnabled();
  await expect(form.getByText(record.destination, { exact: true })).toBeVisible();
  expect(await form.evaluate((node) => {
    const root = node.shadowRoot;
    return root !== null && [...root.querySelectorAll("section, textarea, .actions")].every((element) => element.scrollWidth <= element.clientWidth + 1);
  })).toBe(true);
  await page.screenshot({ path: test.info().outputPath("private-input.png"), fullPage: true });

  // Default-view switching unmounts the plugin. Returning must not restore a draft.
  const frame = page.locator("pi-web-transcript-renderer");
  await frame.getByRole("button", { name: "Default view", exact: true }).click();
  await expect(form).toHaveCount(0);
  await frame.getByRole("button", { name: "Custom view", exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  await expect(confirm).not.toBeChecked();
  await input.fill(sentinel); await confirm.check();
  await save.click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(form).not.toContainText(sentinel);
  await form.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(input).toHaveCount(0);
  await form.getByRole("button", { name: "Notify agent", exact: true }).click();
  await expect(form.getByRole("button", { name: "Notify agent", exact: true })).toHaveCount(0);
  expect(calls.filter((call) => call.url.endsWith("/submit"))).toHaveLength(1);
  expect(calls.every((call) => !call.url.includes("sentinel"))).toBe(true);
  expect(calls.filter((call) => !call.url.endsWith("/submit")).every((call) => !JSON.stringify(call.body).includes("synthetic-private-browser-sentinel"))).toBe(true);
  expect(messages.join("\n")).not.toContain(sentinel);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage].map((storage) => Object.keys(storage).map((key) => [key, storage.getItem(key)]))))).not.toContain("synthetic-private-browser-sentinel");
});
