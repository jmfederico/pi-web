import { ChatView } from "../../src/client/src/components/ChatView";

const host = document.createElement("main");
host.style.cssText = "position: fixed; inset: 0; overflow: hidden";
const root = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = `
  :host { --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-accent: #aaf; --pi-surface-hover: #333; --pi-success: #4c8; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  chat-view { height: 100%; max-width: 900px; margin-inline: auto; }
`;
const chat = new ChatView();
chat.sessionId = "extension-dialog-fixture";
chat.messages = [{ role: "assistant", parts: [{ type: "text", text: "The extension has received your answer." }] }];
chat.onDismissClosedDialog = (id) => { chat.closedDialogs = chat.closedDialogs.filter((closed) => closed.dialog.dialogId !== id); };
chat.closedDialogs = [{
  dialog: {
    dialogId: "settled-input", kind: "input", title: "Which branch should receive these changes?",
    askedAt: "2026-07-27T10:00:00Z", runScoped: false,
  },
  reason: "answered", answer: "feature/automatic-dialog-dismissal",
}];
root.append(style, chat);
document.body.append(host);
