// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingExtensionDialog } from "../api";
import type { ClosedExtensionDialog } from "../appState";
import { ChatView } from "./ChatView";
import { controlledChatViewport, manualChatFrames } from "./chatScroll.testSupport";
import { ExtensionDialogCard } from "./ExtensionDialogCard";

afterEach(() => {
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("ChatView open extension dialogs", () => {
  it("renders the oldest pending dialog at the transcript foot without a synthetic scroll anchor", async () => {
    const view = await mountView();
    const oldest = openDialog("dlg-1", "Allow file writes?");
    view.pendingDialogs = [oldest, openDialog("dlg-2", "Pick a region", { kind: "select", options: ["eu", "us"] })];
    await view.updateComplete;

    const card = requiredElement(view.shadowRoot?.querySelector<ExtensionDialogCard>(".chat > extension-dialog-card.open-dialog-card"), "open dialog card");
    expect(card).toBeInstanceOf(ExtensionDialogCard);
    expect(card.hasAttribute("data-scroll-anchor-id")).toBe(false);
    expect(card.dialog).toBe(oldest);
    expect(view.shadowRoot?.querySelector(".queued-dialogs")?.textContent).toContain("1 more extension dialog queued");
  });

  it("renders no queued affordance for a single pending dialog", async () => {
    const view = await mountView();
    view.pendingDialogs = [openDialog("dlg-1", "Allow file writes?")];
    await view.updateComplete;

    expect(view.shadowRoot?.querySelector(".chat > extension-dialog-card.open-dialog-card")).not.toBeNull();
    expect(view.shadowRoot?.querySelector(".queued-dialogs")).toBeNull();
  });

  it("scrolls a newly opened dialog to its start", async () => {
    const flush = manualChatFrames();
    const view = await mountView();
    const { metrics, write } = controlledChatViewport(view);
    flush(); write.mockClear(); metrics.height = 2600;

    view.pendingDialogs = [openDialog("dlg-1", "Allow file writes?")];
    await view.updateComplete;

    const form = requiredElement(view.shadowRoot?.querySelector(".chat > extension-dialog-card.open-dialog-card"), "open dialog");
    vi.spyOn(form, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 400, 600, 800));
    flush();
    expect(write).toHaveBeenCalledExactlyOnceWith(2000);
  });

  it("targets a newly opened dialog rather than an existing ask form", async () => {
    const flush = manualChatFrames();
    const view = await mountView();
    const { metrics, write } = controlledChatViewport(view);
    flush();
    view.onSubmitAsk = vi.fn();
    view.messages = [{ role: "tool", parts: [{ type: "askUserQuestion", ask: { askId: "ask", askedAt: "2026-07-20T10:00:00.000Z", questions: [{ id: "q", question: "Question?", options: [], multiple: false }] } }] }];
    await view.updateComplete; flush();
    view.renderRoot.querySelector<HTMLButtonElement>('[aria-label="Jump to end"]')?.click();
    write.mockClear(); metrics.height = 3200;
    view.pendingDialogs = [openDialog("new-dialog", "Confirm?")];
    await view.updateComplete;
    const ask = requiredElement(view.renderRoot.querySelector(".chat ask-user-card.open-question-card"), "existing ask");
    const dialog = requiredElement(view.renderRoot.querySelector(".open-dialog-card"), "new dialog");
    vi.spyOn(ask, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 330, 600, 100));
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 700, 600, 600));
    flush();
    expect(write).toHaveBeenCalledExactlyOnceWith(2300);
  });

  it("forwards the answer and cancel callbacks to the open dialog card", async () => {
    const view = await mountView();
    const onAnswerDialog = vi.fn();
    const onCancelDialog = vi.fn();
    view.onAnswerDialog = onAnswerDialog;
    view.onCancelDialog = onCancelDialog;
    view.pendingDialogs = [openDialog("dlg-1", "Allow file writes?")];
    await view.updateComplete;

    const card = requiredElement(view.shadowRoot?.querySelector<ExtensionDialogCard>("extension-dialog-card.open-dialog-card"), "open dialog card");
    void card.onAnswer?.("dlg-1", true);
    void card.onCancel?.("dlg-1");

    expect(onAnswerDialog).toHaveBeenCalledWith("dlg-1", true);
    expect(onCancelDialog).toHaveBeenCalledWith("dlg-1");
  });
});

describe("ChatView closed extension dialogs", () => {
  it("renders closed dialogs transiently above the open one and forwards the dismiss callback", async () => {
    const view = await mountView();
    const onDismissClosedDialog = vi.fn();
    view.onDismissClosedDialog = onDismissClosedDialog;
    const closed = closedDialog("dlg-0", "Allow reads?", "answered", true);
    view.closedDialogs = [closed];
    view.pendingDialogs = [openDialog("dlg-1", "Allow file writes?")];
    await view.updateComplete;

    const cards = [...(view.shadowRoot?.querySelectorAll<ExtensionDialogCard>(".chat > extension-dialog-card") ?? [])];
    expect(cards).toHaveLength(2);
    const closedCard = requiredElement(cards[0], "closed dialog card");
    expect(closedCard.classList.contains("closed-dialog-card")).toBe(true);
    expect(closedCard.hasAttribute("data-scroll-anchor-id")).toBe(false);
    expect(closedCard.outcome).toBe(closed);
    expect(cards[1]?.classList.contains("open-dialog-card")).toBe(true);

    closedCard.onDismiss?.("dlg-0");
    expect(onDismissClosedDialog).toHaveBeenCalledWith("dlg-0");
  });
});

async function mountView(): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-1";
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

function openDialog(dialogId: string, title: string, overrides: Partial<PendingExtensionDialog> = {}): PendingExtensionDialog {
  return {
    dialogId,
    kind: "confirm",
    title,
    askedAt: "2026-07-27T10:00:00.000Z",
    runScoped: false,
    ...overrides,
  };
}

function closedDialog(
  dialogId: string,
  title: string,
  reason: ClosedExtensionDialog["reason"],
  answer?: ClosedExtensionDialog["answer"],
): ClosedExtensionDialog {
  return {
    dialog: openDialog(dialogId, title),
    reason,
    ...(answer === undefined ? {} : { answer }),
  };
}
