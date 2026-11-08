// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import type { MarkdownExtensionContribution, MarkdownRenderRequest } from "../../../plugin-api";
import { PluginRegistry } from "../plugins/registry";
import { FormattedText } from "../components/FormattedText";
import { ContentRenderingBoundary } from "../components/ContentRenderingBoundary";
import { ContentRendererHost } from "../components/ContentRendererHost";
import { useDeferredContent, settleDeferredContent } from "./deferredContent.testSupport";
import { markdownRenderingCapabilityToken } from "./markdownRendering";

useDeferredContent();
const registries: PluginRegistry[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  for (const registry of registries.splice(0)) await registry.dispose();
  vi.restoreAllMocks();
});

function registry(options?: ConstructorParameters<typeof PluginRegistry>[0]): PluginRegistry {
  const value = new PluginRegistry(options);
  registries.push(value);
  return value;
}

const renderHighlight: MarkdownExtensionContribution["render"] = ({ text }) => `<mark>${text}</mark>`;

function extension(renderToken: MarkdownExtensionContribution["render"] = renderHighlight): MarkdownExtensionContribution {
  return { id: "highlight", level: "inline", start: (source) => {
    const index = source.indexOf("==");
    return index < 0 ? undefined : index;
  }, tokenize(source) {
    const match = /^==([^=\n]+)==/u.exec(source);
    return match === null ? undefined : { raw: match[0], text: match[1] ?? "" };
  }, render: renderToken };
}

async function install(host: PluginRegistry, contribution = extension(), scope?: { machineId: string; sourcePluginId: string }): Promise<void> {
  await host.register({ id: scope === undefined ? "highlight" : `${scope.machineId}-highlight`, ...scope,
    plugin: { apiVersion: 5, name: "Highlight", requires: [markdownRenderingCapabilityToken],
      activate: () => ({ contributions: { markdownExtensions: [contribution] } }) } });
}

async function documentView(host: PluginRegistry, request: MarkdownRenderRequest): Promise<ContentRenderingBoundary> {
  const root = document.createElement("div");
  document.body.append(root);
  render(host.markdownRendering.render(request), root);
  const boundary = root.querySelector<ContentRenderingBoundary>("pi-web-content-rendering-boundary");
  if (boundary === null) throw new Error("Missing Markdown boundary");
  await settleDeferredContent(boundary);
  return boundary;
}

