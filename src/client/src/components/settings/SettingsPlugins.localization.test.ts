// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { render } from "lit";
import type { PiWebConfigResponse, PiWebPluginsResponse } from "../../api";
import { localization } from "../../localization/browser";
import { PI_WEB_PLUGIN_RECOVERY_COMMANDS } from "../../../../shared/pluginRecoveryCommands";
import { SettingsPluginsPanel, pluginsMessages as messages } from "./SettingsPluginsPanel";
import type { SettingsPanelFrame } from "./SettingsPanelFrame";

const releases: (() => void)[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  releases.splice(0).forEach((release) => { release(); });
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
  vi.restoreAllMocks();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing plugin settings control");
  return value;
}
function response(): PiWebPluginsResponse {
  return {
    lifecycleVersion: 2,
    plugins: [{ id: "raw-<img>-العربية", source: "/raw/<img>/package", scope: "project", machineSpecific: true, enabled: true, discovered: true, conflict: true, server: { state: "failed", message: "Raw <img> failed", health: { status: "degraded", message: "Raw <img> health" }, staleRevision: true, restartRequired: true, disableCommand: "raw command <img> --disable" } }],
    diagnostics: [{ kind: "conflict", snapshot: "active", source: "raw", message: "Raw <img> duplicate" }],
    serverRuntime: { status: "available", terminalMode: "recovery-disabled", restartRequired: true, safeStart: "none", desiredSafeStart: "off", recovery: PI_WEB_PLUGIN_RECOVERY_COMMANDS },
  };
}
function config(): PiWebConfigResponse {
  return { path: "/raw/config", exists: true, config: { plugins: { "raw-<img>-العربية": { enabled: false } } }, effectiveConfig: {}, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false } };
}
function frame(panel: SettingsPluginsPanel): SettingsPanelFrame {
  return required(panel.renderRoot.querySelector("settings-panel-frame"));
}
async function settle(panel: SettingsPluginsPanel): Promise<void> {
  await panel.updateComplete;
  await frame(panel).updateComplete;
}
async function mount(): Promise<SettingsPluginsPanel> {
  const panel = new SettingsPluginsPanel();
  panel.targetLabel = "Raw target <img> العربية";
  panel.configResponse = config();
  panel.pluginsResponse = response();
  panel.onReload = vi.fn();
  panel.onTogglePlugin = vi.fn();
  document.body.append(panel);
  await settle(panel);
  return panel;
}
async function language(panel: SettingsPluginsPanel, language: string): Promise<void> {
  await localization.setPreferences({ language, formatLocale: "ar-EG" });
  await settle(panel);
}
function text(panel: SettingsPluginsPanel): string {
  return `${panel.renderRoot.textContent} ${frame(panel).renderRoot.textContent}`;
}
function plainRich(value: unknown): string {
  const container = document.createElement("div");
  render(value, container);
  return container.textContent;
}

it("updates loaded plugin controls/notices live without losing focus, checked state or action origin", async () => {
  releases.push(localization.registerCatalog({ id: "plugins-test", namespace: "core.settingsPlugins", locale: "de", load: () => Promise.resolve({ heading: "Plugins verwalten", refresh: "Aktualisieren", enable: "Plugin aktivieren", enableAria: "{id} aktivieren" }) }));
  const panel = await mount();
  panel.savedMessage = "Raw saved <img>";
  panel.error = "Raw error <img>";
  await settle(panel);
  const toggle = required(panel.renderRoot.querySelector("input"));
  const row = panel.renderRoot.querySelector("article");
  toggle.focus();
  for (const locale of ["de", "en-XA", "ar-XB"]) {
    await language(panel, locale);
    expect(panel.renderRoot.querySelector("input")).toBe(toggle);
    expect(panel.renderRoot.querySelector("article")).toBe(row);
    expect(panel.shadowRoot?.activeElement).toBe(toggle);
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute("aria-label")).toBe(messages.t("enableAria", { id: "raw-<img>-العربية" }));
    expect(frame(panel).heading).toBe(messages.t("heading"));
    expect(frame(panel).actionLabel).toBe(messages.t("refresh"));
    expect(frame(panel).actionTitle).toBe(messages.t("refreshTitle", { target: panel.targetLabel }));
    expect(panel.renderRoot.querySelector(".status-list")?.getAttribute("aria-label")).toBe(messages.t("statesAria", { id: "raw-<img>-العربية" }));
    expect(panel.renderRoot.querySelector("aside")?.getAttribute("aria-label")).toBe(messages.t("recoveryAria"));
    for (const key of ["disabledState", "conflict", "updatePending", "restartRequired", "enable", "pendingTitle", "pendingOff", "safeTitle", "restartTitle"] as const) expect(text(panel)).toContain(messages.t(key));
    expect(text(panel)).toContain(messages.t("serverState", { state: "failed" }));
    expect(text(panel)).toContain(messages.t("health", { status: "degraded" }));
    expect(text(panel)).toContain(messages.t("savedRestart", { saved: panel.savedMessage }));
    for (const raw of ["Raw saved <img>", "Raw error <img>", "Raw <img> failed", "Raw <img> health", "Raw <img> duplicate", "raw command <img> --disable", panel.targetLabel, ...Object.values(PI_WEB_PLUGIN_RECOVERY_COMMANDS)]) expect(text(panel)).toContain(raw);
    expect(panel.renderRoot.querySelector("img")).toBeNull();
    expect(frame(panel).renderRoot.querySelector("img")).toBeNull();
    expect(panel.onTogglePlugin).not.toHaveBeenCalled();
    expect(panel.onReload).not.toHaveBeenCalled();
  }
  toggle.click();
  expect(panel.onTogglePlugin).toHaveBeenCalledExactlyOnceWith("raw-<img>-العربية", true);
  required(frame(panel).renderRoot.querySelector("button")).click();
  expect(panel.onReload).toHaveBeenCalledOnce();
});

