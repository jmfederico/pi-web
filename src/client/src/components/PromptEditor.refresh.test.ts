// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptEditor } from "./PromptEditor";
import { StatusBar } from "./StatusBar";
import type { SessionStatus } from "../api";
import { clearStagedAttachments, saveStagedAttachments, type PendingAttachment } from "../promptAttachmentStaging";
import { loadAttachmentDelivery } from "../attachmentPreferences";

const image: PendingAttachment = { id: "image", kind: "image", name: "shot.png", mimeType: "image/png", data: "UE5H", size: 3 };
const file: PendingAttachment = { id: "file", kind: "file", name: "report.pdf", mimeType: "application/pdf", data: "UkVQT1JU", size: 6 };
const idle: SessionStatus = {
  sessionId: "refresh", isStreaming: false, isCompacting: false, isBashRunning: false,
  pendingMessageCount: 0, queuedMessages: [], cost: 0,
  model: { id: "model", provider: "provider" }, thinkingLevel: "high",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  clearStagedAttachments("local:refresh");
  vi.restoreAllMocks();
});

async function mount(attachments: PendingAttachment[] = []) {
  saveStagedAttachments("local:refresh", attachments);
  const editor = new PromptEditor();
  editor.sessionId = "refresh";
  editor.status = idle;
  editor.attachmentsFolder = "docs/inbox";
  editor.onSend = vi.fn();
  editor.onStop = vi.fn();
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Typed DOM selector, like querySelector<T>.
function control<T extends Element>(editor: PromptEditor, selector: string): T {
  const element = editor.shadowRoot?.querySelector<T>(selector);
  if (element === undefined || element === null) throw new Error(`Missing ${selector}`);
  return element;
}

describe("production composer refresh", () => {
  it("labels distinct totals, context and estimated cost outside the composer", async () => {
    const bar = new StatusBar();
    bar.status = { ...idle, tokens: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, total: 1500 }, cost: 0.123, contextUsage: { tokens: 1500, contextWindow: 10000, percent: 15 }, pendingMessageCount: 2 };
    bar.warningCount = 2;
    bar.onToggleWarnings = vi.fn();
    document.body.append(bar);
    await bar.updateComplete;
    expect(bar.shadowRoot?.textContent).toContain("In 1.2k");
    expect(bar.shadowRoot?.textContent).toContain("Out 300");
    expect(bar.shadowRoot?.textContent).toContain("Context 15.0%/10k");
    expect(bar.shadowRoot?.textContent).toContain("Est. cost");
    expect(bar.shadowRoot?.textContent).toContain("2 queued");
    bar.shadowRoot?.querySelector<HTMLButtonElement>(".warning-toggle")?.click();
    expect(bar.onToggleWarnings).toHaveBeenCalledOnce();
    bar.status = { ...idle, contextUsage: { tokens: null, contextWindow: 10000, percent: null } };
    await bar.updateComplete;
    expect(bar.shadowRoot?.textContent).toContain("Context 10k");
    bar.status = idle;
    await bar.updateComplete;
    expect(bar.shadowRoot?.textContent).toContain("Context unknown");
  });

  it("shows the selected reasoning value as text and retains the thinking menu callback", async () => {
    const editor = await mount();
    editor.onSelectThinking = vi.fn();
    const thinking = control<HTMLButtonElement>(editor, ".select-thinking");
    expect(thinking.textContent).toBe("high");
    expect(thinking.querySelector("svg")).toBeNull();
    expect(thinking.getAttribute("aria-label")).toBe("Thinking level: high");
    thinking.click();
    expect(editor.onSelectThinking).toHaveBeenCalledOnce();
    editor.status = { ...idle, thinkingLevel: "medium" };
    await editor.updateComplete;
    expect(thinking.textContent).toBe("medium");
    const withoutThinking = { ...idle };
    delete withoutThinking.thinkingLevel;
    editor.status = withoutThinking;
    await editor.updateComplete;
    expect(thinking.textContent).toBe("off");
  });

  it("moves runtime activity to the line without replacing CodeMirror or deriving it from focus", async () => {
    const editor = await mount();
    const content = editor.view?.contentDOM;
    expect(editor.shadowRoot?.querySelector(".composer-activity")).toBeNull();
    editor.focusInput();
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".composer-activity")).toBeNull();
    editor.status = { ...idle, isStreaming: true };
    await editor.updateComplete;
    expect(control(editor, ".composer-activity").textContent).toBe("running");
    editor.activity = { sessionId: "refresh", phase: "active", label: "working", detail: "Reading a file", at: "2026-09-01T00:00:00Z" };
    await editor.updateComplete;
    expect(control(editor, ".composer-activity").textContent).toBe("working: Reading a file");
    expect(editor.view?.contentDOM).toBe(content);
    editor.status = idle;
    editor.activity = { ...editor.activity, phase: "idle", label: "idle" };
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".composer-activity")).toBeNull();
  });

  it("reuses one focused Send/Stop button while preserving Queue, Steer and compaction permissions", async () => {
    const editor = await mount();
    const primary = control<HTMLButtonElement>(editor, ".primary-button");
    const queue = control<HTMLButtonElement>(editor, ".queue-button");
    const steer = control<HTMLButtonElement>(editor, ".steer-button");
    expect(primary.getAttribute("aria-label")).toBe("Send message");
    expect(editor.shadowRoot?.querySelector(".stop-button")).toBeNull();
    expect(queue.disabled).toBe(true);
    expect(steer.disabled).toBe(true);
    expect(queue.getAttribute("aria-label")).toBe("Queue message");
    expect(steer.getAttribute("aria-label")).toBe("Steer current response");
    editor.replaceText("idle send");
    primary.click();
    expect(editor.onSend).toHaveBeenLastCalledWith("idle send", undefined, undefined, undefined, undefined);
    primary.focus();
    editor.canSteer = true;
    editor.canStop = true;
    await editor.updateComplete;
    expect(control(editor, ".primary-button")).toBe(primary);
    expect(editor.shadowRoot?.activeElement).toBe(primary);
    expect(primary.getAttribute("aria-label")).toBe("Stop current work");
    expect(editor.shadowRoot?.querySelector(".send-button")).toBeNull();
    expect(queue.disabled).toBe(false);
    expect(steer.disabled).toBe(false);
    editor.replaceText("keep this draft");
    primary.click();
    expect(editor.onStop).toHaveBeenCalledOnce();
    expect(editor.onSend).toHaveBeenCalledOnce();
    expect(editor.view?.state.doc.toString()).toBe("keep this draft");
    editor.replaceText("follow up");
    queue.click();
    expect(editor.onSend).toHaveBeenLastCalledWith("follow up", "followUp", undefined, undefined, undefined);
    editor.replaceText("steer");
    steer.click();
    expect(editor.onSend).toHaveBeenLastCalledWith("steer", "steer", undefined, undefined, undefined);
    editor.isCompacting = true;
    await editor.updateComplete;
    expect(queue.getAttribute("aria-label")).toBe("Queue message");
    expect(queue.disabled).toBe(false);
    expect(steer.disabled).toBe(true);
    editor.replaceText("after compaction");
    queue.click();
    expect(editor.onSend).toHaveBeenLastCalledWith("after compaction", "followUp", undefined, undefined, undefined);
    editor.sending = true;
    await editor.updateComplete;
    expect(queue.disabled).toBe(true);
    expect(steer.disabled).toBe(true);
    expect(primary.disabled).toBe(false);
    editor.disabled = true;
    await editor.updateComplete;
    expect(primary.disabled).toBe(true);
    expect(queue.disabled).toBe(true);
    expect(steer.disabled).toBe(true);
    expect(control<HTMLButtonElement>(editor, ".editor-attach").disabled).toBe(true);
    expect(editor.view?.contentDOM.contentEditable).toBe("false");
    editor.disabled = false;
    editor.sending = false;
    editor.canSteer = false;
    editor.canStop = false;
    editor.isCompacting = false;
    await editor.updateComplete;
    expect(control(editor, ".primary-button")).toBe(primary);
    expect(primary.getAttribute("aria-label")).toBe("Send message");
    expect(queue.disabled).toBe(true);
    expect(steer.disabled).toBe(true);
  });

  it("keeps Queue and Steer permanently present in fixed positions and disables each exactly when unavailable", async () => {
    const editor = await mount();
    const actionButtons = Array.from(editor.shadowRoot?.querySelectorAll<HTMLButtonElement>(".message-actions button") ?? []);
    const queue = control<HTMLButtonElement>(editor, ".queue-button");
    const steer = control<HTMLButtonElement>(editor, ".steer-button");
    const primary = control<HTMLButtonElement>(editor, ".primary-button");
    expect(actionButtons).toEqual([queue, steer, primary]);

    // 1. Idle state: both Queue and Steer are permanently rendered but disabled; primary is Send.
    expect(editor.shadowRoot?.querySelector(".queue-button")).not.toBeNull();
    expect(editor.shadowRoot?.querySelector(".steer-button")).not.toBeNull();
    expect(queue.disabled).toBe(true);
    expect(steer.disabled).toBe(true);
    expect(primary.getAttribute("aria-label")).toBe("Send message");

    // 2. Active streaming: both Queue and Steer are enabled; primary is Stop.
    editor.canSteer = true;
    editor.canStop = true;
    await editor.updateComplete;
    expect(queue.disabled).toBe(false);
    expect(steer.disabled).toBe(false);
    expect(primary.getAttribute("aria-label")).toBe("Stop current work");

    // 3. Compacting only (canSteer = false): Queue is enabled, Steer is disabled.
    editor.canSteer = false;
    editor.isCompacting = true;
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".steer-button")).not.toBeNull();
    expect(queue.disabled).toBe(false);
    expect(steer.disabled).toBe(true);

    // 4. Compacting while canSteer = true: compaction takes precedence, Steer is disabled, Queue is enabled.
    editor.canSteer = true;
    editor.isCompacting = true;
    await editor.updateComplete;
    expect(queue.disabled).toBe(false);
    expect(steer.disabled).toBe(true);

    // 5. Active streaming but sending: both Queue and Steer are disabled.
    editor.isCompacting = false;
    editor.sending = true;
    await editor.updateComplete;
    expect(queue.disabled).toBe(true);
    expect(steer.disabled).toBe(true);

    // 6. Active streaming but composer disabled: both Queue and Steer are disabled.
    editor.sending = false;
    editor.disabled = true;
    await editor.updateComplete;
    expect(queue.disabled).toBe(true);
    expect(steer.disabled).toBe(true);
  });

  it("renders upstream context chips once and preserves pending-send guards with the shared primary button", async () => {
    const editor = await mount();
    const chips = [{ id: "note", label: "Selected note", text: "Context", pluginId: "source", key: "note", target: { machineId: "local", sessionId: "refresh" } }];
    editor.promptChips = chips;
    let accept: ((accepted: boolean) => void) | undefined;
    const pending = new Promise<boolean>((resolve) => { accept = resolve; });
    editor.onSend = vi.fn(() => pending);
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelectorAll(".prompt-chip")).toHaveLength(1);
    expect(editor.shadowRoot?.querySelectorAll("autocomplete-menu")).toHaveLength(1);
    const primary = control<HTMLButtonElement>(editor, ".primary-button");
    editor.replaceText("with context");
    primary.click();
    primary.click();
    expect(editor.onSend).toHaveBeenCalledExactlyOnceWith("with context", undefined, undefined, undefined, undefined, chips);
    await editor.updateComplete;
    expect(control(editor, ".primary-button")).toBe(primary);
    expect(primary.getAttribute("aria-label")).toBe("Stop current work");
    expect(primary.disabled).toBe(true);
    expect(control<HTMLButtonElement>(editor, ".editor-attach").disabled).toBe(true);
    expect(control(editor, ".composer-activity").textContent).toBe("Sending your message…");
    expect(editor.view?.state.doc.toString()).toBe("with context");
    accept?.(true);
    await pending;
    await editor.updateComplete;
    expect(primary.getAttribute("aria-label")).toBe("Send message");
    expect(primary.disabled).toBe(false);
    expect(editor.view?.state.doc.toString()).toBe("");
  });

  it("uses runtime work state without treating startup or an idle error as running work", async () => {
    const editor = await mount();
    const primary = control<HTMLButtonElement>(editor, ".primary-button");
    for (const status of [{ ...idle, isBashRunning: true }, { ...idle, pendingMessageCount: 1 }, { ...idle, isStreaming: true }]) {
      editor.status = status;
      await editor.updateComplete;
      expect(primary.getAttribute("aria-label")).toBe("Stop current work");
      expect(primary.disabled).toBe(true);
      primary.click();
    }
    expect(editor.onStop).not.toHaveBeenCalled();
    editor.status = idle;
    editor.activity = { sessionId: "refresh", phase: "active", label: "working", at: "2026-09-01T00:00:00Z" };
    await editor.updateComplete;
    expect(primary.getAttribute("aria-label")).toBe("Stop current work");
    editor.activity = { ...editor.activity, startup: true };
    await editor.updateComplete;
    expect(primary.getAttribute("aria-label")).toBe("Send message");
    editor.activity = { ...editor.activity, phase: "error", label: "error" };
    await editor.updateComplete;
    expect(primary.getAttribute("aria-label")).toBe("Send message");
    expect(primary.disabled).toBe(false);
    editor.sending = true;
    await editor.updateComplete;
    expect(primary.getAttribute("aria-label")).toBe("Stop current work");
    expect(primary.disabled).toBe(true);
  });

  it("forces mixed attachments to folder, restores image preference and recovers removal focus", async () => {
    const editor = await mount([file, image]);
    const checkbox = control<HTMLInputElement>(editor, ".attachment-delivery input");
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(control(editor, ".attachment-delivery").textContent).toContain("Save to docs/inbox");
    expect(control(editor, "#attachment-delivery-hint").textContent).toContain("Non-image");
    const remove = control<HTMLButtonElement>(editor, '[aria-label="Remove report.pdf"]');
    remove.focus();
    remove.click();
    await editor.updateComplete;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(editor.shadowRoot?.activeElement).toBe(control(editor, '[aria-label="Remove shot.png"]'));
    expect(loadAttachmentDelivery()).toBe("inline");
    editor.replaceText("please review");
    control<HTMLButtonElement>(editor, ".send-button").click();
    expect(editor.onSend).toHaveBeenCalledWith("please review", undefined, [{ kind: "image", name: "shot.png", mimeType: "image/png", data: "UE5H" }], "inline", undefined);
  });

  it("persists a native checkbox preference and submits the displayed configured folder", async () => {
    const editor = await mount([image]);
    const checkbox = control<HTMLInputElement>(editor, ".attachment-delivery input");
    checkbox.click();
    await editor.updateComplete;
    expect(checkbox.checked).toBe(true);
    expect(loadAttachmentDelivery()).toBe("folder");
    control<HTMLButtonElement>(editor, ".send-button").click();
    expect(editor.onSend).toHaveBeenCalledWith("", undefined, expect.any(Array), "folder", "docs/inbox");
  });

  it("returns last attachment removal focus to Attach", async () => {
    const editor = await mount([image]);
    const remove = control<HTMLButtonElement>(editor, ".attachment-remove");
    remove.focus();
    remove.click();
    await editor.updateComplete;
    expect(editor.shadowRoot?.activeElement).toBe(control(editor, ".editor-attach"));
    expect(editor.shadowRoot?.querySelector(".attachments")).toBeNull();
  });

  it("puts help in the empty editor placeholder and keeps the attachment picker accessible", async () => {
    const editor = await mount();
    expect(editor.shadowRoot?.querySelector(".editor-info, .help-tooltip")).toBeNull();
    expect(control(editor, ".cm-placeholder").textContent).toBe("Message pi… / commands · @ tracked files · @ Space all files · # models");
    const picker = control<HTMLInputElement>(editor, ".attachment-input");
    const click = vi.spyOn(picker, "click");
    control<HTMLButtonElement>(editor, ".editor-attach").click();
    expect(click).toHaveBeenCalledOnce();
    editor.replaceText("a message");
    expect(editor.shadowRoot?.querySelector(".cm-placeholder")).toBeNull();
    editor.replaceText("");
    expect(control(editor, ".cm-placeholder").textContent).toContain("Message pi… / commands");
  });
});
