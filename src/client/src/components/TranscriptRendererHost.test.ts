// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { html } from "lit";
import type { TranscriptToolRenderer, TranscriptToolRendererInput, TranscriptToolRendererResolver, TranscriptMessageRendererInput } from "../../../plugin-api";
import type { ChatLine, ToolExecutionPart } from "../chatTypes";
import type { RegisteredTranscriptRenderer } from "../plugins/transcriptRenderers";
import { PluginRegistry } from "../plugins/registry";
import { adaptPublicPlugin } from "../plugins/publicContext";
import * as backendTransport from "../api/pluginBackends";
import { TranscriptRendererHost } from "./TranscriptRendererHost";
import { ChatView } from "./ChatView";
import { normalizeMessages } from "../chatMessages";
import { applyTranscriptEvent } from "../chatTranscript";

const scope = Object.freeze({ machineId: "remote", sessionId: "session", projectId: "project", workspaceId: "workspace" });
function toolRenderer(render: TranscriptToolRenderer["render"]): Extract<RegisteredTranscriptRenderer, { target: "tool" }> {
  return { id: "plugin:tool", pluginId: "plugin", localId: "tool", target: "tool",
    resolve: (toolName, next) => toolName === "read" ? { render } : next() };
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing transcript element");
  return value;
}
function mount(render: Parameters<typeof toolRenderer>[0]) {
  const host = new TranscriptRendererHost();
  host.scope = scope;
  host.itemKey = "call";
  host.request = { kind: "tool", renderers: [toolRenderer(render)], entry: { toolName: "read", status: "running", args: { path: "file.txt" } } };
  host.append(document.createTextNode("Original output"));
  document.body.append(host);
  return host;
}
function button(host: TranscriptRendererHost): HTMLButtonElement { return required(host.shadowRoot?.querySelector("button")); }

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("lets the reader switch to the host view, cancels work, and retains that choice through updates", async () => {
  const inputs: TranscriptToolRendererInput[] = [];
  const render = vi.fn((input: TranscriptToolRendererInput) => { inputs.push(input); return html`<strong>${input.entry.status}</strong>`; });
  const host = mount(render);
  await host.updateComplete;
  expect(host.shadowRoot?.querySelector("strong")?.textContent).toBe("running");
  expect(inputs[0]?.scope).toEqual(scope);
  expect(Object.isFrozen(inputs[0]?.entry)).toBe(true);
  button(host).click(); await host.updateComplete;
  expect(inputs[0]?.signal.aborted).toBe(true);
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  const request = required(host.request);
  if (request.kind !== "tool") throw new Error("Expected tool");
  host.request = { ...request, entry: { ...request.entry, status: "success" } };
  await host.updateComplete;
  expect(render).toHaveBeenCalledTimes(1);
  button(host).click(); await host.updateComplete;
  expect(render).toHaveBeenCalledTimes(2);
  expect(host.shadowRoot?.querySelector("strong")?.textContent).toBe("success");
  host.remove();
  expect(inputs[1]?.signal.aborted).toBe(true);
});

