// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { pluginStyles } from "../plugins/styles";
import { mcpApi } from "../api";
import { ActionPalette } from "./ActionPalette";
import type { ModalSurface } from "./ModalSurface";
import { SettingsThemePanel } from "./settings/SettingsThemePanel";
import { SettingsMcpPanel } from "./settings/SettingsMcpPanel";
import { FormattedText } from "./FormattedText";

const file = { id: "test:host", url: "https://plugins.test/host.css" };

afterEach(() => {
  document.body.replaceChildren();
  pluginStyles.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("shares contributed sheets across host and nested modal roots and releases them on disconnect", async () => {
  const fetchFile = vi.fn(() => Promise.resolve(new Response("button { border-radius: 7px; }", {
    headers: { "Content-Type": "text/css" },
  })));
  vi.stubGlobal("fetch", fetchFile);
  const palette = new ActionPalette();
  document.body.append(palette);
  await palette.updateComplete;
  const modal = palette.shadowRoot?.querySelector<ModalSurface>("modal-surface");
  if (modal === null || modal === undefined) throw new Error("Palette did not render its modal");
  await modal.updateComplete;
  const roots = [palette.shadowRoot, modal.shadowRoot];
  await pluginStyles.setContributions([file]);
  const sheet = palette.shadowRoot?.adoptedStyleSheets.at(-1);
  expect(sheet).toBeDefined();
  for (const root of roots) expect(root?.adoptedStyleSheets).toContain(sheet);

  // Components connected after the file loads receive the same compiled sheet.
  const themePanel = new SettingsThemePanel();
  const mcpPanel = new SettingsMcpPanel();
  mcpPanel.apiClient = { ...mcpApi, list: () => Promise.resolve({ servers: [], errors: [], userConfigPath: "/agent/mcp.json" }) };
  const text = new FormattedText();
  document.body.append(themePanel, mcpPanel, text);
  await Promise.all([themePanel.updateComplete, mcpPanel.updateComplete, text.updateComplete]);
  expect(themePanel.shadowRoot?.adoptedStyleSheets).toContain(sheet);
  expect(mcpPanel.shadowRoot?.adoptedStyleSheets).toContain(sheet);
  expect(text.shadowRoot?.adoptedStyleSheets).toContain(sheet);
  expect(fetchFile).toHaveBeenCalledTimes(1);

  palette.remove();
  for (const root of roots) expect(root?.adoptedStyleSheets).not.toContain(sheet);
  expect(themePanel.shadowRoot?.adoptedStyleSheets).toContain(sheet);
  document.body.append(palette);
  await palette.updateComplete;
  for (const root of roots) expect(root?.adoptedStyleSheets).toContain(sheet);
  await pluginStyles.setContributions([]);
  for (const root of [...roots, themePanel.shadowRoot, mcpPanel.shadowRoot, text.shadowRoot]) {
    expect(root?.adoptedStyleSheets).not.toContain(sheet);
  }
});
