// @vitest-environment happy-dom
import { useDeferredContent, settleDeferredContent } from "./deferredContent.testSupport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { html, render, type TemplateResult } from "lit";
import type { ContentRendererContribution, ContentRendererInput } from "../../../plugin-api";
import { FormattedText } from "../components/FormattedText";
import { ContentRendererHost } from "../components/ContentRendererHost";
import { ContentRenderingBoundary } from "../components/ContentRenderingBoundary";
import { writeClipboardText } from "../clipboard";
import { PluginRegistry } from "../plugins/registry";
import { renderWorkspaceMarkdownHtml } from "../../../../pi-web-plugins/files/workspaceMarkdown";
import { createContentRenderingCapability, MAX_CONTENT_RENDERER_LENGTH } from "./contentRendering";
import { PLAIN_CODE_BLOCK_POLICY } from "./codeBlockPolicy";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(true) }));

useDeferredContent();

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
  element.contentRendering = registry.getChatContentRendering(element.machineId);
  document.body.append(element);
  await settleDeferredContent(element);
  return { element, registry };
}

async function hostIn(element: Element): Promise<ContentRendererHost> {
  const host = element.shadowRoot?.querySelector("pi-web-content-renderer");
  if (!(host instanceof ContentRendererHost)) throw new Error("Expected a content renderer host");
  await settleDeferredContent(host);
  return host;
}

async function renderPublicMarkdown(content: TemplateResult, root: HTMLElement): Promise<void> {
  render(content, root);
  const boundary = root.querySelector("pi-web-content-rendering-boundary");
  if (!(boundary instanceof ContentRenderingBoundary)) throw new Error("Expected a host rendering boundary");
  await settleDeferredContent(boundary);
}

