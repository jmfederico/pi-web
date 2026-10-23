import { html, render } from "lit";
import { api, type Machine } from "../../src/client/src/api";
import { ConversationLayout } from "../../src/client/src/components/ConversationLayout";
import { ChatView } from "../../src/client/src/components/ChatView";
import { PromptEditor } from "../../src/client/src/components/PromptEditor";
import { MachineSwitcher } from "../../src/client/src/components/MachineSwitcher";
import { ModalSurface } from "../../src/client/src/components/ModalSurface";
import { MessageActionsMenu } from "../../src/client/src/components/chat/MessageActionsMenu";

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
const root = document.createElement("main");
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
`, root);
await Promise.all([layout.updateComplete, editor.updateComplete, clippedSwitcher.updateComplete, messageActions.updateComplete]);

declare global {
  interface Window {
    overlayFixture: { complete: () => Promise<void>; openModal: () => void; openPluginModal: () => void; hideConversation: () => void };
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
  openModal,
  openPluginModal,
  hideConversation: () => { layout.hidden = true; },
};
document.body.dataset["ready"] = "true";