it("cancels paired backend work on entry changes, default view and unmount", async () => {
  const requestBackend = vi.spyOn(backendTransport, "requestPairedPluginBackend").mockResolvedValue(null);
  const inputs: TranscriptToolRendererInput[] = [];
  const registry = new PluginRegistry();
  await registry.register({ id: "paired", backendRevision: "r1", pairedRequestVersion: 1,
    plugin: adaptPublicPlugin({ apiVersion: 5, name: "Paired", activate: () => ({ contributions: { transcriptRenderers: [{ id: "tool", target: "tool",
      resolve: () => ({ render: (input) => { inputs.push(input); return html`paired`; } }),
    }] } }) }) });
  const host = mount(() => undefined);
  const request = required(host.request);
  if (request.kind !== "tool") throw new Error("Expected tool");
  host.request = { ...request, renderers: registry.getTranscriptRenderers(scope.machineId) };
  await host.updateComplete;
  const verifyCancellation = async (cancel: () => void) => {
    const backend = required(inputs.at(-1)?.backend);
    const peer = backend.forScope({ kind: "machine" });
    await peer.request?.("status", null);
    const signal = required(requestBackend.mock.calls.at(-1)?.[3]?.signal);
    expect(signal.aborted).toBe(false);
    cancel(); await host.updateComplete;
    expect(signal.aborted).toBe(true);
    expect(() => peer.request?.("status", null)).toThrow();
  };
  await verifyCancellation(() => { host.request = { ...request, renderers: registry.getTranscriptRenderers(scope.machineId), entry: { ...request.entry, status: "success" } }; });
  await verifyCancellation(() => { button(host).click(); });
  button(host).click(); await host.updateComplete;
  await verifyCancellation(() => { host.remove(); });
  await registry.dispose();
});

it("retires old failure callbacks and renders each new snapshot without remounting unrelated state", async () => {
  const inputs: TranscriptToolRendererInput[] = [];
  const host = mount((input) => { inputs.push(input); return html`<b>${input.entry.resultText}</b>`; });
  await host.updateComplete;
  const request = required(host.request);
  if (request.kind !== "tool") throw new Error("Expected tool");
  host.request = { ...request, entry: { ...request.entry, resultText: "new snapshot" } };
  await host.updateComplete;
  expect(inputs[0]?.signal.aborted).toBe(true);
  inputs[0]?.fail("obsolete"); await host.updateComplete;
  expect(host.shadowRoot?.querySelector("b")?.textContent).toBe("new snapshot");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  inputs[1]?.fail(new Error("current failure")); await host.updateComplete;
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  expect(inputs[1]?.signal.aborted).toBe(true);
  expect(warn).toHaveBeenCalledOnce();
});

it("falls back for declined, thrown, invalid and asynchronous returns, but honors an empty template", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const draws: unknown[] = [() => undefined, () => { throw new Error("broken renderer"); }, () => "invalid", () => Promise.reject(new Error("async violation"))];
  for (const draw of draws) {
    // Deliberately cross the untyped third-party boundary to exercise runtime validation.
    const host = mount(() => undefined);
    const invalid = { render: () => undefined };
    Reflect.set(invalid, "render", draw);
    const request = required(host.request);
    if (request.kind !== "tool") throw new Error("Expected tool");
    Reflect.set(required(request.renderers[0]), "resolve", () => invalid);
    await host.updateComplete;
    await Promise.resolve();
    expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
    expect(host.shadowRoot?.querySelector("button")).toBeNull();
    host.remove();
  }
  expect(warn).toHaveBeenCalledTimes(3);
  const empty = mount(() => html``); await empty.updateComplete;
  expect(empty.shadowRoot?.querySelector("slot")).toBeNull();
  expect(empty.shadowRoot?.querySelector("button")).not.toBeNull();
});


it("keeps unchanged delegation as the default and lets a resolver wrap the core card", async () => {
  const host = mount(() => undefined);
  const request = required(host.request);
  if (request.kind !== "tool") throw new Error("Expected tool");
  const delegate: Extract<RegisteredTranscriptRenderer, { target: "tool" }> = {
    id: "delegate:tool", pluginId: "delegate", localId: "tool", target: "tool", resolve: (_name, next) => next(),
  };
  host.request = { ...request, renderers: [delegate] };
  await host.updateComplete;
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  expect(host.shadowRoot?.querySelector("button")).toBeNull();
  const wrapper: Extract<RegisteredTranscriptRenderer, { target: "tool" }> = { ...delegate, resolve: (_name, next) => {
    const core = next();
    return core === undefined ? undefined : { render: (input) => html`<aside>Core annotation</aside>${core.render(input)}` };
  } };
  host.request = { ...request, renderers: [wrapper] };
  await host.updateComplete;
  expect(host.shadowRoot?.querySelector("aside")?.textContent).toBe("Core annotation");
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  expect(host.shadowRoot?.querySelector("button")).not.toBeNull();
  button(host).click(); await host.updateComplete;
  expect(host.shadowRoot?.querySelector("aside")).toBeNull();
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
});

