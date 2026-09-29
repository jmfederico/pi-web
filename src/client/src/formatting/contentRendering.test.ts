// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import type { ContentRendererContribution, ContentRendererInput } from "../../../plugin-api";
import { FormattedText } from "../components/FormattedText";
import { ContentRendererHost } from "../components/ContentRendererHost";
import { writeClipboardText } from "../clipboard";
import { PluginRegistry } from "../plugins/registry";
import { renderWorkspaceMarkdownHtml } from "../../../../pi-web-plugins/files/workspaceMarkdown";
import { createContentRenderingCapability, MAX_CONTENT_RENDERER_LENGTH } from "./contentRendering";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(true) }));

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function renderer(callback: ContentRendererContribution["render"] = ({ text }) => html`<div class="diagram">${text}</div>`): ContentRendererContribution {
  return { id: "diagram", renderMode: "automatic", languages: ["diagram"], fileExtensions: ["diag"], render: callback };
}

async function mount(text: string, contribution = renderer()) {
  const registry = new PluginRegistry();
  await registry.register({ id: "test", plugin: { apiVersion: 4, name: "Test", activate: () => ({ contributions: { contentRenderers: [contribution] } }) } });
  const element = new FormattedText();
  element.text = text;
  element.contentRendering = registry.chatContentRendering;
  document.body.append(element);
  await element.updateComplete;
  return { element, registry };
}

async function hostIn(element: Element): Promise<ContentRendererHost> {
  const host = element.shadowRoot?.querySelector("pi-web-content-renderer");
  if (!(host instanceof ContentRendererHost)) throw new Error("Expected a content renderer host");
  await host.updateComplete;
  return host;
}

