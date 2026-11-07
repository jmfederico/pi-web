import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { api, configApi, piPackagesApi, pluginsApi, type PiWebConfigResponse } from "../../src/client/src/api";
import { SettingsDialog } from "../../src/client/src/components/SettingsDialog";
import type { SettingsGeneralPanel } from "../../src/client/src/components/settings/SettingsGeneralPanel";
import { uiFormStyles } from "../../src/client/src/components/ui/formStyles";
import { PiWebApp } from "../../src/client/src/components/PiWebApp";
import { saveNavigationPreferences } from "../../src/client/src/navigationPreferences";
import type { RestartDialog } from "../../src/client/src/components/RestartDialog";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const parameters = new URLSearchParams(location.search);
const target = parameters.get("target") ?? "host-access";
const noticesMode = parameters.has("notices");
const configLoad = deferred();
const configSave = deferred();
let response: PiWebConfigResponse = {
  path: "/fixture/config.json", exists: true,
  config: { port: 8504, allowedHosts: ["fixture.local"] },
  effectiveConfig: { port: 8504, allowedHosts: ["fixture.local"], ...(parameters.has("locked") ? { hostAccess: { mode: "restricted", hosts: ["fixture.local"] } as const } : {}) },
  activeHostAccess: null,
  envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false },
  ...(parameters.has("locked") ? { enforcedSettings: { "/hostAccess": "PI_WEB_HOST_ACCESS" } } : {}),
};

// Replace public API collaborators only; all dialog, panel, modal and target
// navigation code is real. The test controls completion rather than sleeping.
configApi.config = async () => { await configLoad.promise; return response; };
configApi.updateConfig = async (update) => {
  document.body.dataset["save"] = "pending";
  await configSave.promise;
  response = { ...response, config: { ...response.config, ...update.set }, effectiveConfig: { ...response.effectiveConfig, ...update.set } };
  document.body.dataset["save"] = "complete";
  return response;
};
pluginsApi.plugins = () => Promise.resolve({
  lifecycleVersion: 2, plugins: [], diagnostics: [],
  serverRuntime: { status: "available", terminalMode: "recovery-disabled", restartRequired: false, recovery: {
    showSafeStart: "", bundledOnly: "", noServerPlugins: "", clearSafeStart: "",
  } },
});
piPackagesApi.packages = () => Promise.resolve({ packages: [] });
api.runtime = () => Promise.resolve({ machineId: "local", ok: true, checkedAt: "fixture", capabilities: [] });
const terminalLaunches: { command: string; title: string }[] = [];

// An extra consumer of the public target convention, placed in the real
// General panel's appearance slot. No copy of the target-navigation algorithm.
class FixtureSettingsPanel extends LitElement {
  @property({ type: Boolean }) ready = false;
  static override styles = [uiFormStyles, css`
    :host { display: block; padding: 16px; }
    .preceding-content { min-height: 100dvh; }
  `];
  override render() {
    return html`<div class="preceding-content">Additional settings above the destination</div>
      ${this.ready ? html`<div data-settings-target="fixture-preference" tabindex="-1" role="group" aria-label="Fixture preference">
        <label class="ui-form-field">Fixture preference
          <select class="ui-input"><option>First</option><option>Second</option></select>
        </label>
      </div>` : null}`;
  }
}
customElements.define("fixture-settings-panel", FixtureSettingsPanel);

