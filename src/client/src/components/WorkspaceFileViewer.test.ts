// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContentResponse } from "../api";
import { MAX_INLINE_PREVIEW_BYTES } from "../../../shared/workspaceFiles";
import { workspaceFileViewModeStore, type WorkspaceFileViewMode, type WorkspaceFileViewModeStore } from "../workspaceFileViewMode";
import { WorkspaceFileViewer, workspaceFilePreviewKind, workspaceFileViewerIdentityKey, type WorkspaceFileViewerIdentity } from "./WorkspaceFileViewer";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("workspace-file-viewer", () => {
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
    expect(viewer.shadowRoot?.querySelector("a, iframe, code-viewer")).toBeNull();
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
    expect(requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("code-viewer"), "raw code viewer").content).toBe(source);
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
    expect(viewer.shadowRoot?.querySelector("code-viewer")).toBeNull();
    const frame = requiredElement(viewer.shadowRoot?.querySelector<HTMLIFrameElement>("iframe"), "HTML preview frame");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Preview of pages/report.html");

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("iframe")).toBeNull();
    expect(viewer.shadowRoot?.querySelector("code-viewer")).not.toBeNull();
  });

  it("opens Markdown as literal raw source and renders it through the safe renderer on request", async () => {
    const source = `# Rendered\n\n<script>alert(1)</script>\n\n![remote](https://attacker.test/pixel.png)\n\n[Docs](https://example.test/docs)`;
    const file = textFile("README.md", source, { mediaType: "markdown", language: "markdown" });
    const viewer = await mountViewer(file);

    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    const raw = requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("code-viewer"), "raw Markdown viewer");
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

  it("restores each file history entry's rendered mode through Back and Forward", async () => {
    const first = textFile("first.html", "<p>first</p>", { mediaType: "html", language: "html" });
    const second = textFile("second.html", "<p>second</p>", { mediaType: "html", language: "html" });
    replaceWorkspaceFileHistory(first.path, "raw");
    const viewer = await mountViewer(first, { modeStore: workspaceFileViewModeStore });
    expectHtmlMode(viewer, first.path, "raw");

    const files = new Map([[first.path, first], [second.path, second]]);
    const restoreFileFromRoute = (): void => {
      const selectedPath = workspaceFileHistoryValue(WORKSPACE_FILE_PATH_QUERY_KEY) ?? undefined;
      viewer.selectedPath = selectedPath;
      viewer.file = selectedPath === undefined ? undefined : files.get(selectedPath);
    };
    window.addEventListener("popstate", restoreFileFromRoute);
    try {
      // Ordinary file selection pushes a history entry while retaining the
      // current mode preference.
      pushWorkspaceFileHistory(second.path);
      viewer.selectedPath = second.path;
      viewer.file = second;
      await viewer.updateComplete;
      expectHtmlMode(viewer, second.path, "raw");

      // A mode switch replaces that file's current history entry.
      modeButton(viewer, "Preview").click();
      await viewer.updateComplete;
      expectHtmlMode(viewer, second.path, "preview");

      window.history.back();
      await viewer.updateComplete;
      expectHtmlMode(viewer, first.path, "raw");

      window.history.forward();
      await viewer.updateComplete;
      expectHtmlMode(viewer, second.path, "preview");
    } finally {
      window.removeEventListener("popstate", restoreFileFromRoute);
    }
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
    expect(viewer.shadowRoot?.querySelector("code-viewer")).toBeNull();

    // The stale click must not have changed the remembered mode either.
    const notes = textFile("notes.md", "# notes", { mediaType: "markdown", language: "markdown" });
    viewer.selectedPath = notes.path;
    viewer.file = notes;
    await viewer.updateComplete;
    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector(".markdown-preview")).toBeNull();
    expect(viewer.shadowRoot?.querySelector("code-viewer")).not.toBeNull();
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
    const raw = requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("code-viewer"), "raw SVG viewer");
    expect(raw.content).toBe(source);
    expect(viewer.shadowRoot?.querySelector("svg, script")).toBeNull();

    modeButton(viewer, "Preview").click();
    await viewer.updateComplete;

    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("code-viewer")).toBeNull();
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
    expect(viewer.shadowRoot?.querySelector("code-viewer")).toBeNull();
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
    expect(requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("code-viewer"), "oversized raw source").content).toBe("<p>first capped bytes</p>");
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

