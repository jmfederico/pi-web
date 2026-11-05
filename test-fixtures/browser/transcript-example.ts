import example from "../../examples/transcript-renderer-plugin/src/index";
import darkCss from "../../pi-web-plugins/themes/assets/pi-web-dark.css?raw";
import lightCss from "../../pi-web-plugins/themes/assets/pi-web-light.css?raw";
import { ChatView } from "../../src/client/src/components/ChatView";
import { normalizeMessages } from "../../src/client/src/chatMessages";
import { PluginRegistry } from "../../src/client/src/plugins/registry";
import { adaptPublicPlugin } from "../../src/client/src/plugins/publicContext";
import { pluginStyles } from "../../src/client/src/plugins/styles";
import { addThemeStylesheets } from "../../src/client/src/plugins/styleSources";

// Isolated real transcript + real example plugin. All conversation data is synthetic.
const releaseDocument = pluginStyles.registerRoot(document, { sharedUi: true });
const themes = [darkCss, lightCss].map((cssText, index) => {
  const url = new URL(`example-theme-${String(index)}.css`, document.baseURI).href;
  addThemeStylesheets([{ url, cssText }]);
  return { id: `example:theme-${String(index)}`, url };
});
const registry = new PluginRegistry();
await registry.register({ id: "example-transcript", plugin: adaptPublicPlugin(example) });
await pluginStyles.setContributions(registry.getStylesheets("local"));

const css = document.createElement("style");
css.textContent = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: var(--pi-bg); color: var(--pi-text); font: 14px var(--pi-font); }
  .example-shell { display: flex; flex-direction: column; max-width: 920px; height: calc(100dvh - 64px); margin: 0 auto;
    border: 1px solid var(--pi-border); background: var(--pi-bg); }
  .example-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
    padding: 16px 20px; border-bottom: 1px solid var(--pi-border); }
  .example-header h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  .example-header p, .example-footer { margin: 0; color: var(--pi-muted); font-size: 12px; }
  .example-theme { display: flex; gap: 4px; }
  chat-view { flex: 1; min-height: 0; min-width: 0; }
  .example-footer { padding: 10px 20px; border-top: 1px solid var(--pi-border); }
  @media (max-width: 600px) { body { padding: 0; } .example-shell { height: 100dvh; border: 0; } .example-header { padding: 12px; } }
`;
document.head.append(css);
const main = document.createElement("main");
main.className = "example-shell";
const header = document.createElement("header");
header.className = "example-header";
const heading = document.createElement("div");
const title = document.createElement("h1");
title.textContent = "Transcript renderer example";
const subtitle = document.createElement("p");
subtitle.textContent = "Isolated test environment · synthetic conversation";
heading.append(title, subtitle);
const choices = document.createElement("div");
choices.className = "example-theme";
const themeButtons = ["Dark", "Light"].map((name, index) => {
  const button = document.createElement("button");
  button.className = "ui-button ui-button--compact ui-choice";
  button.textContent = name;
  button.addEventListener("click", () => { void selectTheme(index); });
  choices.append(button);
  return button;
});
async function selectTheme(index: number): Promise<void> {
  const theme = themes[index];
  if (theme === undefined) throw new Error("Unknown example theme");
  await pluginStyles.setTheme([theme], () => {
    document.documentElement.style.colorScheme = index === 0 ? "dark" : "light";
    document.body.dataset["theme"] = index === 0 ? "dark" : "light";
    themeButtons.forEach((button, buttonIndex) => {
      button.setAttribute("aria-pressed", String(buttonIndex === index));
      button.dataset["selected"] = String(buttonIndex === index);
    });
  });
}
header.append(heading, choices);
const chat = new ChatView();
chat.sessionId = "synthetic-renderer-example";
chat.machineId = "local";
chat.behaviors = { ...chat.behaviors, followTail: false, rememberPosition: false };
chat.transcriptRenderers = registry.getTranscriptRenderers("local");
chat.messages = normalizeMessages([
  { role: "user", entryId: "request", content: "Run the workspace checks and summarize the result." },
  { role: "assistant", entryId: "call", content: [{ type: "toolCall", id: "checks", name: "example_checks", arguments: { command: "npm run check" } }] },
  { role: "toolResult", entryId: "result", toolName: "example_checks", toolCallId: "checks", isError: true,
    content: "3 passed, 1 failed (2.4 s).\nAPI contract: Expected status 200; received 503.",
    details: { durationMs: 2400, checks: [
      { name: "Type checking", status: "passed", durationMs: 830 },
      { name: "Lint", status: "passed", durationMs: 410 },
      { name: "API contract", status: "failed", durationMs: 970 },
      { name: "Package boundaries", status: "passed", durationMs: 190 },
    ] } },
  { role: "custom", entryId: "notice", display: true, customType: "example.task-notice",
    content: "Preview build completed. The preview is ready for review; nothing was deployed.",
    details: { title: "Preview build complete", status: "completed", summary: "The preview is ready for review. Nothing was deployed." } },
  { role: "assistant", entryId: "summary", content: "Three checks passed. The API contract check needs attention: it received a 503 response instead of 200." },
]);
const footer = document.createElement("footer");
footer.className = "example-footer";
footer.textContent = "Presentation only · no tools executed · existing PI WEB palettes";
main.append(header, chat, footer);
document.body.append(main);
await selectTheme(0);
await chat.updateComplete;
for (const details of chat.shadowRoot?.querySelectorAll<HTMLDetailsElement>(".event-group") ?? []) {
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
}
await chat.updateComplete;
window.addEventListener("pagehide", () => { releaseDocument(); void registry.dispose(); pluginStyles.clear(); }, { once: true });
document.body.dataset["ready"] = "true";
