import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import {
  WorkspaceUploadBatchError,
  WorkspaceUploadCancelledError,
  type FileContentResponse,
  type FileTreeEntry,
  type FileTreeResponse,
  type Machine,
  type Project,
  type Workspace,
  type WorkspaceUploadBatchProgress,
  type WriteWorkspaceFileResponse,
} from "../api";
import { FileExplorerController, type FileExplorerControllerDependencies } from "./fileExplorerController";

type FileExplorerApi = NonNullable<FileExplorerControllerDependencies["api"]>;
type WorkspaceTree = FileExplorerApi["workspaceTree"];
type WorkspaceFile = FileExplorerApi["workspaceFile"];
type UploadWorkspaceFiles = NonNullable<FileExplorerControllerDependencies["uploadWorkspaceFiles"]>;
type UploadWorkspaceFilesOptions = NonNullable<Parameters<UploadWorkspaceFiles>[3]>;

const originalWindow = globalThis.window;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
});

const machine: Machine = {
  id: "remote-1",
  name: "Remote",
  kind: "remote",
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
};

const project: Project = {
  id: "project-1",
  name: "Project",
  path: "/repo",
  createdAt: "2026-06-25T00:00:00.000Z",
};

const workspace: Workspace = {
  id: "workspace-1",
  projectId: project.id,
  path: "/repo",
  label: "repo",
  isMain: true,
  effectiveConfig: {},
};

describe("FileExplorerController file tree workflows", () => {
  it("refreshes the root and already-expanded directories for the selected machine", async () => {
    const rootEntries = [directoryEntry("src"), fileEntry("README.md")];
    const refreshedSrcEntries = [fileEntry("src/index.ts")];
    const refreshedDocsEntries = [fileEntry("docs/guide.md")];
    const workspaceTree = vi.fn<WorkspaceTree>((_projectId, _workspaceId, path = "") => Promise.resolve(treeResponse(path, {
      "": rootEntries,
      src: refreshedSrcEntries,
      docs: refreshedDocsEntries,
    }[path] ?? [])));
    const harness = createHarness({ api: createApi({ workspaceTree }) }, {
      expandedDirs: {
        src: [fileEntry("src/stale.ts")],
        docs: [fileEntry("docs/stale.md")],
      },
      fileTreeStale: true,
      error: "Failed to start workspace removal: HTTP request cancelled",
    });

    await harness.controller.refreshFiles();

    expect(workspaceTree).toHaveBeenCalledTimes(3);
    expect(workspaceTree).toHaveBeenCalledWith("project-1", "workspace-1", "", "remote-1");
    expect(workspaceTree).toHaveBeenCalledWith("project-1", "workspace-1", "src", "remote-1");
    expect(workspaceTree).toHaveBeenCalledWith("project-1", "workspace-1", "docs", "remote-1");
    expect(harness.state.fileTree).toEqual(rootEntries);
    expect(harness.state.expandedDirs).toEqual({ src: refreshedSrcEntries, docs: refreshedDocsEntries });
    expect(harness.state.fileTreeStale).toBe(false);
    // A background refresh must not erase another action's failure before the
    // user has read it.
    expect(harness.state.error).toBe("Failed to start workspace removal: HTTP request cancelled");
  });

  it("clears its own tree failure once a later refresh succeeds", async () => {
    const workspaceTree = vi.fn<WorkspaceTree>()
      .mockRejectedValueOnce(new Error("tree unavailable"))
      .mockImplementation((_projectId, _workspaceId, path = "") => Promise.resolve(treeResponse(path, [fileEntry("README.md")])));
    const harness = createHarness({ api: createApi({ workspaceTree }) });

    await harness.controller.refreshFiles();
    expect(harness.state.error).toBe("Error: tree unavailable");

    await harness.controller.refreshFiles();
    expect(harness.state.error).toBe("");
  });

  it("expands a directory then collapses it locally without refetching", async () => {
    const srcEntries = [fileEntry("src/index.ts")];
    const workspaceTree = vi.fn<WorkspaceTree>((_projectId, _workspaceId, path = "") => Promise.resolve(treeResponse(path, srcEntries)));
    const harness = createHarness({ api: createApi({ workspaceTree }) });

    await harness.controller.expandDir("src");

    expect(workspaceTree).toHaveBeenCalledWith("project-1", "workspace-1", "src", "remote-1");
    expect(harness.state.expandedDirs).toEqual({ src: srcEntries });
    expect(harness.state.error).toBe("");

    workspaceTree.mockClear();
    await harness.controller.expandDir("src");

    expect(workspaceTree).not.toHaveBeenCalled();
    expect(harness.state.expandedDirs).toEqual({});
  });
});

