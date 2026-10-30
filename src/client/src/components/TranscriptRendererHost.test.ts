// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { html } from "lit";
import type { TranscriptToolRenderer, TranscriptToolRendererInput, TranscriptMessageRendererInput } from "../../../plugin-api";
import type { RegisteredTranscriptRenderer } from "../plugins/transcriptRenderers";
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
