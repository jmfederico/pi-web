import plugin from "../../pi-packages/private-input/browser/pi-web-plugin";
import darkCss from "../../pi-web-plugins/themes/assets/pi-web-dark.css?raw";
import { ChatView } from "../../src/client/src/components/ChatView";
import { normalizeMessages } from "../../src/client/src/chatMessages";
import { PluginRegistry } from "../../src/client/src/plugins/registry";
import { adaptPublicPlugin } from "../../src/client/src/plugins/publicContext";
import { pluginStyles } from "../../src/client/src/plugins/styles";
import { addThemeStylesheets } from "../../src/client/src/plugins/styleSources";

// Real transcript, renderer registration, and browser backend transport. Tests
// intercept only the network; no daemon, model, filesystem, or real secret is used.
const themeUrl = new URL("private-input-theme.css", document.baseURI).href;
addThemeStylesheets([{ url: themeUrl, cssText: darkCss }]);
const releaseStyles = pluginStyles.registerRoot(document, { sharedUi: true });
await pluginStyles.setTheme([{ id: "private-input:theme", url: themeUrl }], () => undefined);
const registry = new PluginRegistry();
await registry.register({ id: "remote.private-input", sourcePluginId: "private-input", machineId: "origin",
  machineSpecific: true, backendRevision: "fixture-r1", pairedRequestVersion: 1, plugin: adaptPublicPlugin(plugin) });
const css = document.createElement("style");
css.textContent = `
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font: 14px var(--pi-font); }
  main { height: 100dvh; display: flex; flex-direction: column; max-width: 760px; margin: auto; }
  header { padding: 12px; border-bottom: 1px solid var(--pi-border); }
  chat-view { flex: 1; min-height: 0; min-width: 0; }
`;
document.head.append(css);
const record = {
  requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionId: "conversation",
  destination: `/outside/workspace/${"long-directory-".repeat(12)}/token`,
  purpose: "Configure private access for the example service.", status: "waiting",
};
const chat = new ChatView();
chat.sessionId = record.sessionId;
chat.machineId = "origin";
chat.workspaceContext = { machineId: "origin", projectId: "project", workspaceId: "workspace", root: "/workspace" };
chat.behaviors = { ...chat.behaviors, followTail: false, rememberPosition: false };
chat.transcriptRenderers = registry.getTranscriptRenderers("origin");
chat.messages = normalizeMessages([
  { role: "user", entryId: "user", content: "Request private input for a new token file. Do not read the saved file." },
  { role: "assistant", entryId: "call", content: [{ type: "toolCall", id: "capture", name: "request_private_input", arguments: { destination: record.destination, purpose: record.purpose } }] },
  { role: "toolResult", entryId: "result", toolName: "request_private_input", toolCallId: "capture", isError: false,
    content: "Waiting for private input. No value is included in this request.", details: { interventionRequired: true, privateInput: record } },
]);
const main = document.createElement("main");
const header = document.createElement("header");
header.textContent = "Private input · synthetic browser fixture";
main.append(header, chat); document.body.append(main);
await chat.updateComplete;
window.addEventListener("pagehide", () => { void registry.dispose(); releaseStyles(); }, { once: true });
document.body.dataset["ready"] = "true";