it("composes tool callbacks in discovery order and falls back for a downstream failure", async () => {
  const inputs: TranscriptToolRendererInput[] = [];
  const wrapper: Extract<RegisteredTranscriptRenderer, { target: "tool" }> = {
    id: "wrapper:tool", pluginId: "wrapper", localId: "tool", target: "tool",
    resolve: (name, next) => {
      if (name !== "read") return next();
      const downstream = next();
      if (downstream === undefined) return undefined;
      return { render: (input) => {
        const body = downstream.render(input);
        return body === undefined ? undefined : html`<section><p>Wrapper annotation</p>${body}</section>`;
      } };
    },
  };
  const host = mount((input) => { inputs.push(input); return html`<button @click=${() => { host.dataset["clicked"] = "yes"; }}>Inner action</button>`; });
  const request = required(host.request);
  if (request.kind !== "tool") throw new Error("Expected tool");
  host.request = { ...request, renderers: [wrapper, ...request.renderers] };
  await host.updateComplete;
  expect(host.shadowRoot?.querySelector("section p")?.textContent).toBe("Wrapper annotation");
  required(host.shadowRoot?.querySelector<HTMLButtonElement>("section button")).click();
  expect(host.dataset["clicked"]).toBe("yes");
  button(host).click(); await host.updateComplete;
  expect(inputs[0]?.signal.aborted).toBe(true);
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  button(host).click(); await host.updateComplete;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  inputs.at(-1)?.fail(new Error("Inner renderer failed")); await host.updateComplete;
  expect(host.shadowRoot?.querySelector("section")).toBeNull();
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  expect(warn).toHaveBeenCalledOnce();
});

