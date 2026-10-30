import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { deploymentHtmlForFlavor } from "../../src/server/deploymentIdentity.js";

const deliveredCatalog = {
  themes: [
    { id: "pack:light", pluginId: "pack", name: "Light", colorScheme: "light", stylesheets: [{ id: "pack:light:palette", url: "palette-delivered.css" }] },
    { id: "pack:dark", pluginId: "pack", name: "Dark", colorScheme: "dark", stylesheets: [{ id: "pack:dark:palette", url: "palette-override.css" }] },
  ],
  themePairs: [], defaultTheme: { themeId: "pack:light", auto: false },
};

async function deliverInitialTheme(page: Page): Promise<void> {
  await page.route("**/themes.html?startup", async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const data = JSON.stringify({ catalog: { ...deliveredCatalog, themes: deliveredCatalog.themes.filter((theme) => theme.id === "pack:light") }, stylesheets: [{ url: "palette-delivered.css", cssText: ":root { --pi-bg: #fafafa; --pi-text: #111; }" }] });
    await route.fulfill({ response, body: html.replace("</head>", `<script id="pi-web-theme-data" type="application/json">${data}</script></head>`) });
  });
}

for (const override of [false, true]) {
  test(`initial response supplies a usable server theme ${override ? "without resolving browser overrides during bootstrap" : "without additional requests"}`, async ({ page }) => {
    await deliverInitialTheme(page);
    const requested: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/theme(?:s|-bootstrap)?(?:\?|$)|palette-(?:delivered|override)\.css/.test(request.url())) requested.push(new URL(request.url()).pathname);
    });
    if (override) {
      await page.addInitScript(() => { localStorage.setItem("pi-web-app-theme", JSON.stringify({ themeId: "pack:dark", auto: false })); });
    }
    await page.goto("/themes.html?startup");
    await expect(page.locator("#pi-web-startup")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-pi-web-theme", "pack:light");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 250, 250)");
    expect(requested).toEqual([]);
  });
}

test("theme CSS and identity switch together without exposing the startup palette while loading", async ({ page }) => {
  await page.route("**/palette-first.css", (route) => route.fulfill({ contentType: "text/css", body: ":root { --pi-bg: #fafafa; --pi-text: #111; }" }));
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/palette-next.css", async (route) => {
    await ready;
    await route.fulfill({ contentType: "text/css", body: ":root { --pi-bg: #e0f0ff; --pi-text: #222; }" });
  });
  await page.goto("/themes.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("#first").click();
  await expect(page.locator("html")).toHaveAttribute("data-pi-web-theme", "fixture:first");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 250, 250)");
  const requested = page.waitForRequest("**/palette-next.css");
  await page.locator("#next").click();
  await requested;
  await expect(page.locator("html")).toHaveAttribute("data-pi-web-theme", "fixture:first");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 250, 250)");
  await expect(page.locator("#shadow-sample")).toHaveCSS("background-color", "rgb(250, 250, 250)");
  release();
  await expect(page.locator("html")).toHaveAttribute("data-pi-web-theme", "fixture:next");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(224, 240, 255)");
  await expect(page.locator("#shadow-sample")).toHaveCSS("background-color", "rgb(224, 240, 255)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#e0f0ff");
});

test("application initialization proceeds while the selected declarative palette loads behind the loader", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pi-web-app-theme", JSON.stringify({ themeId: "pack:light", auto: false }));
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/theme-bootstrap", async (route) => {
    await pending;
    await route.fulfill({ json: {
      catalog: {
        themes: [{ id: "pack:light", pluginId: "pack", name: "Light", colorScheme: "light", stylesheets: [{ id: "pack:light:palette", url: "palette-initial.css" }] }],
        themePairs: [], defaultTheme: { themeId: "pack:light", auto: false },
      },
      stylesheets: [{ url: "palette-initial.css", cssText: ":root { --pi-bg: #fefefe; --pi-text: #111; }" }],
    } });
  });
  const requested = page.waitForRequest("**/api/theme-bootstrap");
  await page.goto("/themes.html?startup", { waitUntil: "domcontentloaded" });
  await requested;
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#pi-web-startup")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-pi-web-theme", /.+/);
  release();
  await expect(page.locator("#pi-web-startup")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-pi-web-theme", "pack:light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(254, 254, 254)");
});

// Serve the actual startup document without the application module. This makes
// pre-application painting observable without a daemon or timing-based sleeps.
for (const { colorScheme, flavor } of [
  { colorScheme: "light", flavor: "stable" }, { colorScheme: "dark", flavor: "stable" },
  { colorScheme: "light", flavor: "dev" }, { colorScheme: "dark", flavor: "dev" },
] as const) {
  test(`startup follows the ${colorScheme} device scheme before application startup (${flavor})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.route("**/theme-startup.html", async (route) => {
      const html = await readFile(new URL("../../src/client/index.html", import.meta.url), "utf8");
      await route.fulfill({ contentType: "text/html", body: deploymentHtmlForFlavor(html.replaceAll("%BASE_URL%", "./"), flavor) });
    });
    await page.route("**/src/startup.ts", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
    await page.goto("/theme-startup.html");
    const canvas = await page.locator("body").evaluate((body) => {
      const style = getComputedStyle(body);
      const rgb = style.backgroundColor.match(/\d+/g)?.map(Number) ?? [];
      return { light: (rgb[0] ?? 0) > 127 && (rgb[1] ?? 0) > 127 && (rgb[2] ?? 0) > 127, background: style.backgroundColor };
    });
    expect(canvas.light).toBe(colorScheme === "light");
    await expect(page.locator("html")).not.toHaveAttribute("data-pi-web-theme", /.+/);
    const loader = page.locator("#pi-web-startup");
    await expect(loader).toBeVisible();
    await expect(loader).toHaveAccessibleName(/.+/);
    expect((await loader.innerText()).trim()).toBe("");
    await expect(loader.locator("svg")).toBeVisible();
    await expect(loader.locator("svg")).toHaveCSS("fill", flavor === "dev" ? "rgb(163, 113, 247)" : colorScheme === "light" ? "rgb(0, 140, 130)" : "rgb(0, 240, 216)");
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(0);
    await expect(page.locator("pi-web-app")).toBeHidden();
    const system = await loader.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element).color }));
    // A saved theme can commit while the loader is still covering the app.
    // Its palette and forced scheme must not recolour the browser-native loader.
    await page.evaluate((scheme) => {
      document.documentElement.style.colorScheme = scheme;
      document.documentElement.style.setProperty("--pi-bg", "red");
      document.documentElement.style.setProperty("--pi-text", "lime");
    }, colorScheme === "light" ? "dark" : "light");
    await expect(loader).toHaveCSS("background-color", system.background);
    await expect(loader).toHaveCSS("color", system.text);
    expect(await loader.locator("svg").evaluate((element) => getComputedStyle(element).animationName)).not.toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(loader.locator("svg")).toHaveCSS("animation-name", "none");
  });
}
