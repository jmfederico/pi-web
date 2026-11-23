import { ConversationLayout } from "../../src/client/src/components/ConversationLayout";
import { ChatView } from "../../src/client/src/components/ChatView";
import { PromptEditor } from "../../src/client/src/components/PromptEditor";
import { api, type AskUserSubmission } from "../../src/client/src/api";

api.commands = () => Promise.resolve([]);
api.models = () => Promise.resolve({ models: [] });
const host = document.createElement("main");
host.style.cssText = "position: fixed; inset: 0; height: 100dvh; overflow: hidden";
const root = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = `
  :host { --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-accent: #aaf; --pi-accent-border: #7777bc; --pi-selection-bg: #33334f; --pi-surface-hover: #333; --pi-text-bright: #fff; --pi-warning: #eda; --pi-success: #4c8; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  conversation-layout { height: 100%; max-width: 900px; margin-inline: auto; }
`;
root.append(style);
const layout = new ConversationLayout();
const chat = new ChatView();
chat.sessionId = "question-fixture";
chat.askDraftSessionId = "local:question-fixture";
chat.onQuestionActionsChange = (actions) => { layout.questionActions = actions; };
const editor = new PromptEditor();
editor.sessionId = chat.sessionId;
editor.slot = "composer";
layout.onChatMode = () => { editor.focusInput(); };
let submissions: AskUserSubmission[] = [];
let chats = 0;
chat.onSubmitAsk = (_id, submission) => {
  submissions.push(submission);
  chat.messages = [...chat.messages, { role: "user", parts: [{ type: "text", text: "Answers delivered" }] }];
};
editor.onSend = () => { chats++; return Promise.resolve(true); };
layout.append(chat, editor);
root.append(layout);
document.body.append(host);
await editor.updateComplete;
editor.replaceText("Unsent chat draft");
function openQuestions(): void {
  submissions = [];
  chats = 0;
  chat.messages = [
    { role: "assistant", parts: [{ type: "text", text: "Please answer these questions before we continue." }] },
    { role: "tool", parts: [{ type: "askUserQuestion", ask: {
      askId: "tall-questions", askedAt: "2026-07-20T10:00:00.000Z",
      questions: Array.from({ length: 12 }, (_, index) => ({
        id: `q${String(index)}`, question: `Question ${String(index + 1)}: Which approach would you prefer for this part of the work?`,
        options: index === 0 ? [{ value: "a", label: "Keep the current approach" }] : [],
      })),
    } }] },
  ];
}
window.questionFixture = { openQuestions, result: () => ({ submissions, chats }) };
openQuestions();

declare global {
  interface Window {
    questionFixture: { openQuestions: typeof openQuestions; result: () => { submissions: AskUserSubmission[]; chats: number } };
  }
}
