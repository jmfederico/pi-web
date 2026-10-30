import { html, render } from "lit";
import { api, type Machine, type SessionStatus } from "../../src/client/src/api";
import { ConversationLayout } from "../../src/client/src/components/ConversationLayout";
import { ChatView } from "../../src/client/src/components/ChatView";
import { ContentRendererHost } from "../../src/client/src/components/ContentRendererHost";
import { PromptEditor } from "../../src/client/src/components/PromptEditor";
import { MachineSwitcher } from "../../src/client/src/components/MachineSwitcher";
import { ModalSurface } from "../../src/client/src/components/ModalSurface";
import { MessageActionsMenu } from "../../src/client/src/components/chat/MessageActionsMenu";
import { StatusBar } from "../../src/client/src/components/StatusBar";
import { SessionNoticesPanel } from "../../src/client/src/components/SessionNoticesPanel";
import { appStyles } from "../../src/client/src/components/shared";
import themeDefinitions from "../../pi-web-plugins/themes/package.json";
import playgroundDefinitions from "../../plugins/playground/package.json";
import { pluginStyles } from "../../src/client/src/plugins/styles";
import { applyPiWebTheme } from "../../src/client/src/theme";
import type { QualifiedThemeContribution } from "../../src/client/src/plugins/types";

api.commands = () => Promise.resolve([{ name: "tree", source: "builtin" }]);
api.files = () => Promise.resolve([{ path: "README.md", kind: "tracked" }]);
api.models = () => Promise.resolve({ models: [{ id: "test-model", name: "Test model", provider: "test" }] });

