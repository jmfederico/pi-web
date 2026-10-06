// @vitest-environment happy-dom
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPromptEditor } from "../../../plugin-api";
import { api, type Machine, type SessionInfo, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { adaptPublicPlugin } from "../plugins/publicContext";
import { PluginRegistry } from "../plugins/registry";
import type { ApplicationPanelContext, PluginRuntimeContext, WorkspacePanelContext } from "../plugins/types";
import { PiWebApp } from "./PiWebApp";
import { PromptEditor } from "./PromptEditor";

const session: SessionInfo = { id: "conversation", cwd: "/repo", path: "/repo/session.jsonl", created: "now", modified: "now", messageCount: 1, firstMessage: "Hi" };
const workspace: Workspace = { id: "workspace", projectId: "project", path: "/repo", label: "Main", isMain: true, effectiveConfig: {} };
const local: Machine = { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" };
const remote: Machine = { ...local, id: "remote", name: "Remote", kind: "remote" };
const registries: PluginRegistry[] = [];

beforeEach(() => {
  vi.spyOn(api, "commands").mockResolvedValue([]);
});

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

/** Render the real app template without starting unrelated bootstrap/network loops. */
async function composerHost() {
  const app = new PiWebApp();
  const registry = field(app, "plugins", PluginRegistry);
  registries.push(registry);
  await registry.registerBatch([]);
  const controller = field(app, "sessions", SessionController);
  const modes: unknown = Reflect.get(app, "verifiedPluginModeByMachine");
  if (!(modes instanceof Map)) throw new Error("Plugin lifecycle modes unavailable");
  modes.set("local", "recovery-disabled");
  modes.set("remote", "recovery-disabled");
  let state: AppState = { ...initialAppState(), selectedMachine: local, selectedWorkspace: workspace, selectedSession: session, sessions: [session] };
  Reflect.set(app, "state", state);
  const host = document.createElement("div");
  document.body.append(host);
  const refresh = async () => {
    render(app.render(), host);
    const editor = host.querySelector("prompt-editor");
    if (!(editor instanceof PromptEditor)) throw new Error("Composer not rendered");
    Object.defineProperty(app, "promptEditor", { configurable: true, value: editor });
    await editor.updateComplete;
    return editor;
  };
  const select = async (machine: Machine, selectedSession: SessionInfo = session) => {
    state = { ...state, selectedMachine: machine, selectedSession };
    Reflect.set(app, "state", state);
    return refresh();
  };
  const pluginPrompt = async (id: string) => {
    let prompt: PluginPromptEditor | undefined;
    await registry.register({ id, plugin: adaptPublicPlugin({ apiVersion: 4, name: id, activate: () => ({ contributions: {
      actions: [{ id: "capture", title: id, run: (context) => { prompt = context.prompt; } }],
      applicationPanels: [{ id: "application", title: id, render: (context) => { prompt = context.prompt; return html`Panel`; } }],
      workspacePanels: [{ id: "workspace", title: id, render: (context) => { prompt = context.prompt; return html`Panel`; } }],
    } }) }) });
    const context = contextFrom(app, "createPluginRuntimeContext", isRuntimeContext);
    await registry.getActions(context).find((action) => action.pluginId === id)?.run();
    if (prompt === undefined) throw new Error("Enabled plugin did not receive its prompt facade");
    return { prompt, captured: () => prompt };
  };
  const sendApi = (prompt: typeof api.prompt, extra: Partial<typeof api> = {}) => {
    Reflect.set(controller, "api", { ...api, ...extra, prompt });
  };
  const remount = async () => {
    render(null, host);
    return refresh();
  };
  return { app, registry, refresh, select, pluginPrompt, sendApi, remount };
}

describe("plugin context → composer → server submission", () => {
  it("shows removable labels, notifies their owner and supports silent withdrawal", async () => {
    const host = await composerHost();
    const { prompt } = await host.pluginPrompt("source");
    const onRemove = vi.fn();
    prompt.setChip?.({ id: "note", label: "Selected note", text: "Context", onRemove });
    const editor = await host.refresh();
    expect(editor.shadowRoot?.querySelector('[aria-label="Pending plugin context"]')?.textContent).toContain("Selected note");
    editor.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Remove Selected note"]')?.click();
    await host.refresh();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("user");
    expect(editor.shadowRoot?.querySelector(".prompt-chip")).toBeNull();
    prompt.setChip?.({ id: "note", label: "Selected note", text: "New context", onRemove });
    prompt.removeChip?.("note");
    await host.refresh();
    expect(editor.shadowRoot?.querySelector(".prompt-chip")).toBeNull();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it.each(["/login", "!pwd", ""])("sends %j as an ordinary prompt with context, and waits for server acceptance", async (text) => {
    const host = await composerHost();
    const { prompt } = await host.pluginPrompt("source");
    const onRemove = vi.fn();
    prompt.setChip?.({ id: "note", label: "Note", text: "Context", onRemove });
    let accept: ((value: { accepted: true }) => void) | undefined;
    const request = vi.fn<typeof api.prompt>(() => new Promise((resolve) => { accept = resolve; }));
    const command = vi.fn<typeof api.runCommand>(), shell = vi.fn<typeof api.shell>();
    host.sendApi(request, { runCommand: command, shell });
    const editor = await host.refresh();
    editor.replaceText(text);
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    // Double-click before Lit commits sending state must not duplicate delivery.
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    expect(request).toHaveBeenCalledExactlyOnceWith(session, text === "" ? "Context" : `${text}\n\nContext`, undefined, "local", undefined);
    expect(command).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(host.registry.promptChips.list({ machineId: "local", sessionId: session.id })).toHaveLength(1);
    accept?.({ accepted: true });
    await vi.waitFor(() => { expect(onRemove).toHaveBeenCalledExactlyOnceWith("submitted"); });
    await host.refresh();
    expect(editor.shadowRoot?.querySelector(".prompt-chip")).toBeNull();
    expect(editor.view?.state.doc.toString()).toBe("");
  });

  it("retains chips and the user's draft on failure, then retries successfully", async () => {
    const host = await composerHost();
    const { prompt } = await host.pluginPrompt("source");
    const onRemove = vi.fn();
    prompt.setChip?.({ id: "note", label: "Note", text: "Context", onRemove });
    const request = vi.fn<typeof api.prompt>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ accepted: true });
    host.sendApi(request);
    const editor = await host.refresh();
    editor.replaceText("Question");
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    await vi.waitFor(() => { expect(editor.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("kept for retry"); });
    expect(editor.view?.state.doc.toString()).toBe("Question");
    expect(onRemove).not.toHaveBeenCalled();
    expect(editor.shadowRoot?.querySelector(".prompt-chip")).not.toBeNull();
    await host.refresh();
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    await vi.waitFor(() => { expect(onRemove).toHaveBeenCalledExactlyOnceWith("submitted"); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("restages plugin-saved data through a fresh public facade with new callbacks", async () => {
    const saved = { id: "saved-note", label: "Saved note", text: "Saved context" };
    const original = await composerHost();
    const beforeReload = await original.pluginPrompt("source");
    const oldCallback = vi.fn();
    beforeReload.prompt.setChip?.({ ...saved, onRemove: oldCallback });
    await original.registry.dispose();

    const restored = await composerHost();
    const afterReload = await restored.pluginPrompt("source");
    const callback = vi.fn();
    expect(restored.registry.promptChips.list({ machineId: "local", sessionId: session.id })).toEqual([]);
    afterReload.prompt.setChip?.({ ...saved, onRemove: callback });
    afterReload.prompt.setChip?.({ ...saved, onRemove: callback });
    restored.sendApi(() => Promise.resolve({ accepted: true }));
    const editor = await restored.refresh();
    expect(editor.shadowRoot?.querySelectorAll(".prompt-chip")).toHaveLength(1);
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    await vi.waitFor(() => { expect(callback).toHaveBeenCalledExactlyOnceWith("submitted"); });
    expect(oldCallback).not.toHaveBeenCalled();
  });

  it("keeps ownership and captured targets across panel closure and navigation", async () => {
    const host = await composerHost();
    const first = await host.pluginPrompt("first");
    const second = await host.pluginPrompt("second");
    // Both panel context factories must supply the registration's own facade.
    host.registry.getApplicationPanels().find((panel) => panel.pluginId === "first")?.render(contextFrom(host.app, "createApplicationPanelContext", isApplicationContext));
    first.captured()?.setChip?.({ id: "same", label: "First", text: "One" });
    host.registry.getWorkspacePanels().find((panel) => panel.pluginId === "second")?.render(contextFrom(host.app, "createWorkspacePanelContext", isWorkspaceContext, workspace));
    second.captured()?.setChip?.({ id: "same", label: "Second", text: "Two" });
    let editor = await host.refresh();
    expect(editor.shadowRoot?.querySelectorAll(".prompt-chip")).toHaveLength(2);
    editor = await host.select(local, { ...session, id: "other" });
    expect(editor.shadowRoot?.querySelector(".prompt-chip")).toBeNull();
    // Retaining a facade targets its original conversation, not the visible one.
    first.prompt.setChip?.({ id: "same", label: "Updated first", text: "Updated" });
    await host.refresh();
    expect(editor.shadowRoot?.querySelector(".prompt-chip")).toBeNull();
    editor = await host.select(remote);
    expect(editor.shadowRoot?.querySelector(".prompt-chip")).toBeNull();
    editor = await host.select(local);
    expect(editor.shadowRoot?.textContent).toContain("Updated first");
    expect(editor.shadowRoot?.textContent).toContain("Second");
    first.prompt.removeChip?.("same");
    await host.refresh();
    expect(editor.shadowRoot?.querySelectorAll(".prompt-chip")).toHaveLength(1);
    expect(editor.shadowRoot?.textContent).toContain("Second");
  });

  it("does not let an obsolete composer erase a remounted composer's draft", async () => {
    const host = await composerHost();
    const { prompt } = await host.pluginPrompt("source");
    prompt.setChip?.({ id: "note", label: "Note", text: "Context" });
    let accept: ((value: { accepted: true }) => void) | undefined;
    host.sendApi(() => new Promise((resolve) => { accept = resolve; }));
    const editor = await host.refresh();
    editor.replaceText("Original");
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    const replacement = await host.remount();
    replacement.replaceText("New draft after remount");
    accept?.({ accepted: true });
    await vi.waitFor(() => { expect(host.registry.promptChips.list({ machineId: "local", sessionId: session.id })).toEqual([]); });
    const restored = await host.remount();
    expect(restored.view?.state.doc.toString()).toBe("New draft after remount");
  });

  it("does not erase another conversation or edits made while a send is pending", async () => {
    const host = await composerHost();
    const { prompt } = await host.pluginPrompt("source");
    prompt.setChip?.({ id: "note", label: "Note", text: "Context" });
    let accept: ((value: { accepted: true }) => void) | undefined;
    host.sendApi(() => new Promise((resolve) => { accept = resolve; }));
    const editor = await host.refresh();
    editor.replaceText("Original");
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    await host.select(local, { ...session, id: "other" });
    editor.replaceText("Next conversation draft");
    accept?.({ accepted: true });
    await vi.waitFor(() => { expect(host.registry.promptChips.list({ machineId: "local", sessionId: session.id })).toEqual([]); });
    expect(editor.view?.state.doc.toString()).toBe("Next conversation draft");
    await host.select(local);
    prompt.setChip?.({ id: "note", label: "Note", text: "More context" });
    await host.refresh();
    editor.replaceText("Before send");
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    editor.replaceText("Edited during send");
    accept?.({ accepted: true });
    await vi.waitFor(() => { expect(host.registry.promptChips.list({ machineId: "local", sessionId: session.id })).toEqual([]); });
    expect(editor.view?.state.doc.toString()).toBe("Edited during send");
  });
});

function field<T>(app: PiWebApp, key: string, constructor: new (...args: never[]) => T): T {
  const value: unknown = Reflect.get(app, key);
  if (!(value instanceof constructor)) throw new Error(`Missing ${key}`);
  return value;
}

function contextFrom<T>(app: PiWebApp, key: string, isContext: (value: unknown) => value is T, ...args: unknown[]): T {
  const method: unknown = Reflect.get(app, key);
  if (typeof method !== "function") throw new Error(`Missing ${key}`);
  const value: unknown = Reflect.apply(method, app, args);
  if (!isContext(value)) throw new Error(`Invalid ${key} context`);
  return value;
}

function isRuntimeContext(value: unknown): value is PluginRuntimeContext {
  return typeof value === "object" && value !== null && "openActionPalette" in value;
}

function isApplicationContext(value: unknown): value is ApplicationPanelContext {
  return typeof value === "object" && value !== null && "machine" in value && "prompt" in value;
}

function isWorkspaceContext(value: unknown): value is WorkspacePanelContext {
  return isApplicationContext(value) && "files" in value;
}
