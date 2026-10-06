import { describe, expect, it, vi } from "vitest";
import type { DisplayedMessageActionAvailabilityContext, DisplayedMessageActionContext, DisplayedMessageActionContribution, EntryMessageActionContribution, MessageActionAvailabilityContext, MessageActionContext, MessageActionContribution } from "../../../plugin-api";
import type { ChatLine } from "../components/shared";
import { availableDisplayedMessageActions, availableMessageActions, displayedMessageActionMessage, MessageActionAvailabilityCache, messageActionMessage, type RegisteredMessageAction } from "./messageActions";
import { PluginRegistry } from "./registry";

const input: MessageActionAvailabilityContext = {
  machine: { id: "remote", name: "Remote", kind: "remote" },
  session: { id: "s", cwd: "/repo", archived: false, pending: false, busy: false },
  message: { entryId: "entry", role: "user", text: "Hello" },
};

function plugin(...actions: MessageActionContribution[]) {
  return { apiVersion: 4 as const, name: "Message tools", activate: () => ({ contributions: { messageActions: actions } }) };
}

function context(): MessageActionContext {
  return {
    ...input,
    navigate: vi.fn(), prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    projects: { machineId: "remote", listProjects: vi.fn(), suggestDirectories: vi.fn() },
    history: { fork: vi.fn(), goBack: vi.fn() },
  };
}

const displayedInput: DisplayedMessageActionAvailabilityContext = {
  machine: input.machine,
  session: input.session,
  message: { role: "assistant", text: "Streaming answer" },
};

function displayedContext(snapshot = displayedInput): DisplayedMessageActionContext {
  return {
    ...snapshot,
    navigate: vi.fn(), prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    projects: { machineId: snapshot.machine.id, listProjects: vi.fn(), suggestDirectories: vi.fn() },
  };
}

function registered(action: MessageActionContribution): RegisteredMessageAction {
  return { ...action, binding: { registrationPluginId: "runtime", sourcePluginId: "source" } };
}

