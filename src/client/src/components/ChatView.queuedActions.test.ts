// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { writeClipboardText } from "../clipboard";
import { queuedMessageRecallConfirmation } from "../queuedMessageActions";
import type { QueuedSessionMessage } from "../api";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(true) }));
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.clearAllMocks(); });

const messages = [{ kind: "steer" as const, text: "adjust" }, { kind: "steer" as const, text: "again" }, { kind: "followUp" as const, text: "next" }];

async function queuedView(queuedMessages: QueuedSessionMessage[] = messages) {
  const view = new ChatView();
  view.sessionId = "session";
  view.machineId = "remote";
  view.status = { sessionId: "session", isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: queuedMessages.length, queuedMessages, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  view.onQueuedMessageAction = vi.fn().mockResolvedValue(undefined);
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function setQueueCompatibility(view: ChatView, reason: string | undefined): void {
  if (view.status === undefined) throw new Error("Missing session status");
  const status = { ...view.status };
  if (reason === undefined) delete status.queueMessageActionsUnavailable;
  else status.queueMessageActionsUnavailable = reason;
  view.status = status;
}

function button(view: ChatView, selector: string): HTMLButtonElement {
  const button = view.shadowRoot?.querySelector<HTMLButtonElement>(selector);
  if (button === undefined || button === null) throw new Error(`Missing ${selector}`);
  return button;
}

describe("queued message actions", () => {
  it("shows attachment indicators and counts, including attachment-only messages", async () => {
    const view = await queuedView([
      { kind: "steer", text: "picture", hasAttachments: true, attachmentCount: 1 },
      { kind: "followUp", text: "", hasAttachments: true, attachmentCount: 3 },
      { kind: "followUp", text: "legacy", hasAttachments: true },
      { kind: "followUp", text: "plain", attachmentCount: 0 },
    ]);
    const badges = Array.from(view.shadowRoot?.querySelectorAll(".queued-attachments") ?? []);
    expect(badges).toHaveLength(3);
    expect(badges.map((badge) => badge.textContent.trim())).toEqual(["📎 1 attachment", "📎 3 attachments", "📎 Attachments"]);
    expect(view.shadowRoot?.querySelector("img")).toBeNull();
  });

  it("shows attachment metadata for messages waiting for session creation", async () => {
    const view = await queuedView();
    view.clientQueuedMessages = [{ kind: "followUp", text: "pending", hasAttachments: true, attachmentCount: 2 }];
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".queued-attachments")?.textContent).toContain("2 attachments");
  });
  it("renders named icon-only queue controls, including both switch destinations", async () => {
    const view = await queuedView();
    view.onClearServerQueue = vi.fn();
    await view.updateComplete;
    for (const label of ["Clear queue", "Copy queued message", "Switch to Queue", "Switch to Steer", "Recall queued message", "Remove queued message"]) {
      const control = button(view, `[aria-label="${label}"]`);
      expect(control.title).not.toBe("");
      expect(control.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(control.textContent.trim()).toBe(label === "Copy queued message" ? "⧉" : "");
    }
    button(view, '[aria-label="Switch to Steer"]').click();
    expect(view.onQueuedMessageAction).toHaveBeenCalledWith({ machineId: "remote", sessionId: "session", action: "toggle", index: 2, expectedQueue: messages });
  });

  it("copies text without mutating the queue or adding success feedback", async () => {
    const view = await queuedView();
    button(view, '[aria-label="Copy queued message"]').click();
    await Promise.resolve();
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).not.toContain("Copied");
    expect(view.shadowRoot?.querySelector('[role="status"]')).toBeNull();
    expect(writeClipboardText).toHaveBeenCalledWith("adjust");
    expect(view.onQueuedMessageAction).not.toHaveBeenCalled();
  });

  it("reports copy failure and clears the error after a successful retry", async () => {
    vi.mocked(writeClipboardText).mockResolvedValueOnce(false);
    const view = await queuedView();
    button(view, '[aria-label="Copy queued message"]').click();
    await vi.waitFor(() => { expect(view.shadowRoot?.textContent).toContain("Could not copy message"); });
    button(view, '[aria-label="Copy queued message"]').click();
    await vi.waitFor(() => { expect(view.shadowRoot?.querySelector('[role="status"]')).toBeNull(); });
    expect(view.shadowRoot?.textContent).not.toContain("Copied");
  });

  it("does not show copy feedback in a different session", async () => {
    let finishCopy: ((copied: boolean) => void) | undefined;
    vi.mocked(writeClipboardText).mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishCopy = resolve; }));
    const view = await queuedView();
    button(view, '[aria-label="Copy queued message"]').click();
    view.sessionId = "another-session";
    await view.updateComplete;
    finishCopy?.(false);
    await Promise.resolve();
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).not.toContain("Could not copy message");
  });

  it.each([['[aria-label="Switch to Queue"]', "toggle"], ['[title^="Recall this message"]', "edit"], ['[aria-label="Remove queued message"]', "remove"]])("wires %s to its queue snapshot", async (selector, action) => {
    const view = await queuedView();
    button(view, selector).click();
    expect(view.onQueuedMessageAction).toHaveBeenCalledWith({ machineId: "remote", sessionId: "session", action, index: 0, expectedQueue: messages });
  });

  it.each(["SDK queue layout is incompatible", ""])("disables only SDK-dependent controls when compatibility is unavailable (%s)", async (reason) => {
    const view = await queuedView();
    setQueueCompatibility(view, reason);
    view.clientQueuedMessages = [{ kind: "followUp", text: "local pending" }];
    view.onClearServerQueue = vi.fn();
    await view.updateComplete;
    const serverQueue = view.shadowRoot?.querySelectorAll(".queued-messages")[1];
    const visibleReason = reason || "Individual queue controls are unavailable with this runtime.";
    expect(serverQueue?.textContent).toContain(visibleReason);
    expect(view.shadowRoot?.querySelector(".queued-messages")?.textContent).not.toContain(visibleReason);
    const dependentControls = Array.from(serverQueue?.querySelectorAll<HTMLButtonElement>(".queued-action") ?? []).filter((control) => control.getAttribute("aria-label") !== "Copy queued message");
    expect(dependentControls).toHaveLength(messages.length * 3);
    for (const control of dependentControls) {
      expect(control.disabled).toBe(true);
      expect(control.title).toBe(visibleReason);
      control.click();
    }
    expect(view.onQueuedMessageAction).not.toHaveBeenCalled();
    const copy = serverQueue?.querySelector<HTMLButtonElement>('[aria-label="Copy queued message"]');
    expect(copy?.disabled).toBe(false);
    copy?.click();
    expect(writeClipboardText).toHaveBeenCalledWith("adjust");
    const clear = button(view, ".queued-clear-button");
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(view.onClearServerQueue).toHaveBeenCalledOnce();

    setQueueCompatibility(view, undefined);
    await view.updateComplete;
    const remove = button(view, '[aria-label="Remove queued message"]');
    expect(remove.disabled).toBe(false);
    remove.click();
    expect(view.onQueuedMessageAction).toHaveBeenCalledOnce();
  });

  it("blocks stale control events before an incompatible status has rendered", async () => {
    const view = await queuedView();
    const remove = button(view, '[aria-label="Remove queued message"]');
    setQueueCompatibility(view, "Incompatible SDK");
    remove.click();
    expect(view.onQueuedMessageAction).not.toHaveBeenCalled();
    await view.updateComplete;
  });

  it("disables mutations while another action is pending", async () => {
    const view = await queuedView();
    view.queuedMessageActionPending = true;
    await view.updateComplete;
    const remove = button(view, '[aria-label="Remove queued message"]');
    expect(remove.disabled).toBe(true);
    remove.click();
    expect(view.onQueuedMessageAction).not.toHaveBeenCalled();
    expect(button(view, '[aria-label="Copy queued message"]').disabled).toBe(false);
  });

  it("confirms clearing later messages without an attachment warning for text-only recall", () => {
    expect(queuedMessageRecallConfirmation(messages, 0)).toBe("Recall this message?\n\nThis will also remove 1 later steer and 1 queued follow-up.");
    expect(queuedMessageRecallConfirmation(messages, 1)).toBe("Recall this message?\n\nThis will also remove 1 queued follow-up.");
    expect(queuedMessageRecallConfirmation(messages, 2)).toBeUndefined();
  });

  it("warns about attachment loss only on the recalled message", () => {
    const attached = messages.map((message, index) => ({ ...message, hasAttachments: index === 2 }));
    expect(queuedMessageRecallConfirmation(attached, 0)).not.toContain("attachments");
    expect(queuedMessageRecallConfirmation(attached, 2)).toBe("Recall this message? Only its text will return to the composer. Its attachments will be lost.");
    expect(queuedMessageRecallConfirmation([{ kind: "steer", text: "attached", hasAttachments: true }, { kind: "followUp", text: "later" }], 0)).toBe("Recall this message? Only its text will return to the composer. Its attachments will be lost.\n\nThis will also remove 1 queued follow-up.");
  });
});
