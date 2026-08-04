import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContentResponse, FileTreeEntry } from "../api";
import { initialAppState } from "../appState";
import type { WorkspacePanelContext } from "../plugins/types";
import type { WorkspaceUploadBatchState } from "../workspaceUploadState";
// Genuine Lit event-wiring extraction (upload input/form submit and file-tree
// row clicks) routes through the shared, type-guarded template-inspection escape
// hatch; see ../templateInspection.testSupport for the proportionality
// rationale. Viewer content messaging is asserted via the public
// workspaceFileViewerStatusLabel seam instead of scraping Lit markup.
import { findOptionalTemplateEventHandlerAfterMarker, templateClickHandlerForText, templateEventHandlerAfterMarker } from "../templateInspection.testSupport";
import { WorkspaceFilesPanel, startDirectWorkspaceUpload, uploadBatchProgressValue, uploadBatchStatusLabel, workspaceFileViewerStatusLabel, workspaceUploadBatchesForScope, workspaceUploadReviewDefaults, workspaceUploadReviewError } from "./WorkspaceFilesPanel";

afterEach(() => {
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

    // Viewer messaging (selected binary file) is a content concern; assert it
    // through the public seam rather than the rendered template.
    expect(workspaceFileViewerStatusLabel(workspacePanelContext({
      selectedFilePath: "README.md",
      selectedFileContent: binaryFileContent("README.md", 4096),
    }))).toBe("Binary file: README.md · 4.0 KB");
  });
});

describe("workspaceFileViewerStatusLabel", () => {
  it("messages empty, loading, and binary viewer states while deferring to real viewers", () => {
    expect(workspaceFileViewerStatusLabel(workspacePanelContext({ selectedFilePath: undefined }))).toBe("Select a file.");
    expect(workspaceFileViewerStatusLabel(workspacePanelContext({ selectedFilePath: "" }))).toBe("Select a file.");
    expect(workspaceFileViewerStatusLabel(workspacePanelContext({ selectedFilePath: "notes.md", selectedFileContent: undefined }))).toBe("Loading notes.md…");
    expect(workspaceFileViewerStatusLabel(workspacePanelContext({
      selectedFilePath: "logo.png",
      selectedFileContent: { ...binaryFileContent("logo.png", 10), mediaType: "image" },
    }))).toBeUndefined();
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
    fileTree: patch.fileTree ?? [],
    expandedDirs: patch.expandedDirs ?? {},
    selectedFilePath: patch.selectedFilePath,
    selectedFileContent: patch.selectedFileContent,
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