function button(host: ContentRendererHost, label: string): HTMLButtonElement {
  const found = [...host.renderRoot.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  if (found === undefined) throw new Error(`Missing ${label} button`);
  return found;
}

describe("shared content rendering", () => {
  it("remembers independent duplicate blocks only with an opt-in identity and expires on revisit", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const manual = { ...renderer(), renderMode: "manual" as const };
    const { element } = await mount("```diagram\nsame\n```\n\n```diagram\nsame\n```", manual);
    element.intentKey = "memory-duplicates";
    await element.updateComplete;
    const host = await hostIn(element);
    button(host, "Render").click();
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector(".diagram")).not.toBeNull();
    element.remove();
    document.body.append(element);
    await element.updateComplete;
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector(".diagram")).not.toBeNull();
    const second = element.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")[1];
    await second?.updateComplete;
    expect(second?.shadowRoot?.querySelector("pre")?.textContent).toBe("same");
    clock.mockReturnValue(1000 + 15 * 60_000);
    element.text += "\n\nprose";
    await element.updateComplete;
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector(".diagram")).not.toBeNull();
    element.remove();
    document.body.append(element);
    await element.updateComplete;
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe("same");
  });

  it("restores exact renderer and mode, but not across identities, source changes or missing renderers", async () => {
    const { element, registry } = await mount("```diagram\nsource\n```", { ...renderer(), renderMode: "manual" });
    await registry.register({ id: "z", plugin: { apiVersion: 4, name: "Z", activate: () => ({ contributions: { contentRenderers: [{ ...renderer(), renderMode: "manual" }] } }) } });
    element.intentKey = "memory-chooser";
    await element.updateComplete;
    const host = await hostIn(element);
    const chooser = host.renderRoot.querySelector("select");
    if (chooser === null) throw new Error("Expected chooser");
    chooser.value = "z:diagram";
    chooser.dispatchEvent(new Event("change"));
    await host.updateComplete;
    button(host, "Render").click();
    await host.updateComplete;
    element.intentKey = "different-session";
    await element.updateComplete;
    await host.updateComplete;
    expect(chooser.value).toBe("test:diagram");
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
    element.intentKey = "memory-chooser";
    await element.updateComplete;
    await host.updateComplete;
    expect(chooser.value).toBe("z:diagram");
    expect(host.shadowRoot?.querySelector(".diagram")).not.toBeNull();
    button(host, "Raw").click();
    await host.updateComplete;
    element.remove();
    document.body.append(element);
    await element.updateComplete;
    await host.updateComplete;
    expect(chooser.value).toBe("z:diagram");
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
    element.text = "```diagram\nchanged\n```";
    await element.updateComplete;
    await host.updateComplete;
    expect(chooser.value).toBe("test:diagram");
    expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe("changed");
    button(host, "Render").click();
    await host.updateComplete;
    host.choices = host.choices.filter(({ id }) => id !== "test:diagram");
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
  });

  it("does not remember automatic rendering or opt-out Markdown activation", async () => {
    const { element } = await mount("```diagram\nsource\n```");
    element.intentKey = "automatic-is-not-intent";
    await element.updateComplete;
    const host = await hostIn(element);
    host.choices = host.choices.map((choice) => ({ ...choice, renderer: { ...choice.renderer, renderMode: "manual" } }));
    element.remove();
    document.body.append(element);
    await element.updateComplete;
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
    host.intentKey = undefined;
    await host.updateComplete;
    button(host, "Render").click();
    await host.updateComplete;
    element.remove();
    document.body.append(element);
    await element.updateComplete;
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
  });

  it("defaults to manual, resets on source/renderer changes, and keeps activation across prose updates", async () => {
    const draw = vi.fn(({ text }: ContentRendererInput) => html`<b>${text}</b>`);
    const manual = renderer(draw);
    delete manual.renderMode;
    const { element, registry } = await mount("```diagram\none\n```", manual);
    const host = await hostIn(element);
    expect(draw).not.toHaveBeenCalled();
    expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe("one");
    button(host, "Render").click();
    await host.updateComplete;
    expect(draw).toHaveBeenCalledOnce();
    element.text += "\n\nMore prose";
    await element.updateComplete;
    await host.updateComplete;
    expect(draw).toHaveBeenCalledOnce();
    element.text = "```diagram\ntwo\n```";
    await element.updateComplete;
    await host.updateComplete;
    expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(draw).toHaveBeenCalledOnce();
    expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe("two");
    button(host, "Render").click();
    await host.updateComplete;
    await registry.register({ id: "other", plugin: { apiVersion: 4, name: "Other", activate: () => ({ contributions: { contentRenderers: [{ ...manual, renderMode: "manual" }] } }) } });
    element.requestUpdate();
    await element.updateComplete;
    await host.updateComplete;
    const chooser = host.renderRoot.querySelector("select");
    if (chooser === null) throw new Error("Expected chooser");
    chooser.value = "other:diagram";
    chooser.dispatchEvent(new Event("change"));
    await host.updateComplete;
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(true);
    button(host, "Render").click();
    await host.updateComplete;
    expect(draw).toHaveBeenCalledTimes(3);
    button(host, "Raw").click();
    await host.updateComplete;
    expect(draw.mock.calls[2]?.[0].signal.aborted).toBe(true);
    button(host, "Copy source").click();
    expect(writeClipboardText).toHaveBeenLastCalledWith("two");
  });

  it("keeps per-diagram controls independent, labelled and focused across toggles", async () => {
    const { element } = await mount("```diagram\nfirst\n```\n\n```diagram\nsecond\n```");
    const hosts = [...element.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")];
    expect(hosts).toHaveLength(2);
    const [first, second] = hosts;
    if (first === undefined || second === undefined) throw new Error("Expected two diagrams");
    await Promise.all(hosts.map((host) => host.updateComplete));
    const raw = button(first, "Raw");
    raw.focus();
    raw.click();
    await first.updateComplete;
    expect(first.shadowRoot?.activeElement).toBe(raw);
    expect(raw.getAttribute("aria-pressed")).toBe("true");
    expect(first.shadowRoot?.getElementById(raw.getAttribute("aria-controls") ?? "")).not.toBeNull();
    expect(first.shadowRoot?.querySelector("pre")?.textContent).toBe("first");
    expect(second.shadowRoot?.querySelector(".diagram")?.textContent).toBe("second");
    button(second, "Copy source").click();
    await Promise.resolve();
    await second.updateComplete;
    expect(writeClipboardText).toHaveBeenLastCalledWith("second");
    expect(second.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe("Copied source");
  });

  it("does not expose intent memory through public Markdown even to untyped callers", async () => {
    const capability = createContentRenderingCapability(() => [{ id: "manual", label: "Manual", renderer: { ...renderer(), renderMode: "manual" } }]);
    const request = { machineId: "local", text: "```diagram\nsource\n```", toSafeHtml: renderWorkspaceMarkdownHtml };
    Reflect.set(request, "intentKey", "untyped-public-memory");
    const root = document.createElement("div");
    document.body.append(root);
    const mountHost = async () => {
      render(capability.renderMarkdown(request), root);
      const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
      if (host === null) throw new Error("Expected host");
      await host.updateComplete;
      return host;
    };
    const first = await mountHost();
    expect(first.intentKey).toBeUndefined();
    button(first, "Render").click();
    await first.updateComplete;
    expect(first.renderRoot.querySelector(".diagram")).not.toBeNull();
    render(null, root);
    const second = await mountHost();
    expect(second.renderRoot.querySelector("pre")?.textContent).toBe("source");
  });

  it("ignores an untyped rendererId with embedded controls and lets the chooser switch", async () => {
    const first = vi.fn<ContentRendererContribution["render"]>(() => html`<b>First</b>`);
    const second = vi.fn(() => html`<b>Second</b>`);
    const capability = createContentRenderingCapability(() => [
      { id: "first", label: "First", renderer: renderer(first) },
      { id: "second", label: "Second", renderer: renderer(second) },
    ]);
    const root = document.createElement("div");
    document.body.append(root);
    const request = { machineId: "local", text: "source" };
    Reflect.set(request, "rendererId", "second"); // JavaScript consumer violates the public union.
    render(capability.renderText(request), root);
    const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (host === null) throw new Error("Expected host");
    await host.updateComplete;
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(Object.keys(first.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["fail", "signal", "text"]);
    const chooser = host.renderRoot.querySelector("select");
    if (chooser === null) throw new Error("Expected chooser");
    chooser.value = "second";
    chooser.dispatchEvent(new Event("change"));
    await host.updateComplete;
    expect(second).toHaveBeenCalledOnce();
    expect(chooser.value).toBe("second");
    expect(host.renderRoot.querySelector("b")?.textContent).toBe("Second");
  });

  it("omits embedded controls only on request and retains failure source and cancellation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inputs: ContentRendererInput[] = [];
    const capability = createContentRenderingCapability(() => [{ id: "test:diagram", label: "Test / diagram", renderer: renderer((input) => {
      inputs.push(input);
      return html`<b>Preview</b>`;
    }) }]);
    const root = document.createElement("div");
    document.body.append(root);
    render(capability.renderText({ machineId: "local", text: "source", controls: "external" }), root);
    const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (host === null) throw new Error("Expected a renderer host");
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("button")).toBeNull();
    inputs[0]?.fail(new Error("failed"));
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe("source");
    expect(host.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain("Preview failed");
    expect(inputs[0]?.signal.aborted).toBe(true);
  });

  it("previews closed fences during streaming without remounting on trailing prose, with raw and copy always available", async () => {
    const draw = vi.fn(({ text }: ContentRendererInput) => html`<div class="diagram">${text}</div>`);
    const { element } = await mount("```diagram\nA --> B", renderer(draw));
    expect(element.shadowRoot?.querySelector("pi-web-content-renderer")).toBeNull();
    expect(element.shadowRoot?.querySelector("pre code")?.textContent).toContain("A --> B");
    const copy = element.shadowRoot?.querySelector<HTMLButtonElement>(".code-copy-button");
    copy?.click();
    expect(writeClipboardText).toHaveBeenCalledWith("A --> B\n");

    element.text += "\n```\n\nTrailing";
    await element.updateComplete;
    const host = await hostIn(element);
    expect(host.shadowRoot?.querySelector(".diagram")?.textContent).toBe("A --> B");
    const signal = draw.mock.calls[0]?.[0].signal;
    const diagram = host.shadowRoot?.querySelector(".diagram");
    element.text += " streaming prose\n\nMore.";
    await element.updateComplete;
    await host.updateComplete;
    expect(await hostIn(element)).toBe(host);
    expect(host.shadowRoot?.querySelector(".diagram")).toBe(diagram);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    button(host, "Copy source").click();
    await host.updateComplete;
    expect(writeClipboardText).toHaveBeenLastCalledWith("A --> B");
    button(host, "Raw").click();
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("pre code")?.textContent).toBe("A --> B");
    expect(signal?.aborted).toBe(true);
    button(host, "Preview").click();
    await host.updateComplete;
    expect(draw).toHaveBeenCalledTimes(2);
    element.remove();
    expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(true);
  });

  it("keeps a four-space-indented fence marker raw until a valid closing fence arrives", async () => {
    const draw = vi.fn(({ text }: ContentRendererInput) => html`<div class="diagram">${text}</div>`);
    const { element } = await mount("```diagram\nsource\n    ```", renderer(draw));
    expect(element.shadowRoot?.querySelector("pi-web-content-renderer")).toBeNull();
    expect(element.shadowRoot?.querySelector("pre code")?.textContent).toContain("    ```");
    expect(element.shadowRoot?.querySelector(".code-copy-button")).not.toBeNull();
    expect(draw).not.toHaveBeenCalled();

    element.text += "\n   ```";
    await element.updateComplete;
    expect((await hostIn(element)).text).toBe("source\n    ```");
    expect(draw).toHaveBeenCalledOnce();
  });

  it("contains synchronous and asynchronous failures, ignoring stale failure callbacks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inputs: ContentRendererInput[] = [];
    const { element } = await mount("```diagram\none\n```", renderer((input) => { inputs.push(input); return html`<b>${input.text}</b>`; }));
    const host = await hostIn(element);
    element.text = "```diagram\ntwo\n```";
    await element.updateComplete;
    await host.updateComplete;
    inputs[0]?.fail(new Error("obsolete"));
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("b")?.textContent).toBe("two");
    inputs[1]?.fail(new Error("current"));
    await host.updateComplete;
    expect(host.shadowRoot?.textContent).toContain("Preview failed");
    expect(button(host, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(host.shadowRoot?.querySelector("pre code")?.textContent).toBe("two");
    button(host, "Copy source").click();
    expect(writeClipboardText).toHaveBeenLastCalledWith("two");
    button(host, "Preview").click();
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("b")?.textContent).toBe("two");
    const failed = await mount("```diagram\nthrow\n```", renderer(() => { throw new Error("sync"); }));
    expect((await hostIn(failed.element)).shadowRoot?.textContent).toContain("Preview failed");
  });

  it("rejects accidental async render callbacks without leaking rejected promises", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invalid = renderer();
    Reflect.set(invalid, "render", () => Promise.reject(new Error("async callback is unsupported")));
    const { element } = await mount("```diagram\nsource\n```", invalid);
    const host = await hostIn(element);
    expect(host.shadowRoot?.textContent).toContain("Preview failed");
    expect(host.shadowRoot?.querySelector("pre code")?.textContent).toBe("source");
  });

  it("supports nested and tilde fences, full-document reference links, and keeps HTML inert", async () => {
    const { element } = await mount("> ~~~~diagram\n> nested\n> ~~~~\n\n[link][ref]\n\n[ref]: https://example.test\n\n<script>bad()</script>");
    expect((await hostIn(element)).text).toBe("nested");
    expect(element.shadowRoot?.querySelector("a")?.href).toBe("https://example.test/");
    expect(element.shadowRoot?.querySelector("script")).toBeNull();
    element.text = "~~~diagram\nunclosed\n~~";
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("pi-web-content-renderer")).toBeNull();
  });

  it.each(["manual", "automatic"] as const)("keeps %s Markdown defaults unless consumer activation is supplied", async (renderMode) => {
    const draw = vi.fn(() => html`<b>Preview</b>`);
    const contribution = { ...renderer(draw), renderMode };
    const capability = createContentRenderingCapability(() => [{ id: "diagram", label: "Diagram", renderer: contribution }]);
    const root = document.createElement("div");
    document.body.append(root);
    const request = { machineId: "local", text: "```diagram\nsource\n```", toSafeHtml: renderWorkspaceMarkdownHtml };
    render(capability.renderMarkdown(request), root);
    const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (host === null) throw new Error("Expected fence host");
    await host.updateComplete;
    expect(draw).toHaveBeenCalledTimes(renderMode === "automatic" ? 1 : 0);
    render(capability.renderMarkdown({ ...request, allowManualPreview: false }), root);
    await host.updateComplete;
    expect(draw).toHaveBeenCalledTimes(renderMode === "automatic" ? 1 : 0);
    render(capability.renderMarkdown({ ...request, allowManualPreview: true }), root);
    await host.updateComplete;
    expect(draw).toHaveBeenCalledOnce();
    button(host, "Raw").click();
    await host.updateComplete;
    render(capability.renderMarkdown({ ...request, allowManualPreview: true }), root);
    await host.updateComplete;
    expect(host.renderRoot.querySelector("pre")?.textContent).toBe("source");
    expect(draw).toHaveBeenCalledOnce();
  });

  it("retains the Files sanitizer while rendering fences and refuses truncated/oversize plugin input", () => {
    const select = vi.fn(() => [{ id: "test:diagram", label: "Test / diagram", renderer: renderer() }]);
    const capability = createContentRenderingCapability(select);
    const root = document.createElement("div");
    document.body.append(root);
    const text = "```diagram\nsafe\n```\n\n![tracking](https://evil.test/pixel)\n\n<svg onload=bad()>";
    render(capability.renderMarkdown({ machineId: "remote", text, toSafeHtml: renderWorkspaceMarkdownHtml }), root);
    expect(root.querySelector("pi-web-content-renderer")).not.toBeNull();
    expect(root.querySelector("img,svg,script")).toBeNull();
    expect(root.textContent).toContain("Image omitted");
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ machineId: "remote", text: "safe", language: "diagram" }));
    render(capability.renderMarkdown({ machineId: "remote", text, truncated: true, toSafeHtml: renderWorkspaceMarkdownHtml }), root);
    expect(root.querySelector("pi-web-content-renderer")).toBeNull();
    expect(capability.renderText({ machineId: "remote", text: "x".repeat(MAX_CONTENT_RENDERER_LENGTH + 1), filePath: "a.diag" })).toBeUndefined();
    expect(capability.renderText({ machineId: "remote", text: "safe", truncated: true, filePath: "a.diag" })).toBeUndefined();
  });

  it("switches only one diagram, cancels stale work, resets failure and preserves choices during streaming", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inputs: ContentRendererInput[] = [];
    const draw = vi.fn((input: ContentRendererInput) => { inputs.push(input); return html`<b>Alternative</b>`; });
    const { element, registry } = await mount("```diagram\nfirst\n```\n\n```diagram\nsecond\n```");
    await registry.register({ id: "z-other", plugin: { apiVersion: 4, name: "Other", activate: () => ({ contributions: { contentRenderers: [renderer(draw)] } }) } });
    element.requestUpdate();
    await element.updateComplete;
    const host = await hostIn(element);
    const second = element.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")[1];
    if (second === undefined) throw new Error("Expected second diagram");
    await second.updateComplete;
    const chooser = host.renderRoot.querySelector("select");
    if (chooser === null) throw new Error("Expected renderer chooser");
    expect([...chooser.options].map((option) => option.value)).toEqual(["test:diagram", "z-other:diagram"]);
    expect(draw).not.toHaveBeenCalled();
    chooser.value = "z-other:diagram";
    chooser.dispatchEvent(new Event("change"));
    await host.updateComplete;
    expect(draw).toHaveBeenCalledOnce();
    expect(second.shadowRoot?.querySelector(".diagram")?.textContent).toBe("second");
    element.text += "\n\nStreaming prose";
    await element.updateComplete;
    await host.updateComplete;
    expect(draw).toHaveBeenCalledOnce();
    expect(chooser.value).toBe("z-other:diagram");
    inputs[0]?.fail(new Error("current"));
    await host.updateComplete;
    expect(host.shadowRoot?.textContent).toContain("Preview failed");
    chooser.value = "test:diagram";
    chooser.dispatchEvent(new Event("change"));
    await host.updateComplete;
    expect(inputs[0]?.signal.aborted).toBe(true);
    inputs[0]?.fail(new Error("stale"));
    await host.updateComplete;
    expect(host.shadowRoot?.textContent).not.toContain("Preview failed");
    expect(host.shadowRoot?.querySelector(".diagram")?.textContent).toBe("first");
    button(host, "Copy source").click();
    expect(writeClipboardText).toHaveBeenLastCalledWith("first");
    button(host, "Raw").click();
    await host.updateComplete;
    chooser.value = "z-other:diagram";
    chooser.dispatchEvent(new Event("change"));
    await host.updateComplete;
    expect(draw).toHaveBeenCalledOnce();
    button(host, "Preview").click();
    await host.updateComplete;
    expect(draw).toHaveBeenCalledTimes(2);
    chooser.value = "test:diagram";
    chooser.dispatchEvent(new Event("change"));
    await host.updateComplete;
    expect(inputs[1]?.signal.aborted).toBe(true);
  });
});
