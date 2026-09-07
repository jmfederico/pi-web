// @vitest-environment happy-dom

import type { FileContentResponse, FileTreeResponse, WorkspaceFilesCapabilityV1, WorkspacePanelContext, WorkspacePanelNavigationV1, WriteWorkspaceFileResponse } from "@jmfederico/pi-web/plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFilesPanel, startDirectWorkspaceUpload, uploadBatchProgressValue, uploadBatchStatusLabel, workspaceUploadReviewDefaults, workspaceUploadReviewError } from "./FilesPanel";
import { FilesRuntime, type WorkspaceUploadBatchState } from "./FilesRuntime";
import { defineFilesCustomElements } from "./pi-web-plugin";

defineFilesCustomElements();

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Files panel component boundary", () => {
  it("loads and renders the tree, wires expansion/selection, and passes content to the viewer", async () => {
    const listFiles = vi.fn<WorkspaceFilesCapabilityV1["listFiles"]>((path) => Promise.resolve(path === ""
      ? treeResponse("", [{ name: "src", path: "src", type: "directory" }, { name: "README.md", path: "README.md", type: "file" }])
      : treeResponse(path, [{ name: "main.ts", path: "src/main.ts", type: "file" }])));
    const readFile = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path) => Promise.resolve(fileResponse(path)));
    const context = createContext({ files: createFiles({ listFiles, readFile }) });
    const panel = await mountPanel(context);

    await vi.waitFor(() => { expect(panel.shadowRoot?.textContent).toContain("README.md"); });
    buttonWithText(panel.shadowRoot, "src").click();
    await vi.waitFor(() => { expect(buttonWithText(panel.shadowRoot, "main.ts")).toBeDefined(); });
    buttonWithText(panel.shadowRoot, "README.md").click();
    await vi.waitFor(() => {
      const viewer = requiredElement(panel.shadowRoot?.querySelector<HTMLElement & { selectedPath?: string; file?: FileContentResponse }>("pi-web-files-viewer"), "Files viewer");
      expect(viewer.selectedPath).toBe("README.md");
      expect(viewer.file?.content).toBe("contents:README.md");
    });
    const expansionCall = listFiles.mock.calls.find(([path]) => path === "src");
    expect(expansionCall).toBeDefined();
    expect(expansionCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(readFile.mock.calls[0]?.[0]).toBe("README.md");
    expect(readFile.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("adopts query-only back and forward contexts delivered through invalidation", async () => {
    const files = createFiles({ readFile: (path) => Promise.resolve({ ...fileResponse(path), mediaType: "markdown" }) });
    const first = createContext({ files, navigation: createNavigation({ file: "a.md", mode: "raw" }) });
    const runtime = new FilesRuntime();
    const panel = await mountPanel(first, runtime);
    await vi.waitFor(() => {
      const viewer = requiredElement(panel.shadowRoot?.querySelector<HTMLElement>("pi-web-files-viewer"), "Files viewer");
      expect(buttonWithText(viewer.shadowRoot, "Raw").getAttribute("aria-pressed")).toBe("true");
    });

    const restored = { ...first, navigation: createNavigation({ file: "b.md", mode: "preview" }) };
    await runtime.invalidate(restored);

    await vi.waitFor(() => {
      const viewer = requiredElement(panel.shadowRoot?.querySelector<HTMLElement & { file?: FileContentResponse }>("pi-web-files-viewer"), "Files viewer");
      expect(viewer.file?.path).toBe("b.md");
      expect(buttonWithText(viewer.shadowRoot, "Preview").getAttribute("aria-pressed")).toBe("true");
    });
    expect(panel.context).toBe(restored);
  });

  it("cancels an obsolete selected-file request on disconnect and restores it on reconnect", async () => {
    const signals: AbortSignal[] = [];
    let readCount = 0;
    const readFile = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path, options) => {
      readCount += 1;
      const signal = options?.signal ?? new AbortController().signal;
      signals.push(signal);
      if (readCount > 1) return Promise.resolve(fileResponse(path));
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { reject(new DOMException("cancelled", "AbortError")); }, { once: true });
      });
    });
    const context = createContext({ files: createFiles({
      readFile,
      listFiles: () => Promise.resolve(treeResponse("", [{ name: "README.md", path: "README.md", type: "file" }])),
    }) });
    const panel = await mountPanel(context);
    await vi.waitFor(() => { expect(panel.shadowRoot?.textContent).toContain("README.md"); });
    buttonWithText(panel.shadowRoot, "README.md").click();
    await vi.waitFor(() => { expect(readFile).toHaveBeenCalledOnce(); });

    panel.remove();
    expect(signals[0]?.aborted).toBe(true);
    panel.context = { ...context, navigation: { ...createNavigation(), query: { file: "README.md" } } };
    document.body.append(panel);

    await vi.waitFor(() => { expect(readFile).toHaveBeenCalledTimes(2); });
    await vi.waitFor(() => {
      const viewer = requiredElement(panel.shadowRoot?.querySelector<HTMLElement & { file?: FileContentResponse }>("pi-web-files-viewer"), "Files viewer");
      expect(viewer.file?.content).toBe("contents:README.md");
    });
  });

  it("cancels an unobserved tree request on disconnect and reloads it on reconnect", async () => {
    const signals: AbortSignal[] = [];
    let listCount = 0;
    const listFiles = vi.fn<WorkspaceFilesCapabilityV1["listFiles"]>((path, options) => {
      listCount += 1;
      const signal = options?.signal ?? new AbortController().signal;
      signals.push(signal);
      if (listCount > 1) return Promise.resolve(treeResponse(path, [{ name: "README.md", path: "README.md", type: "file" }]));
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { reject(new DOMException("cancelled", "AbortError")); }, { once: true });
      });
    });
    const context = createContext({ files: createFiles({ listFiles }) });
    const panel = await mountPanel(context);
    await vi.waitFor(() => { expect(listFiles).toHaveBeenCalledOnce(); });

    panel.remove();
    expect(signals[0]?.aborted).toBe(true);
    document.body.append(panel);

    await vi.waitFor(() => { expect(listFiles).toHaveBeenCalledTimes(2); });
    await vi.waitFor(() => { expect(panel.shadowRoot?.textContent).toContain("README.md"); });
    expect(signals[1]?.aborted).toBe(false);
  });

  it("uses a native modal dialog for upload review and restores trigger focus on close", async () => {
    const context = createContext();
    const panel = await mountPanel(context);
    const upload = buttonWithText(panel.shadowRoot, "Upload");
    const input = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-input"), "upload input");
    upload.focus();
    upload.click();
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["hello"], "hello.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await panel.updateComplete;
    await panel.updateComplete;

    const dialog = requiredElement(panel.shadowRoot?.querySelector<HTMLDialogElement>("dialog.upload-dialog"), "upload dialog");
    expect(dialog.open).toBe(true);
    expect(dialog.matches("[open]")).toBe(true);
    expect(panel.shadowRoot?.activeElement?.id).toBe("workspace-upload-destination");

    dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true }));
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector("dialog.upload-dialog")).toBeNull();
    expect(panel.shadowRoot?.activeElement).toBe(upload);
  });

  it("closes upload review without refocusing a hidden trigger when responsive layout hides the panel", async () => {
    const panel = await mountPanel(createContext());
    const upload = buttonWithText(panel.shadowRoot, "Upload");
    const focus = vi.spyOn(upload, "focus");
    const input = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-input"), "upload input");
    upload.click();
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["hello"], "hello.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await panel.updateComplete;
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector<HTMLDialogElement>("dialog.upload-dialog")?.open).toBe(true);

    Object.defineProperty(panel, "getClientRects", { configurable: true, value: () => [] });
    focus.mockClear();
    window.dispatchEvent(new Event("resize"));
    await panel.updateComplete;
    await panel.updateComplete;

    expect(panel.shadowRoot?.querySelector("dialog.upload-dialog")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    panel.requestUpdate();
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector("dialog.upload-dialog")).toBeNull();
  });

  it("drops chooser results that arrive after responsive layout hides the panel", async () => {
    const panel = await mountPanel(createContext());
    const upload = buttonWithText(panel.shadowRoot, "Upload");
    const input = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-input"), "upload input");
    const focus = vi.spyOn(upload, "focus");

    upload.click();
    Object.defineProperty(panel, "getClientRects", { configurable: true, value: () => [] });
    window.dispatchEvent(new Event("resize"));
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["later"], "later.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await panel.updateComplete;
    await panel.updateComplete;

    expect(panel.shadowRoot?.querySelector("dialog.upload-dialog")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    Object.defineProperty(panel, "getClientRects", { configurable: true, value: visibleClientRects });
    panel.requestUpdate();
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector("dialog.upload-dialog")).toBeNull();
  });

  it("renders a many-file review with native close, cancel, and submit controls", async () => {
    const panel = await mountPanel(createContext());
    const input = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-input"), "upload input");
    const files = Array.from({ length: 20 }, (_value, index) => new File(["content"], `file-${String(index)}.txt`));
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await panel.updateComplete;
    await panel.updateComplete;

    const dialog = requiredElement(panel.shadowRoot?.querySelector<HTMLDialogElement>("dialog.upload-dialog"), "upload dialog");
    expect(dialog.open).toBe(true);
    expect(dialog.querySelectorAll(".review-file")).toHaveLength(20);
    expect(requiredElement(dialog.querySelector<HTMLButtonElement>(".close-button"), "close button").getAttribute("aria-label")).toBe("Cancel upload");
    expect(requiredElement(dialog.querySelector<HTMLButtonElement>("button[type='submit']"), "upload submit button").textContent).toContain("Upload");

    buttonWithText(dialog, "Cancel").click();
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector("dialog.upload-dialog")).toBeNull();
  });

  it("submits reviewed files with safe defaults and renders upload completion", async () => {
    let resolveUpload: (response: WriteWorkspaceFileResponse) => void = () => undefined;
    const uploadFile = vi.fn<WorkspaceFilesCapabilityV1["uploadFile"]>((file, options) => ({
      path: `${options?.destinationFolder ?? ""}/${file.name}`,
      completed: new Promise((resolve) => { resolveUpload = resolve; }),
      cancel: vi.fn(),
    }));
    const context = createContext({ files: createFiles({ uploadFile }) });
    const panel = await mountPanel(context);
    const input = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-input"), "upload input");
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["hello"], "hello.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await panel.updateComplete;
    await panel.updateComplete;

    requiredElement(panel.shadowRoot?.querySelector<HTMLButtonElement>("dialog button[type='submit']"), "upload submit button").click();
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledOnce(); });
    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({ name: "hello.txt" }), expect.objectContaining({
      destinationFolder: ".pi-web/uploads",
      createDirs: true,
      overwrite: false,
    }));

    resolveUpload(writeResponse(".pi-web/uploads/hello.txt"));
    await vi.waitFor(() => { expect(panel.shadowRoot?.textContent).toContain("Uploaded 1 file"); });
    expect(panel.shadowRoot?.textContent).toContain("Done");
  });

  it("surfaces a bounded capability error instead of calling unsupported host methods", async () => {
    const context = createContext({ files: legacyFiles(), navigation: null });
    const panel = await mountPanel(context);

    expect(panel.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain("workspace-files capability v1");
    expect(panel.shadowRoot?.querySelector(".split")).toBeNull();
  });
});

