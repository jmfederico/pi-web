// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}
// Create inert frame contexts, but block child navigation so fixtures cannot fetch pages.
import { afterEach, describe, expect, it, vi } from "vitest";
import { html, LitElement } from "lit";
import type { FileContentResponse, FilePreviewerContribution, WorkspaceFilesCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { ContentRendererHost } from "../../src/client/src/components/ContentRendererHost";
import { settleDeferredContent, useDeferredContent } from "../../src/client/src/formatting/deferredContent.testSupport";
import { adaptPublicPlugin } from "../../src/client/src/plugins/publicContext";
import { PluginRegistry } from "../../src/client/src/plugins/registry";
import { FilesDocumentPreview } from "./FilesDocumentPreview";
import { createDocumentPreviewers } from "./documentPreviewers";
import { filesLocalizationFixture } from "./filesLocalization.testSupport";
import { DEFAULT_MAX_INLINE_PREVIEW_BYTES, WorkspaceFileViewer, workspaceFileViewerIdentityKey, type WorkspaceFileViewerIdentity } from "./FilesViewer";
import type { WorkspaceFileViewMode, WorkspaceFileViewModeStore } from "./workspaceFileViewMode";

if (customElements.get("pi-web-files-viewer") === undefined) customElements.define("pi-web-files-viewer", WorkspaceFileViewer);
if (customElements.get("pi-web-files-document-preview") === undefined) customElements.define("pi-web-files-document-preview", FilesDocumentPreview);
useDeferredContent();
const registries: PluginRegistry[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  for (const registry of registries.splice(0)) await registry.dispose();
  localStorage.clear(); vi.restoreAllMocks();
});

function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error("Missing expected preview element");
  return value;
}
function query(root: ParentNode, selector: string): Element | null {
  const direct = root.querySelector(selector);
  if (direct !== null) return direct;
  if (root instanceof Element && root.shadowRoot !== null) {
    const nested = query(root.shadowRoot, selector);
    if (nested !== null) return nested;
  }
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot !== null) {
      const found = query(element.shadowRoot, selector);
      if (found !== null) return found;
    }
  }
  return null;
}
function queryAs<ElementType extends Element>(root: ParentNode, selector: string, kind: new () => ElementType): ElementType | null {
  const found = query(root, selector);
  if (found !== null && !(found instanceof kind)) throw new Error("Unexpected preview element type");
  return found;
}
async function settleTree(root: Element | ShadowRoot): Promise<void> {
  if (root instanceof LitElement) await root.updateComplete;
  if (root instanceof Element && root.shadowRoot !== null) await settleTree(root.shadowRoot);
  for (const child of root.children) await settleTree(child);
}
async function settle(viewer: WorkspaceFileViewer): Promise<void> {
  await settleTree(viewer); await settleDeferredContent(viewer); await settleTree(viewer);
  await settleDeferredContent(viewer); await settleTree(viewer);
}
function button(viewer: WorkspaceFileViewer, label: string): HTMLButtonElement {
  return required([...required(viewer.shadowRoot).querySelectorAll(".viewer-mode button")].find((item): item is HTMLButtonElement => item instanceof HTMLButtonElement && item.textContent.trim() === label));
}
function status(viewer: WorkspaceFileViewer): string { return required(query(viewer, ".viewer-status")).textContent.trim(); }
function file(path: string, patch: Partial<FileContentResponse> = {}): FileContentResponse {
  return { path, encoding: "utf8", size: 10, modifiedAt: "first", content: "source", truncated: false, binary: false, ...patch };
}
function store(preference: WorkspaceFileViewMode | "fresh" = "raw") {
  return { adopt: () => preference === "fresh" ? undefined : preference, publish: vi.fn<(mode: WorkspaceFileViewMode) => void>() } satisfies WorkspaceFileViewModeStore;
}
async function mount(initial: FileContentResponse | undefined, preference: WorkspaceFileViewMode | "fresh" = "raw") {
  const localization = filesLocalizationFixture();
  const registry = new PluginRegistry({ localization: localization.service }); registries.push(registry);
  const viewer = new WorkspaceFileViewer();
  viewer.content = localization.content;
  viewer.machineId = "local"; viewer.projectId = "project"; viewer.workspaceId = "workspace";
  const modeStore = store(preference);
  viewer.filePreviewing = registry.filePreviewing; viewer.modeStore = modeStore;
  viewer.previewUrlBuilder = (_project, _workspace, path, options) => {
    const query = new URLSearchParams({ path });
    if (options?.modifiedAt !== undefined) query.set("v", options.modifiedAt);
    if (options?.download === true) query.set("download", "1");
    return `about:blank?${query.toString()}`;
  };
  const unavailable = (): never => { throw new Error("Unused fixture file operation"); };
  const files: WorkspaceFilesCapabilityV1 = {
    capabilityVersion: 1, defaultUploadFolder: "uploads", maxInlinePreviewBytes: DEFAULT_MAX_INLINE_PREVIEW_BYTES,
    readFile: unavailable, listFiles: unavailable, writeFile: unavailable, deleteFile: unavailable, moveFile: unavailable, uploadFile: unavailable,
    previewUrl: (path, options) => viewer.previewUrlBuilder(viewer.projectId, viewer.workspaceId, path, { ...(options?.version === undefined ? {} : { modifiedAt: options.version }), machineId: viewer.machineId }),
    downloadUrl: (path) => viewer.previewUrlBuilder(viewer.projectId, viewer.workspaceId, path, { download: true }),
  };
  viewer.files = files;
  await registry.register({ id: "documents", plugin: adaptPublicPlugin({ apiVersion: 5, name: "Document previews", activate: () => ({ contributions: {
    filePreviewers: createDocumentPreviewers({ html, content: localization.content, getMarkdownRendering: () => registry.markdownRendering, getStylesheetIntegration: () => undefined }),
  } }) }) });
  viewer.file = initial; viewer.selectedPath = initial?.path;
  document.body.append(viewer); await settle(viewer);
  return { viewer, registry, localization, modeStore };
}