const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: dark; --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-text-bright: #fff; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-accent: #aaf; --pi-overlay: #0008; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui; }
`;
document.head.append(style);
// Match the app's full-viewport shadow host without starting PiWebApp or services.
const host = document.createElement("main");
host.style.cssText = "position: fixed; inset: 0; height: 100dvh; overflow: hidden;";
const application = host.attachShadow({ mode: "open" });
document.body.append(host);
const opener = document.createElement("button");
opener.textContent = "Open settings";
if (!noticesMode) application.append(opener);
let app: PiWebApp | undefined;
let dialog: SettingsDialog | undefined;
let extraPanel: FixtureSettingsPanel | undefined;
opener.addEventListener("click", () => { void openSettings(); });
async function openSettings(): Promise<void> {
  dialog = new SettingsDialog();
  dialog.target = target;
  dialog.onClose = () => { dialog?.remove(); };
  dialog.onNavigate = (section) => { if (dialog) dialog.section = section; };
  dialog.onConfigSaved = (config) => { document.body.dataset["savedPort"] = String(config.port); };
  application.append(dialog);
  await dialog.updateComplete;
  if (target === "fixture-preference") {
    const panel = dialog.renderRoot.querySelector<SettingsGeneralPanel>("settings-general-panel");
    if (!panel) throw new Error("General panel did not mount");
    extraPanel = new FixtureSettingsPanel();
    extraPanel.slot = "appearance";
    panel.append(extraPanel);
    await extraPanel.updateComplete;
  }
  document.body.dataset["opened"] = "true";
}

// Let Lit's nested asynchronous updates and target traversal finish before
// asserting a negative (no focus theft). These are paint barriers, not delays.
async function painted(): Promise<void> {
  await app?.updateComplete;
  await (app?.shadowRoot?.querySelector<SettingsDialog>("settings-dialog") ?? dialog)?.updateComplete;
  await new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); });
}

declare global {
  interface Window {
    settingsNavigationFixture: {
      releaseConfig: () => Promise<void>;
      rerender: () => Promise<void>;
      releaseSave: () => Promise<void>;
      selection: () => { session: unknown; workspace: unknown };
      terminalLaunches: () => { command: string; title: string }[];
    };
  }
}
window.settingsNavigationFixture = {
  releaseConfig: async () => {
    if (extraPanel) extraPanel.ready = true;
    configLoad.resolve();
    await painted();
  },
  rerender: async () => {
    if (!dialog) throw new Error("Settings is not open");
    dialog.actions = [...dialog.actions];
    await painted();
  },
  releaseSave: async () => { configSave.resolve(); await painted(); },
  terminalLaunches: () => terminalLaunches,
  selection: () => {
    const state: unknown = Reflect.get(app ?? {}, "state");
    if (typeof state !== "object" || state === null || !("selectedSession" in state) || !("selectedWorkspace" in state)) {
      throw new Error("Expected mounted app selection");
    }
    return { session: state.selectedSession, workspace: state.selectedWorkspace };
  },
};

if (noticesMode) {
  // Keep the actual shell, plugin registration, Notices navigation, Settings
  // action and config callbacks. Omit only unrelated transport/discovery startup;
  // loadClientConfig still reads through the public fake config API above.
  class FixtureNoticesApp extends PiWebApp {
    override connectedCallback(): void { LitElement.prototype.connectedCallback.call(this); }
    protected override updated(): void {
      super.updated();
      const restart = this.renderRoot.querySelector<RestartDialog>("restart-dialog");
      if (restart) {
        restart.loadCommands = () => Promise.resolve({ restartWeb: "pi-web-docker --dev restart-web" });
        restart.activity = "idle";
        restart.onRun = (command, title) => {
          terminalLaunches.push({ command, title });
          return Promise.resolve();
        };
      }
    }
  }
  customElements.define("fixture-notices-app", FixtureNoticesApp);
  saveNavigationPreferences({ pinnedIds: ["chat", "core:notices"], mobileCollapsed: false });
  app = new FixtureNoticesApp();
  application.append(app);
  configLoad.resolve();
  const load: unknown = Reflect.get(app, "loadClientConfig");
  if (typeof load !== "function") throw new Error("Missing gateway config loading boundary");
  await Reflect.apply(load, app, []);
  await app.updateComplete;
  document.body.dataset["ready"] = "true";
}
window.addEventListener("pagehide", () => { dialog?.remove(); app?.remove(); }, { once: true });