it("shares placement selection with the mounted host, keeps default/failure views standalone, and retires scoped work", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const inputs: TranscriptToolRendererInput[] = [];
  const resolve = vi.fn<TranscriptToolRendererResolver>((name, next) => name === "plugin_tool"
    ? { placement: "standalone", render: (input) => { inputs.push(input); return html`<strong>${input.entry.status}</strong>`; } }
    : next());
  const registry = new PluginRegistry();
  await registry.register({ id: "plugin", plugin: adaptPublicPlugin({ apiVersion: 5, name: "Test", activate: () => ({
    contributions: { transcriptRenderers: [{ id: "tool", target: "tool", resolve }] },
  }) }) });
  const view = new ChatView();
  view.machineId = scope.machineId; view.sessionId = scope.sessionId;
  view.behaviors = { ...view.behaviors, followTail: false, rememberPosition: false };
  view.quietMode = true; view.isSendingPrompt = true;
  const execution: ToolExecutionPart = { type: "toolExecution", toolName: "plugin_tool", toolCallId: "call", summary: "", status: "running" };
  const line: ChatLine = { role: "tool", entryId: "entry", parts: [execution] };
  view.messages = [
    { role: "assistant", parts: [{ type: "thinking", text: "before" }] }, line,
    { role: "tool", parts: [{ ...execution, toolName: "ordinary_tool", toolCallId: "ordinary" }] },
  ];
  view.transcriptRenderers = registry.getTranscriptRenderers(scope.machineId);
  document.body.append(view); await view.updateComplete;
  const host = required(view.shadowRoot?.querySelector<TranscriptRendererHost>("pi-web-transcript-renderer"));
  await host.updateComplete;
  const groups = [...view.renderRoot.querySelectorAll<HTMLDetailsElement>(".event-group")];
  expect(groups).toHaveLength(2);
  expect(groups.every((group) => !group.open)).toBe(true);
  expect(host.closest("details")).toBeNull();
  expect(host.shadowRoot?.querySelector("strong")?.textContent).toBe("running");
  expect(resolve.mock.calls.map(([name]) => name)).toEqual(["plugin_tool", "ordinary_tool"]);
  expect(inputs[0]?.scope).toMatchObject({ machineId: scope.machineId, sessionId: scope.sessionId });

  button(host).click(); await host.updateComplete;
  expect(inputs[0]?.signal.aborted).toBe(true);
  view.messages = view.messages.map((message) => message === line ? { ...line, parts: [{ ...execution, status: "success" }] } : message);
  await view.updateComplete; await host.updateComplete;
  expect(view.shadowRoot?.querySelector("pi-web-transcript-renderer")).toBe(host);
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  expect(inputs).toHaveLength(1);
  expect(resolve).toHaveBeenCalledTimes(3);
  button(host).click(); await host.updateComplete;
  expect(host.shadowRoot?.querySelector("strong")?.textContent).toBe("success");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  inputs.at(-1)?.fail(new Error("failed presentation")); await host.updateComplete;
  view.requestUpdate(); await view.updateComplete; await host.updateComplete;
  expect(host.closest("details")).toBeNull();
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  expect(warn).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledTimes(3);

  view.machineId = "other"; await view.updateComplete;
  const otherHost = required(view.shadowRoot?.querySelector<TranscriptRendererHost>("pi-web-transcript-renderer"));
  await otherHost.updateComplete;
  expect(inputs.at(-1)?.scope.machineId).toBe("other");
  expect(resolve).toHaveBeenCalledTimes(5);
  view.transcriptRenderers = [];
  await view.updateComplete;
  expect(inputs.at(-1)?.signal.aborted).toBe(true);
  expect(view.shadowRoot?.querySelector("pi-web-transcript-renderer")).toBeNull();
  expect(view.renderRoot.querySelectorAll(".event-group")).toHaveLength(1);
  await registry.dispose();
});

it.each(["decline", "throw"] as const)("keeps a standalone %s fallback mounted outside quiet activity without retrying selection", async (failure) => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const resolve = vi.fn<TranscriptToolRendererResolver>(() => ({ placement: "standalone", render: () => {
    if (failure === "throw") throw new Error("broken body");
    return undefined;
  } }));
  const later = vi.fn<TranscriptToolRendererResolver>(() => ({ render: () => html`later` }));
  const view = new ChatView();
  view.behaviors = { ...view.behaviors, followTail: false, rememberPosition: false };
  view.quietMode = true;
  view.messages = [{ role: "tool", parts: [{ type: "toolExecution", toolName: "any_tool", summary: "", status: "success" }] }];
  view.transcriptRenderers = [resolve, later].map((callback, index) => ({ id: `plugin:${String(index)}`, pluginId: "plugin", localId: String(index), target: "tool", resolve: callback }));
  document.body.append(view); await view.updateComplete;
  const host = required(view.shadowRoot?.querySelector<TranscriptRendererHost>("pi-web-transcript-renderer"));
  await host.updateComplete;
  view.requestUpdate(); await view.updateComplete; await host.updateComplete;
  expect(host.closest("details")).toBeNull();
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  expect(host.querySelector("tool-execution-view")).not.toBeNull();
  expect(host.shadowRoot?.querySelector("button")).toBeNull();
  expect(resolve).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(failure === "throw" ? 1 : 0);
});