describe("FileExplorerController file request lifecycle", () => {
  it("does not let a deferred A response overwrite the loaded B selection", async () => {
    const requests = deferredWorkspaceFiles();
    const harness = createHarness({ api: createApi({ workspaceFile: requests.fn }) });

    const loadA = harness.controller.restoreFile("a.txt");
    const loadB = harness.controller.restoreFile("b.txt");
    requests.request(1).resolve(fileResponse("b.txt", "current B"));
    await loadB;

    expect(harness.state.selectedFilePath).toBe("b.txt");
    expect(harness.state.selectedFileContent?.content).toBe("current B");

    requests.request(0).resolve(fileResponse("a.txt", "stale A"));
    await loadA;

    expect(harness.state.selectedFilePath).toBe("b.txt");
    expect(harness.state.selectedFileContent?.content).toBe("current B");
  });

  it("uses request generation to reject stale A and B responses in an A to B to A sequence", async () => {
    const requests = deferredWorkspaceFiles();
    const harness = createHarness({ api: createApi({ workspaceFile: requests.fn }) });

    const firstA = harness.controller.restoreFile("a.txt");
    const loadB = harness.controller.restoreFile("b.txt");
    const latestA = harness.controller.restoreFile("a.txt");

    requests.request(0).resolve(fileResponse("a.txt", "first A"));
    await firstA;
    expect(harness.state.selectedFileContent).toBeUndefined();

    requests.request(1).resolve(fileResponse("b.txt", "stale B"));
    await loadB;
    expect(harness.state.selectedFileContent).toBeUndefined();

    requests.request(2).resolve(fileResponse("a.txt", "latest A"));
    await latestA;
    expect(harness.state.selectedFilePath).toBe("a.txt");
    expect(harness.state.selectedFileContent?.content).toBe("latest A");
  });

  it("rejects a same-path response after the selected workspace changes", async () => {
    const requests = deferredWorkspaceFiles();
    const harness = createHarness({ api: createApi({ workspaceFile: requests.fn }) });

    const staleLoad = harness.controller.restoreFile("same.txt");
    harness.patchState({ selectedWorkspace: { ...workspace, id: "workspace-2" } });
    requests.request(0).resolve(fileResponse("same.txt", "old workspace"));
    await staleLoad;

    expect(harness.state.selectedFilePath).toBe("same.txt");
    expect(harness.state.selectedFileContent).toBeUndefined();

    const currentLoad = harness.controller.restoreFile("same.txt");
    expect(requests.request(1)).toMatchObject({ workspaceId: "workspace-2", path: "same.txt" });
    requests.request(1).resolve(fileResponse("same.txt", "new workspace"));
    await currentLoad;
    expect(harness.state.selectedFileContent?.content).toBe("new workspace");
  });

  it("rejects a same-path response after the selected machine changes", async () => {
    const requests = deferredWorkspaceFiles();
    const harness = createHarness({ api: createApi({ workspaceFile: requests.fn }) });

    const staleLoad = harness.controller.restoreFile("same.txt");
    harness.patchState({ selectedMachine: { ...machine, id: "remote-2", name: "Other remote" } });
    requests.request(0).resolve(fileResponse("same.txt", "old machine"));
    await staleLoad;

    expect(harness.state.selectedFilePath).toBe("same.txt");
    expect(harness.state.selectedFileContent).toBeUndefined();

    const currentLoad = harness.controller.restoreFile("same.txt");
    expect(requests.request(1)).toMatchObject({ machineId: "remote-2", path: "same.txt" });
    requests.request(1).resolve(fileResponse("same.txt", "new machine"));
    await currentLoad;
    expect(harness.state.selectedFileContent?.content).toBe("new machine");
  });

  it("ignores stale failures without changing the current selection or its load state", async () => {
    const requests = deferredWorkspaceFiles();
    const harness = createHarness({ api: createApi({ workspaceFile: requests.fn }) });

    const staleLoad = harness.controller.restoreFile("a.txt");
    const currentLoad = harness.controller.restoreFile("b.txt");
    requests.request(0).reject(new Error("old request failed"));
    await staleLoad;

    expect(harness.state.selectedFilePath).toBe("b.txt");
    expect(harness.state.selectedFileContent).toBeUndefined();
    expect(harness.state.selectedFileLoadError).toBeUndefined();
    expect(harness.state.error).toBe("");

    requests.request(1).resolve(fileResponse("b.txt", "current B"));
    await currentLoad;
    expect(harness.state.selectedFileContent?.content).toBe("current B");
  });

  it("keeps a current unavailable file selected with an observable load error", async () => {
    const requests = deferredWorkspaceFiles();
    const harness = createHarness({ api: createApi({ workspaceFile: requests.fn }) });

    const load = harness.controller.selectFile("missing.txt");
    requests.request(0).reject(new Error("Path does not exist: missing.txt"));
    await load;

    expect(harness.state.selectedFilePath).toBe("missing.txt");
    expect(harness.state.selectedFileContent).toBeUndefined();
    expect(harness.state.selectedFileLoadError).toBe("Path does not exist: missing.txt");
    expect(harness.state.error).toBe("");
    expect(harness.updateUrl).toHaveBeenCalledTimes(1);
  });

  it("clears the selected-file error for a fresh request and keeps it clear after success", async () => {
    const requests = deferredWorkspaceFiles();
    const harness = createHarness({ api: createApi({ workspaceFile: requests.fn }) });

    const failedLoad = harness.controller.restoreFile("retry.txt");
    requests.request(0).reject(new Error("temporarily unavailable"));
    await failedLoad;
    expect(harness.state.selectedFileLoadError).toBe("temporarily unavailable");

    const retryLoad = harness.controller.restoreFile("retry.txt");
    expect(harness.state.selectedFileContent).toBeUndefined();
    expect(harness.state.selectedFileLoadError).toBeUndefined();

    requests.request(1).resolve(fileResponse("retry.txt", "recovered"));
    await retryLoad;
    expect(harness.state.selectedFileContent?.content).toBe("recovered");
    expect(harness.state.selectedFileLoadError).toBeUndefined();
  });
});

