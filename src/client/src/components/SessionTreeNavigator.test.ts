import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionTreeNavigateResult, SessionTreeSnapshot, SessionTreeSummaryChoice } from "../api";
// Genuine Lit callback extraction is limited to pointer row/confirmation wiring;
// keyboard state and hierarchy are covered through the pure sessionTreeModel.
// A DOM harness would otherwise add a new test environment only for two clicks.
import { templateClickHandlerForText, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { SessionTreeNavigator, sessionTreeEntryReturnsToEditor, sessionTreeVisualDepth } from "./SessionTreeNavigator";

type NavigateCallback = (targetId: string, summaryChoice: SessionTreeSummaryChoice) => Promise<SessionTreeNavigateResult>;
type VoidMethod = (this: SessionTreeNavigator) => void;
type PromiseMethod = (this: SessionTreeNavigator) => Promise<void>;
type SummaryModeMethod = (this: SessionTreeNavigator, mode: SessionTreeSummaryChoice["mode"]) => void;

describe("session-tree-navigator interactions", () => {
  it("uses pointer selection for explicit navigation and retains it after cancellation", async () => {
    const navigator = initializedNavigator();
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: true, aborted: true });
    navigator.onNavigate = onNavigate;

    templateClickHandlerForText(renderNavigator(navigator), "Side branch")(new Event("click"));
    clickTreeNavigate(navigator);
    await callPromiseMethod(navigator, "submitNavigation");

    expect(onNavigate).toHaveBeenNthCalledWith(1, "side", { mode: "none" });
    expect(componentProperty(navigator, "step")).toBe("tree");
    expect(componentProperty(navigator, "statusMessage")).toContain("selected history entry is unchanged");

    clickTreeNavigate(navigator);
    await callPromiseMethod(navigator, "submitNavigation");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "side", { mode: "none" });
  });

  it("submits trimmed custom focus, exposes busy cancellation, and returns to the same node", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const navigator = initializedNavigator();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    navigator.onNavigate = onNavigate;
    navigator.onAbort = onAbort;

    clickTreeNavigate(navigator);
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

    clickTreeNavigate(navigator);
    callSummaryModeMethod(navigator, "default");
    const submission = callPromiseMethod(navigator, "submitNavigation");
    await callPromiseMethod(navigator, "abortNavigation");
    expect(componentProperty(navigator, "statusMessage")).toBe("Cancelling summarization…");

    navigation.reject(new Error("remote operation failed"));
    await submission;

    expect(componentProperty(navigator, "statusMessage")).toBe("");
    expect(componentProperty(navigator, "error")).toBe("Could not navigate session history: remote operation failed");
  });

  it("keeps navigation failures actionable and local to the confirmation step", async () => {
    const navigator = initializedNavigator();
    navigator.onNavigate = () => Promise.reject(new Error("The session changed since /tree was opened. Reopen /tree and try again."));

    clickTreeNavigate(navigator);
    await callPromiseMethod(navigator, "submitNavigation");

    expect(componentProperty(navigator, "step")).toBe("confirm");
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
    callVoidMethod(navigator, "continueToConfirmation");
    await callPromiseMethod(navigator, "submitNavigation");

    expect(componentProperty(navigator, "selectedId")).toBeUndefined();
    expect(componentProperty(navigator, "step")).toBe("tree");
    expect(closeFocus).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("describes Pi's editor-return semantics and bounds pathological visual indentation", () => {
    expect(sessionTreeEntryReturnsToEditor("user")).toBe(true);
    expect(sessionTreeEntryReturnsToEditor("custom-message")).toBe(true);
    expect(sessionTreeEntryReturnsToEditor("assistant")).toBe(false);
    expect(sessionTreeEntryReturnsToEditor("tool-result")).toBe(false);
    expect(sessionTreeVisualDepth(-1)).toBe(0);
    expect(sessionTreeVisualDepth(12)).toBe(12);
    expect(sessionTreeVisualDepth(20_000)).toBe(32);
  });
});

function initializedNavigator(): SessionTreeNavigator {
  const navigator = new SessionTreeNavigator();
  navigator.tree = tree();
  callVoidMethod(navigator, "resetTree");
  return navigator;
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

function renderNavigator(navigator: SessionTreeNavigator): TemplateResult {
  return navigator.render();
}

function clickTreeNavigate(navigator: SessionTreeNavigator): void {
  templateEventHandlerNearMarker(renderNavigator(navigator), ">Navigate</button>")(new Event("click"));
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
