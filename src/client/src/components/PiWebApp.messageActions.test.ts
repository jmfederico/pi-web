// @vitest-environment happy-dom
import { LitElement, render, type TemplateResult } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { DisplayedMessageActionContext, MessageActionContext } from "../../../plugin-api";
import * as clipboard from "../clipboard";
import { api, type SessionInfo, type SessionTranscriptSnapshot, type SessionTreeNavigateResult } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { PluginRegistry } from "../plugins/registry";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { ChatView } from "./ChatView";
import { PiWebApp } from "./PiWebApp";
import { PromptEditor } from "./PromptEditor";

// Keep the actual shell/editor lifecycle, without starting network bootstrap.
class MessageActionApp extends PiWebApp {
  override connectedCallback(): void {
    LitElement.prototype.connectedCallback.call(this);
  }
}
customElements.define("message-action-test-app", MessageActionApp);

const session: SessionInfo = {
  id: "session-1", cwd: "/repo", path: "/repo/session.jsonl", created: "now", modified: "now", messageCount: 1, firstMessage: "Hello",
};
const apps: PiWebApp[] = [];

afterEach(async () => {
  document.body.replaceChildren();
  localStorage.clear();
  for (const app of apps.splice(0)) {
    const controller: unknown = Reflect.get(app, "sessions");
    if (controller instanceof SessionController) controller.dispose();
    const registry: unknown = Reflect.get(app, "plugins");
    if (registry instanceof PluginRegistry) await registry.dispose();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("connects public plugin callbacks and core history actions to the app's scoped helpers", async () => {
  const { app, registry, controller, state, renderChat } = await setupChat([
    { role: "user", entryId: "entry-1", parts: [{ type: "text", text: "Hello" }] },
  ]);
  const history = vi.spyOn(controller, "actOnMessage").mockResolvedValue(undefined);
  let received: MessageActionContext | undefined;
  await registry.register({ id: "notes", plugin: {
    apiVersion: 4, name: "Notes", activate: () => ({ contributions: { messageActions: [{
      id: "note", title: "Save note", run: (context) => { received = context; context.prompt.setChip?.({ id: "note", label: "Note", text: context.message.text }); },
    }] } }),
  } });
  const container = document.createElement("div");
  document.body.append(container);
  render(renderChat.call(app, state, session), container);
  const view = container.querySelector<ChatView>("chat-view");
  if (view === null) throw new Error("Expected chat view");
  await view.updateComplete;
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  click(view, "Save note");
  await view.updateComplete;
  await vi.waitFor(() => { expect(actionButton(view, "Save note").disabled).toBe(false); });
  expect(confirm).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  expect(received).toMatchObject({ machine: { id: "local" }, session: { id: session.id }, message: { entryId: "entry-1", text: "Hello", role: "user" } });
  expect(received).not.toHaveProperty("state");
  expect(received?.session).not.toHaveProperty("path");
  expect(registry.promptChips.list({ machineId: "local", sessionId: session.id })).toMatchObject([{ label: "Note", text: "Hello" }]);
  click(view, "Clone session from this message");
  await vi.waitFor(() => { expect(history).toHaveBeenLastCalledWith("entry-1", "fork"); });
  await vi.waitFor(() => { expect(actionButton(view, "Go back to this message").disabled).toBe(false); });
  click(view, "Go back to this message");
  await vi.waitFor(() => { expect(history).toHaveBeenLastCalledWith("entry-1", "back"); });

  Reflect.set(app, "state", { ...state, selectedSession: { ...session, id: "other" } });
  await expect(received?.history.fork()).rejects.toThrow("no longer available");
  expect(history).toHaveBeenCalledTimes(2);
  expect(received?.prompt.getText()).toBe("");
  // Chips remain bound to the initiating conversation even after selection changes.
  received?.prompt.setChip?.({ id: "note", label: "Later", text: "Captured" });
  expect(registry.promptChips.list({ machineId: "local", sessionId: "other" })).toEqual([]);
  expect(registry.promptChips.list({ machineId: "local", sessionId: session.id })).toMatchObject([{ label: "Later" }]);
});

it("dispatches exact displayed slices through plugins, including streaming messages and shared entry IDs", async () => {
  const writeText = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValue(true);
  const { app, registry, controller, state, renderChat } = await setupChat([
    { role: "assistant", entryId: "shared", parts: [{ type: "thinking", text: "Reasoning" }, { type: "text", text: "  First  ", displayText: "Presentation only" }] },
    { role: "assistant", entryId: "shared", parts: [{ type: "text", text: "Second" }] },
    { role: "assistant", parts: [{ type: "text", text: "Streaming" }] },
  ]);
  let received: DisplayedMessageActionContext | undefined;
  await registry.register({ id: "display", plugin: {
    apiVersion: 4, name: "Display workflows", activate: () => ({ contributions: { messageActions: [{
      target: "display", id: "inspect", title: "Inspect", visible: ({ message }) => message.text !== "",
      run: (context) => { received = context; return { title: "Inspected" }; },
    }] } }),
  } });
  const history = vi.spyOn(controller, "actOnMessage").mockResolvedValue(undefined);
  const paginated = { ...state, messagePageStart: 40, messagePageEnd: 43, messagePageTotal: 43 };
  Reflect.set(app, "state", paginated);
  const container = document.createElement("div");
  document.body.append(container);
  render(renderChat.call(app, paginated, session), container);
  const view = container.querySelector<ChatView>("chat-view");
  if (view === null) throw new Error("Expected chat view");
  await view.updateComplete;
  const copies = Array.from(view.renderRoot.querySelectorAll<HTMLButtonElement>('[aria-label="Copy assistant message"]'));
  expect(copies).toHaveLength(3);
  for (const [index, text] of ["First", "Second", "Streaming"].entries()) {
    copies[index]?.click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledTimes(index + 1); expect(copies[index]?.disabled).toBe(false); });
    expect(writeText).toHaveBeenLastCalledWith(text);
  }
  const inspections = Array.from(view.renderRoot.querySelectorAll<HTMLButtonElement>('[aria-label="Inspect"]'));
  inspections[2]?.click();
  await vi.waitFor(() => { expect(received?.message).toEqual({ role: "assistant", text: "Streaming" }); });
  expect(received).not.toHaveProperty("history");
  expect(received).not.toHaveProperty("state");
  expect(received?.projects.machineId).toBe("local");
  expect(history).not.toHaveBeenCalled();
  await vi.waitFor(() => { expect(view.renderRoot.querySelector('[aria-label="Inspected"]')).not.toBeNull(); });
  Reflect.set(app, "state", { ...paginated, selectedSession: { ...session, id: "other" } });
  copies[0]?.click();
  await view.updateComplete;
  expect(writeText).toHaveBeenCalledTimes(3);
});

it("restores an empty live composer without confirming or waiting for history", async () => {
  const { editor, view, navigateTree, transcriptSnapshot } = await setupComposerChat("");
  const navigation = deferred<SessionTreeNavigateResult>();
  const refresh = deferred<SessionTranscriptSnapshot>();
  navigateTree.mockReturnValue(navigation.promise);
  transcriptSnapshot.mockReturnValue(refresh.promise);
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  // Saved text is not the live composer; it must not cause a false warning.
  saveDraft(machineSessionKey("local", session.id), "stale storage");
  click(view, "Go back to this message");
  await vi.waitFor(() => { expect(navigateTree).toHaveBeenCalledOnce(); });
  expect(confirm).not.toHaveBeenCalled();
  expect(editor.disabled).toBe(true);
  expect(editor.view?.state.readOnly).toBe(true);
  navigation.resolve({ cancelled: false, editorText: "Hello" });
  await vi.waitFor(() => {
    expect(transcriptSnapshot).toHaveBeenCalledOnce();
    expect(editor.view?.state.doc.toString()).toBe("Hello");
    expect(editor.disabled).toBe(false);
  });
  expect(editor.view?.state.readOnly).toBe(false);
  expect(loadDraft(machineSessionKey("local", session.id))).toBe("Hello");
  expect(view.shadowRoot?.querySelector(".suggested-input")).toBeNull();
  editor.view?.dispatch({ changes: { from: 0, to: 5, insert: "typed during refresh" } });
  refresh.resolve(await freshTranscript());
  await vi.waitFor(() => { expect(view.shadowRoot?.querySelector(".msg-action:disabled")).toBeNull(); });
  expect(editor.view?.state.doc.toString()).toBe("typed during refresh");
  expect(loadDraft(machineSessionKey("local", session.id))).toBe("typed during refresh");
  expect(view.shadowRoot?.querySelector(".suggested-input")).toBeNull();
});

it("going back to an assistant message preserves the draft without a replacement warning", async () => {
  const { editor, view, navigateTree, transcriptSnapshot } = await setupComposerChat("unsent draft", "assistant");
  navigateTree.mockResolvedValue({ cancelled: false });
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  click(view, "Go back to this message");
  await vi.waitFor(() => {
    expect(navigateTree).toHaveBeenCalledOnce();
    expect(transcriptSnapshot).toHaveBeenCalledOnce();
    expect(editor.disabled).toBe(false);
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(editor.view?.state.doc.toString()).toBe("unsent draft");
  expect(loadDraft(machineSessionKey("local", session.id))).toBe("unsent draft");
});

it("cancelling replacement leaves the live draft and history unchanged", async () => {
  const { editor, view, runCommand, navigateTree } = await setupComposerChat("unsent draft");
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  click(view, "Go back to this message");
  await vi.waitFor(() => {
    expect(confirm).toHaveBeenCalledExactlyOnceWith("Going back will replace your unsent draft. Continue?");
    expect(actionButton(view, "Go back to this message").disabled).toBe(false);
  });
  expect(runCommand).not.toHaveBeenCalled();
  expect(navigateTree).not.toHaveBeenCalled();
  expect(editor.view?.state.doc.toString()).toBe("unsent draft");
  expect(loadDraft(machineSessionKey("local", session.id))).toBe("unsent draft");
  expect(editor.disabled).toBe(false);
});

it.each(["unsent draft", " \n"])("replaces non-empty text only after explicit confirmation (%j)", async (draft) => {
  const { editor, view, navigateTree } = await setupComposerChat(draft);
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  click(view, "Go back to this message");
  await vi.waitFor(() => {
    expect(navigateTree).toHaveBeenCalledOnce();
    expect(editor.view?.state.doc.toString()).toBe("Hello");
    expect(editor.disabled).toBe(false);
  });
  expect(confirm).toHaveBeenCalledExactlyOnceWith("Going back will replace your unsent draft. Continue?");
  expect(loadDraft(machineSessionKey("local", session.id))).toBe("Hello");
});

it.each(["cancelled", "failed"] as const)("unlocks and preserves the composer when go-back is %s", async (outcome) => {
  const { editor, view, navigateTree } = await setupComposerChat("unsent draft");
  if (outcome === "cancelled") navigateTree.mockResolvedValue({ cancelled: true });
  else navigateTree.mockRejectedValue(new Error("Navigation failed"));
  vi.stubGlobal("confirm", () => true);
  click(view, "Go back to this message");
  await vi.waitFor(() => {
    expect(navigateTree).toHaveBeenCalledOnce();
    expect(editor.disabled).toBe(false);
    expect(actionButton(view, "Go back to this message").disabled).toBe(false);
  });
  expect(editor.view?.state.doc.toString()).toBe("unsent draft");
  expect(loadDraft(machineSessionKey("local", session.id))).toBe("unsent draft");
});

it("confirms queue recall consequences and protects an existing composer draft", async () => {
  const { app, controller, editor, view, state } = await setupComposerChat("unsent draft");
  const queuedMessages = [{ kind: "steer" as const, text: "adjust" }, { kind: "followUp" as const, text: "next" }];
  const status = { sessionId: session.id, isStreaming: true, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 2, queuedMessages, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  Reflect.set(app, "state", { ...state, status });
  await app.updateComplete;
  await view.updateComplete;
  const mutate = vi.spyOn(controller, "mutateQueuedMessage").mockResolvedValue(undefined);
  const confirm = vi.fn<(text: string) => boolean>().mockReturnValue(false);
  vi.stubGlobal("confirm", confirm);
  const recall = view.shadowRoot?.querySelector<HTMLButtonElement>('[title^="Recall this message"]');
  if (!recall) throw new Error("Expected queue recall button");
  recall.click();
  expect(mutate).not.toHaveBeenCalled();
  expect(editor.disabled).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();

  confirm.mockReset().mockReturnValueOnce(true).mockReturnValueOnce(false);
  recall.click();
  expect(confirm.mock.calls.map(([text]) => text)).toEqual([
    "Recall this message?\n\nThis will also remove 1 queued follow-up.",
    "Recalling will replace your unsent draft. Continue?",
  ]);
  expect(mutate).not.toHaveBeenCalled();
  expect(editor.view?.state.doc.toString()).toBe("unsent draft");
});

it.each([false, true])("locks the composer during queue recall and warns only for attachments (%s)", async (hasAttachments) => {
  const { app, controller, editor, view, state } = await setupComposerChat("");
  const queuedMessages = [{ kind: "followUp" as const, text: "next", hasAttachments }];
  Reflect.set(app, "state", { ...state, status: { sessionId: session.id, isStreaming: true, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 1, queuedMessages, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await app.updateComplete;
  await view.updateComplete;
  const request = deferred<undefined>();
  const mutate = vi.spyOn(controller, "mutateQueuedMessage").mockReturnValue(request.promise);
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  const recall = view.shadowRoot?.querySelector<HTMLButtonElement>('[title^="Recall this message"]');
  if (!recall) throw new Error("Expected queue recall button");
  recall.click();
  await vi.waitFor(() => { expect(mutate).toHaveBeenCalledWith("edit", 0, queuedMessages); });
  expect(editor.disabled).toBe(true);
  if (hasAttachments) expect(confirm).toHaveBeenCalledWith("Recall this message? Only its text will return to the composer. Its attachments will be lost.");
  else expect(confirm).not.toHaveBeenCalled();
  request.resolve(undefined);
  await vi.waitFor(() => { expect(editor.disabled).toBe(false); });
});

async function setupComposerChat(draft: string, role: "user" | "assistant" = "user") {
  const context = await setupChat([
    { role, entryId: "entry-1", parts: [{ type: "text", text: "Hello" }] },
  ], new MessageActionApp());
  const runCommand = vi.fn<typeof api.runCommand>(() => Promise.resolve({ type: "tree", tree: {
    nodes: [{ id: "entry-1", parentId: null, kind: role, summary: "Hello" }], activeLeafId: "entry-1", activePathIds: ["entry-1"],
  } }));
  const navigateTree = vi.fn<typeof api.navigateTree>(() => Promise.resolve({ cancelled: false, editorText: "Hello" }));
  const transcriptSnapshot = vi.fn<typeof api.transcriptSnapshot>(freshTranscript);
  Reflect.set(context.controller, "api", { ...api, runCommand, navigateTree, transcriptSnapshot });
  document.body.append(context.app);
  await context.app.updateComplete;
  const editor = context.app.shadowRoot?.querySelector("prompt-editor");
  const view = context.app.shadowRoot?.querySelector("chat-view");
  if (!(editor instanceof PromptEditor) || !(view instanceof ChatView)) throw new Error("Expected real composer and chat view");
  await editor.updateComplete;
  await view.updateComplete;
  editor.replaceText(draft);
  await editor.updateComplete;
  return { ...context, editor, view, runCommand, navigateTree, transcriptSnapshot };
}

function freshTranscript(): Promise<SessionTranscriptSnapshot> {
  return Promise.resolve({
    page: { messages: [], start: 0, total: 0 }, seq: 0, partial: null,
    status: { sessionId: session.id, isStreaming: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, queuedMessages: [], cost: 0, suggestedInput: "Hello",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  if (resolve === undefined) throw new Error("Expected a promise resolver");
  return { promise, resolve };
}

async function setupChat(messages: AppState["messages"], app = new PiWebApp()) {
  // Use the real chat render seam without mounting the shell's unrelated
  // network/session lifecycles; interactions still use actual DOM buttons.
  apps.push(app);
  await Reflect.get(app, "builtInPluginsReady");
  const registry: unknown = Reflect.get(app, "plugins");
  const controller: unknown = Reflect.get(app, "sessions");
  const modes: unknown = Reflect.get(app, "verifiedPluginModeByMachine");
  const renderChat: unknown = Reflect.get(app, "renderChatView");
  if (!(registry instanceof PluginRegistry) || !(controller instanceof SessionController) || !(modes instanceof Map) || !isRenderChat(renderChat)) {
    throw new Error("Expected app chat collaborators");
  }
  modes.set("local", "recovery-disabled");
  const state: AppState = { ...initialAppState(), selectedSession: session, messages };
  Reflect.set(app, "state", state);
  return { app, registry, controller, state, renderChat };
}

function click(view: ChatView, label: string) {
  actionButton(view, label).click();
}

function actionButton(view: ChatView, label: string): HTMLButtonElement {
  const button = Array.from(view.renderRoot.querySelectorAll<HTMLButtonElement>(".msg-action")).find((button) => button.getAttribute("aria-label") === label);
  if (button === undefined) throw new Error(`Expected ${label} button`);
  return button;
}

function isRenderChat(value: unknown): value is (this: PiWebApp, state: AppState, session: SessionInfo) => TemplateResult {
  return typeof value === "function";
}