describe("message action snapshots", () => {
  it("trims each original ordinary text part, skips blanks and excludes rendered/tool/thinking payloads", () => {
    const original = { type: "text" as const, text: "  **Original**\n  indented  \n", displayText: "Rendered substitute" };
    const message: ChatLine = {
      entryId: "entry", role: "assistant", parts: [
        original,
        { type: "text", text: " \n\t " },
        { type: "thinking", text: "Private reasoning", displayText: "Rendered thinking" },
        { type: "image", mimeType: "image/png", data: "image payload" },
        { type: "toolCall", toolName: "read", summary: "Tool summary", args: { text: "Tool arguments" } },
        { type: "toolExecution", toolName: "read", summary: "Execution summary", status: "success", resultText: "Execution result" },
        { type: "toolResult", toolName: "read", text: "Tool result", isError: false },
        { type: "skillInvocation", name: "example", location: "/skill", content: "Skill instructions" },
        { type: "skillRead", name: "example", path: "/skill/SKILL.md" },
        { type: "empty" },
        { type: "text", text: "\tSecond  line \n" },
      ],
    };
    const snapshot = displayedMessageActionMessage(message);
    expect(snapshot).toEqual({ entryId: "entry", role: "assistant", text: "**Original**\n  indented\n\nSecond  line" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(original.text).toBe("  **Original**\n  indented  \n");
    original.text = "Later stream update";
    expect(snapshot.text).toBe("**Original**\n  indented\n\nSecond  line");
  });

  it("supports entryless displayed messages and yields no copy text for non-text-only headers", () => {
    expect(displayedMessageActionMessage({ role: "user", parts: [{ type: "text", text: " Optimistic " }] }))
      .toEqual({ role: "user", text: "Optimistic" });
    expect(displayedMessageActionMessage({ role: "assistant", parts: [
      { type: "text", text: " \n " },
      { type: "thinking", text: "Thinking" },
      { type: "toolResult", toolName: "read", text: "Result", isError: false },
    ] })).toEqual({ role: "assistant", text: "" });
  });

  it("keeps entry snapshots identified, untrimmed and scoped to the displayed role", () => {
    const message: ChatLine = { entryId: "entry", role: "assistant", parts: [
      { type: "text", text: " Original ", displayText: "Rendered substitute" },
      { type: "thinking", text: "Reasoning" },
      { type: "text", text: "" },
      { type: "text", text: " Tail " },
    ] };
    const snapshot = messageActionMessage(message, "skill");
    expect(snapshot).toEqual({ entryId: "entry", role: "skill", text: " Original \n\n\n\n Tail " });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(messageActionMessage({ role: "user", parts: [{ type: "text", text: "Optimistic" }] })).toBeUndefined();
  });
});

describe("message action availability", () => {
  it("requires display opt-in, preserves disabled actions and supplies custom or fallback labels", () => {
    const entryVisible = vi.fn<NonNullable<EntryMessageActionContribution["visible"]>>(() => true);
    const displayVisible = vi.fn<NonNullable<DisplayedMessageActionContribution["visible"]>>(() => true);
    const displayEnabled = vi.fn<NonNullable<DisplayedMessageActionContribution["enabled"]>>(() => false);
    const displayLabel = vi.fn<NonNullable<DisplayedMessageActionContribution["ariaLabel"]>>(({ message }) => `Copy ${message.role}`);
    const hiddenEnabled = vi.fn(() => true);
    const actions = [
      registered({ id: "default", title: "Default entry", visible: entryVisible, run: () => undefined }),
      registered({ target: "entry", id: "entry", title: "Explicit entry", visible: entryVisible, run: () => undefined }),
      registered({ target: "display", id: "custom", title: "Custom", visible: displayVisible, enabled: displayEnabled, ariaLabel: displayLabel, run: () => undefined }),
      registered({ target: "display", id: "fallback", title: "Fallback", run: () => undefined }),
      registered({ target: "display", id: "hidden", title: "Hidden", visible: () => false, enabled: hiddenEnabled, run: () => undefined }),
    ];
    expect(availableDisplayedMessageActions(actions, displayedInput)).toEqual([
      { action: actions[2], enabled: false, ariaLabel: "Copy assistant" },
      { action: actions[3], enabled: true, ariaLabel: "Fallback" },
    ]);
    for (const callback of [displayVisible, displayEnabled, displayLabel]) {
      expect(callback).toHaveBeenCalledExactlyOnceWith(displayedInput);
    }
    expect(entryVisible).not.toHaveBeenCalled();
    expect(hiddenEnabled).not.toHaveBeenCalled();
    expect(availableMessageActions(actions, input).map(({ action }) => action.id)).toEqual(["default", "entry"]);
    expect(entryVisible).toHaveBeenCalledTimes(2);
    expect(displayVisible).toHaveBeenCalledOnce();
  });

  it("uses displayed slice snapshots without changing entry callback text or conflating same-role headers", () => {
    const entryVisible = vi.fn<NonNullable<EntryMessageActionContribution["visible"]>>(() => true);
    const displayVisible = vi.fn<NonNullable<DisplayedMessageActionContribution["visible"]>>(({ message }) => message.text !== "");
    const actions = [
      registered({ id: "history", title: "History", visible: entryVisible, run: () => undefined }),
      registered({ target: "display", id: "copy", title: "Copy", visible: displayVisible, run: () => undefined }),
    ];
    const source: ChatLine = { entryId: "entry", role: "assistant", parts: [
      { type: "thinking", text: "Reasoning" },
      { type: "text", text: " First " },
      { type: "text", text: " Second " },
    ] };
    const thinking: ChatLine = { ...source, parts: [{ type: "thinking", text: "Reasoning" }] };
    const first: ChatLine = { ...source, parts: [{ type: "text", text: " First " }] };
    const second: ChatLine = { ...source, parts: [{ type: "text", text: " Second " }] };
    const cache = new MessageActionAvailabilityCache();
    const base = { machine: input.machine, session: input.session };
    expect(cache.get(source, actions, base, thinking).map(({ action }) => action.id)).toEqual(["history"]);
    const firstActions = cache.get(source, actions, base, first);
    expect(firstActions.map(({ action }) => action.id)).toEqual(["history", "copy"]);
    expect(displayVisible).toHaveBeenLastCalledWith({ ...base, message: { entryId: "entry", role: "assistant", text: "First" } });
    expect(entryVisible).toHaveBeenLastCalledWith({ ...base, message: { entryId: "entry", role: "assistant", text: " First \n\n Second " } });
    expect(cache.get(source, actions, base, second)).not.toBe(firstActions);
    expect(displayVisible).toHaveBeenLastCalledWith({ ...base, message: { entryId: "entry", role: "assistant", text: "Second" } });
    expect(cache.get(source, [...actions], { machine: { ...base.machine }, session: { ...base.session } }, { ...first })).toBe(firstActions);
    expect(displayVisible).toHaveBeenCalledTimes(3);
    expect(cache.get(source, actions, base, { ...first, role: "skill" })).not.toBe(firstActions);
    expect(entryVisible).toHaveBeenLastCalledWith({ ...base, message: { entryId: "entry", role: "skill", text: " First \n\n Second " } });
    cache.get(source, actions, { ...base, session: { ...base.session, busy: true } }, first);
    expect(displayVisible).toHaveBeenLastCalledWith({ ...base, session: { ...base.session, busy: true }, message: { entryId: "entry", role: "assistant", text: "First" } });
  });

  it("gates default/explicit entry predicates by canonical status and caches that status independently", () => {
    const entryVisible = vi.fn<NonNullable<EntryMessageActionContribution["visible"]>>(() => true);
    const entryEnabled = vi.fn<NonNullable<EntryMessageActionContribution["enabled"]>>(() => false);
    const entryLabel = vi.fn<NonNullable<EntryMessageActionContribution["ariaLabel"]>>(() => "Entry label");
    const displayVisible = vi.fn(() => true);
    const displayEnabled = vi.fn(() => false);
    const displayLabel = vi.fn(() => "Display label");
    const actions = [
      registered({ id: "default", title: "Default entry", visible: entryVisible, enabled: entryEnabled, ariaLabel: entryLabel, run: () => undefined }),
      registered({ target: "display", id: "display", title: "Display", visible: displayVisible, enabled: displayEnabled, ariaLabel: displayLabel, run: () => undefined }),
      registered({ target: "entry", id: "explicit", title: "Explicit entry", visible: entryVisible, enabled: entryEnabled, ariaLabel: entryLabel, run: () => undefined }),
    ];
    const source: ChatLine = { entryId: "shared", role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "reply" }] };
    const slice: ChatLine = { ...source, parts: [{ type: "text", text: "reply" }] };
    const base = { machine: input.machine, session: input.session };
    const cache = new MessageActionAvailabilityCache();
    const noncanonical = cache.get(source, actions, base, slice, false);

    expect(noncanonical).toEqual([{ action: actions[1], enabled: false, ariaLabel: "Display label" }]);
    for (const predicate of [entryVisible, entryEnabled, entryLabel]) expect(predicate).not.toHaveBeenCalled();
    for (const predicate of [displayVisible, displayEnabled, displayLabel]) {
      expect(predicate).toHaveBeenCalledExactlyOnceWith({ ...base, message: { entryId: "shared", role: "assistant", text: "reply" } });
    }
    const canonical = cache.get(source, actions, base, slice, true);
    expect(canonical).toEqual([
      { action: actions[0], enabled: false, ariaLabel: "Entry label" },
      noncanonical[0],
      { action: actions[2], enabled: false, ariaLabel: "Entry label" },
    ]);
    expect(cache.get(source, actions, base, { ...slice })).toBe(canonical);
    expect(cache.get(source, actions, base, { ...slice }, false)).toBe(noncanonical);
    for (const predicate of [entryVisible, entryEnabled, entryLabel]) expect(predicate).toHaveBeenCalledTimes(2);
    for (const predicate of [displayVisible, displayEnabled, displayLabel]) expect(predicate).toHaveBeenCalledTimes(2);
  });

  it("offers only display actions for optimistic or streaming messages without calling entry predicates", () => {
    const entryVisible = vi.fn<NonNullable<EntryMessageActionContribution["visible"]>>(() => true);
    const actions = [
      registered({ id: "history", title: "History", visible: entryVisible, run: () => undefined }),
      registered({ target: "display", id: "copy", title: "Copy", run: () => undefined }),
    ];
    const cache = new MessageActionAvailabilityCache();
    expect(cache.get({ role: "assistant", parts: [{ type: "text", text: "Streaming" }] }, actions, input))
      .toEqual([{ action: actions[1], enabled: true, ariaLabel: "Copy" }]);
    expect(entryVisible).not.toHaveBeenCalled();
  });
});