describe("workspace-file-viewer review wiring", () => {
  it("passes review + reviewFilePath to code-viewer for the raw source view", async () => {
    const review = fakeReviewHandle();
    const file = textFile("main.ts", "const x = 1", { language: "typescript" });
    const viewer = await mountViewer(file, { review });
    const codeViewer = requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { review?: unknown; reviewFilePath?: string }>("code-viewer"), "code viewer");
    expect(codeViewer.review).toBe(review);
    expect(codeViewer.reviewFilePath).toBe("main.ts");
  });

  it("does not reach code-viewer's review props for a non-raw preview kind", async () => {
    const review = fakeReviewHandle();
    const image = binaryFile("logo.png", { mediaType: "image", mimeType: "image/png" });
    const viewer = await mountViewer(image, { review });
    expect(viewer.shadowRoot?.querySelector("code-viewer")).toBeNull();
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
  machineId?: string;
  projectId?: string;
  workspaceId?: string;
  selectedPath?: string | undefined;
  file?: FileContentResponse | undefined;
  loadError?: string | undefined;
  previewUrlBuilder?: WorkspaceFileViewer["previewUrlBuilder"];
  modeStore?: WorkspaceFileViewModeStore;
  review?: WorkspaceFileViewer["review"];
}

/** Minimal fake review handle: identity is all these tests need (prop pass-through, not behavior). */
function fakeReviewHandle(): NonNullable<WorkspaceFileViewer["review"]> {
  return {
    total: () => 0,
    countForFile: () => 0,
    commentsForLine: () => [],
    draftForLine: () => null,
    lineState: () => ({ selected: false, commented: false }),
    canAuthor: () => true,
    beginSelection: () => { /* unused in this test */ },
    extendSelection: () => { /* unused in this test */ },
    commitSelection: () => { /* unused in this test */ },
    cancelSelection: () => { /* unused in this test */ },
    setDraftBody: () => { /* unused in this test */ },
    submitDraft: () => { /* unused in this test */ },
    cancelDraft: () => { /* unused in this test */ },
    updateComment: () => { /* unused in this test */ },
    removeComment: () => { /* unused in this test */ },
  };
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

const WORKSPACE_FILE_PATH_QUERY_KEY = "core.workspace.files--file";
const WORKSPACE_FILE_MODE_QUERY_KEY = "core.workspace.files--mode";

function replaceWorkspaceFileHistory(path: string, mode: WorkspaceFileViewMode): void {
  const url = new URL(window.location.href);
  url.searchParams.set(WORKSPACE_FILE_PATH_QUERY_KEY, path);
  url.searchParams.set(WORKSPACE_FILE_MODE_QUERY_KEY, mode);
  window.history.replaceState({}, "", url);
}

function pushWorkspaceFileHistory(path: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(WORKSPACE_FILE_PATH_QUERY_KEY, path);
  window.history.pushState({}, "", url);
}

function workspaceFileHistoryValue(key: string): string | null {
  return new URL(window.location.href).searchParams.get(key);
}

function expectHtmlMode(viewer: WorkspaceFileViewer, path: string, mode: WorkspaceFileViewMode): void {
  expect(workspaceFileHistoryValue(WORKSPACE_FILE_PATH_QUERY_KEY)).toBe(path);
  expect(workspaceFileHistoryValue(WORKSPACE_FILE_MODE_QUERY_KEY)).toBe(mode);
  expect(modeButton(viewer, mode === "raw" ? "Raw" : "Preview").getAttribute("aria-pressed")).toBe("true");
  expect(modeButton(viewer, mode === "raw" ? "Preview" : "Raw").getAttribute("aria-pressed")).toBe("false");
  expect(viewer.shadowRoot?.querySelector("code-viewer") !== null).toBe(mode === "raw");
  expect(viewer.shadowRoot?.querySelector("iframe") !== null).toBe(mode === "preview");
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

function modeButton(viewer: WorkspaceFileViewer, text: "Preview" | "Raw"): HTMLButtonElement {
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