describe("Files upload helpers", () => {
  it("validates destinations and uses the host-effective folder for direct drops", () => {
    expect(workspaceUploadReviewDefaults("project/uploads")).toEqual({ destinationFolder: "project/uploads", createDirs: true, overwrite: false });
    expect(workspaceUploadReviewError([], "project/uploads")).toBe("Choose at least one file to upload.");
    expect(workspaceUploadReviewError([new File(["a"], "a.txt")], "../outside")).toContain("path traversal");

    const runtime = new FilesRuntime({ createUploadBatchId: () => "batch-1" });
    const context = createContext();
    const run = startDirectWorkspaceUpload(runtime, context, [new File(["a"], "a.txt")]);
    expect(run?.batchId).toBe("batch-1");
    expect(runtime.snapshot(context).uploadBatches["batch-1"]?.destinationFolder).toBe(".pi-web/uploads");
  });

  it("shows terminal batch labels at full progress", () => {
    const failed = uploadBatch({ status: "error", percent: 0.31 });
    expect(uploadBatchStatusLabel(failed)).toBe("Failed");
    expect(uploadBatchProgressValue(failed)).toBe(1);
    const uploading = uploadBatch({ status: "uploading", percent: 0.31 });
    expect(uploadBatchStatusLabel(uploading)).toBe("31%");
    expect(uploadBatchProgressValue(uploading)).toBe(0.31);
  });
});

