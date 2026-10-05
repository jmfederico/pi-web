// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import { PromptEditor } from "./PromptEditor";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

const status: SessionStatus = {
  sessionId: "activity-test", model: { id: "model", provider: "provider" }, thinkingLevel: "high",
  isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
  queuedMessages: [], cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function mount() {
  const editor = new PromptEditor();
  editor.sessionId = status.sessionId;
  editor.status = { ...status };
  editor.workingMessage = "Consulting the rubber duck";
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

it("places model, thinking and live activity above the editor without replacing its document", async () => {
  const editor = await mount();
  const header = editor.shadowRoot?.querySelector(".composer-header");
  const input = editor.shadowRoot?.querySelector(".editor-wrap");
  expect(header?.querySelector(".select-model")?.textContent).toContain("provider/model");
  expect(header?.querySelector(".select-thinking")?.textContent).toContain("high");
  expect(header?.querySelector('[role="status"]')?.textContent).toContain("Consulting the rubber duck");
  if (!header || !input) throw new Error("Missing composer header or input");
  expect(header.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(editor.shadowRoot?.querySelector(".actions .compact-status")).toBeNull();
  editor.replaceText("keep this draft");
  const view = editor.view;
  editor.workingMessage = "Untangling the spaghetti";
  await editor.updateComplete;
  expect(header.textContent).toContain("Untangling the spaghetti");
  expect(editor.view).toBe(view);
  expect(view?.state.doc.toString()).toBe("keep this draft");
});

it("clears idle phrases, falls back without an extension and retains operational state precedence", async () => {
  const editor = await mount();
  const text = () => editor.shadowRoot?.querySelector('[role="status"]')?.textContent;
  editor.status = { ...status, isStreaming: false };
  await editor.updateComplete;
  expect(text()).not.toContain("Consulting");
  editor.status = { ...status };
  editor.workingMessage = undefined;
  await editor.updateComplete;
  expect(text()).toContain("Working");
  editor.workingMessage = "Consulting the rubber duck";
  editor.activity = { sessionId: status.sessionId, phase: "active", label: "running tool", detail: "bash", at: "now" };
  await editor.updateComplete;
  expect(text()).toContain("running tool: bash");
  expect(text()).not.toContain("Consulting");
  editor.activity = { ...editor.activity, phase: "error", label: "tool failed" };
  await editor.updateComplete;
  expect(text()).toContain("tool failed: bash");
  expect(editor.shadowRoot?.querySelector(".composer-activity.error")).not.toBeNull();
  editor.activity = undefined;
  editor.status = { ...status, isCompacting: true };
  await editor.updateComplete;
  expect(text()).toContain("Compacting history");
  editor.status = { ...status, isBashRunning: true };
  await editor.updateComplete;
  expect(text()).toContain("Running shell command");
  editor.status = { ...status, isStreaming: false, pendingMessageCount: 1 };
  await editor.updateComplete;
  expect(text()).toContain("Message queued");
  editor.sending = true;
  await editor.updateComplete;
  expect(text()).toContain("Sending your message");
});