describe("displayed message action registry", () => {
  it("rechecks visible/enabled at invocation, binds an entryless context without history and returns feedback", async () => {
    const registry = new PluginRegistry();
    const visible = vi.fn<NonNullable<DisplayedMessageActionContribution["visible"]>>(() => true);
    const enabled = vi.fn<NonNullable<DisplayedMessageActionContribution["enabled"]>>(() => true);
    const feedback = { title: "Copied", ariaLabel: "Copied assistant message" };
    const run = vi.fn<DisplayedMessageActionContribution["run"]>().mockResolvedValue(feedback);
    await registry.register({ id: "runtime", sourcePluginId: "source", machineId: "remote", plugin: plugin({ target: "display", id: "copy", title: "Copy", visible, enabled, run }) });
    expect(availableDisplayedMessageActions(registry.getMessageActions("remote"), displayedInput)).toHaveLength(1);
    const invocation = displayedContext();
    const createContext = vi.fn(() => invocation);
    visible.mockReturnValue(false);
    await expect(registry.runDisplayedMessageAction("runtime:copy", displayedInput, createContext)).resolves.toBeUndefined();
    visible.mockReturnValue(true);
    enabled.mockReturnValue(false);
    await expect(registry.runDisplayedMessageAction("runtime:copy", displayedInput, createContext)).resolves.toBeUndefined();
    expect(createContext).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    enabled.mockReturnValue(true);
    await expect(registry.runDisplayedMessageAction("runtime:copy", displayedInput, createContext)).resolves.toBe(feedback);
    expect(visible).toHaveBeenLastCalledWith(displayedInput);
    expect(enabled).toHaveBeenLastCalledWith(displayedInput);
    expect(createContext).toHaveBeenCalledExactlyOnceWith({ registrationPluginId: "runtime", sourcePluginId: "source" });
    expect(run).toHaveBeenCalledExactlyOnceWith(invocation);
    expect(invocation).not.toHaveProperty("history");
    expect(invocation.message).not.toHaveProperty("entryId");
    expect(registry.getMessageActions("local")).toEqual([]);
    await registry.dispose();
  });

  it.each([undefined, "entry"] as const)("keeps target %s entry actions backward compatible and never dispatches across targets", async (target) => {
    const registry = new PluginRegistry();
    const entryRun = vi.fn<EntryMessageActionContribution["run"]>(async ({ history }) => { await history.fork(); });
    const displayRun = vi.fn<DisplayedMessageActionContribution["run"]>();
    await registry.register({ id: "runtime", plugin: plugin(
      { ...(target === undefined ? {} : { target }), id: "history", title: "History", run: entryRun },
      { target: "display", id: "copy", title: "Copy", run: displayRun },
    ) });
    const invocation = context();
    const createEntryContext = vi.fn(() => invocation);
    const createDisplayContext = vi.fn(() => displayedContext());
    await registry.runDisplayedMessageAction("runtime:history", displayedInput, createDisplayContext);
    await registry.runMessageAction("runtime:copy", input, createEntryContext);
    await registry.runDisplayedMessageAction("runtime:missing", displayedInput, createDisplayContext);
    expect(createEntryContext).not.toHaveBeenCalled();
    expect(createDisplayContext).not.toHaveBeenCalled();
    expect(entryRun).not.toHaveBeenCalled();
    expect(displayRun).not.toHaveBeenCalled();
    await expect(registry.runMessageAction("runtime:history", input, createEntryContext)).resolves.toBeUndefined();
    expect(entryRun).toHaveBeenCalledExactlyOnceWith(invocation);
    expect(invocation.history.fork).toHaveBeenCalledOnce();
    await expect(registry.runDisplayedMessageAction("runtime:copy", displayedInput, createDisplayContext)).resolves.toBeUndefined();
    expect(displayRun).toHaveBeenCalledExactlyOnceWith(createDisplayContext.mock.results[0]?.value);
    await registry.dispose();
  });

  it("snapshots definition callbacks so later plugin mutations cannot replace availability or execution", async () => {
    const registry = new PluginRegistry();
    const visible = vi.fn<NonNullable<DisplayedMessageActionContribution["visible"]>>(() => true);
    const enabled = vi.fn<NonNullable<DisplayedMessageActionContribution["enabled"]>>(() => true);
    const ariaLabel = vi.fn<NonNullable<DisplayedMessageActionContribution["ariaLabel"]>>(() => "Original label");
    const feedback = { title: "Original feedback" };
    const run = vi.fn<DisplayedMessageActionContribution["run"]>(() => feedback);
    const action: DisplayedMessageActionContribution = { target: "display", id: "copy", title: "Original", visible, enabled, ariaLabel, run };
    await registry.register({ id: "runtime", plugin: plugin(action) });
    action.id = "replacement";
    action.title = "Replacement";
    action.visible = () => false;
    action.enabled = () => false;
    action.ariaLabel = () => "Replacement label";
    action.run = () => { throw new Error("Replacement callback must not run"); };
    const actions = registry.getMessageActions("remote");
    expect(Object.isFrozen(actions[0])).toBe(true);
    expect(availableDisplayedMessageActions(actions, displayedInput)).toEqual([
      { action: actions[0], enabled: true, ariaLabel: "Original label" },
    ]);
    expect(actions[0]).toMatchObject({ id: "runtime:copy", title: "Original", target: "display" });
    const invocation = displayedContext();
    await expect(registry.runDisplayedMessageAction("runtime:copy", displayedInput, () => invocation)).resolves.toBe(feedback);
    for (const callback of [visible, enabled, ariaLabel]) expect(callback).toHaveBeenLastCalledWith(displayedInput);
    expect(run).toHaveBeenCalledExactlyOnceWith(invocation);
    await registry.dispose();
  });

  it("gates portable display actions on the initiating machine and stops stale invocations at shutdown/disposal", async () => {
    let active = true;
    const gate = vi.fn((_pluginId: string, machineId: string | undefined) => active && machineId === "remote");
    const registry = new PluginRegistry({ isContributionEnabled: gate });
    const visible = vi.fn<NonNullable<DisplayedMessageActionContribution["visible"]>>(() => true);
    const run = vi.fn<DisplayedMessageActionContribution["run"]>();
    await registry.register({ id: "portable", plugin: plugin({ target: "display", id: "copy", title: "Copy", visible, run }) });
    expect(registry.getMessageActions("remote").map((action) => action.id)).toEqual(["portable:copy"]);
    const createContext = vi.fn(() => displayedContext());
    const otherMachine = { ...displayedInput, machine: { ...displayedInput.machine, id: "local" } };
    await registry.runDisplayedMessageAction("portable:copy", otherMachine, createContext);
    expect(gate).toHaveBeenLastCalledWith("portable", "local");
    active = false;
    await registry.runDisplayedMessageAction("portable:copy", displayedInput, createContext);
    expect(gate).toHaveBeenLastCalledWith("portable", "remote");
    expect(visible).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    active = true;
    await registry.runDisplayedMessageAction("portable:copy", displayedInput, createContext);
    expect(run).toHaveBeenCalledOnce();
    registry.beginShutdown();
    expect(registry.getMessageActions("remote")).toEqual([]);
    await registry.runDisplayedMessageAction("portable:copy", displayedInput, createContext);
    await registry.dispose();
    await registry.runDisplayedMessageAction("portable:copy", displayedInput, createContext);
    expect(visible).toHaveBeenCalledOnce();
    expect(createContext).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("message action registry", () => {
  it("qualifies actions, supplies the exact package binding and rechecks click-time availability", async () => {
    let enabled = true;
    const registry = new PluginRegistry();
    const run = vi.fn<EntryMessageActionContribution["run"]>();
    await registry.register({ id: "runtime", sourcePluginId: "source", machineId: "remote", plugin: plugin({ id: "note", title: "Note", enabled: () => enabled, run }) });
    expect(registry.getMessageActions("remote").map((action) => action.id)).toEqual(["runtime:note"]);
    const createContext = vi.fn(() => context());
    enabled = false;
    await registry.runMessageAction("runtime:note", input, createContext);
    expect(createContext).not.toHaveBeenCalled();
    enabled = true;
    await registry.runMessageAction("runtime:note", input, createContext);
    expect(createContext).toHaveBeenCalledExactlyOnceWith({ registrationPluginId: "runtime", sourcePluginId: "source" });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject(input);
    expect(registry.getMessageActions("local")).toEqual([]);
    await registry.dispose();
  });

  it("uses portable/machine-specific precedence, live lifecycle gating and disposal", async () => {
    let active = true;
    const registry = new PluginRegistry({ isContributionEnabled: () => active });
    const run = vi.fn<EntryMessageActionContribution["run"]>();
    const action = { id: "note", title: "Note", run };
    await registry.register({ id: "gateway", machineSpecific: true, plugin: plugin(action) });
    await registry.register({ id: "remote-instance", sourcePluginId: "gateway", machineId: "remote", machineSpecific: true, plugin: plugin(action) });
    expect(registry.getMessageActions("local").map((item) => item.id)).toEqual(["gateway:note"]);
    expect(registry.getMessageActions("remote").map((item) => item.id)).toEqual(["remote-instance:note"]);
    expect(registry.getMessageActions("other")).toEqual([]);
    active = false;
    await registry.runMessageAction("remote-instance:note", input, context);
    expect(run).not.toHaveBeenCalled();
    active = true;
    await registry.dispose();
    expect(registry.getMessageActions("remote")).toEqual([]);
    await registry.runMessageAction("remote-instance:note", input, context);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["entry", "display"] as const)("never publishes failed-start or duplicate %s contributions", async (target) => {
    const registry = new PluginRegistry();
    const action: MessageActionContribution = { target, id: "note", title: "Note", run: () => undefined };
    await expect(registry.register({ id: "failed", plugin: {
      ...plugin(action), activate: () => ({ contributions: { messageActions: [action] }, start: () => { throw new Error("start failed"); } }),
    } })).rejects.toThrow("start failed");
    await expect(registry.register({ id: "duplicate", plugin: {
      ...plugin(action), activate: () => ({ contributions: { messageActions: [action, action] } }),
    } })).rejects.toThrow("Duplicate contribution id");
    expect(registry.getMessageActions("local")).toEqual([]);
    await registry.dispose();
  });
});
