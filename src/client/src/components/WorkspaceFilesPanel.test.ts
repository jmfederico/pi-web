// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContentResponse, FileTreeEntry } from "../api";
import { initialAppState } from "../appState";
import type { WorkspacePanelContext } from "../plugins/types";
import type { WorkspaceUploadBatchState } from "../workspaceUploadState";
// Genuine Lit event-wiring extraction (upload input/form submit and file-tree
// row clicks) routes through the shared, type-guarded template-inspection escape
// hatch; see ../templateInspection.testSupport for the proportionality
// rationale. The extracted stateful viewer has its own happy-dom coverage.
import { findOptionalTemplateEventHandlerAfterMarker, templateClickHandlerForText, templateEventHandlerAfterMarker } from "../templateInspection.testSupport";
import { ModalSurface } from "./ModalSurface";
import { deepActiveElement } from "./modalLayerRegistry";
import { WorkspaceFilesPanel, startDirectWorkspaceUpload, uploadBatchProgressValue, uploadBatchStatusLabel, workspaceUploadBatchesForScope, workspaceUploadReviewDefaults, workspaceUploadReviewError } from "./WorkspaceFilesPanel";
import type { WorkspaceFileViewer } from "./WorkspaceFileViewer";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace-files-panel upload review", () => {
  it("opens review from the hidden file input and submits selected files with defaults", () => {
    vi.stubGlobal("HTMLInputElement", FakeHTMLInputElement);
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
    const onStartWorkspaceUpload = vi.fn<WorkspacePanelContext["onStartWorkspaceUpload"]>(() => ({ batchId: "batch-1", done: Promise.resolve() }));
    const panel = new WorkspaceFilesPanel();
    panel.context = workspacePanelContext({ workspaceUploadDefaultFolder: "project/uploads", onStartWorkspaceUpload });

    const inputChange = templateEventHandlerAfterMarker(panel.render(), `id="workspace-upload-input"`);
    const input = new FakeHTMLInputElement(files);
    inputChange(new EventWithCurrentTarget("change", input));

    expect(input.value).toBe("");
    expect(onStartWorkspaceUpload).not.toHaveBeenCalled();

    const submit = templateEventHandlerAfterMarker<SubmitEvent>(panel.render(), "<form @submit=");
    const submitEvent = new FakeSubmitEvent("submit", { cancelable: true });
    submit(submitEvent);

    expect(submitEvent.defaultPrevented).toBe(true);
    expect(onStartWorkspaceUpload).toHaveBeenCalledWith(files, {
      destinationFolder: "project/uploads",
      createDirs: true,
      overwrite: false,
      selectUploadedFile: true,
    });
    expect(findOptionalTemplateEventHandlerAfterMarker<SubmitEvent>(panel.render(), "<form @submit=")).toBeUndefined();
  });

  it("owns focus while rendered and restores the Upload trigger after Escape and backdrop close", async () => {
    const panel = new WorkspaceFilesPanel();
    panel.context = workspacePanelContext({ workspaceUploadDefaultFolder: "project/uploads" });
    document.body.append(panel);
    await panel.updateComplete;
    const upload = buttonWithText(panel.shadowRoot, "Upload");
    const input = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-input"), "workspace upload input");

    upload.focus();
    openUploadReview(input, new File(["a"], "a.txt"));
    await panel.updateComplete;
    const firstDestination = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-destination"), "first upload destination");
    expect(panel.shadowRoot?.activeElement).toBe(firstDestination);
    expect(uploadDialog(panel).getAttribute("aria-modal")).toBe("true");

    const escape = pressKey(firstDestination, "Escape");
    await panel.updateComplete;
    expect(escape.defaultPrevented).toBe(true);
    expect(panel.shadowRoot?.querySelector(".upload-dialog")).toBeNull();
    expect(panel.shadowRoot?.activeElement).toBe(upload);

    openUploadReview(input, new File(["b"], "b.txt"));
    await panel.updateComplete;
    const backdrop = requiredElement(panel.shadowRoot?.querySelector<HTMLElement>(".dialog-backdrop"), "upload backdrop");
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    await panel.updateComplete;

    expect(panel.shadowRoot?.querySelector(".upload-dialog")).toBeNull();
    expect(panel.shadowRoot?.activeElement).toBe(upload);
  });

  it("takes visual focus ownership from a lower shared modal and restores it on close", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open lower dialog";
    document.body.append(trigger);
    trigger.focus();
    const lower = new ModalSurface();
    lower.initialFocus = "button";
    lower.innerHTML = "<button>Lower action</button>";
    document.body.append(lower);
    await lower.updateComplete;
    const lowerButton = requiredElement(lower.querySelector<HTMLButtonElement>("button"), "lower modal button");

    const panel = new WorkspaceFilesPanel();
    panel.context = workspacePanelContext();
    document.body.append(panel);
    await panel.updateComplete;
    const input = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-input"), "workspace upload input");
    openUploadReview(input, new File(["a"], "a.txt"));
    await panel.updateComplete;
    await lower.updateComplete;
    const destination = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-destination"), "upload destination");

    expect(panel.shadowRoot?.activeElement).toBe(destination);
    expect(modalSection(lower).getAttribute("aria-modal")).toBe("false");
    expect(modalSection(lower).getAttribute("aria-hidden")).toBe("true");

    pressKey(destination, "Escape");
    await panel.updateComplete;
    await lower.updateComplete;

    expect(document.activeElement).toBe(lowerButton);
    expect(modalSection(lower).getAttribute("aria-modal")).toBe("true");
    expect(modalSection(lower).getAttribute("aria-hidden")).toBeNull();
    lower.remove();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not steal focus from a higher shared layer while a file picker resolves", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open upload";
    document.body.append(trigger);
    trigger.focus();
    const higherHost = document.createElement("div");
    higherHost.style.position = "fixed";
    higherHost.style.zIndex = "30";
    const higherRoot = higherHost.attachShadow({ mode: "open" });
    const higher = new ModalSurface();
    higher.initialFocus = "button";
    higher.innerHTML = "<button>Higher action</button>";
    higherRoot.append(higher);
    document.body.append(higherHost);
    await higher.updateComplete;
    const higherButton = requiredElement(higher.querySelector<HTMLButtonElement>("button"), "higher modal button");

    const panel = new WorkspaceFilesPanel();
    panel.context = workspacePanelContext();
    document.body.append(panel);
    await panel.updateComplete;
    const input = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-input"), "workspace upload input");
    openUploadReview(input, new File(["a"], "a.txt"));
    await panel.updateComplete;
    const destination = requiredElement(panel.shadowRoot?.querySelector<HTMLInputElement>("#workspace-upload-destination"), "upload destination");

    expect(deepActiveElement(document)).toBe(higherButton);
    expect(uploadDialog(panel).getAttribute("aria-modal")).toBe("false");
    expect(uploadDialog(panel).getAttribute("aria-hidden")).toBe("true");

    higherHost.remove();
    expect(panel.shadowRoot?.activeElement).toBe(destination);
    expect(uploadDialog(panel).getAttribute("aria-modal")).toBe("true");
    expect(uploadDialog(panel).getAttribute("aria-hidden")).toBeNull();

    pressKey(destination, "Escape");
    await panel.updateComplete;
    expect(document.activeElement).toBe(trigger);
  });
});

