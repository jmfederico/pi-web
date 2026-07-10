import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { WorkspacePanelContext } from "../plugins/types";
import type { WorkspaceUploadBatchState } from "../workspaceUploadState";
import { WorkspaceFilesPanel, startDirectWorkspaceUpload, uploadBatchProgressValue, uploadBatchStatusLabel, workspaceUploadBatchesForScope, workspaceUploadReviewDefaults, workspaceUploadReviewError } from "./WorkspaceFilesPanel";

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

    const inputChange = findTemplateEventHandler<Event>(panel.render(), `id="workspace-upload-input"`);
    const input = new FakeHTMLInputElement(files);
    inputChange(new EventWithCurrentTarget("change", input));

    expect(input.value).toBe("");
    expect(onStartWorkspaceUpload).not.toHaveBeenCalled();

    const submit = findTemplateEventHandler<SubmitEvent>(panel.render(), "<form @submit=");
    const submitEvent = new FakeSubmitEvent("submit", { cancelable: true });
    submit(submitEvent);

    expect(submitEvent.defaultPrevented).toBe(true);
    expect(onStartWorkspaceUpload).toHaveBeenCalledWith(files, {
      destinationFolder: "project/uploads",
      createDirs: true,
      overwrite: false,
      selectUploadedFile: true,
    });
    expect(findOptionalTemplateEventHandler<SubmitEvent>(panel.render(), "<form @submit=")).toBeUndefined();
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

type TemplateEventHandler<E extends Event> = (event: E) => void;

function findTemplateEventHandler<E extends Event>(template: TemplateResult, marker: string): TemplateEventHandler<E> {
  const handler = findOptionalTemplateEventHandler<E>(template, marker);
  if (handler === undefined) throw new Error(`Expected template event handler after ${marker}`);
  return handler;
}

function findOptionalTemplateEventHandler<E extends Event>(template: TemplateResult, marker: string): TemplateEventHandler<E> | undefined {
  return findInTemplate(template);

  function findInTemplate(current: TemplateResult): TemplateEventHandler<E> | undefined {
    const strings = templateStrings(current);
    const values = templateValues(current);
    for (let index = 0; index < values.length; index += 1) {
      const staticChunk = strings[index];
      const value = values[index];
      if (staticChunk !== undefined && staticChunk.includes(marker) && isTemplateEventHandler<E>(value)) return value;
      const nestedHandler = findInValue(value);
      if (nestedHandler !== undefined) return nestedHandler;
    }
    return undefined;
  }

  function findInValue(value: unknown): TemplateEventHandler<E> | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nestedHandler = findInValue(item);
        if (nestedHandler !== undefined) return nestedHandler;
      }
      return undefined;
    }
    if (isTemplateResult(value)) return findInTemplate(value);
    return undefined;
  }
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isTemplateEventHandler<E extends Event>(value: unknown): value is TemplateEventHandler<E> {
  return typeof value === "function";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
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

function workspacePanelContext(patch: Partial<Pick<WorkspacePanelContext, "onStartWorkspaceUpload" | "workspaceUploadDefaultFolder">> = {}): WorkspacePanelContext {
  const workspace = { id: "workspace-1", projectId: "project-1", path: "/tmp/project", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
  return {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace,
    state: { ...initialAppState(), workspaceUploadBatches: {} },
    files: {
      readFile: vi.fn<WorkspacePanelContext["files"]["readFile"]>(() => Promise.reject(new Error("not implemented"))),
      writeFile: vi.fn<WorkspacePanelContext["files"]["writeFile"]>(() => Promise.reject(new Error("not implemented"))),
      deleteFile: vi.fn<WorkspacePanelContext["files"]["deleteFile"]>(() => Promise.reject(new Error("not implemented"))),
      moveFile: vi.fn<WorkspacePanelContext["files"]["moveFile"]>(() => Promise.reject(new Error("not implemented"))),
    },
    prompt: { insertText: vi.fn<WorkspacePanelContext["prompt"]["insertText"]>(), getText: vi.fn<WorkspacePanelContext["prompt"]["getText"]>(() => ""), getSelection: vi.fn<WorkspacePanelContext["prompt"]["getSelection"]>(() => null) },
    terminal: { open: vi.fn<WorkspacePanelContext["terminal"]["open"]>(), runCommand: vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>(() => Promise.reject(new Error("not implemented"))) },
    host: { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() },
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    fileTreeStale: false,
    gitStatus: undefined,
    selectedDiffPath: undefined,
    selectedDiff: undefined,
    selectedStagedDiff: undefined,
    gitStale: false,
    activeTerminalCount: 0,
    selectedTerminalId: undefined,
    terminalAutoStart: false,
    workspaceUploadDefaultFolder: patch.workspaceUploadDefaultFolder ?? ".pi-web/uploads",
    onRefreshFiles: vi.fn<WorkspacePanelContext["onRefreshFiles"]>(),
    onExpandDir: vi.fn<WorkspacePanelContext["onExpandDir"]>(),
    onSelectFile: vi.fn<WorkspacePanelContext["onSelectFile"]>(),
    onStartWorkspaceUpload: patch.onStartWorkspaceUpload ?? vi.fn<WorkspacePanelContext["onStartWorkspaceUpload"]>(() => undefined),
    onCancelWorkspaceUpload: vi.fn<WorkspacePanelContext["onCancelWorkspaceUpload"]>(),
    onClearWorkspaceUpload: vi.fn<WorkspacePanelContext["onClearWorkspaceUpload"]>(),
    onRefreshGit: vi.fn<WorkspacePanelContext["onRefreshGit"]>(),
    onSelectDiff: vi.fn<WorkspacePanelContext["onSelectDiff"]>(),
    onSelectTerminal: vi.fn<WorkspacePanelContext["onSelectTerminal"]>(),
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
