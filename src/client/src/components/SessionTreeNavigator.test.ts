// @vitest-environment happy-dom

import type { TemplateResult } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeForkResult, SessionTreeNavigateResult, SessionTreeNodeKind, SessionTreeSnapshot, SessionTreeSummaryChoice } from "../api";
// The modal-surface shell (focus on open, Escape/backdrop routing) is exercised
// through real DOM interaction; keyboard state and hierarchy stay covered through
// the pure sessionTreeModel, and TemplateResult extraction is limited to pointer
// row/footer wiring in the method-level interaction tests.
import { templateClickHandlerForText, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { deepActiveElement, dialogSurface, pressKey, settleRenderedDialog, surfaceBackdrop } from "./modalSurfaceTestSupport";
import { SessionTreeNavigator, sessionTreeEntryReturnsToEditor, sessionTreeKindPresentation, sessionTreeVisualDepth } from "./SessionTreeNavigator";

type NavigateCallback = (targetId: string, summaryChoice: SessionTreeSummaryChoice) => Promise<SessionTreeNavigateResult>;
type ForkCallback = (entryId: string) => Promise<SessionTreeForkResult>;
type VoidMethod = (this: SessionTreeNavigator) => void;
type PromiseMethod = (this: SessionTreeNavigator) => Promise<void>;
type SummaryModeMethod = (this: SessionTreeNavigator, mode: SessionTreeSummaryChoice["mode"]) => void;

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("session-tree-navigator modal surface", () => {
  it("focuses the selected history row when opened", async () => {
    const navigator = await mountNavigator();

    expect(deepActiveElement()).toBe(treeItem(navigator, "active"));
  });

  it("focuses the close button when opened with an empty tree", async () => {
    const navigator = await mountNavigator({ tree: { nodes: [], activeLeafId: null, activePathIds: [] } });

    expect(deepActiveElement()).toBe(closeButton(navigator));
  });

  it("cancels from the tree step on Escape", async () => {
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onCancel });

    pressKey(dialogSurface(navigator), "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("returns to the tree step from the action step on Escape instead of cancelling", async () => {
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onCancel });
    await advanceToAction(navigator);

    pressKey(dialogSurface(navigator), "Escape");
    await settleRenderedDialog(navigator);

    expect(onCancel).not.toHaveBeenCalled();
    expect(renderedTree(navigator)).not.toBeNull();
  });

  // The surface owns one dismissal route, so a backdrop press steps back from
  // the action step exactly like Escape instead of closing outright.
  it("steps back from the action step on a backdrop press and cancels from the tree step", async () => {
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onCancel });
    await advanceToAction(navigator);

    backdropPress(navigator);
    await settleRenderedDialog(navigator);

    expect(onCancel).not.toHaveBeenCalled();
    expect(renderedTree(navigator)).not.toBeNull();

    backdropPress(navigator);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight summarization on Escape and swallows backdrop presses while busy", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onNavigate, onAbort, onCancel });
    await advanceToAction(navigator);
    summaryRadio(navigator, "default").click();
    await settleRenderedDialog(navigator);
    footerButton(navigator, "Continue from here").click();
    await settleRenderedDialog(navigator);

    backdropPress(navigator);
    pressKey(dialogSurface(navigator), "Escape");

    expect(onCancel).not.toHaveBeenCalled();
    expect(onAbort).toHaveBeenCalledOnce();

    navigation.resolve({ cancelled: true, aborted: true });
    await settleRenderedDialog(navigator);
  });

  it("swallows Escape while a plain navigation is in flight", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onNavigate, onAbort, onCancel });
    await advanceToAction(navigator);
    footerButton(navigator, "Continue from here").click();
    await settleRenderedDialog(navigator);

    pressKey(dialogSurface(navigator), "Escape");

    expect(onAbort).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    navigation.resolve({ cancelled: false });
    await settleRenderedDialog(navigator);
  });

  // A fork in flight gets the same busy contract as a plain navigation: Escape
  // and backdrop presses are swallowed (only summarization can be aborted).
  it("swallows Escape and backdrop presses while a fork is in flight", async () => {
    const fork = deferred<SessionTreeForkResult>();
    const onFork = vi.fn<ForkCallback>(() => fork.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onFork, onAbort, onCancel });
    await advanceToAction(navigator);
    operationRadio(navigator, "fork").click();
    await settleRenderedDialog(navigator);
    footerButton(navigator, "Fork into new session").click();
    await settleRenderedDialog(navigator);

    backdropPress(navigator);
    pressKey(dialogSurface(navigator), "Escape");

    expect(onAbort).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(footerButton(navigator, "Forking…").disabled).toBe(true);

    fork.resolve({ cancelled: true });
    await settleRenderedDialog(navigator);
    expect(navigator.renderRoot.querySelector("h2")?.textContent).toBe("Choose how to continue");
    expect(shadowText(navigator)).toContain("Fork cancelled. No new session was created");
  });
});

