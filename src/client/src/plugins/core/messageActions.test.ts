import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayedMessageActionContext, DisplayedMessageActionContribution, MessageActionAvailabilityContext } from "../../../../plugin-api";
import { availableDisplayedMessageActions, availableMessageActions } from "../messageActions";
import { createCoreMessageActions } from "./messageActions";

const input: MessageActionAvailabilityContext = {
  machine: { id: "local", name: "Local", kind: "local" },
  session: { id: "session", cwd: "/repo", archived: false, pending: false, busy: false },
  message: { entryId: "entry", role: "assistant", text: "Original text" },
};

function copyAction(writeText: (text: string) => Promise<boolean>): DisplayedMessageActionContribution {
  const action = createCoreMessageActions(writeText).find((action) => action.id === "message.copy");
  if (action?.target !== "display") throw new Error("Expected a display-targeted core Copy action");
  return action;
}

function invocation(role: "user" | "assistant" = "assistant"): DisplayedMessageActionContext {
  return {
    machine: input.machine,
    session: input.session,
    message: { role, text: "**Original**\n\nSecond  line" },
    navigate: vi.fn(),
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    projects: { machineId: "local", listProjects: vi.fn(), suggestDirectories: vi.fn() },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("core display Copy action", () => {
  it.each([
    { state: "ready", flags: { busy: false, archived: false, pending: false } },
    { state: "busy", flags: { busy: true, archived: false, pending: false } },
    { state: "archived", flags: { busy: false, archived: true, pending: false } },
    { state: "pending", flags: { busy: false, archived: false, pending: true } },
    { state: "busy, archived and pending", flags: { busy: true, archived: true, pending: true } },
  ])("leaves Copy available for entryless user/assistant text while $state without weakening history policy", ({ flags }) => {
    const writeText = vi.fn<(text: string) => Promise<boolean>>();
    const actions = createCoreMessageActions(writeText).map((action) => ({
      ...action, binding: { registrationPluginId: "core", sourcePluginId: "core" },
    }));
    for (const role of ["user", "assistant"] as const) {
      const session = { ...input.session, ...flags };
      const displayInput = { machine: input.machine, session, message: { role, text: "Original text" } };
      const available = availableDisplayedMessageActions(actions, displayInput);
      expect(available).toHaveLength(1);
      expect(available[0]).toMatchObject({
        action: { id: "message.copy", title: "Copy message", target: "display" },
        enabled: true,
        ariaLabel: `Copy ${role} message`,
      });
      const history = availableMessageActions(actions, { ...input, session, message: { ...input.message, role } });
      expect(history.map(({ action, enabled }) => ({ id: action.id, enabled }))).toEqual([
        { id: "message.fork", enabled: !flags.busy && !flags.archived && !flags.pending },
        { id: "message.back", enabled: !flags.busy && !flags.archived && !flags.pending },
      ]);
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    { role: "user", text: "" },
    { role: "assistant", text: "" },
    { role: "tool", text: "Tool output" },
    { role: "system", text: "System message" },
    { role: "bash", text: "Command output" },
    { role: "skill", text: "Skill instructions" },
  ] as const)("does not offer Copy for $role with text '$text'", ({ role, text }) => {
    const writeText = vi.fn<(text: string) => Promise<boolean>>();
    const actions = createCoreMessageActions(writeText).map((action) => ({
      ...action, binding: { registrationPluginId: "core", sourcePluginId: "core" },
    }));
    expect(availableDisplayedMessageActions(actions, { ...input, message: { role, text } })).toEqual([]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each(["user", "assistant"] as const)("copies %s original text through the injected helper and returns success feedback without confirmation", async (role) => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    const writeText = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
    const action = copyAction(writeText);
    const context = invocation(role);
    const feedback = await action.run(context);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("**Original**\n\nSecond  line");
    expect(confirm).not.toHaveBeenCalled();
    expect(context).not.toHaveProperty("history");
    expect(feedback).toMatchObject({ title: "Copied", ariaLabel: `Copied ${role} message` });
    expect(feedback).toHaveProperty("icon");
    expect(feedback).not.toMatchObject({ icon: action.icon });
  });

  it("fails visibly instead of returning success feedback when the clipboard helper reports failure", async () => {
    const writeText = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(false);
    await expect(copyAction(writeText).run(invocation())).rejects.toThrow("Unable to copy message to the clipboard.");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("**Original**\n\nSecond  line");
  });

  it("propagates a rejected clipboard write rather than disguising it as success", async () => {
    const failure = new Error("Clipboard denied");
    const writeText = vi.fn<(text: string) => Promise<boolean>>().mockRejectedValue(failure);
    await expect(copyAction(writeText).run(invocation())).rejects.toBe(failure);
    expect(writeText).toHaveBeenCalledOnce();
  });
});