describe("FileExplorerController workspace uploads", () => {
  it("tracks upload progress, completes from final responses, refreshes files, and selects the first uploaded file", async () => {
    const upload = controllableUpload();
    const harness = createHarness({ uploadWorkspaceFiles: upload.fn, now: sequenceNow("start", "complete") });
    const files = [new File(["aa"], "a.txt", { type: "text/plain" }), new File(["bbb"], "b.txt")];

    const run = harness.controller.startWorkspaceUpload(files, { destinationFolder: "uploads/manual", overwrite: false });

    expect(run?.batchId).toBe("batch-1");
    expect(upload.fn).toHaveBeenCalledWith("project-1", "workspace-1", files, expect.objectContaining({
      destinationFolder: "uploads/manual",
      machineId: "remote-1",
      overwrite: false,
      createDirs: true,
    }));
    expect(harness.state.workspaceUploadBatches["batch-1"]).toMatchObject({
      destinationFolder: "uploads/manual",
      overwrite: false,
      createDirs: true,
      status: "uploading",
      startedAt: "start",
      total: 5,
      files: [
        { name: "a.txt", path: "uploads/manual/a.txt", status: "uploading", total: 2 },
        { name: "b.txt", path: "uploads/manual/b.txt", status: "pending", total: 3 },
      ],
    });

    upload.emitProgress({
      currentFileIndex: 0,
      files: [
        { index: 0, name: "a.txt", path: "uploads/manual/a.txt", loaded: 1, total: 2, percent: 0.5, lengthComputable: true, done: false },
        { index: 1, name: "b.txt", path: "uploads/manual/b.txt", loaded: 0, total: 3, percent: 0, lengthComputable: true, done: false },
      ],
      loaded: 1,
      total: 5,
      percent: 0.2,
      done: false,
    });

    expect(harness.state.workspaceUploadBatches["batch-1"]).toMatchObject({
      loaded: 1,
      percent: 0.2,
      files: [
        { path: "uploads/manual/a.txt", loaded: 1, percent: 0.5, status: "uploading" },
        { path: "uploads/manual/b.txt", loaded: 0, status: "pending" },
      ],
    });

    upload.resolve([
      writeResponse("uploads/manual/a.txt", 2),
      writeResponse("uploads/manual/b.txt", 3),
    ]);
    await run?.done;

    expect(harness.api.workspaceTree).toHaveBeenCalledWith("project-1", "workspace-1", "", "remote-1");
    expect(harness.api.workspaceFile).toHaveBeenCalledWith("project-1", "workspace-1", "uploads/manual/a.txt", "remote-1");
    expect(harness.updateUrl).toHaveBeenCalledWith({ replace: true });
    expect(harness.state.selectedFilePath).toBe("uploads/manual/a.txt");
    expect(harness.state.workspaceUploadBatches["batch-1"]).toMatchObject({
      status: "completed",
      completedAt: "complete",
      loaded: 5,
      percent: 1,
      files: [
        { status: "completed", response: { path: "uploads/manual/a.txt", size: 2 } },
        { status: "completed", response: { path: "uploads/manual/b.txt", size: 3 } },
      ],
    });
  });

  it("defaults uploads to create parent folders without overwriting existing files", () => {
    const upload = controllableUpload();
    const harness = createHarness({ uploadWorkspaceFiles: upload.fn });
    const files = [new File(["aa"], "a.txt")];

    const run = harness.controller.startWorkspaceUpload(files, { destinationFolder: "uploads" });

    expect(run?.batchId).toBe("batch-1");
    expect(upload.fn).toHaveBeenCalledWith("project-1", "workspace-1", files, expect.objectContaining({
      destinationFolder: "uploads",
      machineId: "remote-1",
      overwrite: false,
      createDirs: true,
    }));
    expect(harness.state.workspaceUploadBatches["batch-1"]).toMatchObject({
      destinationFolder: "uploads",
      overwrite: false,
      createDirs: true,
    });
  });

  it("cancels an in-flight upload without setting the global error", async () => {
    const upload = controllableUpload({ rejectOnCancel: true });
    const harness = createHarness({ uploadWorkspaceFiles: upload.fn, now: sequenceNow("start", "cancel") });
    const run = harness.controller.startWorkspaceUpload([new File(["aa"], "a.txt")], { destinationFolder: "uploads" });

    harness.controller.cancelWorkspaceUpload(run?.batchId ?? "missing");
    await run?.done;

    expect(upload.cancel).toHaveBeenCalledTimes(1);
    expect(harness.state.error).toBe("");
    expect(harness.state.workspaceUploadBatches["batch-1"]).toMatchObject({
      status: "cancelled",
      completedAt: "cancel",
      error: "Upload cancelled",
      files: [{ status: "cancelled", error: "Upload cancelled" }],
    });
  });

  it("clears an in-flight upload by cancelling the request and removing the batch", async () => {
    const upload = controllableUpload({ rejectOnCancel: true });
    const harness = createHarness({ uploadWorkspaceFiles: upload.fn });
    const run = harness.controller.startWorkspaceUpload([new File(["aa"], "a.txt")], { destinationFolder: "uploads" });

    expect(run?.batchId).toBe("batch-1");
    expect(harness.state.workspaceUploadBatches["batch-1"]?.status).toBe("uploading");

    harness.controller.clearWorkspaceUpload(run?.batchId ?? "missing");
    await run?.done;

    expect(upload.cancel).toHaveBeenCalledTimes(1);
    expect(harness.state.workspaceUploadBatches).toEqual({});
    expect(harness.state.error).toBe("");
  });

  it("keeps per-file errors accurate and refreshes after partial batch success", async () => {
    const upload = controllableUpload();
    const harness = createHarness({ uploadWorkspaceFiles: upload.fn, now: sequenceNow("start", "fail") });
    const run = harness.controller.startWorkspaceUpload([new File(["aa"], "a.txt"), new File(["bbbb"], "b.txt")], { destinationFolder: "uploads" });

    upload.emitProgress({
      currentFileIndex: 1,
      files: [
        { index: 0, name: "a.txt", path: "uploads/a.txt", loaded: 2, total: 2, percent: 1, lengthComputable: true, done: true, error: "File already exists: uploads/a.txt" },
        { index: 1, name: "b.txt", path: "uploads/b.txt", loaded: 4, total: 4, percent: 1, lengthComputable: true, done: true },
      ],
      loaded: 6,
      total: 6,
      percent: 1,
      done: true,
    });
    upload.reject(new WorkspaceUploadBatchError(
      [{ index: 0, name: "a.txt", path: "uploads/a.txt", error: "File already exists: uploads/a.txt" }],
      [writeResponse("uploads/b.txt", 4)],
    ));
    await run?.done;

    expect(harness.api.workspaceTree).toHaveBeenCalledWith("project-1", "workspace-1", "", "remote-1");
    expect(harness.api.workspaceFile).toHaveBeenCalledWith("project-1", "workspace-1", "uploads/b.txt", "remote-1");
    expect(harness.state.error).toBe("");
    expect(harness.state.selectedFilePath).toBe("uploads/b.txt");
    expect(harness.state.workspaceUploadBatches["batch-1"]).toMatchObject({
      status: "error",
      completedAt: "fail",
      error: "File already exists: uploads/a.txt",
      loaded: 6,
      total: 6,
      percent: 1,
      files: [
        { path: "uploads/a.txt", status: "error", error: "File already exists: uploads/a.txt" },
        { path: "uploads/b.txt", status: "completed" },
      ],
    });
  });

  it("rejects unsafe upload destinations before starting a batch", () => {
    const upload = controllableUpload();
    const harness = createHarness({ uploadWorkspaceFiles: upload.fn });

    const run = harness.controller.startWorkspaceUpload([new File(["aa"], "a.txt")], { destinationFolder: "../outside" });

    expect(run).toBeUndefined();
    expect(upload.fn).not.toHaveBeenCalled();
    expect(harness.state.workspaceUploadBatches).toEqual({});
    expect(harness.state.error).toContain("upload destination must not contain path traversal");
  });
});

