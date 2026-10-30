import { html, render } from "lit";
import type { ApplicationPanelContextV5, JsonValue } from "../../src/plugin-api";
import plugin from "../../pi-packages/scheduled-tasks/browser/pi-web-plugin";
import { LocalizationService } from "../../src/client/src/localization/service";
import { createPluginLocalization } from "../../src/client/src/plugins/localization";
import { stylesheetIntegrationCapability } from "../../src/client/src/plugins/styles";
import "../../pi-web-plugins/themes/assets/classic.css";

const lifetime = new AbortController();
const service = new LocalizationService({ development: true, preferences: { language: "en", formatLocale: "en-GB" } });
const localization = createPluginLocalization(service, "scheduled-tasks", "@jmfederico/pi-web-scheduled-tasks", lifetime.signal);
const activation = plugin.activate({ apiVersion: 5, pluginId: "scheduled-tasks", runtimePluginId: "scheduled-tasks", signal: lifetime.signal, lifetimeSignal: lifetime.signal, localization, html, svg: html });
activation.start({ signal: lifetime.signal, capabilities: { resolve: (token) => token.parse(stylesheetIntegrationCapability) } });
const task = { id: "review", name: "Daily issue classification and compatibility review", revision: 2, projectId: "project-with-a-long-registered-id", workspaceId: "main-workspace", schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "Europe/Madrid", paused: false, archived: false, nextDue: "2026-10-02T07:00:00Z" };
const execution = { id: "execution-review", task, trigger: "scheduled", createdAt: "2026-10-01T07:00:00Z", status: "completed", sessionId: "review-conversation", dispatchError: null, latestReport: { summary: "Reviewed 18 issues. Classified 4 new reports and recorded compatibility findings.\nShared notes: docs/compatibility.md" } };
const request = (operation: string, input: JsonValue): Promise<JsonValue> => {
  if (operation === "overview") return Promise.resolve({ tasks: [
    { ...task, latestExecution: execution },
    { ...task, id: "backup", name: "Check the nightly backup", latestExecution: { ...execution, status: "errored", sessionId: "backup-conversation", latestReport: { summary: "The backup could not be verified. The storage service needs your attention before tonight’s run." } } },
    { ...task, id: "pending", name: "Weekly dependency review", latestExecution: { ...execution, status: "dispatched", latestReport: null } },
    { ...task, id: "paused", name: "One-off investigation", schedule: { kind: "once", at: "2026-10-03T08:00:00Z" }, paused: true, nextDue: null, latestExecution: null },
    { ...task, id: "archived", name: "Archived compatibility check", archived: true, latestExecution: null },
  ] });
  if (operation === "history") return Promise.resolve({ executions: [{ ...execution, id: JSON.stringify(input), latestReport: { summary: execution.latestReport.summary + "\n" + "Detailed findings are available in the conversation. ".repeat(35) } }], nextOffset: null });
  if (operation === "inspect") return Promise.resolve({ ...task, prompt: "Review new issues.\n" + "LongReference".repeat(60) });
  if (operation === "execution") return Promise.resolve({ ...execution, task: { ...task, prompt: "Review the issues saved for this run.\nRecord the findings." } });
  throw new Error(`Dashboard attempted non-read operation ${operation}`);
};
const context: ApplicationPanelContextV5 = {
  machine: { id: "local", name: "Local", kind: "local" }, state: {},
  catalog: { version: 1, machineId: "local", projects: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("unused")) }, workspaces: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("unused")) }, sessions: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("unused")) } },
  backend: { machineId: "local", forScope: () => ({ request }) },
  navigate: (destination) => { document.body.dataset["destination"] = JSON.stringify(destination); return Promise.resolve(); },
  host: { requestRender: () => undefined }, prompt: { insertText: () => undefined, getText: () => "draft", getSelection: () => null },
};
const style = document.createElement("style");
style.textContent = `body { margin:0; background:var(--pi-bg); color:var(--pi-text); font-family:system-ui; }
#fixture { display:flex; width:min(100%, 420px); height:calc(100dvh - 48px); border-inline-end:1px solid var(--pi-border); }
#language { margin:8px; }`;
document.head.append(style);
const language = document.createElement("button"); language.id = "language"; language.textContent = "RTL";
language.onclick = () => { void service.setPreferences({ language: "ar-XB", formatLocale: "ar-EG" }); };
const container = document.createElement("main"); container.id = "fixture";
document.body.append(language, container);
const panel = activation.contributions.applicationPanels[0];
if (!panel) throw new Error("Missing panel");
render(panel.render(context), container);
window.addEventListener("pagehide", () => { lifetime.abort(); }, { once: true });