describe("workspace-files-panel file tree boundary", () => {
  it("renders expanded tree and selected-file state while wiring row clicks", () => {
    const onExpandDir = vi.fn<WorkspacePanelContext["onExpandDir"]>();
    const onSelectFile = vi.fn<WorkspacePanelContext["onSelectFile"]>();
    const panel = new WorkspaceFilesPanel();
    panel.context = workspacePanelContext({
      fileTree: [directoryEntry("src"), fileEntry("README.md", 4096)],
      expandedDirs: { src: [fileEntry("src/main.ts")] },
      selectedFilePath: "README.md",
      selectedFileContent: binaryFileContent("README.md", 4096),
      onExpandDir,
      onSelectFile,
    });

    const rendered = panel.render();

    // The nested child (main.ts) is only reachable when the expanded directory
    // actually renders its children, so a working click handler on it proves the
    // expanded-tree structure without scraping markup for the row text.
    templateClickHandlerForText(rendered, "main.ts")(new Event("click"));
    templateClickHandlerForText(rendered, "src")(new Event("click"));
    templateClickHandlerForText(rendered, "README.md")(new Event("click"));

    expect(onExpandDir).toHaveBeenCalledWith("src");
    expect(onSelectFile).toHaveBeenCalledWith("src/main.ts");
    expect(onSelectFile).toHaveBeenCalledWith("README.md");
  });

  it("shows a review count badge on a file row with comments, and none without", async () => {
    const panel = new WorkspaceFilesPanel();
    panel.context = workspacePanelContext({
      fileTree: [fileEntry("README.md", 4096), fileEntry("empty.md", 1)],
      review: { ...stubReview(), countForFile: (path) => (path === "README.md" ? 2 : 0) },
    });
    document.body.append(panel);
    await panel.updateComplete;

    const rows = Array.from(panel.shadowRoot?.querySelectorAll<HTMLElement>("button.row") ?? []);
    const readmeRow = rows.find((row) => row.textContent.includes("README.md"));
    const emptyRow = rows.find((row) => row.textContent.includes("empty.md"));
    expect(requiredElement(requiredElement(readmeRow, "README.md row").querySelector(".badge"), "README.md badge").textContent).toBe("2");
    expect(requiredElement(emptyRow, "empty.md row").querySelector(".badge")).toBeNull();
  });

  it("passes the selected workspace file scope into the contained viewer", async () => {
    const file = textFileContent("README.md");
    const panel = new WorkspaceFilesPanel();
    panel.context = workspacePanelContext({ selectedFilePath: file.path, selectedFileContent: file });
    document.body.append(panel);
    await panel.updateComplete;

    const viewer = requiredElement(panel.shadowRoot?.querySelector<WorkspaceFileViewer>("workspace-file-viewer"), "workspace file viewer");
    expect(viewer.machineId).toBe("local");
    expect(viewer.projectId).toBe("project-1");
    expect(viewer.workspaceId).toBe("workspace-1");
    expect(viewer.selectedPath).toBe("README.md");
    expect(viewer.file).toBe(file);
    expect(viewer.loadError).toBeUndefined();
  });
});