function button(host: ContentRendererHost, label: string): HTMLButtonElement {
  const found = [...host.renderRoot.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  if (found === undefined) throw new Error(`Missing ${label} button`);
  return found;
}

describe("shared content rendering", () => {
  it("passes file and chat fence metadata through the service to renderer inputs", async () => {
    const draw = vi.fn<ContentRendererContribution["render"]>(() => html`preview`);
    const capability = createContentRenderingCapability(() => [{ id: "test", label: "Test", renderer: renderer(draw) }]);
    const root = document.createElement("div");
    document.body.append(root);
    render(capability.renderText({ machineId: "remote", text: "source", language: "test", filePath: "dir/a.test" }), root);
    const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (host === null) throw new Error("Expected host");
    await settleDeferredContent(host);
    expect(draw.mock.calls[0]?.[0]).toMatchObject({ machineId: "remote", text: "source", language: "test", filePath: "dir/a.test" });
    await renderPublicMarkdown(capability.renderMarkdown({ machineId: "other", text: "```js extra\ncode\n```", toSafeHtml: renderWorkspaceMarkdownHtml }), root);
    const boundary = root.querySelector<ContentRenderingBoundary>("pi-web-content-rendering-boundary");
    const fence = boundary?.renderRoot.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (fence === undefined || fence === null) throw new Error("Expected fence host");
    await settleDeferredContent(fence);
    expect(draw.mock.calls.at(-1)?.[0]).toMatchObject({ machineId: "other", text: "code", language: "js extra" });
  });
  it.each(["text", "markdown"] as const)("refreshes mounted %s previews only when the host dependency token changes", async (kind) => {
    let revision: unknown = {};
    const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Preview</b>`);
    const contribution = renderer(draw);
    const dependency = vi.fn(() => revision);
    const capability = createContentRenderingCapability(() => [{ id: "test", label: "Test", renderer: contribution }], dependency);
    const root = document.createElement("div");
    document.body.append(root);
    const refresh = async () => {
      if (kind === "text") render(capability.renderText({ machineId: "remote", text: "source", language: "diagram" }), root);
      else await renderPublicMarkdown(capability.renderMarkdown({ machineId: "remote", text: "```diagram\nsource\n```", toSafeHtml: renderWorkspaceMarkdownHtml }), root);
      const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
      if (host === null) throw new Error("Expected host");
      await settleDeferredContent(host);
      return host;
    };
    const host = await refresh();
    const preview = host.renderRoot.querySelector("b");
    expect(await refresh()).toBe(host);
    expect(draw).toHaveBeenCalledOnce();
    expect(host.renderRoot.querySelector("b")).toBe(preview);
    revision = {};
    expect(await refresh()).toBe(host);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(dependency).toHaveBeenLastCalledWith({ machineId: "remote", text: "source", language: "diagram" });
    expect(Object.keys(draw.mock.calls[1]?.[0] ?? {})).not.toContain("renderingRevision");
  });

  it("renders machine-scoped snapshots and refreshes unavailable renderers through the same input", async () => {
    let enabled = true;
    const registry = new PluginRegistry({ isContributionEnabled: () => enabled });
    await registry.registerBatch(["local", "remote"].map((machineId) => ({
      id: `${machineId}-diagram`, machineId, machineSpecific: true,
      plugin: { apiVersion: 4, name: machineId, activate: () => ({ contributions: {
        contentRenderers: [renderer(({ text }) => html`<div class="diagram">${machineId}: ${text}</div>`)],
      } }) },
    })));
    const element = new FormattedText();
    element.text = "```diagram\nsource\n```";
    element.contentRendering = registry.getChatContentRendering("local");
    document.body.append(element);
    await settleDeferredContent(element);
    expect((await hostIn(element)).shadowRoot?.querySelector(".diagram")?.textContent).toBe("local: source");

    // A retained snapshot cannot render against another machine's request.
    element.machineId = "remote";
    await settleDeferredContent(element);
    expect(element.shadowRoot?.querySelector("pi-web-content-renderer")).toBeNull();
    expect(element.shadowRoot?.querySelector("pre")?.textContent).toBe("source\n");
    element.contentRendering = registry.getChatContentRendering("remote");
    await settleDeferredContent(element);
    expect((await hostIn(element)).shadowRoot?.querySelector(".diagram")?.textContent).toBe("remote: source");

    enabled = false;
    element.contentRendering = registry.getChatContentRendering("remote");
    await settleDeferredContent(element);
    expect(element.shadowRoot?.querySelector("pi-web-content-renderer")).toBeNull();
    expect(element.shadowRoot?.querySelector("pre")?.textContent).toBe("source\n");
    enabled = true;
    element.contentRendering = registry.getChatContentRendering("remote");
    await settleDeferredContent(element);
    expect((await hostIn(element)).shadowRoot?.querySelector(".diagram")?.textContent).toBe("remote: source");
    element.remove();
    await registry.dispose();
  });

  it("remembers independent duplicate blocks only with an opt-in identity and expires on revisit", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const manual = { ...renderer(), renderMode: "manual" as const };
    const { element } = await mount("```diagram\nsame\n```\n\n```diagram\nsame\n```", manual);
    element.intentKey = "memory-duplicates";
    await settleDeferredContent(element);
    const host = await hostIn(element);
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector(".diagram")).not.toBeNull();
    element.remove();
    document.body.append(element);
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector(".diagram")).not.toBeNull();
    const second = element.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")[1];
    await second?.updateComplete;
    expect(second?.shadowRoot?.querySelector("pre")?.textContent).toBe("same");
    clock.mockReturnValue(1000 + 15 * 60_000);
    element.text += "\n\nprose";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector(".diagram")).not.toBeNull();
    element.remove();
    document.body.append(element);
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe("same");
  });

  it("restores exact renderer and mode, but not across identities, source changes or missing renderers", async () => {
    const { element, registry } = await mount("```diagram\nsource\n```", { ...renderer(), renderMode: "manual" });
    await registry.register({ id: "z", plugin: { apiVersion: 4, name: "Z", activate: () => ({ contributions: { contentRenderers: [{ ...renderer(), renderMode: "manual" }] } }) } });
    element.contentRendering = registry.getChatContentRendering(element.machineId);
    element.intentKey = "memory-chooser";
    await settleDeferredContent(element);
    const host = await hostIn(element);
    button(host, "z / diagram").click();
    await settleDeferredContent(host);
    element.intentKey = "different-session";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(button(host, "test / diagram").getAttribute("aria-pressed")).toBe("false");
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
    element.intentKey = "memory-chooser";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(button(host, "z / diagram").getAttribute("aria-pressed")).toBe("true");
    expect(host.shadowRoot?.querySelector(".diagram")).not.toBeNull();
    button(host, "Raw").click();
    await settleDeferredContent(host);
    element.remove();
    document.body.append(element);
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(button(host, "z / diagram").getAttribute("aria-pressed")).toBe("false");
    expect(button(host, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
    element.text = "```diagram\nchanged\n```";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(button(host, "test / diagram").getAttribute("aria-pressed")).toBe("false");
    expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe("changed");
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
    host.choices = host.choices.filter(({ id }) => id !== "test:diagram");
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
  });

  it("does not remember automatic rendering or opt-out Markdown activation", async () => {
    const { element } = await mount("```diagram\nsource\n```");
    element.intentKey = "automatic-is-not-intent";
    await settleDeferredContent(element);
    const host = await hostIn(element);
    // Isolate intent restoration from the parent's renderer-snapshot ownership.
    host.remove();
    host.choices = host.choices.map((choice) => ({ ...choice, renderer: { ...choice.renderer, renderMode: "manual" } }));
    document.body.append(host);
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector("pre")).not.toBeNull();
    host.intentKey = undefined;
    await settleDeferredContent(host);
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
    host.remove();
    document.body.append(host);
    await settleDeferredContent(host);
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
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();
    element.text += "\n\nMore prose";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();
    element.text = "```diagram\ntwo\n```";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(draw).toHaveBeenCalledOnce();
    expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe("two");
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
    const preview = host.shadowRoot?.querySelector("b");
    await registry.register({ id: "other", plugin: { apiVersion: 4, name: "Other", activate: () => ({ contributions: { contentRenderers: [{ ...manual, renderMode: "manual" }] } }) } });
    element.contentRendering = registry.getChatContentRendering(element.machineId);
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(element.renderRoot.querySelector("pi-web-content-renderer")).toBe(host);
    expect(host.shadowRoot?.querySelector("b")).toBe(preview);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(false);
    button(host, "other / diagram").click();
    await settleDeferredContent(host);
    expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(true);
    expect(draw).toHaveBeenCalledTimes(3);
    button(host, "Raw").click();
    await settleDeferredContent(host);
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
    await settleDeferredContent(first);
    expect(first.shadowRoot?.activeElement).toBe(raw);
    expect(raw.getAttribute("aria-pressed")).toBe("true");
    expect(first.shadowRoot?.getElementById(raw.getAttribute("aria-controls") ?? "")).not.toBeNull();
    expect(first.shadowRoot?.querySelector("pre")?.textContent).toBe("first");
    expect(second.shadowRoot?.querySelector(".diagram")?.textContent).toBe("second");
    button(second, "Copy source").click();
    await Promise.resolve();
    await settleDeferredContent(second);
    expect(writeClipboardText).toHaveBeenLastCalledWith("second");
    expect(second.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe("Copied source");
  });

  it("does not expose chat intent or source policy through public Markdown even to untyped callers", async () => {
    const capability = createContentRenderingCapability(() => [{ id: "manual", label: "Manual", renderer: { ...renderer(), renderMode: "manual" } }]);
    const request = { machineId: "local", text: "```diagram\nsource\n```", toSafeHtml: renderWorkspaceMarkdownHtml };
    Reflect.set(request, "intentKey", "untyped-public-memory");
    Reflect.set(request, "codeBlocks", PLAIN_CODE_BLOCK_POLICY);
    const root = document.createElement("div");
    document.body.append(root);
    const mountHost = async () => {
      await renderPublicMarkdown(capability.renderMarkdown(request), root);
      const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
      if (host === null) throw new Error("Expected host");
      await settleDeferredContent(host);
      return host;
    };
    const first = await mountHost();
    expect(first.intentKey).toBeUndefined();
    expect(first.codeBlocks).toBeUndefined();
    expect(first.renderRoot.querySelector(".copy")).not.toBeNull();
    button(first, "Manual").click();
    await settleDeferredContent(first);
    expect(first.renderRoot.querySelector(".diagram")).not.toBeNull();
    render(null, root);
    const second = await mountHost();
    expect(second.renderRoot.querySelector("pre")?.textContent).toBe("source");
  });

  it("ignores an untyped rendererId with embedded controls and lets named buttons switch", async () => {
    const first = vi.fn<ContentRendererContribution["render"]>(() => html`<b>First</b>`);
    const second = vi.fn(() => html`<b>Second</b>`);
    const capability = createContentRenderingCapability(() => [
      { id: "first", label: "First", renderer: renderer(first) },
      { id: "second", label: "Second", renderer: renderer(second) },
    ]);
    const root = document.createElement("div");
    document.body.append(root);
    const request = { machineId: "local", text: "source" };
    Reflect.set(request, "rendererId", "first"); // JavaScript consumer violates the public union.
    render(capability.renderText(request), root);
    const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (host === null) throw new Error("Expected host");
    await settleDeferredContent(host);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    button(host, "First").click();
    await settleDeferredContent(host);
    expect(first).toHaveBeenCalledOnce();
    expect(Object.keys(first.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["fail", "machineId", "signal", "text"]);
    expect(button(host, "First").getAttribute("aria-pressed")).toBe("true");
    expect(host.renderRoot.querySelector("b")?.textContent).toBe("First");
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
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector("button")).toBeNull();
    inputs[0]?.fail(new Error("failed"));
    await settleDeferredContent(host);
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
    await settleDeferredContent(element);
    const host = await hostIn(element);
    expect(host.shadowRoot?.querySelector(".diagram")?.textContent).toBe("A --> B");
    const signal = draw.mock.calls[0]?.[0].signal;
    const diagram = host.shadowRoot?.querySelector(".diagram");
    element.text += " streaming prose\n\nMore.";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(await hostIn(element)).toBe(host);
    expect(host.shadowRoot?.querySelector(".diagram")).toBe(diagram);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    button(host, "Copy source").click();
    await settleDeferredContent(host);
    expect(writeClipboardText).toHaveBeenLastCalledWith("A --> B");
    button(host, "Raw").click();
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector("pre code")?.textContent).toBe("A --> B");
    expect(signal?.aborted).toBe(true);
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
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
    await settleDeferredContent(element);
    expect((await hostIn(element)).text).toBe("source\n    ```");
    expect(draw).toHaveBeenCalledOnce();
  });

  it("contains synchronous and asynchronous failures, ignoring stale failure callbacks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inputs: ContentRendererInput[] = [];
    const { element } = await mount("```diagram\none\n```", renderer((input) => { inputs.push(input); return html`<b>${input.text}</b>`; }));
    const host = await hostIn(element);
    element.text = "```diagram\ntwo\n```";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    inputs[0]?.fail(new Error("obsolete"));
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector("b")?.textContent).toBe("two");
    inputs[1]?.fail(new Error("current"));
    await settleDeferredContent(host);
    expect(host.shadowRoot?.textContent).toContain("Preview failed");
    expect(button(host, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(host.shadowRoot?.querySelector("pre code")?.textContent).toBe("two");
    button(host, "Copy source").click();
    expect(writeClipboardText).toHaveBeenLastCalledWith("two");
    expect(button(host, "test / diagram").getAttribute("aria-pressed")).toBe("false");
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
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
    await settleDeferredContent(element);
    expect(element.shadowRoot?.querySelector("pi-web-content-renderer")).toBeNull();
  });

  it.each(["manual", "automatic"] as const)("keeps %s Markdown defaults unless consumer activation is supplied", async (renderMode) => {
    const draw = vi.fn(() => html`<b>Preview</b>`);
    const contribution = { ...renderer(draw), renderMode };
    const capability = createContentRenderingCapability(() => [{ id: "diagram", label: "Diagram", renderer: contribution }]);
    const root = document.createElement("div");
    document.body.append(root);
    const request = { machineId: "local", text: "```diagram\nsource\n```", toSafeHtml: renderWorkspaceMarkdownHtml };
    await renderPublicMarkdown(capability.renderMarkdown(request), root);
    const host = root.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (host === null) throw new Error("Expected fence host");
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledTimes(renderMode === "automatic" ? 1 : 0);
    await renderPublicMarkdown(capability.renderMarkdown({ ...request, allowManualPreview: false }), root);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledTimes(renderMode === "automatic" ? 1 : 0);
    await renderPublicMarkdown(capability.renderMarkdown({ ...request, allowManualPreview: true }), root);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();
    button(host, "Raw").click();
    await settleDeferredContent(host);
    await renderPublicMarkdown(capability.renderMarkdown({ ...request, allowManualPreview: true }), root);
    await settleDeferredContent(host);
    expect(host.renderRoot.querySelector("pre")?.textContent).toBe("source");
    expect(draw).toHaveBeenCalledOnce();
  });

  it("retains the Files sanitizer while rendering fences and refuses truncated/oversize plugin input", async () => {
    const select = vi.fn(() => [{ id: "test:diagram", label: "Test / diagram", renderer: renderer() }]);
    const capability = createContentRenderingCapability(select);
    const root = document.createElement("div");
    document.body.append(root);
    const text = "```diagram\nsafe\n```\n\n![tracking](https://evil.test/pixel)\n\n<svg onload=bad()>";
    await renderPublicMarkdown(capability.renderMarkdown({ machineId: "remote", text, toSafeHtml: renderWorkspaceMarkdownHtml }), root);
    expect(root.querySelector("pi-web-content-renderer")).not.toBeNull();
    expect(root.querySelector("img,svg,script")).toBeNull();
    expect(root.textContent).toContain("Image omitted");
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ machineId: "remote", text: "safe", language: "diagram" }));
    await renderPublicMarkdown(capability.renderMarkdown({ machineId: "remote", text, truncated: true, toSafeHtml: renderWorkspaceMarkdownHtml }), root);
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
    element.contentRendering = registry.getChatContentRendering(element.machineId);
    await settleDeferredContent(element);
    const host = await hostIn(element);
    const second = element.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")[1];
    if (second === undefined) throw new Error("Expected second diagram");
    await settleDeferredContent(second);
    expect(host.renderRoot.querySelector("select")).toBeNull();
    expect([...host.renderRoot.querySelectorAll('.views button')].map((view) => view.textContent.trim()))
      .toEqual(["test / diagram", "z-other / diagram", "Raw"]);
    expect(draw).toHaveBeenCalledTimes(2); // New last automatic becomes the default.
    for (const item of [host, second]) {
      button(item, "test / diagram").click();
      await settleDeferredContent(item);
    }
    draw.mockClear();
    inputs.length = 0;
    button(host, "z-other / diagram").click();
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();
    expect(second.shadowRoot?.querySelector(".diagram")?.textContent).toBe("second");
    element.text += "\n\nStreaming prose";
    await settleDeferredContent(element);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();
    expect(button(host, "z-other / diagram").getAttribute("aria-pressed")).toBe("true");
    inputs[0]?.fail(new Error("current"));
    await settleDeferredContent(host);
    expect(host.shadowRoot?.textContent).toContain("Preview failed");
    expect(button(host, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(button(host, "z-other / diagram").getAttribute("aria-pressed")).toBe("false");
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
    expect(inputs[0]?.signal.aborted).toBe(true);
    inputs[0]?.fail(new Error("stale"));
    await settleDeferredContent(host);
    expect(host.shadowRoot?.textContent).not.toContain("Preview failed");
    expect(host.shadowRoot?.querySelector(".diagram")?.textContent).toBe("first");
    button(host, "Copy source").click();
    expect(writeClipboardText).toHaveBeenLastCalledWith("first");
    button(host, "Raw").click();
    await settleDeferredContent(host);
    button(host, "z-other / diagram").click();
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(button(host, "z-other / diagram").getAttribute("aria-pressed")).toBe("true");
    expect(button(host, "Raw").getAttribute("aria-pressed")).toBe("false");
    button(host, "test / diagram").click();
    await settleDeferredContent(host);
    expect(inputs[1]?.signal.aborted).toBe(true);
  });
});
