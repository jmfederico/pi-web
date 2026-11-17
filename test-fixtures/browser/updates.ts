import { html, LitElement, svg } from "lit";
import type { ApplicationPanelContextV5, MachineLifecycle, RestartResult } from "../../src/plugin-api";
import plugin from "../../pi-web-plugins/updates/pi-web-plugin";
import { LocalizationService } from "../../src/client/src/localization/service";
import { createPluginLocalization } from "../../src/client/src/plugins/localization";
import { workspacePanelStyles } from "../../src/client/src/theme/base/shellStyles";

const lifetime = new AbortController();
const service = new LocalizationService({ preferences: { language: "en", formatLocale: "en-US", timeZone: "UTC" } });
const panel = plugin.activate({
  apiVersion: 5, pluginId: "updates", runtimePluginId: "updates", html, svg,
  localization: createPluginLocalization(service, "updates", "updates", lifetime.signal),
  signal: lifetime.signal, lifetimeSignal: lifetime.signal,
}).contributions.applicationPanels[0];
if (panel === undefined) throw new Error("Updates panel missing");

const machine = { id: "remote-build", name: "Build machine", kind: "remote" } as const;
interface Request { machineId: string; options: Parameters<MachineLifecycle["requestRestart"]>[0] }
const requests: Request[] = [];
let acceptLaunch: ((result: RestartResult) => void) | undefined;
const unavailable = (): never => { throw new Error("Unexpected fixture host operation"); };
// No processes or live services: resolve only when the test accepts the fake terminal launch.
const context: ApplicationPanelContextV5 = {
  machine,
  catalog: {
    version: 1, machineId: machine.id,
    projects: { list: unavailable, get: unavailable },
    workspaces: { list: unavailable, get: unavailable },
    sessions: { list: unavailable, get: unavailable },
  },
  navigate: unavailable,
  prompt: { insertText: unavailable, getText: () => "", getSelection: () => null },
  host: { requestRender: () => { fixture.requestUpdate(); } },
  lifecycle: { requestRestart: (options) => {
    requests.push({ machineId: machine.id, options });
    return new Promise<RestartResult>((resolve) => { acceptLaunch = resolve; });
  } },
  state: { piWebStatus: {
    packageName: "@jmfederico/pi-web", generatedAt: "2026-06-14T00:00:00.000Z",
    components: {
      web: { component: "web", label: "Web/UI", available: true, stale: false, runtimeVersion: "1.202605.9", installedVersion: "1.202605.9" },
      sessiond: { component: "sessiond", label: "Session daemon", available: true, stale: true, runtimeVersion: "1.202605.8", installedVersion: "1.202605.9" },
    },
    commands: {
      restart: "pi-web-docker --dev restart", restartWeb: "pi-web-docker --dev restart-web", restartSessiond: "pi-web-docker --dev restart-sessiond",
      update: "pi-web update", status: "pi-web status",
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false }, messages: [],
  } },
};
const renderPanel = panel.render;
class UpdatesFixture extends LitElement {
  static override styles = workspacePanelStyles;
  protected override render() { return html`<div class="panel-content">${renderPanel(context)}</div>`; }
}
customElements.define("updates-fixture", UpdatesFixture);
const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: dark; --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-text-bright: #fff; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-accent: #aaf; --pi-accent-border: #88b; }
  body { margin: 0; background: var(--pi-bg); }
  updates-fixture { position: fixed; inset: 0; width: min(100%, 760px); height: 100dvh; overflow: hidden; }
`;
document.head.append(style);
const fixture = new UpdatesFixture();
document.body.append(fixture);

declare global {
  interface Window { updatesFixture: { requests: () => Request[]; acceptTerminal: () => void } }
}
window.updatesFixture = {
  requests: () => requests,
  acceptTerminal: () => {
    if (acceptLaunch === undefined) throw new Error("No pending terminal launch");
    const resolve = acceptLaunch;
    acceptLaunch = undefined;
    resolve("launched");
  },
};
window.addEventListener("pagehide", () => { lifetime.abort(); fixture.remove(); }, { once: true });
await fixture.updateComplete;
