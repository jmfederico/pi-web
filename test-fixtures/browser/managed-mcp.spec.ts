import { expect, test } from "@playwright/test";
import { managedMcpView } from "../../pi-packages/mcp-manager/browser/managedMcp.testSupport.js";
import type { ManagedMcpUpdate } from "../../pi-packages/mcp-manager/shared.js";

function isUpdate(value: unknown): value is ManagedMcpUpdate {
  return typeof value === "object" && value !== null
    && "serverName" in value && typeof value.serverName === "string"
    && "enabled" in value && typeof value.enabled === "boolean"
    && "revision" in value && typeof value.revision === "string"
    && "scope" in value && ["global", "project", "session"].some((scope) => scope === value.scope);
}

test("all scope controls remain reachable in desktop columns and a narrow scrolling panel", async ({ page }, testInfo) => {
  const updates: ManagedMcpUpdate[] = [];
  let view = managedMcpView();
  await page.route("**/mcp-fixture", async (route) => {
    const payload: unknown = route.request().postDataJSON();
    if (typeof payload !== "object" || payload === null || !("scope" in payload) || !("operation" in payload) || !("input" in payload)) throw new Error("Invalid backend request");
    expect(payload.scope).toEqual({ kind: "workspace", projectId: "project", workspaceId: "workspace" });
    expect(payload.input).not.toHaveProperty("cwd");
    if (payload.operation === "update") {
      const update = payload.input;
      if (!isUpdate(update)) throw new Error("Invalid fixture update");
      updates.push(update);
      view = { ...view, revision: `revision-${String(updates.length + 1)}`, servers: view.servers.map((row) => {
        if (row.name !== update.serverName) return row;
        const enabled = { ...row.enabled, [update.scope]: update.enabled };
        return { ...row, enabled, effectiveEnabled: Object.values(enabled).some(Boolean) };
      }) };
    }
    await route.fulfill({ json: view });
  });
  await page.goto("/managed-mcp.html");
  const global = page.getByRole("checkbox", { name: "Enable docs in Global", exact: true });
  const project = page.getByRole("checkbox", { name: "Enable docs in Project", exact: true });
  const session = page.getByRole("checkbox", { name: "Enable docs in Session", exact: true });
  await expect(global).toBeChecked();
  await expect(page.getByText("Build machine", { exact: true })).toBeVisible();
  await expect(page.getByText("Documentation review", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("managed-mcp-context.png"), fullPage: true });
  await project.check();
  await expect(page.getByRole("button", { name: "Save Project change for docs" })).toBeVisible();
  expect(updates).toHaveLength(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const keepEditing = page.getByRole("button", { name: "Keep editing", exact: true });
  await expect(keepEditing).toBeFocused();
  await keepEditing.click();
  await expect(project).toBeChecked();
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await refresh.click();
  await expect(keepEditing).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(refresh).toBeFocused();
  await expect(project).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("managed-mcp-unsaved.png"), fullPage: true });
  await page.getByRole("button", { name: "Save Project change for docs" }).click();
  await expect(project).toBeEnabled();
  await session.check();
  await expect(session).toBeEnabled();
  expect(updates.map(({ scope }) => scope)).toEqual(["project", "session"]);
  await expect(page.getByRole("checkbox", { name: "Enable project-tools in Global", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Enable native in Session", exact: true })).toBeDisabled();

  const boxes = await Promise.all([global, project, session].map((control) => control.boundingBox()));
  const [g, p, s] = boxes;
  if (!g || !p || !s) throw new Error("Missing checkbox geometry");
  if (testInfo.project.name === "touch") {
    expect(g.y).toBeLessThan(p.y);
    expect(p.y).toBeLessThan(s.y);
  } else {
    expect(g.x).toBeLessThan(p.x);
    expect(p.x).toBeLessThan(s.x);
  }
  await page.getByText("Add or edit servers", { exact: true }).click();
  await page.getByText("Configuration example", { exact: true }).click();
  await expect(page.locator("pre code")).toBeVisible();
  await page.getByRole("button", { name: "Copy Project config path" }).scrollIntoViewIfNeeded();
  const overflow = await page.locator("managed-mcp-panel").evaluate((panel) => panel.scrollWidth > panel.clientWidth);
  expect(overflow).toBe(false);
  // Keyboard can reach the configuration actions after the responsive scope stack.
  await page.getByRole("button", { name: "Copy Project config path" }).focus();
  await expect(page.getByRole("button", { name: "Copy Project config path" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("managed-mcp.png"), fullPage: true });
});

test("empty state exposes setup paths without opening a disclosure", async ({ page }, testInfo) => {
  await page.route("**/mcp-fixture", (route) => route.fulfill({ json: managedMcpView({ servers: [] }) }));
  await page.goto("/managed-mcp.html");
  await expect(page.getByRole("button", { name: "Copy Global config path" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Project config path" })).toBeVisible();
  await expect(page.getByText("/workspace/.pi/mcp-manager.json", { exact: true })).toBeVisible();
  await expect(page.locator("pre code")).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("managed-mcp-empty.png"), fullPage: true });
});