function createHarness(deps: FileExplorerControllerDependencies = {}, statePatch: Partial<AppState> = {}) {
  installWindow("http://localhost/app");
  let state: AppState = {
    ...initialAppState(),
    selectedMachine: machine,
    selectedProject: project,
    selectedWorkspace: workspace,
    ...statePatch,
  };
  const api = deps.api ?? createApi();
  const updateUrl = vi.fn();
  let batchSequence = 0;
  const controller = new FileExplorerController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    updateUrl,
    {
      ...deps,
      api,
      createUploadBatchId: deps.createUploadBatchId ?? (() => {
        batchSequence += 1;
        return `batch-${String(batchSequence)}`;
      }),
    },
  );
  return {
    controller,
    api,
    updateUrl,
    patchState: (patch: Partial<AppState>) => { state = { ...state, ...patch }; },
    get state(): AppState { return state; },
  };
}

function installWindow(href: string): void {
  const url = new URL(href);
  const fakeWindow = {
    location: {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
    history: {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
}

function controllableUpload(options: { rejectOnCancel?: boolean } = {}) {
  let resolveUpload: ((responses: WriteWorkspaceFileResponse[]) => void) | undefined;
  let rejectUpload: ((error: unknown) => void) | undefined;
  let uploadOptions: UploadWorkspaceFilesOptions | undefined;
  const cancel = vi.fn(() => {
    if (options.rejectOnCancel === true) rejectUpload?.(new WorkspaceUploadCancelledError());
  });
  const fn = vi.fn<UploadWorkspaceFiles>((_projectId, _workspaceId, _files, sentOptions = {}) => {
    uploadOptions = sentOptions;
    const promise = new Promise<WriteWorkspaceFileResponse[]>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    return { promise, cancel };
  });
  return {
    fn,
    cancel,
    emitProgress: (progress: WorkspaceUploadBatchProgress) => { uploadOptions?.onProgress?.(progress); },
    resolve: (responses: WriteWorkspaceFileResponse[]) => { resolveUpload?.(responses); },
    reject: (error: unknown) => { rejectUpload?.(error); },
  };
}

function sequenceNow(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? "now";
}

function createApi(overrides: Partial<FileExplorerApi> = {}): FileExplorerApi {
  return {
    workspaceTree: vi.fn<WorkspaceTree>((_projectId, _workspaceId, path = "") => Promise.resolve(treeResponse(path))),
    workspaceFile: vi.fn<WorkspaceFile>((_projectId, _workspaceId, path) => Promise.resolve(fileResponse(path))),
    ...overrides,
  };
}

function deferredWorkspaceFiles() {
  const requests: {
    projectId: string;
    workspaceId: string;
    path: string;
    machineId: string;
    resolve: (response: FileContentResponse) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const fn = vi.fn<WorkspaceFile>((projectId, workspaceId, path, machineId) => new Promise<FileContentResponse>((resolve, reject) => {
    requests.push({ projectId, workspaceId, path, machineId: machineId ?? "local", resolve, reject });
  }));
  return {
    fn,
    request: (index: number) => {
      const request = requests[index];
      if (request === undefined) throw new Error(`Missing deferred workspace file request ${String(index)}`);
      return request;
    },
  };
}

function treeResponse(path: string, entries: FileTreeEntry[] = []): FileTreeResponse {
  return { path, entries, scannedAt: "2026-06-25T00:00:00.000Z", truncated: false };
}

function directoryEntry(path: string): FileTreeEntry {
  return { name: path.split("/").at(-1) ?? path, path, type: "directory" };
}

function fileEntry(path: string): FileTreeEntry {
  return { name: path.split("/").at(-1) ?? path, path, type: "file", size: 2 };
}

function fileResponse(path: string, content = "aa"): FileContentResponse {
  return { path, encoding: "utf8", size: content.length, modifiedAt: "2026-06-25T00:00:00.000Z", content, truncated: false, binary: false };
}

function writeResponse(path: string, size: number): WriteWorkspaceFileResponse {
  return { path, size, modifiedAt: "2026-06-25T00:00:00.000Z", created: true };
}