describe("workspaceUploadBatchesForScope", () => {
  it("filters upload batches to the selected project, workspace, and machine", () => {
    const matchingOlder = uploadBatch({ id: "older", startedAt: "2026-06-25T00:00:00.000Z" });
    const matchingNewer = uploadBatch({ id: "newer", startedAt: "2026-06-25T00:01:00.000Z" });
    const batches = {
      older: matchingOlder,
      otherProject: uploadBatch({ id: "otherProject", projectId: "project-2" }),
      otherWorkspace: uploadBatch({ id: "otherWorkspace", workspaceId: "workspace-2" }),
      otherMachine: uploadBatch({ id: "otherMachine", machineId: "remote-1" }),
      newer: matchingNewer,
    };

    expect(workspaceUploadBatchesForScope(batches, { projectId: "project-1", workspaceId: "workspace-1", machineId: "local" })).toEqual([matchingNewer, matchingOlder]);
  });
});

describe("workspace upload terminal display", () => {
  it("uses terminal labels and full progress for failed batches instead of stale partial percentages", () => {
    const failed = uploadBatch({ status: "error", percent: 0.31 });

    expect(uploadBatchStatusLabel(failed)).toBe("Failed");
    expect(uploadBatchProgressValue(failed)).toBe(1);
  });

  it("keeps live percentages while a batch is uploading", () => {
    const uploading = uploadBatch({ status: "uploading", percent: 0.31 });

    expect(uploadBatchStatusLabel(uploading)).toBe("31%");
    expect(uploadBatchProgressValue(uploading)).toBe(0.31);
  });
});

describe("workspace upload defaults", () => {
  it("uses safe defaults for the review dialog", () => {
    expect(workspaceUploadReviewDefaults("project/uploads")).toEqual({
      destinationFolder: "project/uploads",
      createDirs: true,
      overwrite: false,
    });
  });

  it("starts drag/drop uploads directly with safe defaults", () => {
    const files = [new File(["a"], "a.txt")];
    const onStartWorkspaceUpload = vi.fn(() => ({ batchId: "batch-1", done: Promise.resolve() }));

    const run = startDirectWorkspaceUpload({ workspaceUploadDefaultFolder: "project/uploads", onStartWorkspaceUpload }, files);

    expect(run?.batchId).toBe("batch-1");
    expect(onStartWorkspaceUpload).toHaveBeenCalledWith(files, {
      destinationFolder: "project/uploads",
      createDirs: true,
      overwrite: false,
      selectUploadedFile: true,
    });
  });

  it("ignores empty drag/drop uploads", () => {
    const onStartWorkspaceUpload = vi.fn(() => ({ batchId: "batch-1", done: Promise.resolve() }));

    expect(startDirectWorkspaceUpload({ workspaceUploadDefaultFolder: "project/uploads", onStartWorkspaceUpload }, [])).toBeUndefined();
    expect(onStartWorkspaceUpload).not.toHaveBeenCalled();
  });
});