describe("Files as a preview contribution consumer", () => {
  it("preserves explicit loading, error, mismatch and empty states", async () => {
    const { viewer } = await mount(undefined);
    expect(status(viewer)).toBe("Select a file.");
    viewer.selectedPath = "notes.md"; await settle(viewer);
    expect(status(viewer)).toBe("Loading notes.md…");
    viewer.loadError = "backend <img> diagnostic"; await settle(viewer);
    expect(status(viewer)).toContain("backend <img> diagnostic"); expect(query(viewer, "img")).toBeNull();
    viewer.loadError = undefined; viewer.file = file("other.md"); await settle(viewer);
    expect(status(viewer)).toContain("other.md");
    viewer.file = file("notes.md", { size: 0, content: "", mediaType: "markdown" }); await settle(viewer);
    expect(status(viewer)).toBe("This file is empty.");
    expect(query(viewer, "a[download]")).not.toBeNull();
  });

  it.each([
    ["image.svg", "image"], ["report.html", "html"], ["notes.md", "markdown"],
  ] as const)("keeps Raw as the safe default for %s and mounts its registered preview on demand", async (path, mediaType) => {
    const { viewer } = await mount(file(path, { mediaType }));
    expect(query(viewer, "pi-web-files-document-preview")).toBeNull();
    expect(query(viewer, "pi-web-files-code-viewer")).not.toBeNull();
    button(viewer, "Preview").click(); await settle(viewer);
    expect(query(viewer, "pi-web-files-document-preview")).toBeInstanceOf(FilesDocumentPreview);
    expect(button(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    button(viewer, "Raw").click(); await settle(viewer);
    expect(query(viewer, "pi-web-files-document-preview")).toBeNull();
    expect(query(viewer, "pi-web-files-code-viewer")).not.toBeNull();
  });

  it.each([["photo.png", "image"], ["report.pdf", "pdf"]] as const)("automatically discovers the registered binary preview for %s", async (path, mediaType) => {
    const { viewer } = await mount(file(path, { mediaType, binary: true, content: "" }));
    expect(query(viewer, "pi-web-files-document-preview")).toBeInstanceOf(FilesDocumentPreview);
    expect(query(viewer, mediaType === "image" ? "img" : "iframe")).not.toBeNull();
    expect(button(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(query(viewer, "a[download]")).not.toBeNull();
  });

  it("keeps the remembered source preference when choosing a binary preview without a redundant Original view", async () => {
    const source = file("notes.md", { mediaType: "markdown" });
    const { viewer, modeStore } = await mount(source, "preview");
    const publish = modeStore.publish;
    publish.mockClear();
    viewer.file = file("report.pdf", { mediaType: "pdf", binary: true, content: "" });
    viewer.selectedPath = "report.pdf";
    await settle(viewer);
    button(viewer, "Preview").click();
    await settle(viewer);
    expect(query(viewer, "pi-web-file-previewer")).not.toBeNull();
    expect([...required(viewer.shadowRoot).querySelectorAll(".viewer-mode button")].map((item) => item.textContent.trim())).toEqual(["Preview"]);
    expect(query(viewer, "a[download]")).not.toBeNull();
    expect(publish).not.toHaveBeenCalled();
    viewer.file = source;
    viewer.selectedPath = source.path;
    await settle(viewer);
    expect(button(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(publish).not.toHaveBeenCalledWith("raw");
  });

  it("retains retry state and localized recovery actions across language changes", async () => {
    const { viewer, localization } = await mount(file("image.svg", { mediaType: "image" }), "preview");
    required(query(viewer, "img")).dispatchEvent(new Event("error")); await settle(viewer);
    const retry = required(queryAs(viewer, ".preview-state button", HTMLButtonElement));
    retry.focus(); expect(retry.textContent).toBe("Retry preview");
    await localization.service.setPreferences({ ...localization.service.preferences, language: "ar-XB" }); await settle(viewer);
    expect(retry.textContent).not.toBe("Retry preview"); expect(query(viewer, "img")).toBeNull();
    expect(retry.isConnected).toBe(true);
    retry.click(); await settle(viewer); expect(query(viewer, "img")).not.toBeNull();
  });

  it("ignores detached media events and header actions after an A-to-B-to-A switch", async () => {
    const report = file("report.html", { mediaType: "html" });
    const { viewer } = await mount(report, "preview");
    const oldFrame = required(query(viewer, "iframe")); const oldRaw = button(viewer, "Raw");
    viewer.file = undefined; viewer.selectedPath = "photo.png"; await settle(viewer);
    viewer.file = file("photo.png", { mediaType: "image", binary: true }); await settle(viewer);
    viewer.file = undefined; viewer.selectedPath = report.path; await settle(viewer);
    viewer.file = { ...report }; await settle(viewer);
    expect(oldRaw.isConnected).toBe(false);
    oldFrame.dispatchEvent(new Event("error")); oldRaw.click(); await settle(viewer);
    expect(query(viewer, ".preview-state[role=alert]")).toBeNull();
    expect(query(viewer, "iframe")).not.toBeNull(); expect(button(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps size limits, capped Raw source, and unsupported-file downloads explicit", async () => {
    const { viewer } = await mount(file("large.html", { mediaType: "html", content: "first bytes", size: DEFAULT_MAX_INLINE_PREVIEW_BYTES + 1, truncated: true }));
    expect(query(viewer, "[role=status]")?.textContent).toContain("Raw source is truncated");
    expect(query(viewer, '.viewer-actions a[target="_blank"]')).toBeNull();
    button(viewer, "Preview").click(); await settle(viewer);
    expect(status(viewer)).toContain("File too large to preview"); expect(query(viewer, "iframe")).toBeNull();
    viewer.file = file(String.raw`C:\reports\archive.zip`, { binary: true, content: "" }); viewer.selectedPath = viewer.file.path; await settle(viewer);
    const download = required(queryAs(viewer, ".download-link", HTMLAnchorElement));
    expect(download.getAttribute("download")).toBe("archive.zip");
    expect(new URL(download.href).searchParams.get("download")).toBe("1");
  });

  it("uses the same chooser and cancellation path for existing text content renderers", async () => {
    const { viewer, registry } = await mount(file("graph.mmd"));
    const signals: AbortSignal[] = [];
    await registry.register({ id: "diagram", plugin: adaptPublicPlugin({ apiVersion: 5, name: "Diagram", activate: () => ({ contributions: { contentRenderers: [{
      id: "graph", title: "Diagram", fileExtensions: ["mmd"], render: ({ signal }) => { signals.push(signal); return html`<b>Diagram preview</b>`; },
    }] } }) }) });
    viewer.requestUpdate(); await settle(viewer);
    expect(signals).toHaveLength(0);
    button(viewer, "Diagram").click(); await settle(viewer);
    const host = required(queryAs(viewer, "pi-web-content-renderer", ContentRendererHost));
    expect(host.shadowRoot?.textContent).toContain("Diagram preview");
    expect(host.shadowRoot?.querySelector("button")).toBeNull();
    expect(signals).toHaveLength(1);
    button(viewer, "Raw").click(); await settle(viewer); expect(signals[0]?.aborted).toBe(true);
    button(viewer, "Diagram").click(); await settle(viewer); expect(signals.at(-1)?.aborted).toBe(false);
  });

  it("preserves explicit renderer selection while new automatic choices appear", async () => {
    const { viewer, registry } = await mount(file("model.custom"), "fresh");
    const add = async (name: string) => registry.register({ id: name.toLowerCase(), plugin: adaptPublicPlugin({ apiVersion: 5, name, activate: () => ({ contributions: {
      filePreviewers: [{ id: "view", title: name, fileExtensions: ["custom"], renderMode: "automatic", render: () => html`<b>${name}</b>` } satisfies FilePreviewerContribution],
    } }) }) });
    await add("Alpha"); await add("Beta"); viewer.requestUpdate(); await settle(viewer);
    expect(button(viewer, "Beta").getAttribute("aria-pressed")).toBe("true");
    button(viewer, "Alpha").click(); await settle(viewer);
    await add("Gamma"); viewer.requestUpdate(); await settle(viewer);
    expect(button(viewer, "Alpha").getAttribute("aria-pressed")).toBe("true");
    button(viewer, "Raw").click(); await settle(viewer);
    expect(query(viewer, "pi-web-file-previewer")).toBeNull();
  });

  it("keeps saved Markdown preview intent, sanitization and fenced-renderer controls", async () => {
    const source = "# Notes\n\n![tracking](https://evil.test/pixel)\n\n```diagram\nsource\n```\n\n<script>bad()</script>";
    const { viewer, registry } = await mount(file("notes.md", { mediaType: "markdown", content: source, size: source.length }), "preview");
    await registry.register({ id: "diagram", plugin: adaptPublicPlugin({ apiVersion: 5, name: "Diagram", activate: () => ({ contributions: {
      contentRenderers: [{ id: "diagram", title: "Diagram", languages: ["diagram"], render: ({ text }) => html`<b>${text}</b>` }],
    } }) }) });
    viewer.requestUpdate(); await settle(viewer);
    const preview = required(query(viewer, ".markdown-preview"));
    expect(preview.querySelector("h1")?.textContent).toBe("Notes");
    expect(preview.querySelector("script,img")).toBeNull();
    expect(preview.textContent).toContain("Image omitted");
    const host = required(queryAs(viewer, "pi-web-content-renderer", ContentRendererHost));
    expect(host.shadowRoot?.querySelector("b")?.textContent).toBe("source");
    const raw = required([...required(host.shadowRoot).querySelectorAll("button")].find((item) => item.textContent.trim() === "Raw"));
    raw.click(); await settle(viewer);
    expect(host.shadowRoot?.querySelector("pre code")?.textContent).toBe("source");
    viewer.requestUpdate(); await settle(viewer);
    expect(host.shadowRoot?.querySelector("pre code")?.textContent).toBe("source");
  });
});

describe("file identity", () => {
  it("separates source and format identity across machines, workspaces and file revisions", () => {
    const value = file("report.html", { mediaType: "html" });
    const base: WorkspaceFileViewerIdentity = { machineId: "local", projectId: "p", workspaceId: "w", selectedPath: value.path, file: value };
    const variants = [{ ...base, machineId: "remote" }, { ...base, projectId: "other" }, { ...base, workspaceId: "other" },
      { ...base, selectedPath: "other.html" }, { ...base, file: { ...value, modifiedAt: "later" } }, { ...base, file: { ...value, mediaType: "markdown" as const } }];
    const identity = workspaceFileViewerIdentityKey(base);
    for (const variant of variants) expect(workspaceFileViewerIdentityKey(variant)).not.toBe(identity);
  });
});