it("keeps pending saves disabled through locale changes and reconnect, without replaying actions", async () => {
  const panel = await mount();
  panel.saving = true;
  await language(panel, "ar-XB");
  expect(panel.renderRoot.querySelector("input")?.disabled).toBe(true);
  expect(frame(panel).actionDisabled).toBe(true);
  panel.remove();
  await language(panel, "en-XA");
  document.body.append(panel);
  await settle(panel);
  expect(panel.renderRoot.querySelector("input")?.disabled).toBe(true);
  expect(frame(panel).heading).toBe(messages.t("heading"));
  expect(panel.onTogglePlugin).not.toHaveBeenCalled();
  expect(panel.onReload).not.toHaveBeenCalled();
});

it("localizes unavailable/loading/empty/config-unavailable states and fallback target live", async () => {
  const panel = await mount();
  panel.pluginsResponse = undefined;
  panel.configResponse = undefined;
  panel.targetLabel = "";
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(panel, locale);
    expect(text(panel)).toContain(messages.t("unavailableList", { target: messages.t("localTarget") }));
    panel.loading = true;
    await settle(panel);
    expect(text(panel)).toContain(messages.t("loading"));
    panel.loading = false;
    panel.pluginsResponse = { ...response(), plugins: [], diagnostics: [] };
    await settle(panel);
    expect(text(panel)).toContain(messages.t("empty", { target: messages.t("localTarget") }));
    panel.pluginsResponse = response();
    await settle(panel);
    expect(text(panel)).toContain(messages.t("unavailableConfig"));
    expect(panel.renderRoot.querySelector("input")?.disabled).toBe(true);
    panel.pluginsResponse = undefined;
  }
});

it("localizes lifecycle fallback guidance, raw diagnostics and exact safe-start recovery commands", async () => {
  const panel = await mount();
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(panel, locale);
    for (const status of ["unavailable", "incompatible"] as const) {
      panel.pluginsResponse = { ...response(), serverRuntime: { ...response().serverRuntime, status, safeStart: "bundled-only", desiredSafeStart: "none" } };
      await settle(panel);
      expect(text(panel)).toContain(messages.t(status === "unavailable" ? "unavailableRuntime" : "incompatible", { detail: messages.t(status === "unavailable" ? "connectionHelp" : "incompatibleFallback") }));
      expect(text(panel)).toContain(plainRich(messages.rich("safeBundled", { command: PI_WEB_PLUGIN_RECOVERY_COMMANDS.clearSafeStart, code: (parts) => parts })));
      expect(text(panel)).toContain(messages.t("pendingSafe", { mode: "none" }));
      expect(panel.renderRoot.querySelector("aside") === null).toBe(status === "incompatible");
      panel.pluginsResponse = { ...panel.pluginsResponse, serverRuntime: { ...panel.pluginsResponse.serverRuntime, message: "Raw <img> runtime" } };
      await settle(panel);
      expect(text(panel)).toContain(messages.t(status === "unavailable" ? "unavailableRuntime" : "incompatible", { detail: "Raw <img> runtime" }));
    }
  }
  panel.recoveryCommandsSupported = true;
  await settle(panel);
  expect(panel.renderRoot.querySelector("aside")?.textContent).toContain(PI_WEB_PLUGIN_RECOVERY_COMMANDS.clearSafeStart);
});

it("localizes all lifecycle/health states and required/config-only/browser-only provenance", async () => {
  const panel = await mount();
  const plugin = required(response().plugins[0]);
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(panel, locale);
    for (const state of ["active", "failed", "incompatible", "disabled", "missing", "unknown"] as const) {
      for (const status of ["healthy", "degraded", "unhealthy"] as const) {
        panel.pluginsResponse = { ...response(), plugins: [{ ...plugin, server: { ...required(plugin.server), state, health: { status } } }] };
        await settle(panel);
        expect(text(panel)).toContain(messages.t("serverState", { state }));
        expect(text(panel)).toContain(messages.t("health", { status }));
      }
    }
    const browserPlugin = { ...plugin };
    delete browserPlugin.server;
    panel.pluginsResponse = { ...response(), plugins: [{ ...browserPlugin, required: true }, { ...browserPlugin, id: "runtime-only", discovered: false }] };
    await settle(panel);
    const toggle = required(panel.renderRoot.querySelector("input"));
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe(messages.t("requiredAria", { id: plugin.id }));
    for (const key of ["requiredState", "required", "missingState", "browserOnly"] as const) expect(text(panel)).toContain(messages.t(key));
    panel.pluginsResponse = { ...response(), plugins: [] };
    await settle(panel);
    expect(text(panel)).toContain(messages.t("configuredOnly"));
    expect(text(panel)).toContain(messages.t("configOnly"));
  }
  const runtime = { ...response().serverRuntime, restartRequired: false };
  panel.pluginsResponse = { ...response(), serverRuntime: runtime };
  panel.savedMessage = "Raw save";
  await settle(panel);
  expect(text(panel)).toContain(messages.t("savedBrowser", { saved: "Raw save" }));
});