it("contains resolver failures during grouping and reports them once when activity mounts", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const resolve = vi.fn<TranscriptToolRendererResolver>(() => { throw new Error("broken resolver"); });
  const view = new ChatView();
  view.behaviors = { ...view.behaviors, followTail: false, rememberPosition: false };
  view.messages = [{ role: "tool", parts: [{ type: "toolExecution", toolName: "any_tool", summary: "", status: "success" }] }];
  view.transcriptRenderers = [{ id: "plugin:tool", pluginId: "plugin", localId: "tool", target: "tool", resolve }];
  document.body.append(view); await view.updateComplete;
  expect(resolve).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
  const group = required(view.renderRoot.querySelector<HTMLDetailsElement>(".event-group"));
  group.open = true; group.dispatchEvent(new Event("toggle")); await view.updateComplete;
  const host = required(view.shadowRoot?.querySelector<TranscriptRendererHost>("pi-web-transcript-renderer"));
  await host.updateComplete;
  view.requestUpdate(); await view.updateComplete; await host.updateComplete;
  expect(host.shadowRoot?.querySelector("slot")).not.toBeNull();
  expect(resolve).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledOnce();
});

it("wires tools and live/history custom messages through ChatView and restores original rendering on removal", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const toolInputs: TranscriptToolRendererInput[] = [];
  const custom = vi.fn((input: TranscriptMessageRendererInput) => html`<b>${String(input.entry.content)}</b>`);
  const view = new ChatView();
  view.machineId = scope.machineId; view.sessionId = scope.sessionId;
  view.workspaceContext = { ...scope, root: "/workspace" };
  view.behaviors = { ...view.behaviors, followTail: false, rememberPosition: false };
  view.isSendingPrompt = true;
  const raw = { role: "custom", customType: "notice", display: true, entryId: "notice-1", content: "Original notice", details: { count: 3 } };
  view.messages = normalizeMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file.txt" } }] },
    { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "Original tool" }], details: { lines: 2 } },
    raw,
  ]);
  document.body.append(view); await view.updateComplete;
  expect(view.shadowRoot?.querySelector("pi-web-transcript-renderer")).toBeNull();
  view.transcriptRenderers = [
    toolRenderer((input) => { toolInputs.push(input); return html`<strong>Custom tool</strong>`; }),
    { id: "plugin:notice", pluginId: "plugin", localId: "notice", target: "custom-message", customType: "notice", render: custom },
  ];
  await view.updateComplete;
  for (const details of view.shadowRoot?.querySelectorAll<HTMLDetailsElement>(".event-group") ?? []) {
    details.open = true; details.dispatchEvent(new Event("toggle"));
  }
  await view.updateComplete;
  let hosts = [...(view.shadowRoot?.querySelectorAll<TranscriptRendererHost>("pi-web-transcript-renderer") ?? [])];
  await Promise.all(hosts.map((host) => host.updateComplete));
  expect(hosts).toHaveLength(2);
  expect(toolInputs[0]?.entry).toMatchObject({ toolName: "read", status: "success", details: { lines: 2 } });
  expect(custom.mock.calls[0]?.[0]).toMatchObject({ scope, entry: { entryId: "notice-1", customType: "notice", content: "Original notice", details: { count: 3 } } });
  expect(custom.mock.calls[0]?.[0].entry).not.toHaveProperty("parts");
  const live = { ...raw, entryId: "notice-2", content: "Live notice" };
  view.messages = required(applyTranscriptEvent(view.messages, { type: "message.end", message: live }));
  await view.updateComplete;
  hosts = [...(view.shadowRoot?.querySelectorAll<TranscriptRendererHost>("pi-web-transcript-renderer") ?? [])];
  await Promise.all(hosts.map((host) => host.updateComplete));
  expect(custom.mock.calls.at(-1)?.[0].entry).toMatchObject({ entryId: "notice-2", details: { count: 3 } });
  view.transcriptRenderers = [];
  await view.updateComplete;
  expect(toolInputs[0]?.signal.aborted).toBe(true);
  expect(view.shadowRoot?.querySelector("pi-web-transcript-renderer")).toBeNull();
  expect(view.shadowRoot?.querySelector("tool-execution-view")).not.toBeNull();
  expect([...view.shadowRoot?.querySelectorAll("formatted-text") ?? []].map((element): unknown => Reflect.get(element, "text"))).toContain("Original notice");
});
