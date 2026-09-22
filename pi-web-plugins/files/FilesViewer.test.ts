// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { html } from "lit";
import { createContentRenderingCapability } from "../../src/client/src/formatting/contentRendering";
import { ContentRendererHost } from "../../src/client/src/components/ContentRendererHost";
import type { ContentRenderingCapability, FileContentResponse } from "@jmfederico/pi-web/plugin-api";
import { adoptWorkspaceFileViewMode, WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY, type WorkspaceFileViewMode, type WorkspaceFileViewModeStore } from "./workspaceFileViewMode";
import { DEFAULT_MAX_INLINE_PREVIEW_BYTES as MAX_INLINE_PREVIEW_BYTES, WorkspaceFileViewer, workspaceFilePreviewKind, workspaceFileViewerIdentityKey, type WorkspaceFileViewerIdentity } from "./FilesViewer";

if (customElements.get("pi-web-files-viewer") === undefined) customElements.define("pi-web-files-viewer", WorkspaceFileViewer);

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("workspace-file-viewer", () => {
  it.each(["fresh", "saved", "url"] as const)("honors %s Markdown preview intent for manual fences while preserving block controls", async (preference) => {
    const alpha = vi.fn(() => html`<b>Alpha</b>`);
    const beta = vi.fn(() => html`<b>Beta</b>`);
    const contentRendering = createContentRenderingCapability(() => [
      { id: "alpha", label: "Alpha", renderer: { id: "alpha", render: alpha } },
      { id: "beta", label: "Beta", renderer: { id: "beta", render: beta } },
    ]);
    if (preference !== "fresh") localStorage.setItem(WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY, preference === "saved" ? "preview" : "raw");
    const modeStore = {
      adopt: () => adoptWorkspaceFileViewMode({ read: () => preference === "url" ? "preview" : undefined, write: () => undefined }, localStorage),
      publish: vi.fn(),
    };
    const viewer = await mountViewer(textFile("notes.md", "```diagram\nsource\n```", { mediaType: "markdown" }), { contentRendering, modeStore });
    if (preference === "fresh") {
      expect(viewer.renderRoot.querySelector("pi-web-content-renderer")).toBeNull();
      expect(alpha).not.toHaveBeenCalled();
      expect(modeStore.publish).not.toHaveBeenCalled();
      modeButton(viewer, "Preview").click();
      await viewer.updateComplete;
    }
    const host = viewer.renderRoot.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (host === null) throw new Error("Expected Markdown fence host");
    await host.updateComplete;
    expect(alpha).toHaveBeenCalledOnce();
    expect(beta).not.toHaveBeenCalled();
    const chooser = host.renderRoot.querySelector("select");
    if (chooser === null) throw new Error("Expected block chooser");
    chooser.value = "beta";
    chooser.dispatchEvent(new Event("change"));
    await host.updateComplete;
    expect(beta).toHaveBeenCalledOnce();
    const raw = [...host.renderRoot.querySelectorAll("button")].find((button) => button.textContent === "Raw");
    if (raw === undefined) throw new Error("Expected block Raw control");
    raw.click();
    await host.updateComplete;
    viewer.requestUpdate();
    await viewer.updateComplete;
    await host.updateComplete;
    expect(host.renderRoot.querySelector("pre code")?.textContent).toBe("source");
    expect(host.renderRoot.querySelector(".preview")).toBeNull();
    expect(chooser.value).toBe("beta");
    expect(beta).toHaveBeenCalledOnce();
    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(viewer.renderRoot.querySelector("pi-web-content-renderer")).toBeNull();
  });

  it.each(["manual", "automatic"] as const)("uses %s only as a fresh-browser default without saving it", async (renderMode) => {
    const draw = vi.fn(() => html`<b>Preview</b>`);
    const contentRendering = createContentRenderingCapability(() => [{ id: "diagram", label: "Diagram", renderer: { id: "diagram", renderMode, render: draw } }]);
    const publish = vi.fn();
    const viewer = await mountViewer(textFile("graph.mmd", "source"), { contentRendering, modeStore: { adopt: () => undefined, publish } });
    await viewer.renderRoot.querySelector<ContentRendererHost>("pi-web-content-renderer")?.updateComplete;
    expect(draw).toHaveBeenCalledTimes(renderMode === "automatic" ? 1 : 0);
    expect(publish).not.toHaveBeenCalled();
    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(publish).toHaveBeenCalledWith("raw");
    expect(viewer.renderRoot.querySelector("pi-web-files-code-viewer")).not.toBeNull();
  });

  it.each(["manual", "automatic"] as const)("lets saved Preview and Raw override %s defaults", async (renderMode) => {
    const draw = vi.fn(() => html`<b>Preview</b>`);
    const contentRendering = createContentRenderingCapability(() => [{ id: "diagram", label: "Diagram", renderer: { id: "diagram", renderMode, render: draw } }]);
    const viewer = await mountViewer(textFile("graph.mmd", "source"), { contentRendering, modeStore: fakeModeStore("preview") });
    await viewer.renderRoot.querySelector<ContentRendererHost>("pi-web-content-renderer")?.updateComplete;
    expect(draw).toHaveBeenCalledOnce();
    viewer.modeStore = fakeModeStore("raw");
    await viewer.updateComplete;
    expect(viewer.renderRoot.querySelector("pi-web-content-renderer")).toBeNull();
    expect(draw).toHaveBeenCalledOnce();
  });

  it("owns standalone preview controls in the header and cancels the embedded renderer on Raw", async () => {
    let signal: AbortSignal | undefined;
    const contentRendering = createContentRenderingCapability(() => [{ id: "diagram", label: "Diagram", renderer: {
      id: "diagram", languages: ["diagram"], render: (input) => {
        signal = input.signal;
        return html`<b>Diagram preview</b>`;
      },
    } }]);
    const viewer = await mountViewer(textFile("graph.mmd", "A --> B"), { contentRendering });
    expect(signal).toBeUndefined();
    modeButton(viewer, "Render").click();
    await viewer.updateComplete;
    const host = viewer.shadowRoot?.querySelector("pi-web-content-renderer");
    if (!(host instanceof ContentRendererHost)) throw new Error("Expected preview host");
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("button")).toBeNull();
    expect(host.shadowRoot?.textContent).toContain("Diagram preview");
    expect(viewer.shadowRoot?.querySelectorAll(".viewer-header button")).toHaveLength(2);
    expect(viewer.shadowRoot?.querySelector(".viewer-header a[download]")).not.toBeNull();
    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(signal?.aborted).toBe(true);
    expect(viewer.shadowRoot?.querySelector("pi-web-content-renderer")).toBeNull();
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).not.toBeNull();
    modeButton(viewer, "Render").click();
    await viewer.updateComplete;
    const replacement = viewer.shadowRoot?.querySelector("pi-web-content-renderer");
    if (!(replacement instanceof ContentRendererHost)) throw new Error("Expected resumed preview");
    await replacement.updateComplete;
    expect(signal?.aborted).toBe(false);
    const previousSignal = signal;
    viewer.file = textFile("graph.mmd", "changed source");
    await viewer.updateComplete;
    const changedHost = viewer.shadowRoot?.querySelector<ContentRendererHost>("pi-web-content-renderer");
    await changedHost?.updateComplete;
    expect(previousSignal?.aborted).toBe(true);
    expect(signal).not.toBe(previousSignal);
    expect(changedHost?.shadowRoot?.querySelector("b")?.textContent).toBe("Diagram preview");
    expect(modeButton(viewer, "Render").getAttribute("aria-pressed")).toBe("true");
  });

  it("chooses alternatives in the header, preserves choice across modes, and resets for a different file", async () => {
    const inputs: import("../../src/plugin-api").ContentRendererInput[] = [];
    const choices = ["Alpha", "Beta"].map((label) => ({ id: label, label, renderer: {
      id: label, render: (input: import("../../src/plugin-api").ContentRendererInput) => {
        inputs.push(input);
        return html`<b>${label}</b>`;
      },
    } }));
    const contentRendering = createContentRenderingCapability(() => choices);
    const viewer = await mountViewer(textFile("first.mmd", "source"), { contentRendering });
    const chooser = viewer.renderRoot.querySelector<HTMLSelectElement>('.viewer-header select[aria-label="File renderer"]');
    if (chooser === null) throw new Error("Expected header chooser");
    expect(chooser.value).toBe("Alpha");
    expect(inputs).toHaveLength(0);
    modeButton(viewer, "Render").click();
    await viewer.updateComplete;
    const host = viewer.renderRoot.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (host === null) throw new Error("Expected preview host");
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("select,button")).toBeNull();
    expect(inputs).toHaveLength(1);
    chooser.value = "Beta";
    chooser.dispatchEvent(new Event("change"));
    await viewer.updateComplete;
    await host.updateComplete;
    expect(inputs[0]?.signal.aborted).toBe(true);
    expect(inputs).toHaveLength(2);
    expect(host.shadowRoot?.querySelector("b")?.textContent).toBe("Beta");
    modeButton(viewer, "Render").click();
    await viewer.updateComplete;
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("b")?.textContent).toBe("Beta");
    expect(inputs).toHaveLength(2);
    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(inputs[1]?.signal.aborted).toBe(true);
    expect(chooser.value).toBe("Beta");
    modeButton(viewer, "Render").click();
    await viewer.updateComplete;
    const resumed = viewer.renderRoot.querySelector<ContentRendererHost>("pi-web-content-renderer");
    if (resumed === null) throw new Error("Expected resumed preview");
    await resumed.updateComplete;
    expect(resumed.shadowRoot?.querySelector("b")?.textContent).toBe("Beta");
    viewer.selectedPath = "second.mmd";
    viewer.file = textFile("second.mmd", "other");
    await viewer.updateComplete;
    expect(chooser.value).toBe("Alpha");
  });

  it("passes Markdown policy and complete text files to the public rendering capability with machine scope", async () => {
    const renderText = vi.fn<ContentRenderingCapability["renderText"]>(() => html`<div class="plugin-preview">Diagram</div>`);
    const renderMarkdown = vi.fn<ContentRenderingCapability["renderMarkdown"]>(() => html`<div class="plugin-markdown">Markdown</div>`);
    const contentRendering = { listRenderers: () => [], renderText, renderMarkdown };
    const file = textFile("graph.mmd", "graph TD; A-->B");
    const viewer = await mountViewer(file, { machineId: "remote", contentRendering });
    expect(viewer.shadowRoot?.querySelector(".plugin-preview")).toBeNull();
    expect(renderText).toHaveBeenCalledWith({ machineId: "remote", filePath: "graph.mmd", text: file.content, controls: "external", allowManualPreview: false });
    expect(viewer.shadowRoot?.querySelector(".viewer-header .viewer-mode")).not.toBeNull();
    modeButton(viewer, "Preview").click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector(".plugin-preview")).not.toBeNull();
    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector(".plugin-preview")).toBeNull();
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).not.toBeNull();
    renderText.mockClear();
    viewer.file = { ...file, truncated: true };
    await viewer.updateComplete;
    expect(renderText).not.toHaveBeenCalled();
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).not.toBeNull();
    viewer.file = { ...file, size: MAX_INLINE_PREVIEW_BYTES + 1 };
    await viewer.updateComplete;
    expect(renderText).not.toHaveBeenCalled();

    const markdown = textFile("README.md", "```mermaid\ngraph TD\n```", { mediaType: "markdown" });
    viewer.selectedPath = markdown.path;
    viewer.file = markdown;
    await viewer.updateComplete;
    expect(renderMarkdown).not.toHaveBeenCalled();
    modeButton(viewer, "Preview").click();
    await viewer.updateComplete;
    const request = renderMarkdown.mock.calls[0]?.[0];
    expect(request).toMatchObject({ machineId: "remote", text: markdown.content, truncated: false });
    expect(request?.toSafeHtml("![remote](https://evil.test/pixel)")).toContain("Image omitted");
    expect(request?.toSafeHtml("![remote](https://evil.test/pixel)")).not.toContain("<img");
    expect(viewer.shadowRoot?.querySelector(".plugin-markdown")).not.toBeNull();
  });

  it("shows explicit selection, loading, unavailable, and content-mismatch states", async () => {
    const viewer = await mountViewer(undefined, { selectedPath: undefined });
    expect(statusMessage(viewer)).toBe("Select a file.");

    viewer.selectedPath = "notes.md";
    await viewer.updateComplete;
    expect(statusMessage(viewer)).toBe("Loading notes.md…");
    expect(viewer.shadowRoot?.querySelector("[role='status']")?.getAttribute("aria-live")).toBe("polite");

    viewer.loadError = "Path does not exist: notes.md";
    await viewer.updateComplete;
    expect(statusMessage(viewer)).toBe("Unable to load notes.md: Path does not exist: notes.md");
    expect(viewer.shadowRoot?.querySelector("[role='alert']")).not.toBeNull();

    viewer.loadError = undefined;
    viewer.file = textFile("other.md", "# Wrong file", { mediaType: "markdown", language: "markdown" });
    await viewer.updateComplete;
    expect(statusMessage(viewer)).toBe("Unable to preview notes.md: loaded content belongs to other.md.");
    expect(viewer.shadowRoot?.querySelector("a, iframe, pi-web-files-code-viewer")).toBeNull();
  });

  it("opens HTML as literal raw source and previews it in an exactly sandboxed frame on request", async () => {
    const source = `<h1 onclick="alert(1)">Literal heading</h1><script>alert("no")</script>`;
    const file = textFile("pages/report.html", source, {
      mediaType: "html",
      mimeType: "text/html; charset=utf-8",
      language: "html",
    });
    const viewer = await mountViewer(file);

    const group = requiredElement(viewer.shadowRoot?.querySelector("[role='group']"), "mode group");
    expect(group.getAttribute("aria-label")).toBe("View pages/report.html");
    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("false");
    expect(viewer.shadowRoot?.querySelector("iframe")).toBeNull();
    expect(requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("pi-web-files-code-viewer"), "raw code viewer").content).toBe(source);
    expect(viewer.shadowRoot?.querySelector("h1, script")).toBeNull();

    const open = anchorWithText(viewer, "Open ↗");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(open.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(new URL(open.href).searchParams.get("download")).toBeNull();
    const download = requiredElement(viewer.shadowRoot?.querySelector<HTMLAnchorElement>("a[download]"), "download action");
    expect(download.getAttribute("download")).toBe("report.html");
    expect(new URL(download.href).searchParams.get("download")).toBe("1");

    modeButton(viewer, "Preview").click();
    await viewer.updateComplete;

    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).toBeNull();
    const frame = requiredElement(viewer.shadowRoot?.querySelector<HTMLIFrameElement>("iframe"), "HTML preview frame");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Preview of pages/report.html");

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("iframe")).toBeNull();
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).not.toBeNull();
  });

  it("opens Markdown as literal raw source and renders it through the safe renderer on request", async () => {
    const source = `# Rendered\n\n<script>alert(1)</script>\n\n![remote](https://attacker.test/pixel.png)\n\n[Docs](https://example.test/docs)`;
    const file = textFile("README.md", source, { mediaType: "markdown", language: "markdown" });
    const viewer = await mountViewer(file);

    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    const raw = requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("pi-web-files-code-viewer"), "raw Markdown viewer");
    expect(raw.content).toBe(source);
    expect(viewer.shadowRoot?.querySelector(".markdown-preview")).toBeNull();

    modeButton(viewer, "Preview").click();
    await viewer.updateComplete;

    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    const preview = requiredElement(viewer.shadowRoot?.querySelector(".markdown-preview"), "Markdown preview");
    expect(preview.querySelector("h1")?.textContent).toBe("Rendered");
    expect(preview.querySelector("script, img, iframe, object, embed, svg")).toBeNull();
    expect(preview.textContent).toContain("<script>alert(1)</script>");
    expect(preview.textContent).toContain("[Image omitted: remote]");
    const renderedLink = requiredElement(preview.querySelector("a"), "rendered Markdown link");
    expect(renderedLink.getAttribute("target")).toBe("_blank");
    expect(renderedLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(viewer.shadowRoot?.textContent).not.toContain("Open ↗");
  });

  it("adopts the remembered mode, keeps it across files, and publishes what is displayed", async () => {
    const store = fakeModeStore("preview");
    const original = textFile("report.html", "<p>first</p>", { mediaType: "html", language: "html" });
    const viewer = await mountViewer(original, { modeStore: store });

    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(store.published).toEqual(["preview"]);

    // A new revision of the same file, a different machine, and a different
    // file all keep the mode the user last chose.
    viewer.file = { ...original, content: "<p>updated</p>", modifiedAt: "2026-06-25T00:01:00.000Z" };
    await viewer.updateComplete;
    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");

    viewer.machineId = "remote-1";
    await viewer.updateComplete;
    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(store.published).toEqual(["preview", "raw"]);

    const readme = textFile("README.md", "# Docs", { mediaType: "markdown", language: "markdown" });
    viewer.selectedPath = readme.path;
    viewer.file = readme;
    await viewer.updateComplete;
    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector(".markdown-preview")).toBeNull();

    // Files without a rendered form never publish a mode, so a link to a PNG
    // cannot rewrite the remembered choice.
    const image = binaryFile("photo.png", { mediaType: "image", mimeType: "image/png" });
    viewer.selectedPath = image.path;
    viewer.file = image;
    await viewer.updateComplete;
    expect(store.published).toEqual(["preview", "raw"]);
  });

  it("restores the rendered mode when host navigation supplies a new snapshot", async () => {
    const file = textFile("first.html", "<p>first</p>", { mediaType: "html", language: "html" });
    const viewer = await mountViewer(file, { modeStore: fakeModeStore("raw") });
    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");

    viewer.modeStore = fakeModeStore("preview");
    await viewer.updateComplete;
    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("iframe")).not.toBeNull();

    viewer.modeStore = fakeModeStore("raw");
    await viewer.updateComplete;
    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).not.toBeNull();
  });

  it("ignores stale mode controls after a different file is selected", async () => {
    const first = textFile("first.html", "<p>first</p>", { mediaType: "html", language: "html" });
    const viewer = await mountViewer(first);
    const detachedPreviewButton = modeButton(viewer, "Preview");

    // A streamed image has no mode controls, so the earlier buttons leave the
    // DOM entirely and any later click on one is genuinely stale.
    const image = binaryFile("second.png", { mediaType: "image", mimeType: "image/png" });
    viewer.selectedPath = image.path;
    viewer.file = image;
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("img")).not.toBeNull();
    expect(detachedPreviewButton.isConnected).toBe(false);

    detachedPreviewButton.click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("img")).not.toBeNull();
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).toBeNull();

    // The stale click must not have changed the remembered mode either.
    const notes = textFile("notes.md", "# notes", { mediaType: "markdown", language: "markdown" });
    viewer.selectedPath = notes.path;
    viewer.file = notes;
    await viewer.updateComplete;
    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector(".markdown-preview")).toBeNull();
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).not.toBeNull();
  });

  it("ignores stale embedded-preview failures and exposes recovery for the current file", async () => {
    const image = binaryFile("first.png", { mediaType: "image", mimeType: "image/png" });
    const viewer = await mountViewer(image);
    const detachedImage = requiredElement(viewer.shadowRoot?.querySelector<HTMLImageElement>("img"), "first image");

    const pdf = binaryFile("second.pdf", { mediaType: "pdf", mimeType: "application/pdf" });
    viewer.selectedPath = pdf.path;
    viewer.file = pdf;
    await viewer.updateComplete;
    const currentFrame = requiredElement(viewer.shadowRoot?.querySelector<HTMLIFrameElement>("iframe"), "current PDF frame");
    // Sandboxed frames refuse native PDF handlers, so the PDF frame carries no
    // sandbox attribute and relies on the response contract plus the always
    // available Open/Download affordances.
    expect(currentFrame.hasAttribute("sandbox")).toBe(false);
    expect(currentFrame.getAttribute("allow")).toBe("");
    expect(currentFrame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(requiredElement(viewer.shadowRoot?.querySelector(".preview-note"), "PDF fallback note").textContent)
      .toContain("Use Open ↗ or Download above");
    expect(anchorWithText(viewer, "Open ↗")).toBeDefined();

    detachedImage.dispatchEvent(new Event("error"));
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("iframe")).toBe(currentFrame);
    expect(viewer.shadowRoot?.textContent).not.toContain("Preview failed");

    currentFrame.dispatchEvent(new Event("error"));
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain("Preview failed for second.pdf.");
    expect(viewer.shadowRoot?.querySelector("iframe")).toBeNull();
    expect(anchorWithText(viewer, "Open ↗")).toBeDefined();
    expect(viewer.shadowRoot?.querySelector("a[download]")).not.toBeNull();

    buttonWithText(viewer, "Retry preview").click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("iframe")).not.toBeNull();
  });

  it("gives SVG a rendered preview and literal escaped raw source", async () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>`;
    const file = textFile("assets/diagram.svg", source, { mediaType: "image", mimeType: "image/svg+xml" });
    const viewer = await mountViewer(file);

    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("img")).toBeNull();
    const raw = requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("pi-web-files-code-viewer"), "raw SVG viewer");
    expect(raw.content).toBe(source);
    expect(viewer.shadowRoot?.querySelector("svg, script")).toBeNull();

    modeButton(viewer, "Preview").click();
    await viewer.updateComplete;

    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).toBeNull();
    const image = requiredElement(viewer.shadowRoot?.querySelector<HTMLImageElement>("img"), "SVG preview image");
    expect(new URL(image.src).searchParams.get("path")).toBe(file.path);
    expect(image.getAttribute("alt")).toBe("Preview of assets/diagram.svg");

    const streamedImage = binaryFile("photo.png", { mediaType: "image", mimeType: "image/png" });
    viewer.selectedPath = streamedImage.path;
    viewer.file = streamedImage;
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("[role='group']")).toBeNull();
  });

  it("ignores delayed events from an earlier selection of an identically keyed file", async () => {
    const report = textFile("report.html", "<p>first</p>", { mediaType: "html", language: "html" });
    const viewer = await mountViewer(report, { modeStore: fakeModeStore("preview") });
    const detachedFrame = requiredElement(viewer.shadowRoot?.querySelector<HTMLIFrameElement>("iframe"), "first HTML frame");
    const detachedRawButton = modeButton(viewer, "Raw");

    const photo = binaryFile("photo.png", { mediaType: "image", mimeType: "image/png" });
    viewer.selectedPath = photo.path;
    viewer.file = photo;
    await viewer.updateComplete;

    // Re-select the first file with identical metadata: its identity key is the
    // same as before, so only a per-selection token can tell the renders apart.
    viewer.selectedPath = report.path;
    viewer.file = { ...report };
    await viewer.updateComplete;
    expect(detachedFrame.isConnected).toBe(false);
    expect(detachedRawButton.isConnected).toBe(false);
    expect(viewer.shadowRoot?.querySelector("iframe")).not.toBe(detachedFrame);

    detachedFrame.dispatchEvent(new Event("error"));
    detachedRawButton.click();
    await viewer.updateComplete;

    expect(viewer.shadowRoot?.textContent).not.toContain("Preview failed");
    expect(viewer.shadowRoot?.querySelector("iframe")).not.toBeNull();
    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("pi-web-files-code-viewer")).toBeNull();
  });

  it("keeps empty, oversized, unsupported, and truncated states explicit", async () => {
    const emptyMarkdown = textFile("empty.md", "", { mediaType: "markdown", language: "markdown", size: 0 });
    const viewer = await mountViewer(emptyMarkdown);
    expect(statusMessage(viewer)).toBe("This file is empty.");
    expect(modeButton(viewer, "Preview")).toBeDefined();
    expect(viewer.shadowRoot?.querySelector("a[download]")).not.toBeNull();

    const oversizedHtml = textFile("large.html", "<p>first capped bytes</p>", {
      mediaType: "html",
      language: "html",
      size: MAX_INLINE_PREVIEW_BYTES + 1,
      truncated: true,
    });
    viewer.selectedPath = oversizedHtml.path;
    viewer.file = oversizedHtml;
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("[role='status']")?.textContent).toContain("Raw source is truncated");
    expect(requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("pi-web-files-code-viewer"), "oversized raw source").content).toBe("<p>first capped bytes</p>");
    expect(viewer.shadowRoot?.textContent).not.toContain("Open ↗");
    expect(viewer.shadowRoot?.querySelector("a[download]")).not.toBeNull();

    modeButton(viewer, "Preview").click();
    await viewer.updateComplete;
    expect(statusMessage(viewer)).toContain("File too large to preview");
    expect(viewer.shadowRoot?.querySelector("iframe")).toBeNull();

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;

    const archive = binaryFile(String.raw`C:\reports\archive.zip`);
    viewer.selectedPath = archive.path;
    viewer.file = archive;
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.textContent).toContain("Preview isn't available for this file type.");
    const fallback = requiredElement(viewer.shadowRoot?.querySelector<HTMLAnchorElement>(".download-link"), "unsupported-file download fallback");
    expect(fallback.textContent).toContain("Download archive.zip");
    expect(fallback.getAttribute("download")).toBe("archive.zip");
    expect(new URL(fallback.href).searchParams.get("path")).toBe(archive.path);
    expect(new URL(fallback.href).searchParams.get("download")).toBe("1");
  });
});

describe("workspace file viewer seams", () => {
  it("classifies every viewer kind including Markdown", () => {
    expect(workspaceFilePreviewKind(binaryFile("logo.png", { mediaType: "image" }))).toBe("image");
    expect(workspaceFilePreviewKind(textFile("report.html", "x", { mediaType: "html" }))).toBe("html");
    expect(workspaceFilePreviewKind(binaryFile("report.pdf", { mediaType: "pdf" }))).toBe("pdf");
    expect(workspaceFilePreviewKind(textFile("README.md", "x", { mediaType: "markdown" }))).toBe("markdown");
    expect(workspaceFilePreviewKind(binaryFile("archive.zip"))).toBe("download");
    expect(workspaceFilePreviewKind(textFile("main.ts", "const x = 1", { language: "typescript" }))).toBe("code");
  });

  it("keys state by machine, project, workspace, path, modified time, and loaded format", () => {
    const file = textFile("report.html", "<p>x</p>", { mediaType: "html" });
    const base: WorkspaceFileViewerIdentity = {
      machineId: "local",
      projectId: "project-1",
      workspaceId: "workspace-1",
      selectedPath: file.path,
      file,
    };
    const baseKey = workspaceFileViewerIdentityKey(base);
    const variants: WorkspaceFileViewerIdentity[] = [
      { ...base, machineId: "remote-1" },
      { ...base, projectId: "project-2" },
      { ...base, workspaceId: "workspace-2" },
      { ...base, selectedPath: "other.html" },
      { ...base, file: { ...file, modifiedAt: "2026-06-25T00:01:00.000Z" } },
      { ...base, file: { ...file, mediaType: "markdown" } },
    ];

    expect(new Set(variants.map(workspaceFileViewerIdentityKey))).toHaveLength(variants.length);
    for (const variant of variants) expect(workspaceFileViewerIdentityKey(variant)).not.toBe(baseKey);
  });
});

interface ViewerPatch {
  contentRendering?: ContentRenderingCapability;
  machineId?: string;
  projectId?: string;
  workspaceId?: string;
  selectedPath?: string | undefined;
  file?: FileContentResponse | undefined;
  loadError?: string | undefined;
  previewUrlBuilder?: WorkspaceFileViewer["previewUrlBuilder"];
  modeStore?: WorkspaceFileViewModeStore;
}

interface FakeModeStore extends WorkspaceFileViewModeStore {
  published: WorkspaceFileViewMode[];
}

function fakeModeStore(adopted: WorkspaceFileViewMode = "raw"): FakeModeStore {
  const published: WorkspaceFileViewMode[] = [];
  return {
    published,
    adopt: () => adopted,
    publish: (mode) => { published.push(mode); },
  };
}

async function mountViewer(file: FileContentResponse | undefined, patch: ViewerPatch = {}): Promise<WorkspaceFileViewer> {
  const viewer = new WorkspaceFileViewer();
  Object.assign(viewer, {
    machineId: "local",
    projectId: "project-1",
    workspaceId: "workspace-1",
    selectedPath: file?.path,
    file,
    loadError: undefined,
    previewUrlBuilder: inertPreviewUrl,
    modeStore: fakeModeStore(),
  }, patch);
  document.body.append(viewer);
  await viewer.updateComplete;
  return viewer;
}

const inertPreviewUrl: WorkspaceFileViewer["previewUrlBuilder"] = (_projectId, _workspaceId, path, options) => {
  const params = new URLSearchParams({ path });
  if (options?.modifiedAt !== undefined) params.set("v", options.modifiedAt);
  if (options?.download === true) params.set("download", "1");
  return `about:blank?${params.toString()}`;
};

function textFile(path: string, content: string, patch: Partial<FileContentResponse> = {}): FileContentResponse {
  return {
    path,
    encoding: "utf8",
    size: content.length,
    modifiedAt: "2026-06-25T00:00:00.000Z",
    content,
    truncated: false,
    binary: false,
    ...patch,
  };
}

function binaryFile(path: string, patch: Partial<FileContentResponse> = {}): FileContentResponse {
  return {
    path,
    encoding: "utf8",
    size: 4096,
    modifiedAt: "2026-06-25T00:00:00.000Z",
    content: "",
    truncated: false,
    binary: true,
    ...patch,
  };
}

function modeButton(viewer: WorkspaceFileViewer, text: "Preview" | "Render" | "Raw"): HTMLButtonElement {
  return buttonWithText(viewer, text);
}

function buttonWithText(viewer: WorkspaceFileViewer, text: string): HTMLButtonElement {
  const button = [...(viewer.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent.trim() === text);
  return requiredElement(button, `${text} button`);
}

function anchorWithText(viewer: WorkspaceFileViewer, text: string): HTMLAnchorElement {
  const anchor = [...(viewer.shadowRoot?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].find((candidate) => candidate.textContent.trim() === text);
  return requiredElement(anchor, `${text} link`);
}

function statusMessage(viewer: WorkspaceFileViewer): string {
  return requiredElement(viewer.shadowRoot?.querySelector<HTMLElement>(".viewer-status"), "viewer status").textContent.trim();
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