async function mountPanel(context: WorkspacePanelContext, runtime = new FilesRuntime({ createUploadBatchId: () => "batch-1", now: () => "now" })): Promise<WorkspaceFilesPanel> {
  const panel = new WorkspaceFilesPanel();
  panel.context = context;
  panel.runtime = runtime;
  // happy-dom has no layout engine; component visibility is an explicit
  // browser boundary for the responsive native-modal guard.
  Object.defineProperty(panel, "getClientRects", { configurable: true, value: visibleClientRects });
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

interface ContextOptions {
  files?: WorkspacePanelContext["files"];
  navigation?: WorkspacePanelNavigationV1 | null;
}

function createContext(options: ContextOptions = {}): WorkspacePanelContext {
  return {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "repo", isMain: true },
    files: options.files ?? createFiles(),
    host: { requestRender: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    ...(options.navigation === null ? {} : { navigation: options.navigation ?? createNavigation() }),
  };
}

function createFiles(overrides: Partial<WorkspaceFilesCapabilityV1> = {}): WorkspaceFilesCapabilityV1 {
  return {
    capabilityVersion: 1,
    defaultUploadFolder: ".pi-web/uploads",
    maxInlinePreviewBytes: 1024 * 1024,
    readFile: (path) => Promise.resolve(fileResponse(path)),
    listFiles: (path) => Promise.resolve(treeResponse(path)),
    writeFile: () => Promise.reject(new Error("not implemented")),
    deleteFile: () => Promise.reject(new Error("not implemented")),
    moveFile: () => Promise.reject(new Error("not implemented")),
    previewUrl: (path) => `https://example.test/preview/${encodeURIComponent(path)}`,
    downloadUrl: (path) => `https://example.test/download/${encodeURIComponent(path)}`,
    uploadFile: () => ({ path: "pending", completed: new Promise(() => undefined), cancel: vi.fn() }),
    ...overrides,
  };
}

function legacyFiles(): WorkspacePanelContext["files"] {
  return {
    readFile: (path) => Promise.resolve(fileResponse(path)),
    listFiles: (path) => Promise.resolve(treeResponse(path)),
    writeFile: () => Promise.reject(new Error("not implemented")),
    deleteFile: () => Promise.reject(new Error("not implemented")),
    moveFile: () => Promise.reject(new Error("not implemented")),
  };
}

function createNavigation(query: WorkspacePanelNavigationV1["query"] = {}): WorkspacePanelNavigationV1 {
  return { version: 1, contributionId: "files:workspace.files", query, set: vi.fn() };
}

function treeResponse(path: string, entries: FileTreeResponse["entries"] = []): FileTreeResponse {
  return { path, entries, scannedAt: "now", truncated: false };
}

function fileResponse(path: string): FileContentResponse {
  const content = `contents:${path}`;
  return { path, encoding: "utf8", size: content.length, modifiedAt: "now", content, truncated: false, binary: false };
}

function writeResponse(path: string): WriteWorkspaceFileResponse {
  return { path, size: 5, modifiedAt: "now", created: true };
}

function uploadBatch(patch: Partial<WorkspaceUploadBatchState> = {}): WorkspaceUploadBatchState {
  return {
    id: "batch-1",
    destinationFolder: ".pi-web/uploads",
    overwrite: false,
    createDirs: true,
    files: [],
    currentFileIndex: -1,
    loaded: 0,
    total: 0,
    percent: 0,
    status: "uploading",
    startedAt: "now",
    ...patch,
  };
}

function visibleClientRects(): DOMRect[] {
  return [new DOMRect(0, 0, 800, 600)];
}

function buttonWithText(root: ParentNode | null | undefined, text: string): HTMLButtonElement {
  const button = [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent.trim().endsWith(text));
  return requiredElement(button, `${text} button`);
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