describe("session-tree-navigator location step", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("keeps operation selection out of step 1 and offers only Cancel and Next", async () => {
    const navigator = await mountNavigator();

    expect(footerLabels(navigator)).toEqual(["Cancel", "Next"]);
    expect(shadowText(navigator)).toContain("Select the history entry where you would like to continue.");
    expect(navigator.renderRoot.querySelector("input[name='session-tree-operation']")).toBeNull();
    expect(footerButton(navigator, "Next").classList.contains("primary")).toBe(true);
    expect(footerButton(navigator, "Next").disabled).toBe(false);
  });

  it("keeps an empty history inert", async () => {
    const navigator = await mountNavigator({ tree: { nodes: [], activeLeafId: null, activePathIds: [] } });

    expect(shadowText(navigator)).toContain("does not contain any selectable history entries");
    expect(footerLabels(navigator)).toEqual(["Cancel", "Next"]);
    expect(footerButton(navigator, "Next").disabled).toBe(true);
  });

  it("uses the same semantic kind badge treatment in the tree and selected-entry steps", async () => {
    const navigator = await mountNavigator();
    const root = treeItem(navigator, "root");
    root.click();
    await settleRenderedDialog(navigator);

    const treeBadge = kindBadge(root);
    expect(treeBadge.textContent).toBe("User");
    expect(treeBadge.classList.contains("kind-tone-user")).toBe(true);
    expect(root.classList.contains("kind-tone-user")).toBe(false);

    await advanceToAction(navigator);
    const selectedEntry = navigator.renderRoot.querySelector(".selected-entry");
    if (!(selectedEntry instanceof HTMLElement)) throw new Error("Selected entry was unavailable");
    const actionBadge = kindBadge(selectedEntry);
    expect(actionBadge.textContent).toBe("User");
    expect(actionBadge.classList.contains("kind-tone-user")).toBe(true);
    expect(selectedEntry.classList.contains("kind-tone-user")).toBe(false);
  });

  it("ignores f and F but advances with Enter", async () => {
    const navigator = await mountNavigator();
    const selected = treeItem(navigator, "active");

    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "F", bubbles: true }));
    await settleRenderedDialog(navigator);

    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();
    expect(navigator.renderRoot.querySelector("h2")).toBeNull();

    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settleRenderedDialog(navigator);

    expect(navigator.renderRoot.querySelector("h2")?.textContent).toBe("Choose how to continue");
    expect(footerLabels(navigator)).toEqual(["Back", "Continue from here"]);
  });

  it("moves focus across steps and traps Tab in the dialog", async () => {
    const navigator = await mountNavigator();
    const next = footerButton(navigator, "Next");

    expect(navigator.shadowRoot?.activeElement).toBe(treeItem(navigator, "active"));

    next.focus();
    pressKey(dialogSurface(navigator), "Tab");
    expect(navigator.shadowRoot?.activeElement).toBe(closeButton(navigator));

    dialogSurface(navigator).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true, composed: true }));
    expect(navigator.shadowRoot?.activeElement).toBe(next);

    next.click();
    await settleRenderedDialog(navigator);
    expect(navigator.shadowRoot?.activeElement).toBe(operationRadio(navigator, "continue"));

    footerButton(navigator, "Back").click();
    await settleRenderedDialog(navigator);
    expect(navigator.shadowRoot?.activeElement).toBe(treeItem(navigator, "active"));
  });

  it("uses Back and Escape to revisit location, then Escape to cancel", async () => {
    const onCancel = vi.fn();
    const navigator = await mountNavigator({ onCancel });

    await advanceToAction(navigator);
    footerButton(navigator, "Back").click();
    await settleRenderedDialog(navigator);
    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();

    await advanceToAction(navigator);
    pressKey(dialogSurface(navigator), "Escape");
    await settleRenderedDialog(navigator);
    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();

    treeItem(navigator, "active").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("session-tree-navigator action step", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("defaults to Continue, keeps operation and summary choices distinct, and hides summaries for Fork", async () => {
    const navigator = await mountNavigator();
    await advanceToAction(navigator);

    expect(fieldsetByLegend(navigator, "How would you like to continue?")).toBeTruthy();
    expect(operationRadio(navigator, "continue").checked).toBe(true);
    expect(operationRadio(navigator, "fork").checked).toBe(false);
    expect(operationRadio(navigator, "continue").parentElement?.textContent).toContain("Continue in this session");
    expect(operationRadio(navigator, "fork").parentElement?.textContent).toContain("Fork into a new session");
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeTruthy();
    expect(summaryRadio(navigator, "none").checked).toBe(true);
    expect(footerButton(navigator, "Continue from here")).toBeTruthy();
    expect(selectedEntryText(navigator)).toContain("prompt editor will be empty");

    operationRadio(navigator, "fork").click();
    await settleRenderedDialog(navigator);

    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeNull();
    expect(navigator.renderRoot.querySelector("input[name='session-tree-summary']")).toBeNull();
    expect(selectedEntryText(navigator)).toContain("include this entry and all history leading to it");
    expect(shadowText(navigator)).toContain("separate session file while leaving the original unchanged");
    expect(footerButton(navigator, "Fork into new session")).toBeTruthy();

    operationRadio(navigator, "continue").click();
    await settleRenderedDialog(navigator);
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeTruthy();
    expect(footerButton(navigator, "Continue from here")).toBeTruthy();
  });

  it("explains user-message restoration for same-session continuation and forks", async () => {
    const navigator = await mountNavigator();
    treeItem(navigator, "root").click();
    await settleRenderedDialog(navigator);
    await advanceToAction(navigator);

    expect(selectedEntryText(navigator)).toContain("text will return to the prompt editor for optional editing and resubmission in this session");

    operationRadio(navigator, "fork").click();
    await settleRenderedDialog(navigator);
    expect(selectedEntryText(navigator)).toContain("branch before this user message");
    expect(selectedEntryText(navigator)).toContain("new session draft");
  });

  it("dispatches the final action to the selected callback and retains location after cancellation", async () => {
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: true });
    const onFork = vi.fn<ForkCallback>().mockResolvedValue({ cancelled: true });
    const navigator = await mountNavigator({ onNavigate, onFork });

    treeItem(navigator, "side").click();
    await settleRenderedDialog(navigator);
    await advanceToAction(navigator);
    footerButton(navigator, "Continue from here").click();
    await settleRenderedDialog(navigator);

    expect(onNavigate).toHaveBeenCalledWith("side", { mode: "none" });
    expect(onFork).not.toHaveBeenCalled();
    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();
    expect(shadowText(navigator)).toContain("selected history entry is unchanged");

    await advanceToAction(navigator);
    operationRadio(navigator, "fork").click();
    await settleRenderedDialog(navigator);
    footerButton(navigator, "Fork into new session").click();
    await settleRenderedDialog(navigator);

    expect(onFork).toHaveBeenCalledWith("side");
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(navigator.renderRoot.querySelector("h2")?.textContent).toBe("Choose how to continue");
    expect(operationRadio(navigator, "fork").checked).toBe(true);
    expect(selectedEntryText(navigator)).toContain("Side branch");
    expect(navigator.renderRoot.querySelector(".dialog-status[role='status']")?.textContent).toContain("Fork cancelled. No new session was created");
  });

  it("validates custom summary focus without submitting", async () => {
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: false });
    const navigator = await mountNavigator({ onNavigate });
    await advanceToAction(navigator);

    summaryRadio(navigator, "custom").click();
    await settleRenderedDialog(navigator);
    footerButton(navigator, "Continue from here").click();
    await settleRenderedDialog(navigator);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(navigator.renderRoot.querySelector(".validation-error[role='alert']")?.textContent).toContain("Enter custom summary focus instructions");
    expect(navigator.shadowRoot?.activeElement).toBe(customFocus(navigator));
  });

  it("submits trimmed custom focus and exposes disabled busy controls and cancellation", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    const navigator = await mountNavigator({ onNavigate, onAbort });
    await advanceToAction(navigator);

    summaryRadio(navigator, "custom").click();
    await settleRenderedDialog(navigator);
    const textarea = customFocus(navigator);
    textarea.value = "  focus on failed tests  ";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settleRenderedDialog(navigator);
    footerButton(navigator, "Continue from here").click();
    await settleRenderedDialog(navigator);

    expect(onNavigate).toHaveBeenCalledWith("active", { mode: "custom", instructions: "focus on failed tests" });
    expect(fieldsetByLegend(navigator, "How would you like to continue?")?.disabled).toBe(true);
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")?.disabled).toBe(true);
    expect(closeButton(navigator).disabled).toBe(true);
    expect(footerButton(navigator, "Back").disabled).toBe(true);
    expect(footerButton(navigator, "Summarizing…").disabled).toBe(true);
    expect(footerButton(navigator, "Cancel summarization").disabled).toBe(false);

    pressKey(dialogSurface(navigator), "Escape");
    await settleRenderedDialog(navigator);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(footerButton(navigator, "Cancelling…").disabled).toBe(true);

    navigation.resolve({ cancelled: true, aborted: true });
    await settleRenderedDialog(navigator);
    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();
    expect(shadowText(navigator)).toContain("Summarization cancelled");
  });

  it("keeps navigation failures visible and actionable in step 2", async () => {
    const navigator = await mountNavigator();
    navigator.onNavigate = () => Promise.reject(new Error("The session changed since /tree was opened."));
    await advanceToAction(navigator);

    footerButton(navigator, "Continue from here").click();
    await settleRenderedDialog(navigator);

    expect(navigator.renderRoot.querySelector("h2")?.textContent).toBe("Choose how to continue");
    expect(navigator.renderRoot.querySelector(".dialog-error[role='alert']")?.textContent).toContain("Could not navigate session history: The session changed since /tree was opened.");
    expect(footerButton(navigator, "Continue from here").disabled).toBe(false);
  });

  it("keeps fork failures visible in step 2 without showing summary controls", async () => {
    const navigator = await mountNavigator();
    navigator.onFork = () => Promise.reject(new Error("Restart the session daemon to enable tree forks."));
    await advanceToAction(navigator);
    operationRadio(navigator, "fork").click();
    await settleRenderedDialog(navigator);

    footerButton(navigator, "Fork into new session").click();
    await settleRenderedDialog(navigator);

    expect(navigator.renderRoot.querySelector("h2")?.textContent).toBe("Choose how to continue");
    expect(navigator.renderRoot.querySelector(".dialog-error[role='alert']")?.textContent).toContain("Restart the session daemon to enable tree forks.");
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeNull();
    expect(footerButton(navigator, "Fork into new session").disabled).toBe(false);
  });

  it("disables the unified step while a fork is in flight", async () => {
    const forkResult = deferred<SessionTreeForkResult>();
    const navigator = await mountNavigator();
    navigator.onFork = () => forkResult.promise;
    await advanceToAction(navigator);
    operationRadio(navigator, "fork").click();
    await settleRenderedDialog(navigator);

    footerButton(navigator, "Fork into new session").click();
    await settleRenderedDialog(navigator);

    expect(fieldsetByLegend(navigator, "How would you like to continue?")?.disabled).toBe(true);
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeNull();
    expect(closeButton(navigator).disabled).toBe(true);
    expect(footerButton(navigator, "Back").disabled).toBe(true);
    expect(footerButton(navigator, "Forking…").disabled).toBe(true);
    expect(footerLabels(navigator)).not.toContain("Cancel summarization");

    forkResult.resolve({ cancelled: true });
    await settleRenderedDialog(navigator);
    expect(footerButton(navigator, "Fork into new session").disabled).toBe(false);
    expect(shadowText(navigator)).toContain("Fork cancelled. No new session was created");
  });
});