describe("shared plugin Markdown rendering", () => {
  it("defers parsing, shares syntax across chat/documents and preserves their different image policies", async () => {
    const host = registry();
    const draw = vi.fn(renderHighlight);
    await install(host, extension(draw));
    const text = "==shared== ![picture](https://example.com/image.png) <script>bad()</script>";
    const template = host.markdownRendering.render({ machineId: "local", text });
    expect(draw).not.toHaveBeenCalled();
    const chat = new FormattedText();
    chat.text = text;
    chat.contentRendering = host.getChatContentRendering("local");
    document.body.append(chat);
    await settleDeferredContent(chat);
    const root = document.createElement("div");
    document.body.append(root);
    render(template, root);
    const documentBoundary = root.querySelector<ContentRenderingBoundary>("pi-web-content-rendering-boundary");
    if (documentBoundary === null) throw new Error("Missing Markdown boundary");
    await settleDeferredContent(documentBoundary);
    expect(chat.renderRoot.querySelector("mark")?.textContent).toBe("shared");
    expect(documentBoundary.querySelector("mark")?.textContent).toBe("shared");
    expect(chat.renderRoot.querySelector("img")).not.toBeNull();
    expect(documentBoundary.querySelector("img,script")).toBeNull();
    expect(documentBoundary.textContent).toContain("Image omitted");
    expect(draw).toHaveBeenCalledOnce();
  });

  it("reuses completed syntax and fence hosts as trailing prose streams", async () => {
    const host = registry();
    const draw = vi.fn(renderHighlight);
    await install(host, extension(draw));
    const preview = vi.fn(() => html`<b>Preview</b>`);
    await host.register({ id: "diagram", plugin: { apiVersion: 5, name: "Diagram", activate: () => ({ contributions: {
      contentRenderers: [{ id: "diagram", languages: ["diagram"], renderMode: "automatic", render: preview }],
    } }) } });
    const chat = new FormattedText();
    chat.contentRendering = host.getChatContentRendering("local");
    chat.text = "==unfinished";
    document.body.append(chat);
    await settleDeferredContent(chat);
    expect(chat.renderRoot.querySelector("mark")).toBeNull();
    chat.text = "==unfinished==\n\n```diagram\nsource\n```\n\nTail";
    await settleDeferredContent(chat);
    const fence = chat.renderRoot.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (fence === null) throw new Error("Missing fence renderer");
    await settleDeferredContent(fence);
    chat.text += " grows";
    await settleDeferredContent(chat);
    expect(chat.renderRoot.querySelector("pi-web-content-renderer")).toBe(fence);
    await settleDeferredContent(fence);
    expect(chat.renderRoot.querySelector("mark")?.textContent).toBe("unfinished");
    expect(draw).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledOnce();
  });

  it("invalidates mounted document output on enablement changes, without work on unchanged notifications", async () => {
    let enabled = true;
    const host = registry({ isContributionEnabled: () => enabled });
    const draw = vi.fn(renderHighlight);
    await install(host, extension(draw));
    const view = await documentView(host, { machineId: "local", text: "==live==" });
    const original = view.querySelector("mark");
    host.notifySelectionChanged();
    await settleDeferredContent(view);
    expect(view.querySelector("mark")).toBe(original);
    expect(draw).toHaveBeenCalledOnce();
    enabled = false;
    host.notifySelectionChanged();
    await settleDeferredContent(view);
    expect(view.querySelector("mark")).toBeNull();
    expect(view.textContent).toContain("==live==");
    enabled = true;
    host.notifySelectionChanged();
    await settleDeferredContent(view);
    expect(view.querySelector("mark")?.textContent).toBe("live");
    view.remove();
    enabled = false;
    host.notifySelectionChanged();
    document.body.append(view);
    await settleDeferredContent(view);
    expect(view.querySelector("mark")).toBeNull();
  });

  it("isolates remote syntax and does not reuse a retained chat snapshot on another machine", async () => {
    const host = registry();
    await install(host, extension(), { machineId: "remote", sourcePluginId: "highlight" });
    const local = await documentView(host, { machineId: "local", text: "==local==" });
    expect(local.querySelector("mark")).toBeNull();
    const remote = await documentView(host, { machineId: "remote", text: "==remote==" });
    expect(remote.querySelector("mark")?.textContent).toBe("remote");
    const chat = new FormattedText();
    chat.machineId = "remote";
    chat.text = "==remote==";
    chat.contentRendering = host.getChatContentRendering("remote");
    document.body.append(chat);
    await settleDeferredContent(chat);
    expect(chat.renderRoot.querySelector("mark")).not.toBeNull();
    chat.machineId = "local";
    await settleDeferredContent(chat);
    expect(chat.renderRoot.querySelector("mark")).toBeNull();
  });

  it("publishes extensions only after successful startup and rejects invalid or v4 contributions", async () => {
    const host = registry();
    await expect(host.register({ id: "failed", plugin: { apiVersion: 5, name: "Failed", activate: () => ({
      contributions: { markdownExtensions: [extension()] }, start: () => { throw new Error("startup failed"); },
    }) } })).rejects.toThrow("startup failed");
    const view = await documentView(host, { machineId: "local", text: "==literal==" });
    expect(view.querySelector("mark")).toBeNull();
    await expect(host.register({ id: "invalid", plugin: { apiVersion: 5, name: "Invalid", activate: () => ({
      // @ts-expect-error Exercise the JavaScript plugin registration boundary.
      contributions: { markdownExtensions: [{ ...extension(), render: undefined }] },
    }) } })).rejects.toThrow("Markdown extensions require");
    await expect(host.register({ id: "legacy", plugin: { apiVersion: 4, name: "Legacy", activate: () => ({
      contributions: { markdownExtensions: [extension()] },
    }) } })).rejects.toThrow("require browser API v5");
  });
});