const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-border: #555; --pi-muted: #aaa; --pi-success-surface: #123d23; --pi-success: #4c8; --pi-overlay: #0008; --pi-accent: #aaf; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px; }
  .conversation { height: 65vh; }
  modal-surface { --modal-surface-width: min(600px, 94vw); --modal-surface-max-height: 85dvh; }
  .modal-content { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
`;
document.head.append(style);

// Browser contracts explicitly opt into the checkout-only experimental plugin.
const fixtureThemes: QualifiedThemeContribution[] = [...themeDefinitions.piWeb.plugins, ...playgroundDefinitions.piWeb.plugins].flatMap((themePlugin) => themePlugin.themes.map((theme) => ({
  ...theme,
  id: `${themePlugin.id}:${theme.id}`,
  pluginId: themePlugin.id,
  localId: theme.id,
  colorScheme: theme.colorScheme === "light" ? "light" : "dark",
  stylesheets: theme.stylesheets.map((sheet) => ({
    ...sheet,
    id: `${themePlugin.id}:${theme.id}:${sheet.id}`,
    url: themePlugin.id === "playground"
      ? new URL(`../../plugins/playground/assets/${sheet.path}`, import.meta.url).href
      : new URL(`../../pi-web-plugins/themes/assets/${sheet.path}`, import.meta.url).href,
  })),
})));
pluginStyles.registerRoot(document);

const machine = (id: string, kind: Machine["kind"]): Machine => ({ id, name: id, kind, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" });
function switcher(): MachineSwitcher {
  const result = new MachineSwitcher();
  const local = machine("local", "local");
  result.machines = [local, machine("Remote", "remote")];
  result.selected = local;
  result.onRemove = () => undefined;
  return result;
}

let modalNumber = 0;
function openModal(): void {
  const modal = new ModalSurface();
  modal.label = `Dialog ${String(++modalNumber)}`;
  modal.initialFocus = "input";
  modal.onClose = () => { modal.remove(); };
  render(html`<div class="modal-content">
    <label>Dialog input <input aria-label="Dialog input"></label>
    ${switcher()}
    <button @click=${openModal}>Open nested dialog</button>
    <button @click=${() => { modal.busy = !modal.busy; }}>Toggle busy</button>
    <button @click=${() => { modal.remove(); }}>Close dialog</button>
  </div>`, modal);
  document.body.append(modal);
}
function openPluginModal(): void {
  const dialog = document.createElement("dialog");
  render(html`<label>Plugin input <input aria-label="Plugin input"></label>${switcher()}<button @click=${() => { dialog.close(); dialog.remove(); }}>Close plugin dialog</button>`, dialog);
  document.body.append(dialog);
  dialog.showModal();
}
const layout = new ConversationLayout();
layout.className = "conversation";
layout.sending = true;
const chat = new ChatView();
chat.messages = [{ role: "user", parts: [{ type: "text", text: "Chat messages behind suggestions" }] }];
layout.append(chat);
const editor = new PromptEditor();
editor.slot = "composer";
editor.sessionId = "browser-fixture";
editor.projectId = "fixture";
editor.workspaceId = "fixture";
editor.cwd = "/repo";
layout.append(editor);
const clippedSwitcher = switcher();
const messageActions = new MessageActionsMenu();
render(html`<button @click=${() => { messageActions.close(); }}>Copy fixture</button>`, messageActions);
const scrollingHost = document.createElement("div");
const scrollingRoot = scrollingHost.attachShadow({ mode: "open" });
render(html`<style>
  .scroll { height: 85px; overflow: auto; }
  .scroll-content { height: 500px; padding-top: 12px; }
  .clip { display: flex; align-items: center; gap: 10px; position: relative; transform: translateZ(0); overflow: hidden; height: 56px; padding: 8px; border: 1px solid #888; }
  machine-switcher { width: 240px; flex: 0 0 240px; }
</style><div class="scroll"><div class="scroll-content"><div class="clip">${clippedSwitcher}${messageActions}</div></div></div>`, scrollingRoot);
// Completion positioning measures the outermost shadow host as the app layout.
// Match PiWebApp's full-height fixed shell rather than making the editor itself
// the outermost host and accidentally constraining its menu to the input box.
const root = document.createElement("main");
root.style.cssText = "position: fixed; inset: 0; height: 100dvh; overflow: hidden;";
const application = root.attachShadow({ mode: "open" });
application.append(style.cloneNode(true));
document.body.append(root);
render(html`
  <div class="toolbar">
    <button @click=${openModal}>Open dialog</button>
    <button @click=${openPluginModal}>Open plugin dialog</button>
    <button @click=${() => { layout.sending = !layout.sending; }}>Toggle activity</button>
    <button @click=${() => { layout.toggleAttribute("hidden"); }}>Toggle conversation</button>
    <button @click=${() => { editor.sessionId = "another-session"; }}>Switch session</button>
  </div>
  ${layout}
  ${scrollingHost}
`, application);
await Promise.all([layout.updateComplete, editor.updateComplete, clippedSwitcher.updateComplete, messageActions.updateComplete]);

declare global {
  interface Window {
    overlayFixture: { complete: () => Promise<void>; openModal: () => void; openPluginModal: () => void; hideConversation: () => void; mountRenderer: () => Promise<void>; applyTheme: (id: string) => Promise<void>; mountStatistics: (safeArea: number) => Promise<void>; mountNotices: () => Promise<void> };
  }
}
window.overlayFixture = {
  complete: async () => {
    const view = editor.view;
    if (view === undefined) throw new Error("Editor is not mounted");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "/" }, selection: { anchor: 1 } });
    // Completion loading and rendering are asynchronous even with a fake API.
    await Promise.resolve();
    await Promise.resolve();
    await editor.updateComplete;
    await editor.updateComplete;
  },
  applyTheme: async (id) => {
    const theme = fixtureThemes.find((theme) => theme.id === id);
    if (!theme) throw new Error(`Missing fixture theme: ${id}`);
    await pluginStyles.setTheme(theme.stylesheets ?? [], () => { applyPiWebTheme(theme); });
  },
  mountRenderer: async () => {
    const renderer = new ContentRendererHost();
    renderer.id = "theme-renderer";
    renderer.text = "const retries = 3;";
    renderer.choices = [{ id: "highlighted", label: "Highlighted", renderer: {
      id: "highlighted", renderMode: "automatic", render: () => html`<code>Highlighted configuration</code>`,
    } }];
    application.prepend(renderer);
    await renderer.updateComplete;
  },
  mountStatistics: async (safeArea) => {
    const footer = new StatusBar();
    footer.slot = "status";
    layout.append(footer);
    layout.sending = false;
    layout.classList.remove("conversation");
    // Use the production shell's safe-area reservation and flex composition,
    // not a second implementation of its layout arithmetic.
    const shellStyles = document.createElement("style");
    shellStyles.textContent = appStyles.cssText;
    const shell = document.createElement("div");
    shell.className = "shell two-column-layout navigation-panel-collapsed";
    const main = document.createElement("main");
    main.append(layout);
    shell.append(main);
    application.replaceChildren(shellStyles, shell);
    root.style.setProperty("--pi-app-safe-area-bottom", `${String(safeArea)}px`);
    await Promise.all([layout.updateComplete, editor.updateComplete, footer.updateComplete]);
  },
  mountNotices: async () => {
    const panel = new SessionNoticesPanel();
    const status: SessionStatus = {
      sessionId: "notices-fixture", isStreaming: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, queuedMessages: [], cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      warnings: Array.from({ length: 20 }, (_, index) => ({
        severity: "warning" as const, message: `Condition ${String(index)}: ${"long-resource-name/".repeat(20)}`,
        dismiss: { id: `notice-${String(index)}` },
      })),
    };
    panel.status = status;
    const container = document.createElement("section");
    container.id = "notices-boundary";
    container.style.cssText = "height: 160px; overflow: hidden;";
    container.append(panel);
    container.addEventListener("session-notice-dismiss", () => { container.dataset["dismissed"] = "true"; });
    application.prepend(container);
    await panel.updateComplete;
  },
  openModal,
  openPluginModal,
  hideConversation: () => { layout.hidden = true; },
};
document.body.dataset["ready"] = "true";