describe("session-tree-navigator interactions", () => {
  it("uses pointer selection for explicit navigation and retains it after cancellation", async () => {
    const navigator = initializedNavigator();
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: true, aborted: true });
    navigator.onNavigate = onNavigate;

    templateClickHandlerForText(renderNavigator(navigator), "Side branch")(new Event("click"));
    clickTreeNext(navigator);
    await callPromiseMethod(navigator, "submitNavigation");

    expect(onNavigate).toHaveBeenNthCalledWith(1, "side", { mode: "none" });
    expect(componentProperty(navigator, "step")).toBe("tree");
    expect(componentProperty(navigator, "statusMessage")).toContain("selected history entry is unchanged");

    clickTreeNext(navigator);
    await callPromiseMethod(navigator, "submitNavigation");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "side", { mode: "none" });
  });

  it("restores the valid no-summary default after leaving an incomplete custom choice", async () => {
    const navigator = initializedNavigator();
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: false });
    navigator.onNavigate = onNavigate;

    clickTreeNext(navigator);
    callSummaryModeMethod(navigator, "custom");
    await callPromiseMethod(navigator, "submitNavigation");
    expect(onNavigate).not.toHaveBeenCalled();

    callVoidMethod(navigator, "returnToTree");
    clickTreeNext(navigator);

    expect(componentProperty(navigator, "summaryMode")).toBe("none");
    await callPromiseMethod(navigator, "submitNavigation");
    expect(onNavigate).toHaveBeenCalledWith("active", { mode: "none" });
  });

  it("submits trimmed custom focus, exposes busy cancellation, and returns to the same node", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const navigator = initializedNavigator();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    navigator.onNavigate = onNavigate;
    navigator.onAbort = onAbort;

    clickTreeNext(navigator);
    callSummaryModeMethod(navigator, "custom");
    setComponentProperty(navigator, "customInstructions", "  focus on failed tests  ");

    const submission = callPromiseMethod(navigator, "submitNavigation");
    expect(componentProperty(navigator, "busy")).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith("active", { mode: "custom", instructions: "focus on failed tests" });

    await callPromiseMethod(navigator, "abortNavigation");
    expect(onAbort).toHaveBeenCalledOnce();
    expect(componentProperty(navigator, "aborting")).toBe(true);

    navigation.resolve({ cancelled: true, aborted: true });
    await submission;
    expect(componentProperty(navigator, "busy")).toBe(false);
    expect(componentProperty(navigator, "selectedId")).toBe("active");
    expect(componentProperty(navigator, "step")).toBe("tree");
  });

  it("clears transient cancelling status if navigation rejects after abort", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const navigator = initializedNavigator();
    navigator.onNavigate = () => navigation.promise;
    navigator.onAbort = () => Promise.resolve();

    clickTreeNext(navigator);
    callSummaryModeMethod(navigator, "default");
    const submission = callPromiseMethod(navigator, "submitNavigation");
    await callPromiseMethod(navigator, "abortNavigation");
    expect(componentProperty(navigator, "statusMessage")).toBe("Cancelling summarization…");

    navigation.reject(new Error("remote operation failed"));
    await submission;

    expect(componentProperty(navigator, "statusMessage")).toBe("");
    expect(componentProperty(navigator, "error")).toBe("Could not navigate session history: remote operation failed");
  });

  it("keeps navigation failures actionable and local to the action step", async () => {
    const navigator = initializedNavigator();
    navigator.onNavigate = () => Promise.reject(new Error("The session changed since /tree was opened. Reopen /tree and try again."));

    clickTreeNext(navigator);
    await callPromiseMethod(navigator, "submitNavigation");

    expect(componentProperty(navigator, "step")).toBe("action");
    expect(componentProperty(navigator, "busy")).toBe(false);
    expect(componentProperty(navigator, "error")).toBe("Could not navigate session history: The session changed since /tree was opened. Reopen /tree and try again.");
  });

  it("focuses the active leaf selected when the dialog opens", () => {
    const navigator = initializedNavigator();
    const activeFocus = vi.fn();
    const activeScroll = vi.fn();
    const root = {
      querySelector: () => null,
      querySelectorAll: () => [
        { dataset: { treeNodeId: "root" }, focus: vi.fn(), scrollIntoView: vi.fn() },
        { dataset: { treeNodeId: "active" }, focus: activeFocus, scrollIntoView: activeScroll },
      ],
    };
    if (!Reflect.set(navigator, "renderRoot", root)) throw new Error("Could not install navigator render root");

    callVoidMethod(navigator, "focusSelectedTreeItem");

    expect(activeFocus).toHaveBeenCalledOnce();
    expect(activeScroll).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("keeps an empty tree inert and moves initial focus to the close boundary", async () => {
    const navigator = new SessionTreeNavigator();
    navigator.tree = { nodes: [], activeLeafId: null, activePathIds: [] };
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: false });
    navigator.onNavigate = onNavigate;
    const closeFocus = vi.fn();
    const root = {
      querySelector: (selector: string) => selector === ".close-button" ? { focus: closeFocus } : null,
      querySelectorAll: () => [],
    };
    if (!Reflect.set(navigator, "renderRoot", root)) throw new Error("Could not install navigator render root");
    callVoidMethod(navigator, "resetTree");

    callVoidMethod(navigator, "focusSelectedTreeItem");
    callVoidMethod(navigator, "continueToAction");
    await callPromiseMethod(navigator, "submitNavigation");

    expect(componentProperty(navigator, "selectedId")).toBeUndefined();
    expect(componentProperty(navigator, "step")).toBe("tree");
    expect(closeFocus).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("session-tree-navigator display helpers", () => {
  it("maps every node kind to its semantic badge treatment and readable label", () => {
    const actual: Record<SessionTreeNodeKind, ReturnType<typeof sessionTreeKindPresentation>> = {
      user: sessionTreeKindPresentation("user"),
      assistant: sessionTreeKindPresentation("assistant"),
      "tool-result": sessionTreeKindPresentation("tool-result"),
      bash: sessionTreeKindPresentation("bash"),
      "custom-message": sessionTreeKindPresentation("custom-message"),
      compaction: sessionTreeKindPresentation("compaction"),
      "branch-summary": sessionTreeKindPresentation("branch-summary"),
      "model-change": sessionTreeKindPresentation("model-change"),
      "thinking-level-change": sessionTreeKindPresentation("thinking-level-change"),
      "session-info": sessionTreeKindPresentation("session-info"),
      label: sessionTreeKindPresentation("label"),
      custom: sessionTreeKindPresentation("custom"),
      other: sessionTreeKindPresentation("other"),
    };

    expect(actual).toEqual({
      user: { label: "User", tone: "user", bookkeeping: false },
      assistant: { label: "Assistant", tone: "assistant", bookkeeping: false },
      "tool-result": { label: "Tool result", tone: "tool", bookkeeping: false },
      bash: { label: "Shell", tone: "shell", bookkeeping: false },
      "custom-message": { label: "Custom message", tone: "context", bookkeeping: false },
      compaction: { label: "Compaction", tone: "context", bookkeeping: false },
      "branch-summary": { label: "Branch summary", tone: "context", bookkeeping: false },
      "model-change": { label: "Model", tone: "metadata", bookkeeping: true },
      "thinking-level-change": { label: "Thinking", tone: "metadata", bookkeeping: true },
      "session-info": { label: "Session info", tone: "metadata", bookkeeping: true },
      label: { label: "Label", tone: "metadata", bookkeeping: true },
      custom: { label: "Custom", tone: "metadata", bookkeeping: true },
      other: { label: "Other", tone: "metadata", bookkeeping: true },
    });
  });

  it("describes Pi's editor-return semantics and bounds pathological visual indentation", () => {
    expect(sessionTreeEntryReturnsToEditor("user")).toBe(true);
    expect(sessionTreeEntryReturnsToEditor("custom-message")).toBe(true);
    expect(sessionTreeEntryReturnsToEditor("assistant")).toBe(false);
    expect(sessionTreeEntryReturnsToEditor("tool-result")).toBe(false);
    expect(sessionTreeVisualDepth(-1)).toBe(0);
    expect(sessionTreeVisualDepth(7)).toBe(7);
    expect(sessionTreeVisualDepth(20_000)).toBe(8);
  });
});

interface MountedNavigatorProps {
  tree?: SessionTreeSnapshot;
  onNavigate?: NavigateCallback;
  onFork?: ForkCallback;
  onAbort?: () => Promise<void>;
  onCancel?: () => void;
}

async function mountNavigator(props: MountedNavigatorProps = {}): Promise<SessionTreeNavigator> {
  const element = document.createElement("session-tree-navigator");
  if (!(element instanceof SessionTreeNavigator)) throw new Error("session-tree-navigator element was not upgraded");
  element.tree = props.tree ?? tree();
  element.onNavigate = props.onNavigate ?? (() => Promise.resolve({ cancelled: false }));
  if (props.onFork !== undefined) element.onFork = props.onFork;
  if (props.onAbort !== undefined) element.onAbort = props.onAbort;
  if (props.onCancel !== undefined) element.onCancel = props.onCancel;
  document.body.append(element);
  await settleRenderedDialog(element);
  return element;
}

async function advanceToAction(navigator: SessionTreeNavigator): Promise<void> {
  footerButton(navigator, "Next").click();
  await settleRenderedDialog(navigator);
}

function renderedTree(navigator: SessionTreeNavigator): Element | null {
  return navigator.shadowRoot?.querySelector("[role='tree']") ?? null;
}

function backdropPress(navigator: SessionTreeNavigator): void {
  surfaceBackdrop(navigator).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
}

function tree(): SessionTreeSnapshot {
  return {
    nodes: [
      { id: "root", parentId: null, kind: "user", summary: "Initial prompt" },
      { id: "active", parentId: "root", kind: "assistant", summary: "Active answer" },
      { id: "side", parentId: "root", kind: "assistant", summary: "Side branch" },
    ],
    activeLeafId: "active",
    activePathIds: ["root", "active"],
  };
}

function treeItem(navigator: SessionTreeNavigator, id: string): HTMLElement {
  const item = navigator.renderRoot.querySelector(`[data-tree-node-id='${id}']`);
  if (!(item instanceof HTMLElement)) throw new Error(`Tree item "${id}" was unavailable`);
  return item;
}

function kindBadge(container: ParentNode): HTMLElement {
  const badge = container.querySelector(".kind");
  if (!(badge instanceof HTMLElement)) throw new Error("Kind badge was unavailable");
  return badge;
}

function closeButton(navigator: SessionTreeNavigator): HTMLButtonElement {
  const button = navigator.renderRoot.querySelector(".close-button");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Close button was unavailable");
  return button;
}

function footerButton(navigator: SessionTreeNavigator, label: string): HTMLButtonElement {
  for (const button of navigator.renderRoot.querySelectorAll("footer button")) {
    if (button.textContent.trim() !== label) continue;
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Footer button "${label}" is not a button element`);
    return button;
  }
  throw new Error(`Footer button "${label}" was unavailable`);
}

function footerLabels(navigator: SessionTreeNavigator): string[] {
  return [...navigator.renderRoot.querySelectorAll("footer button")].map((button) => button.textContent.trim());
}

function operationRadio(navigator: SessionTreeNavigator, value: "continue" | "fork"): HTMLInputElement {
  return radio(navigator, "session-tree-operation", value);
}

function summaryRadio(navigator: SessionTreeNavigator, value: SessionTreeSummaryChoice["mode"]): HTMLInputElement {
  return radio(navigator, "session-tree-summary", value);
}

function radio(navigator: SessionTreeNavigator, name: string, value: string): HTMLInputElement {
  const input = navigator.renderRoot.querySelector(`input[name='${name}'][value='${value}']`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Radio ${name}:${value} was unavailable`);
  return input;
}

function fieldsetByLegend(navigator: SessionTreeNavigator, legend: string): HTMLFieldSetElement | null {
  for (const fieldset of navigator.renderRoot.querySelectorAll("fieldset")) {
    if (fieldset.querySelector("legend")?.textContent !== legend) continue;
    if (!(fieldset instanceof HTMLFieldSetElement)) throw new Error(`Fieldset "${legend}" was not a fieldset element`);
    return fieldset;
  }
  return null;
}

function customFocus(navigator: SessionTreeNavigator): HTMLTextAreaElement {
  const textarea = navigator.renderRoot.querySelector("#session-tree-custom-focus");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Custom summary focus was unavailable");
  return textarea;
}

function selectedEntryText(navigator: SessionTreeNavigator): string {
  return navigator.renderRoot.querySelector(".selected-entry")?.textContent ?? "";
}

function shadowText(navigator: SessionTreeNavigator): string {
  return navigator.renderRoot.textContent;
}

// Method-level harness for the interaction tests: drives the navigator without
// a DOM attachment and reads private state by name.
function initializedNavigator(): SessionTreeNavigator {
  const navigator = new SessionTreeNavigator();
  navigator.tree = tree();
  callVoidMethod(navigator, "resetTree");
  return navigator;
}

function renderNavigator(navigator: SessionTreeNavigator): TemplateResult {
  return navigator.render();
}

function clickTreeNext(navigator: SessionTreeNavigator): void {
  templateEventHandlerNearMarker(renderNavigator(navigator), ">Next</button>")(new Event("click"));
}

function componentProperty(navigator: SessionTreeNavigator, property: string): unknown {
  return Reflect.get(navigator, property);
}

function setComponentProperty(navigator: SessionTreeNavigator, property: string, value: unknown): void {
  if (!Reflect.set(navigator, property, value)) throw new Error(`Could not set navigator property ${property}`);
}

function callVoidMethod(navigator: SessionTreeNavigator, methodName: string): void {
  const method: unknown = Reflect.get(navigator, methodName);
  if (!isVoidMethod(method)) throw new Error(`SessionTreeNavigator.${methodName} is not callable`);
  method.call(navigator);
}

async function callPromiseMethod(navigator: SessionTreeNavigator, methodName: string): Promise<void> {
  const method: unknown = Reflect.get(navigator, methodName);
  if (!isPromiseMethod(method)) throw new Error(`SessionTreeNavigator.${methodName} is not callable`);
  await method.call(navigator);
}

function callSummaryModeMethod(navigator: SessionTreeNavigator, mode: SessionTreeSummaryChoice["mode"]): void {
  const method: unknown = Reflect.get(navigator, "selectSummaryMode");
  if (!isSummaryModeMethod(method)) throw new Error("SessionTreeNavigator.selectSummaryMode is not callable");
  method.call(navigator, mode);
}

function isVoidMethod(value: unknown): value is VoidMethod {
  return typeof value === "function";
}

function isPromiseMethod(value: unknown): value is PromiseMethod {
  return typeof value === "function";
}

function isSummaryModeMethod(value: unknown): value is SummaryModeMethod {
  return typeof value === "function";
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
