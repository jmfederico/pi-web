// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayedMessageActionAvailabilityContext, DisplayedMessageActionContext, DisplayedMessageActionContribution, EntryMessageActionContribution, MessageActionAvailabilityContext, MessageActionContext, MessageActionContribution, MessageActionFeedback } from "../../../plugin-api";
import * as clipboard from "../clipboard";
import { normalizeMessages } from "../chatMessages";
import { corePlugin } from "../plugins/core";
import { PluginRegistry } from "../plugins/registry";
import type { ChatLine } from "./shared";
import type { FormattedText } from "./FormattedText";
import { ChatView } from "./ChatView";

const base = {
  machine: { id: "local", name: "Local", kind: "local" },
  session: { id: "session-1", cwd: "/repo", archived: false, pending: false, busy: false },
} as const;

function invocation(input: MessageActionAvailabilityContext): MessageActionContext {
  return {
    ...input,
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    navigate: vi.fn(),
    projects: { machineId: "local", listProjects: vi.fn(), suggestDirectories: vi.fn() },
    history: { fork: vi.fn(), goBack: vi.fn() },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(contributions?: MessageActionContribution[]) {
  const registry = new PluginRegistry();
  await registry.register({ id: "core", plugin: corePlugin });
  if (contributions !== undefined) await registry.register({ id: "custom", plugin: {
    apiVersion: 4, name: "Custom", activate: () => ({ contributions: { messageActions: contributions } }),
  } });
  const view = new ChatView();
  view.sessionId = base.session.id;
  view.messages = [{ role: "user", entryId: "entry-1", parts: [{ type: "text", text: "Hello" }] }];
  view.messageActionContext = base;
  view.messageActions = registry.getMessageActions("local");
  const context = invocation({ ...base, message: { entryId: "entry-1", role: "user", text: "Hello" } });
  view.onMessageAction = (input, id) => registry.runMessageAction(id, input, () => context);
  view.onDisplayedMessageAction = (input, id) => registry.runDisplayedMessageAction(id, input, () => displayedInvocation(input));
  document.body.append(view);
  await view.updateComplete;
  return { view, registry, context };
}

function displayedInvocation(input: DisplayedMessageActionAvailabilityContext): DisplayedMessageActionContext {
  return {
    ...input,
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    navigate: vi.fn(),
    projects: { machineId: "local", listProjects: vi.fn(), suggestDirectories: vi.fn() },
  };
}

function button(view: ChatView, label: string): HTMLButtonElement {
  const result = buttons(view).find((button) => button.getAttribute("aria-label") === label);
  if (result === undefined) throw new Error(`Missing message action ${label}`);
  return result;
}

function buttons(view: ChatView) {
  return Array.from(view.renderRoot.querySelectorAll<HTMLButtonElement>(".msg-action"));
}

async function settle(view: ChatView) {
  await view.updateComplete;
  await view.updateComplete;
}

describe("plugin-defined transcript message actions", () => {
  it.each([
    ["Clone session from this message", "fork", "Are you sure you want to fork this session?"],
    ["Go back to this message", "goBack", "Are you sure you want to go back to this message?"],
  ] as const)("preserves core confirmation for %s through the public callback", async (label, action, copy) => {
    const { view, context } = await mount();
    expect(buttons(view).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Clone session from this message", "Go back to this message", "Copy user message",
    ]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    button(view, label).click();
    await settle(view);
    expect(confirm).toHaveBeenCalledWith(copy);
    expect(context.history[action]).not.toHaveBeenCalled();
    await vi.waitFor(() => { expect(button(view, label).disabled).toBe(false); });
    confirm.mockReturnValue(true);
    button(view, label).click();
    await settle(view);
    await vi.waitFor(() => { expect(context.history[action]).toHaveBeenCalledOnce(); });
  });

  it("runs arbitrary plugin workflows without a host confirmation and filters availability per message", async () => {
    const run = vi.fn<EntryMessageActionContribution["run"]>();
    const { view, context } = await mount([
      { id: "quote", title: "Quote", visible: ({ message }) => message.role === "user", enabled: ({ message }) => message.text !== "Blocked", run },
      { id: "hidden", title: "Hidden", visible: () => false, run },
    ]);
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    button(view, "Quote").click();
    await settle(view);
    expect(run).toHaveBeenCalledExactlyOnceWith(context);
    expect(confirm).not.toHaveBeenCalled();
    expect(buttons(view).some((button) => button.title === "Hidden")).toBe(false);
    view.messages = [{ role: "user", entryId: "entry-2", parts: [{ type: "text", text: "Blocked" }] }];
    await settle(view);
    expect(button(view, "Quote").disabled).toBe(true);
    view.messages = [{ role: "assistant", entryId: "entry-3", parts: [{ type: "text", text: "Answer" }] }];
    await settle(view);
    expect(buttons(view).some((button) => button.title === "Quote")).toBe(false);
  });

  it("uses original message identities and displayed roles across paginated skill headers", async () => {
    const { view } = await mount([{ id: "skill", title: "Inspect skill", visible: ({ message }) => message.role === "skill", run: () => undefined }]);
    view.messageStart = 20;
    view.messages = [{ role: "assistant", entryId: "skill-entry", parts: [{ type: "skillRead", name: "example", path: "/skills/example/SKILL.md" }] }];
    view.onMessageAction = vi.fn(() => Promise.resolve());
    await settle(view);
    expect(buttons(view).map((button) => button.title)).toEqual(["Inspect skill"]);
    button(view, "Inspect skill").click();
    await settle(view);
    expect(view.onMessageAction).toHaveBeenCalledWith({ ...base, message: { entryId: "skill-entry", role: "skill", text: "" } }, "custom:skill");
  });

  it("renders whole-entry history only on the reply while display plugins remain on shared thinking/reply headers", async () => {
    const displayRun = vi.fn<DisplayedMessageActionContribution["run"]>();
    const { view } = await mount([{ target: "display", id: "inspect", title: "Inspect slice", run: displayRun }]);
    const onHistory = vi.fn(() => Promise.resolve());
    view.onMessageAction = onHistory;
    view.messageStart = 20;
    view.messages = normalizeMessages([{ role: "assistant", entryId: "assistant-8", content: [
      { type: "thinking", thinking: "Considering user testing messages" },
      { type: "text", text: "Test message 8/10" },
    ] }]);
    await settle(view);
    const group = view.renderRoot.querySelector<HTMLDetailsElement>("details.event-group");
    if (group === null) throw new Error("Missing thinking event group");
    expect(group.open).toBe(false);
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    await settle(view);

    const thinking = group.querySelector<HTMLElement>("section.group-msg.assistant");
    const reply = view.renderRoot.querySelector<HTMLElement>("article.msg.assistant");
    if (thinking === null || reply === null) throw new Error("Missing shared-entry slices");
    const formatted = [thinking, reply].map((slice) => {
      const element = slice.querySelector<FormattedText>("formatted-text");
      if (element === null) throw new Error("Missing slice text");
      return element;
    });
    await Promise.all(formatted.map((element) => element.updateComplete));
    expect(formatted.map((element) => element.renderRoot.textContent)).toEqual([
      expect.stringContaining("Considering user testing messages"), expect.stringContaining("Test message 8/10"),
    ]);
    expect(Array.from(thinking.querySelectorAll<HTMLButtonElement>(".msg-action"), (action) => action.title)).toEqual(["Inspect slice"]);
    expect(Array.from(reply.querySelectorAll<HTMLButtonElement>(".msg-action"), (action) => action.title)).toEqual([
      "Clone session from this message", "Go back to this message", "Copy message", "Inspect slice",
    ]);
    for (const label of ["Clone session from this message", "Go back to this message"]) {
      expect(buttons(view).filter((action) => action.getAttribute("aria-label") === label)).toHaveLength(1);
    }

    const displayButtons = buttons(view).filter((action) => action.title === "Inspect slice");
    for (const action of displayButtons) {
      action.click();
      await settle(view);
    }
    expect(displayRun.mock.calls.map(([context]) => context.message)).toEqual([
      { entryId: "assistant-8", role: "assistant", text: "" },
      { entryId: "assistant-8", role: "assistant", text: "Test message 8/10" },
    ]);
    const fork = view.messageActions.find((action) => action.title === "Clone session from this message");
    if (fork === undefined) throw new Error("Missing history contribution");
    button(view, fork.title).click();
    await settle(view);
    expect(onHistory).toHaveBeenCalledExactlyOnceWith({
      ...base, message: { entryId: "assistant-8", role: "assistant", text: "Test message 8/10" },
    }, fork.id);
  });

  it("offers only opted-in display actions without a durable entry", async () => {
    const { view } = await mount();
    view.messages = [{ role: "assistant", parts: [{ type: "text", text: "Streaming" }] }];
    await view.updateComplete;
    expect(buttons(view).map((button) => button.title)).toEqual(["Copy message"]);
  });

  it("copies through the plugin registry, preserves original text and renews transient feedback", async () => {
    vi.useFakeTimers();
    const writeText = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValue(true);
    const { view } = await mount();
    view.messages = [{ role: "assistant", parts: [
      { type: "thinking", text: "Private reasoning" },
      { type: "text", text: "  First  ", displayText: "Displayed differently" },
      { type: "text", text: "   " },
      { type: "text", text: " Second\n" },
    ] }];
    await settle(view);
    expect(buttons(view).map((button) => button.title)).toEqual(["Copy message"]);
    button(view, "Copy assistant message").click();
    await settle(view);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("First\n\nSecond");
    await vi.waitFor(() => { expect(button(view, "Copied assistant message").title).toBe("Copied"); });
    expect(button(view, "Copied assistant message").textContent).toContain("✓");
    await vi.advanceTimersByTimeAsync(800);
    button(view, "Copied assistant message").click();
    await vi.waitFor(() => { expect(button(view, "Copied assistant message").disabled).toBe(false); });
    await vi.advanceTimersByTimeAsync(800);
    expect(button(view, "Copied assistant message").title).toBe("Copied");
    await vi.advanceTimersByTimeAsync(400);
    await settle(view);
    expect(button(view, "Copy assistant message").title).toBe("Copy message");
  });

  it("has no built-in Copy fallback when the contribution is absent", async () => {
    const { view } = await mount();
    view.messageActions = view.messageActions.filter((action) => action.id !== "core:message.copy");
    await settle(view);
    expect(buttons(view).map((button) => button.title)).toEqual(["Clone session from this message", "Go back to this message"]);
  });

  it("lets Copy run while an entry workflow is pending and reports clipboard failure without success feedback", async () => {
    const writeText = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValue(false);
    const { view } = await mount();
    let finish: (() => void) | undefined;
    view.onMessageAction = () => new Promise<void>((resolve) => { finish = resolve; });
    button(view, "Go back to this message").click();
    await settle(view);
    expect(button(view, "Go back to this message").disabled).toBe(true);
    expect(button(view, "Copy user message").disabled).toBe(false);
    button(view, "Copy user message").click();
    await settle(view);
    expect(writeText).toHaveBeenCalledWith("Hello");
    expect(button(view, "Copy user message").title).toBe("Copy message");
    await vi.waitFor(() => { expect(view.renderRoot.querySelector('[role="alert"]')?.textContent).toBe("Unable to copy message to the clipboard."); });
    finish?.();
    await settle(view);
  });

  it("shows generic plugin feedback only at its originating display target and clears it on selection/disconnect", async () => {
    vi.useFakeTimers();
    const { view } = await mount([{ target: "display", id: "mark", title: "Mark", run: () => ({ title: "Marked" }) }]);
    view.messages = [
      { role: "user", entryId: "shared", parts: [{ type: "text", text: "One" }] },
      { role: "user", entryId: "shared", parts: [{ type: "text", text: "Two" }] },
    ];
    await settle(view);
    button(view, "Mark").click();
    await settle(view);
    expect(buttons(view).filter((button) => button.title === "Marked")).toHaveLength(1);
    expect(buttons(view).filter((button) => button.title === "Mark")).toHaveLength(1);
    view.machineId = "remote";
    await settle(view);
    expect(buttons(view).filter((button) => button.title === "Marked")).toHaveLength(0);
    button(view, "Mark").click();
    await settle(view);
    view.remove();
    document.body.append(view);
    await settle(view);
    expect(buttons(view).filter((button) => button.title === "Marked")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1200);
    await settle(view);
  });

  it.each(["selection", "remount"])("ignores late plugin feedback after %s retires the invocation", async (change) => {
    const { view } = await mount([{ target: "display", id: "save", title: "Save", run: () => undefined }]);
    let finish: ((feedback: MessageActionFeedback) => void) | undefined;
    const result = new Promise<MessageActionFeedback>((resolve) => { finish = resolve; });
    view.onDisplayedMessageAction = () => result;
    button(view, "Save").click();
    await settle(view);
    if (change === "selection") {
      view.sessionId = "other";
      await settle(view);
      view.sessionId = base.session.id;
    } else {
      view.remove();
      document.body.append(view);
    }
    await settle(view);
    finish?.({ title: "Saved" });
    await result;
    await settle(view);
    expect(buttons(view).some((button) => button.title === "Saved")).toBe(false);
    expect(button(view, "Save").disabled).toBe(false);
  });

  it("disables core history actions while busy but leaves Copy and other plugin policy independent", async () => {
    const { view } = await mount([{ id: "note", title: "Note", run: () => undefined }]);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    view.messageActionContext = { ...base, session: { ...base.session, busy: true } };
    await settle(view);
    button(view, "Clone session from this message").click();
    expect(confirm).not.toHaveBeenCalled();
    expect(button(view, "Copy user message").disabled).toBe(false);
    expect(button(view, "Note").disabled).toBe(false);
    view.messageActionContext = base;
    view.onMessageAction = vi.fn(() => Promise.reject(new Error("History changed")));
    await settle(view);
    button(view, "Go back to this message").click();
    await settle(view);
    expect(view.renderRoot.querySelector('[role="alert"]')?.textContent).toBe("History changed");
  });

  it("does not repeat historical availability checks or fetch on unrelated stream/render updates", async () => {
    const visible = vi.fn<NonNullable<EntryMessageActionContribution["visible"]>>(() => true);
    const enabled = vi.fn<NonNullable<EntryMessageActionContribution["enabled"]>>(() => true);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { view, registry } = await mount([{ id: "note", title: "Note", visible, enabled, run: () => undefined }]);
    const history = view.messages[0];
    if (history === undefined) throw new Error("Expected historical message");
    expect(visible).toHaveBeenCalledTimes(1);
    for (const text of ["One", "Two", "Three"]) {
      view.messages = [history, { role: "assistant", parts: [{ type: "text", text }] }];
      // The app makes new small snapshots/lists on each render; identities of
      // the registered actions and unchanged transcript lines remain stable.
      view.messageActionContext = { machine: { ...base.machine }, session: { ...base.session } };
      view.messageActions = registry.getMessageActions("local");
      await settle(view);
    }
    expect(visible).toHaveBeenCalledTimes(1);
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    const updated: ChatLine = { ...history, parts: [{ type: "text", text: "Changed" }] };
    view.messages = [updated];
    await settle(view);
    expect(visible).toHaveBeenCalledTimes(2);
    expect(visible).toHaveBeenLastCalledWith(expect.objectContaining({ message: { entryId: "entry-1", role: "user", text: "Changed" } }));
    view.messageActionContext = { ...base, session: { ...base.session, archived: true } };
    await settle(view);
    expect(enabled).toHaveBeenCalledTimes(3);
    expect(button(view, "Clone session from this message").disabled).toBe(true);
  });
});