describe("workspaceUploadReviewError", () => {
  it("accepts one or more files with a workspace-relative destination", () => {
    expect(workspaceUploadReviewError([
      new File(["a"], "a.txt"),
      new File(["b"], "b.txt"),
    ], ".pi-web/uploads")).toBeUndefined();
  });

  it("rejects empty selections and unsafe destinations before starting an upload", () => {
    expect(workspaceUploadReviewError([], ".pi-web/uploads")).toBe("Choose at least one file to upload.");
    expect(workspaceUploadReviewError([new File(["a"], "a.txt")], "../outside")).toContain("path traversal");
  });
});

function openUploadReview(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function uploadDialog(panel: WorkspaceFilesPanel): HTMLElement {
  return requiredElement(panel.shadowRoot?.querySelector<HTMLElement>(".upload-dialog"), "upload dialog");
}

function modalSection(surface: ModalSurface): HTMLElement {
  return requiredElement(surface.shadowRoot?.querySelector<HTMLElement>("section[role='dialog']"), "modal section");
}

function buttonWithText(root: ParentNode | null | undefined, text: string): HTMLButtonElement {
  const button = [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent.trim() === text);
  return requiredElement(button, `${text} button`);
}

function pressKey(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  return event;
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

class FakeFileList implements FileList {
  readonly length: number;
  [index: number]: File;

  constructor(private readonly files: readonly File[]) {
    this.length = files.length;
    files.forEach((file, index) => {
      this[index] = file;
    });
  }

  item(index: number): File | null {
    return this.files[index] ?? null;
  }

  [Symbol.iterator](): ArrayIterator<File> {
    return this.files[Symbol.iterator]();
  }
}

class FakeHTMLInputElement extends EventTarget {
  readonly files: FileList;
  value = "selected-files";

  constructor(files: readonly File[]) {
    super();
    this.files = new FakeFileList(files);
  }
}

class EventWithCurrentTarget extends Event {
  constructor(type: string, private readonly eventCurrentTarget: EventTarget) {
    super(type);
  }

  override get currentTarget(): EventTarget {
    return this.eventCurrentTarget;
  }
}

class FakeSubmitEvent extends Event implements SubmitEvent {
  readonly submitter: HTMLElement | null = null;
}

function fileEntry(path: string, size = 2): FileTreeEntry {
  return { name: path.split("/").at(-1) ?? path, path, type: "file", size };
}

function directoryEntry(path: string): FileTreeEntry {
  return { name: path.split("/").at(-1) ?? path, path, type: "directory" };
}

function binaryFileContent(path: string, size: number): FileContentResponse {
  return {
    path,
    encoding: "utf8",
    size,
    modifiedAt: "2026-06-25T00:00:00.000Z",
    content: "",
    truncated: false,
    binary: true,
  };
}

function textFileContent(path: string): FileContentResponse {
  return {
    path,
    language: "typescript",
    encoding: "utf8",
    size: 12,
    modifiedAt: "2026-06-25T00:00:00.000Z",
    content: "const x = 1;",
    truncated: false,
    binary: false,
  };
}

function workspacePanelContext(patch: Partial<WorkspacePanelContext> = {}): WorkspacePanelContext {
  const workspace = patch.workspace ?? { id: "workspace-1", projectId: "project-1", path: "/tmp/project", label: "main", isMain: true, effectiveConfig: {} };
  return {
    machine: patch.machine ?? { id: "local", name: "Local", kind: "local" },
    workspace,
    state: patch.state ?? { ...initialAppState(), workspaceUploadBatches: {} },
    files: patch.files ?? {
      readFile: vi.fn<WorkspacePanelContext["files"]["readFile"]>(() => Promise.reject(new Error("not implemented"))),
      listFiles: vi.fn<WorkspacePanelContext["files"]["listFiles"]>(() => Promise.reject(new Error("not implemented"))),
      writeFile: vi.fn<WorkspacePanelContext["files"]["writeFile"]>(() => Promise.reject(new Error("not implemented"))),
      deleteFile: vi.fn<WorkspacePanelContext["files"]["deleteFile"]>(() => Promise.reject(new Error("not implemented"))),
      moveFile: vi.fn<WorkspacePanelContext["files"]["moveFile"]>(() => Promise.reject(new Error("not implemented"))),
    },
    backend: patch.backend ?? { request: vi.fn<NonNullable<WorkspacePanelContext["backend"]>["request"]>(() => Promise.resolve(null)) },
    prompt: patch.prompt ?? { insertText: vi.fn<WorkspacePanelContext["prompt"]["insertText"]>(), getText: vi.fn<WorkspacePanelContext["prompt"]["getText"]>(() => ""), getSelection: vi.fn<WorkspacePanelContext["prompt"]["getSelection"]>(() => null) },
    terminal: patch.terminal ?? { open: vi.fn<WorkspacePanelContext["terminal"]["open"]>(), runCommand: vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>(() => Promise.reject(new Error("not implemented"))) },
    host: patch.host ?? { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() },
    review: patch.review ?? stubReview(),
    fileTree: patch.fileTree ?? [],
    expandedDirs: patch.expandedDirs ?? {},
    selectedFilePath: patch.selectedFilePath,
    selectedFileContent: patch.selectedFileContent,
    selectedFileLoadError: patch.selectedFileLoadError,
    fileTreeStale: patch.fileTreeStale ?? false,
    activeTerminalCount: patch.activeTerminalCount ?? 0,
    selectedTerminalId: patch.selectedTerminalId,
    terminalAutoStart: patch.terminalAutoStart ?? false,
    workspaceUploadDefaultFolder: patch.workspaceUploadDefaultFolder ?? ".pi-web/uploads",
    onRefreshFiles: patch.onRefreshFiles ?? vi.fn<WorkspacePanelContext["onRefreshFiles"]>(),
    onExpandDir: patch.onExpandDir ?? vi.fn<WorkspacePanelContext["onExpandDir"]>(),
    onSelectFile: patch.onSelectFile ?? vi.fn<WorkspacePanelContext["onSelectFile"]>(),
    onStartWorkspaceUpload: patch.onStartWorkspaceUpload ?? vi.fn<WorkspacePanelContext["onStartWorkspaceUpload"]>(() => undefined),
    onCancelWorkspaceUpload: patch.onCancelWorkspaceUpload ?? vi.fn<WorkspacePanelContext["onCancelWorkspaceUpload"]>(),
    onClearWorkspaceUpload: patch.onClearWorkspaceUpload ?? vi.fn<WorkspacePanelContext["onClearWorkspaceUpload"]>(),
    onSelectTerminal: patch.onSelectTerminal ?? vi.fn<WorkspacePanelContext["onSelectTerminal"]>(),
  };
}

function stubReview(): WorkspacePanelContext["review"] {
  return {
    total: () => 0,
    countForFile: () => 0,
    commentsForLine: () => [],
    draftForLine: () => null,
    lineState: () => ({ selected: false, commented: false }),
    canAuthor: () => false,
    beginSelection: () => undefined,
    extendSelection: () => undefined,
    commitSelection: () => undefined,
    cancelSelection: () => undefined,
    setDraftBody: () => undefined,
    submitDraft: () => undefined,
    cancelDraft: () => undefined,
    updateComment: () => undefined,
    removeComment: () => undefined,
  };
}

function uploadBatch(patch: Partial<WorkspaceUploadBatchState> = {}): WorkspaceUploadBatchState {
  return {
    id: patch.id ?? "batch-1",
    projectId: patch.projectId ?? "project-1",
    workspaceId: patch.workspaceId ?? "workspace-1",
    machineId: patch.machineId ?? "local",
    destinationFolder: patch.destinationFolder ?? ".pi-web/uploads",
    overwrite: patch.overwrite ?? true,
    createDirs: patch.createDirs ?? true,
    files: patch.files ?? [],
    currentFileIndex: patch.currentFileIndex ?? -1,
    loaded: patch.loaded ?? 0,
    total: patch.total ?? 0,
    percent: patch.percent ?? 0,
    status: patch.status ?? "uploading",
    startedAt: patch.startedAt ?? "2026-06-25T00:00:00.000Z",
    ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
  };
}
