// @vitest-environment happy-dom
import type { JsonValue, PluginCatalog, PluginPeerRequestOptions, PluginRuntimeContextV5, PluginSelectionService } from "@jmfederico/pi-web/plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./pi-web-plugin.js";
import { LocalizationService } from "../../../src/client/src/localization/service.js";
import { createPluginLocalization } from "../../../src/client/src/plugins/localization.js";

const prepared = { workspaceId: "main-tree", workspacePath: "/repo", branches: ["main", "origin/main", "feature"], defaultBase: "main" };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup(request = vi.fn<(operation: string, input: JsonValue, options?: PluginPeerRequestOptions) => Promise<JsonValue>>((operation) => Promise.resolve(operation === "prepare" ? prepared : { workspaceId: "main-tree", sessionId: "fresh-session" })), selection?: PluginSelectionService) {
  const lifetime = new AbortController();
  const service = new LocalizationService({ development: true, preferences: { language: "en", formatLocale: "en-US" } });
  const localization = createPluginLocalization(service, "workflows", "@jmfederico/pi-web-workflows", lifetime.signal);
  const activation = plugin.activate({ lifetimeSignal: lifetime.signal, localization, ...(selection ? { selection } : {}) });
  const releaseStyles = vi.fn();
  const registerRoot = vi.fn(() => releaseStyles);
  activation.start({
    capabilities: { resolve: capability => capability.parse({ registerRoot, createController: vi.fn(), subscribe: vi.fn() }) },
    signal: lifetime.signal,
  });
  disposals.push(() => { activation.dispose(); lifetime.abort(); });
  const action = activation.contributions.actions[0];
  if (!action) throw new Error("Worktree action missing");
  const catalog: PluginCatalog = {
    version: 1, machineId: "remote",
    projects: { list: vi.fn(), get: vi.fn() },
    workspaces: { list: vi.fn(), get: vi.fn() },
    sessions: { list: vi.fn(), get: vi.fn() },
  };
  const forScope = vi.fn(() => ({ request, openChannel: vi.fn() }));
  const context = {
    state: { mainView: "workspace", selectedProject: { id: "project", name: "Example", path: "/repo" }, selectedWorkspace: { id: "feature-tree", projectId: "project", label: "Feature", path: "/repo-feature", isMain: false } },
    catalog, backend: { machineId: "remote", forScope }, navigate: vi.fn(() => Promise.resolve()),
    prompt: { insertText: vi.fn(), getText: () => "existing draft", getSelection: () => null },
  } satisfies Pick<PluginRuntimeContextV5, "state" | "catalog" | "backend" | "navigate" | "prompt">;
  return { action, activation, context, request, forScope, lifetime, service, localization, registerRoot, releaseStyles };
}
function root(): ShadowRoot {
  const shadow = document.body.firstElementChild?.shadowRoot;
  if (!shadow) throw new Error("Worktree dialog missing");
  return shadow;
}
function control<T extends Element>(selector: string, constructor: new () => T): T {
  const value = root().querySelector(selector);
  if (!(value instanceof constructor)) throw new Error(`Missing dialog control: ${selector}`);
  return value;
}
async function open(target: ReturnType<typeof setup>) {
  target.action.run(target.context);
  await vi.waitFor(() => { expect(control("#base", HTMLInputElement).disabled).toBe(false); });
}
function submit() { control("form", HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }

describe("Workflows worktree dialog", () => {
  it("registers shared UI styles for the dialog and releases them on close", async () => {
    const target = setup();
    await open(target);
    expect(target.registerRoot).toHaveBeenCalledExactlyOnceWith(root(), { sharedUi: true });
    control("#cancel", HTMLButtonElement).click();
    expect(target.releaseStyles).toHaveBeenCalledOnce();
  });

  it("updates live labels, validation and direction without replacing fields or repeating requests", async () => {
    const target = setup();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    target.action.run(target.context);
    // The opener is deliberately outside the plugin host.
    const shadow = document.body.lastElementChild?.shadowRoot;
    if (!shadow) throw new Error("Worktree dialog missing");
    const base = shadow.querySelector<HTMLInputElement>("#base");
    const description = shadow.querySelector<HTMLTextAreaElement>("#description");
    const form = shadow.querySelector<HTMLFormElement>("form");
    if (!base || !description || !form) throw new Error("Worktree fields missing");
    await vi.waitFor(() => { expect(base.disabled).toBe(false); });
    base.value = "origin/main";
    description.value = "  ";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    const englishError = shadow.querySelector("#error")?.textContent;
    description.value = "User purpose <script>";
    description.focus();
    await target.service.setPreferences({ language: "ar-XB", formatLocale: "ar-EG" });
    expect(target.action.title).not.toBe("Create Worktree");
    expect(target.action.description).not.toBe("Choose a base branch and purpose, then start a new conversation in the main workspace");
    expect(target.action.group).not.toBe("Workflows");
    expect(target.action.disabledReason()).not.toBe("Select a project with the Workflows backend available first.");
    expect(document.body.lastElementChild?.getAttribute("dir")).toBe("rtl");
    expect(shadow.querySelector("#error")?.textContent).not.toBe(englishError);
    expect(shadow.querySelector("#base")).toBe(base);
    expect(base.value).toBe("origin/main");
    expect(description.value).toBe("User purpose <script>");
    expect(shadow.activeElement).toBe(description);
    expect(target.request).toHaveBeenCalledTimes(1);
    shadow.querySelector<HTMLButtonElement>("#cancel")?.click();
    expect(document.activeElement).toBe(opener);
    await target.service.setPreferences({ language: "en", formatLocale: "en-US" });
    expect(shadow.querySelector("h2")?.textContent).not.toBe("Create worktree");
  });

  it("localizes retained browser protocol errors but preserves identical backend diagnostics", async () => {
    const malformed = setup(vi.fn(() => Promise.resolve({ ...prepared, branches: 1 })));
    malformed.action.run(malformed.context);
    await vi.waitFor(() => { expect(control("#error", Element).textContent).toBe("Invalid branch list from Workflows."); });
    await malformed.service.setPreferences({ language: "en-XA", formatLocale: "en-US" });
    expect(control("#error", Element).textContent).not.toBe("Invalid branch list from Workflows.");
    malformed.activation.dispose();
    const backend = setup(vi.fn(() => Promise.reject(new Error("Invalid branch list from Workflows."))));
    backend.action.run(backend.context);
    await vi.waitFor(() => { expect(control("#error", Element).textContent).toBe("Invalid branch list from Workflows."); });
    await backend.service.setPreferences({ language: "ar-XB", formatLocale: "en-US" });
    expect(control("#error", Element).textContent).toBe("Invalid branch list from Workflows.");
    expect(control("#status", Element).textContent).not.toBe("Could not load worktree options.");
  });

  it("updates uncertain dispatch recovery live without permitting another dispatch", async () => {
    const target = setup(vi.fn((operation) => operation === "prepare" ? Promise.resolve(prepared) : Promise.reject(new Error("Backend <failure>"))));
    await open(target);
    control("#description", HTMLTextAreaElement).value = "Fix login";
    submit();
    await vi.waitFor(() => { expect(control("#cancel", Element).textContent).toBe("Close"); });
    await target.service.setPreferences({ language: "en-XA", formatLocale: "en-US" });
    expect(control("#error", Element).textContent).toContain("Backend <failure>");
    expect(control("#error", Element).querySelector("failure")).toBeNull();
    expect(control("#cancel", Element).textContent).not.toBe("Close");
    expect(control("#status", Element).textContent).not.toBe("Dispatch could not be confirmed.");
    submit();
    expect(target.request).toHaveBeenCalledTimes(2);
    expect(control("button[type=submit]", HTMLButtonElement).disabled).toBe(true);
  });

  it("works without a conversation, captures the project's machine, and preserves the composer", async () => {
    const target = setup();
    expect(target.action.enabled(target.context)).toBe(true);
    await open(target);
    expect(target.forScope).toHaveBeenCalledExactlyOnceWith({ kind: "project", projectId: "project" });
    expect(control("#base", HTMLInputElement).value).toBe("main");
    expect(Array.from(control("#branches", HTMLDataListElement).options, (option) => option.value)).toEqual(prepared.branches);
    expect(control("#status", Element).textContent).toContain("/repo");
    expect(target.context.prompt.insertText).not.toHaveBeenCalled();
    control("#description", HTMLTextAreaElement).value = " Fix login redirects ";
    control("#base", HTMLInputElement).value = "origin/main";
    submit(); submit();
    await vi.waitFor(() => { expect(target.context.navigate).toHaveBeenCalledExactlyOnceWith({ machineId: "remote", projectId: "project", workspaceId: "main-tree", sessionId: "fresh-session", view: "chat" }); });
    const calls = target.request.mock.calls.filter(([operation]) => operation === "dispatch");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["dispatch", { base: "origin/main", description: "Fix login redirects" }]);
    expect(calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(document.body.children).toHaveLength(0);
    expect(target.context.prompt.insertText).not.toHaveBeenCalled();
  });

  it("requires a selected project and paired backend, not an empty Chat prompt", () => {
    const target = setup();
    expect(target.action.enabled({ ...target.context, state: {} })).toBe(false);
    expect(target.action.enabled({ state: target.context.state })).toBe(false);
    target.action.run({ ...target.context, state: {} });
    expect(target.request).not.toHaveBeenCalled();
    expect(document.body.children).toHaveLength(0);
  });

  it("rejects whitespace descriptions and lets Cancel close without dispatch", async () => {
    const target = setup();
    await open(target);
    control("#description", HTMLTextAreaElement).value = "  ";
    submit();
    expect(control("#error", Element).textContent).toContain("purpose or description");
    control("#cancel", HTMLButtonElement).click();
    expect(target.request).toHaveBeenCalledTimes(1);
    expect(document.body.children).toHaveLength(0);
  });

  it("shows preparation failures without admitting a session", async () => {
    const target = setup(vi.fn(() => Promise.reject(new Error("No main workspace"))));
    target.action.run(target.context);
    await vi.waitFor(() => { expect(control("#error", Element).textContent).toBe("No main workspace"); });
    expect(control("button[type=submit]", HTMLButtonElement).disabled).toBe(true);
    expect(target.context.navigate).not.toHaveBeenCalled();
  });

  it("does not offer blind retries after an uncertain dispatch failure", async () => {
    const target = setup(vi.fn((operation) => operation === "prepare" ? Promise.resolve(prepared) : Promise.reject(new Error("Connection lost"))));
    await open(target);
    control("#description", HTMLTextAreaElement).value = "Fix login";
    submit();
    await vi.waitFor(() => { expect(control("#error", Element).textContent).toContain("Check Sessions before trying again"); });
    expect(control("button[type=submit]", HTMLButtonElement).disabled).toBe(true);
    expect(control("#cancel", Element).textContent).toBe("Close");
    submit();
    expect(target.request).toHaveBeenCalledTimes(2);
  });

  it("reports the existing session when navigation fails, without dispatching again", async () => {
    const target = setup();
    target.context.navigate.mockRejectedValue(new Error("Navigation failed"));
    await open(target);
    control("#description", HTMLTextAreaElement).value = "Fix login";
    submit();
    await vi.waitFor(() => { expect(control("#error", Element).textContent).toContain("Open conversation fresh-session in Sessions"); });
    submit();
    expect(target.request).toHaveBeenCalledTimes(2);
  });

  it("cleans up and discards preparation results after disposal", async () => {
    let resolve: (value: JsonValue) => void = () => { throw new Error("Request not started"); };
    const target = setup(vi.fn(() => new Promise<JsonValue>((done) => { resolve = done; })));
    target.action.run(target.context);
    const options = target.request.mock.calls[0]?.[2];
    target.activation.dispose();
    expect(options?.signal?.aborted).toBe(true);
    resolve(prepared);
    await Promise.resolve();
    expect(document.body.children).toHaveLength(0);
    expect(target.context.navigate).not.toHaveBeenCalled();
  });

  it("closes on project/machine changes and unsubscribes on plugin shutdown", async () => {
    let changed: Parameters<PluginSelectionService["subscribe"]>[0] = () => undefined;
    const unsubscribe = vi.fn();
    const selection: PluginSelectionService = { getSnapshot: () => ({}), subscribe: (listener) => { changed = listener; return unsubscribe; } };
    const target = setup(undefined, selection);
    await open(target);
    await changed({ selectedMachine: { id: "other-machine", name: "Other", kind: "remote" } });
    expect(document.body.children).toHaveLength(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    await open(target);
    target.lifetime.abort();
    expect(document.body.children).toHaveLength(0);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
