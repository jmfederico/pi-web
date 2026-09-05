import type {
  FileContentResponse,
  FileTreeEntry,
  FileTreeResponse,
  WorkspaceFilesCapabilityV1,
  WorkspacePanelContext,
  WorkspacePanelNavigationV1,
  WriteWorkspaceFileResponse,
} from "@jmfederico/pi-web/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { FilesRuntime } from "./FilesRuntime";

describe("FilesRuntime tree and selection", () => {
  it("refreshes root and expanded directories, then collapses locally", async () => {
    const listFiles = vi.fn<WorkspaceFilesCapabilityV1["listFiles"]>((path) => Promise.resolve(treeResponse(path, {
      "": [directoryEntry("src"), fileEntry("README.md")],
      src: [fileEntry("src/index.ts")],
    }[path] ?? [])));
    const context = createContext({ files: createFiles({ listFiles }) });
    const runtime = new FilesRuntime();
    const scope = runtime.snapshot(context);
    scope.expandedDirs = { src: [fileEntry("src/stale.ts")] };
    scope.treeStale = true;

    await runtime.refreshFiles(context);

    expect(listFiles.mock.calls.find(([path]) => path === "")?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(listFiles.mock.calls.find(([path]) => path === "src")?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(scope.fileTree).toEqual([directoryEntry("src"), fileEntry("README.md")]);
    expect(scope.expandedDirs).toEqual({ src: [fileEntry("src/index.ts")] });
    expect(scope.treeStale).toBe(false);

    listFiles.mockClear();
    await runtime.expandDir(context, "src");
    expect(listFiles).not.toHaveBeenCalled();
    expect(scope.expandedDirs).toEqual({});
  });

  it("aborts superseded refreshes and directory expansions before stale results can commit", async () => {
    const trees = deferredTrees();
    const context = createContext({ files: createFiles({ listFiles: trees.fn }) });
    const runtime = new FilesRuntime();

    const staleRefresh = runtime.refreshFiles(context);
    const currentRefresh = runtime.refreshFiles(context);
    expect(trees.request(0).signal.aborted).toBe(true);
    trees.request(1).resolve(treeResponse("", [directoryEntry("src")]));
    await Promise.all([staleRefresh, currentRefresh]);
    expect(runtime.snapshot(context).fileTree).toEqual([directoryEntry("src")]);

    const staleExpansion = runtime.expandDir(context, "src");
    const concurrentExpansion = runtime.expandDir(context, "docs");
    const currentExpansion = runtime.expandDir(context, "src");
    expect(trees.request(2).signal.aborted).toBe(true);
    expect(trees.request(3).signal.aborted).toBe(false);
    trees.request(3).resolve(treeResponse("docs", [fileEntry("docs/guide.md")]));
    trees.request(4).resolve(treeResponse("src", [fileEntry("src/current.ts")]));
    await Promise.all([staleExpansion, concurrentExpansion, currentExpansion]);
    expect(runtime.snapshot(context).expandedDirs).toEqual({
      docs: [fileEntry("docs/guide.md")],
      src: [fileEntry("src/current.ts")],
    });
  });

  it("aborts tree work when its last observer disconnects and refreshes on reconnect", async () => {
    const trees = deferredTrees();
    const context = createContext({ files: createFiles({ listFiles: trees.fn }) });
    const runtime = new FilesRuntime();
    const unsubscribe = runtime.subscribe(context, vi.fn());

    const refresh = runtime.refreshFiles(context);
    const expansion = runtime.expandDir(context, "src");
    unsubscribe();

    expect(trees.request(0).signal.aborted).toBe(true);
    expect(trees.request(1).signal.aborted).toBe(true);
    expect(runtime.snapshot(context)).toMatchObject({ initialized: false, treeLoading: false, treeStale: true });
    await Promise.all([refresh, expansion]);
    await runtime.invalidate(context);
    expect(trees.fn).toHaveBeenCalledTimes(2);

    runtime.subscribe(context, vi.fn());
    const scope = runtime.prepare(context);
    trees.request(2).resolve(treeResponse("", [fileEntry("README.md")]));
    await vi.waitFor(() => { expect(scope.fileTree).toEqual([fileEntry("README.md")]); });
    expect(trees.request(2).signal.aborted).toBe(false);
  });

  it("keeps expected failures visible and clears its tree error after recovery", async () => {
    const listFiles = vi.fn<WorkspaceFilesCapabilityV1["listFiles"]>()
      .mockRejectedValueOnce(new Error("tree unavailable"))
      .mockResolvedValue(treeResponse("", [fileEntry("README.md")]));
    const context = createContext({ files: createFiles({ listFiles }) });
    const runtime = new FilesRuntime();
    const scope = runtime.snapshot(context);

    await runtime.refreshFiles(context);
    expect(scope.error).toBe("tree unavailable");

    await runtime.refreshFiles(context);
    expect(scope.error).toBeUndefined();
    expect(scope.fileTree).toEqual([fileEntry("README.md")]);
  });

  it("rejects stale A to B to A responses and aborts obsolete reads", async () => {
    const reads = deferredReads();
    const setNavigation = vi.fn<WorkspacePanelNavigationV1["set"]>();
    const navigation = createNavigation({}, setNavigation);
    const context = createContext({ files: createFiles({ readFile: reads.fn }), navigation });
    const runtime = new FilesRuntime();

    const firstA = runtime.selectFile(context, "a.txt");
    const loadB = runtime.selectFile(context, "b.txt");
    const latestA = runtime.selectFile(context, "a.txt");

    expect(reads.request(0).signal.aborted).toBe(true);
    expect(reads.request(1).signal.aborted).toBe(true);
    reads.request(0).resolve(fileResponse("a.txt", "first A"));
    reads.request(1).resolve(fileResponse("b.txt", "stale B"));
    reads.request(2).resolve(fileResponse("a.txt", "latest A"));
    await Promise.all([firstA, loadB, latestA]);

    const scope = runtime.snapshot(context);
    expect(scope.selectedFilePath).toBe("a.txt");
    expect(scope.selectedFileContent?.content).toBe("latest A");
    expect(setNavigation).toHaveBeenNthCalledWith(1, "file", "a.txt");
    expect(setNavigation).toHaveBeenNthCalledWith(2, "file", "b.txt");
    expect(setNavigation).toHaveBeenNthCalledWith(3, "file", "a.txt");
  });

  it("isolates equal paths across machine/workspace scope and keeps current read errors local", async () => {
    const firstReads = deferredReads();
    const secondReads = deferredReads();
    const runtime = new FilesRuntime();
    const first = createContext({ files: createFiles({ readFile: firstReads.fn }) });
    const second = createContext({ machineId: "remote-2", workspaceId: "workspace-2", files: createFiles({ readFile: secondReads.fn }) });

    const stale = runtime.selectFile(first, "same.txt");
    const current = runtime.selectFile(second, "same.txt");
    firstReads.request(0).resolve(fileResponse("same.txt", "old scope"));
    secondReads.request(0).reject(new Error("Path does not exist: same.txt"));
    await Promise.all([stale, current]);

    expect(runtime.snapshot(first).selectedFileContent?.content).toBe("old scope");
    expect(runtime.snapshot(second).selectedFileContent).toBeUndefined();
    expect(runtime.snapshot(second).selectedFileLoadError).toBe("Path does not exist: same.txt");
  });

  it("follows back and forward navigation delivered through panel invalidation", async () => {
    const readFile = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path) => Promise.resolve(fileResponse(path, `loaded:${path}`)));
    const files = createFiles({ readFile });
    const runtime = new FilesRuntime();
    const first = createContext({ files, navigation: createNavigation({ file: "a.txt" }) });
    const scope = runtime.prepare(first);
    await vi.waitFor(() => { expect(scope.selectedFileContent?.content).toBe("loaded:a.txt"); });
    const contexts: WorkspacePanelContext[] = [];
    runtime.subscribe(first, (_snapshot, context) => { contexts.push(context); });

    const second = { ...first, navigation: createNavigation({ file: "b.txt", mode: "raw" }) };
    await runtime.invalidate(second);
    await vi.waitFor(() => { expect(scope.selectedFileContent?.content).toBe("loaded:b.txt"); });

    const back = { ...first, navigation: createNavigation({ file: "a.txt", mode: "preview" }) };
    await runtime.invalidate(back);
    await vi.waitFor(() => { expect(scope.selectedFileContent?.content).toBe("loaded:a.txt"); });
    expect(contexts).toContain(second);
    expect(contexts.at(-1)).toBe(back);
    expect(readFile.mock.calls.map(([path]) => path)).toEqual(["a.txt", "b.txt", "a.txt"]);
  });

  it("restores the aliased navigation snapshot and reports missing required host capabilities", async () => {
    const navigation = createNavigation({ file: "src/main.ts" });
    const readFile = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path) => Promise.resolve(fileResponse(path, "restored")));
    const context = createContext({ files: createFiles({ readFile }), navigation });
    const runtime = new FilesRuntime();

    const scope = runtime.prepare(context);
    await vi.waitFor(() => { expect(scope.selectedFileContent?.content).toBe("restored"); });
    expect(readFile.mock.calls[0]?.[0]).toBe("src/main.ts");
    expect(readFile.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const unavailable = createContext({ files: legacyFiles(), navigation: null });
    expect(runtime.prepare(unavailable).capabilityError).toContain("workspace-files capability v1");
  });
});

describe("FilesRuntime uploads", () => {
  it("uploads sequentially with progress, safe defaults, refresh, and first-success selection", async () => {
    const uploads = controllableUploads();
    const listFiles = vi.fn<WorkspaceFilesCapabilityV1["listFiles"]>(() => Promise.resolve(treeResponse("")));
    const readFile = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path) => Promise.resolve(fileResponse(path)));
    const files = createFiles({ uploadFile: uploads.fn, listFiles, readFile });
    const setNavigation = vi.fn<WorkspacePanelNavigationV1["set"]>();
    const navigation = createNavigation({}, setNavigation);
    const context = createContext({ files, navigation });
    const runtime = new FilesRuntime({ createUploadBatchId: () => "batch-1", now: sequenceNow("start", "complete") });
    const selected = [new File(["aa"], "a.txt"), new File(["bbb"], "b.txt")];

    const run = runtime.startWorkspaceUpload(context, selected, { destinationFolder: "uploads/manual" });
    expect(run?.batchId).toBe("batch-1");
    expect(uploads.fn).toHaveBeenCalledTimes(1);
    expect(uploads.options(0)).toMatchObject({
      destinationFolder: "uploads/manual",
      createDirs: true,
      overwrite: false,
    });

    uploads.progress(0, { loaded: 1, total: 2, percent: 0.5, lengthComputable: true });
    expect(runtime.snapshot(context).uploadBatches["batch-1"]).toMatchObject({ loaded: 1, total: 5, percent: 0.2 });

    uploads.resolve(0, writeResponse("uploads/manual/a.txt", 2));
    await vi.waitFor(() => { expect(uploads.fn).toHaveBeenCalledTimes(2); });
    uploads.resolve(1, writeResponse("uploads/manual/b.txt", 3));
    await run?.done;

    expect(runtime.snapshot(context).uploadBatches["batch-1"]).toMatchObject({
      status: "completed",
      completedAt: "complete",
      files: [
        { path: "uploads/manual/a.txt", status: "completed" },
        { path: "uploads/manual/b.txt", status: "completed" },
      ],
    });
    expect(listFiles.mock.calls.find(([path]) => path === "")?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(readFile).toHaveBeenCalledWith("uploads/manual/a.txt", expect.anything());
    expect(setNavigation).toHaveBeenCalledWith("file", "uploads/manual/a.txt");
  });

  it("continues after one file fails and selects the first successful upload", async () => {
    const uploads = controllableUploads();
    const context = createContext({ files: createFiles({
      uploadFile: uploads.fn,
      listFiles: () => Promise.resolve(treeResponse("")),
      readFile: (path) => Promise.resolve(fileResponse(path)),
    }) });
    const runtime = new FilesRuntime({ createUploadBatchId: () => "batch-1", now: sequenceNow("start", "failed") });
    const run = runtime.startWorkspaceUpload(context, [new File(["a"], "a.txt"), new File(["b"], "b.txt")], { destinationFolder: "uploads" });

    uploads.reject(0, new Error("File already exists: uploads/a.txt"));
    await vi.waitFor(() => { expect(uploads.fn).toHaveBeenCalledTimes(2); });
    uploads.resolve(1, writeResponse("uploads/b.txt", 1));
    await run?.done;

    expect(runtime.snapshot(context).uploadBatches["batch-1"]).toMatchObject({
      status: "error",
      error: "File already exists: uploads/a.txt",
      files: [
        { status: "error", error: "File already exists: uploads/a.txt" },
        { status: "completed", path: "uploads/b.txt" },
      ],
    });
    expect(runtime.snapshot(context).selectedFilePath).toBe("uploads/b.txt");
  });

  it("refreshes and selects a successful file when a later upload is cancelled", async () => {
    const uploads = controllableUploads({ rejectOnCancel: true });
    const listFiles = vi.fn<WorkspaceFilesCapabilityV1["listFiles"]>(() => Promise.resolve(treeResponse("")));
    const readFile = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path) => Promise.resolve(fileResponse(path)));
    const context = createContext({ files: createFiles({ uploadFile: uploads.fn, listFiles, readFile }) });
    const runtime = new FilesRuntime({ createUploadBatchId: () => "batch-1" });
    const run = runtime.startWorkspaceUpload(context, [new File(["a"], "a.txt"), new File(["b"], "b.txt")], { destinationFolder: "uploads" });

    uploads.resolve(0, writeResponse("uploads/a.txt", 1));
    await vi.waitFor(() => { expect(uploads.fn).toHaveBeenCalledTimes(2); });
    runtime.cancelWorkspaceUpload(context, "batch-1");
    await run?.done;

    expect(runtime.snapshot(context).uploadBatches["batch-1"]?.status).toBe("cancelled");
    expect(listFiles.mock.calls.find(([path]) => path === "")?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(readFile).toHaveBeenCalledWith("uploads/a.txt", expect.anything());
    expect(runtime.snapshot(context).selectedFilePath).toBe("uploads/a.txt");
  });

  it("dismisses a completed batch without retaining cancellation state", async () => {
    const uploads = controllableUploads();
    const context = createContext({ files: createFiles({ uploadFile: uploads.fn }) });
    const runtime = new FilesRuntime({ createUploadBatchId: () => "reused-batch" });
    const first = runtime.startWorkspaceUpload(context, [new File(["a"], "a.txt")], { destinationFolder: "uploads", selectUploadedFile: false });
    uploads.resolve(0, writeResponse("uploads/a.txt", 1));
    await first?.done;
    runtime.clearWorkspaceUpload(context, "reused-batch");

    const second = runtime.startWorkspaceUpload(context, [new File(["b"], "b.txt")], { destinationFolder: "uploads", selectUploadedFile: false });
    expect(uploads.fn).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot(context).uploadBatches["reused-batch"]?.status).toBe("uploading");
    uploads.resolve(1, writeResponse("uploads/b.txt", 1));
    await second?.done;
  });

  it("cancels and dismisses an in-flight upload without resurrecting its batch", async () => {
    const uploads = controllableUploads({ rejectOnCancel: true });
    const context = createContext({ files: createFiles({ uploadFile: uploads.fn }) });
    const runtime = new FilesRuntime({ createUploadBatchId: () => "batch-1", now: sequenceNow("start", "cancel") });
    const run = runtime.startWorkspaceUpload(context, [new File(["a"], "a.txt")], { destinationFolder: "uploads" });

    runtime.cancelWorkspaceUpload(context, "batch-1");
    await run?.done;
    expect(uploads.cancel(0)).toHaveBeenCalledOnce();
    expect(runtime.snapshot(context).uploadBatches["batch-1"]).toMatchObject({ status: "cancelled", error: "Upload cancelled" });

    runtime.clearWorkspaceUpload(context, "batch-1");
    expect(runtime.snapshot(context).uploadBatches).toEqual({});
  });

  it("never evicts an inactive scope while its upload is in flight", async () => {
    const uploads = controllableUploads({ rejectOnCancel: true });
    const context = createContext({ files: createFiles({ uploadFile: uploads.fn }) });
    const runtime = new FilesRuntime({ createUploadBatchId: () => "protected-batch" });
    const run = runtime.startWorkspaceUpload(context, [new File(["a"], "a.txt")], { destinationFolder: "uploads" });

    for (let index = 0; index < 10; index += 1) {
      runtime.snapshot(createContext({ machineId: `remote-${String(index)}`, workspaceId: `workspace-${String(index)}` }));
    }

    expect(runtime.snapshot(context).uploadBatches["protected-batch"]?.status).toBe("uploading");
    runtime.cancelWorkspaceUpload(context, "protected-batch");
    await run?.done;
  });

  it("rejects traversal before starting transport", () => {
    const uploadFile = vi.fn<WorkspaceFilesCapabilityV1["uploadFile"]>();
    const context = createContext({ files: createFiles({ uploadFile }) });
    const runtime = new FilesRuntime();

    expect(runtime.startWorkspaceUpload(context, [new File(["a"], "a.txt")], { destinationFolder: "../outside" })).toBeUndefined();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(runtime.snapshot(context).error).toContain("path traversal");
  });
});

interface ContextOptions {
  machineId?: string;
  workspaceId?: string;
  files?: WorkspacePanelContext["files"];
  navigation?: WorkspacePanelNavigationV1 | null;
}

function createContext(options: ContextOptions = {}): WorkspacePanelContext {
  return {
    machine: { id: options.machineId ?? "remote-1", name: "Remote", kind: "remote" },
    workspace: { id: options.workspaceId ?? "workspace-1", projectId: "project-1", path: "/repo", label: "repo", isMain: true },
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
    uploadFile: () => { throw new Error("not implemented"); },
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

function createNavigation(
  query: Record<string, string | readonly string[]> = {},
  set: WorkspacePanelNavigationV1["set"] = vi.fn<WorkspacePanelNavigationV1["set"]>(),
): WorkspacePanelNavigationV1 {
  return { version: 1, contributionId: "files:workspace.files", query, set };
}

function deferredTrees() {
  const requests: {
    path: string;
    signal: AbortSignal;
    resolve: (value: FileTreeResponse) => void;
  }[] = [];
  const fn = vi.fn<WorkspaceFilesCapabilityV1["listFiles"]>((path, options) => new Promise((resolve, reject) => {
    const signal = options?.signal ?? new AbortController().signal;
    requests.push({ path, signal, resolve });
    signal.addEventListener("abort", () => { reject(new DOMException("cancelled", "AbortError")); }, { once: true });
  }));
  return {
    fn,
    request: (index: number) => {
      const request = requests[index];
      if (request === undefined) throw new Error(`Missing tree request ${String(index)}`);
      return request;
    },
  };
}

function deferredReads() {
  const requests: {
    path: string;
    signal: AbortSignal;
    resolve: (value: FileContentResponse) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const fn = vi.fn<WorkspaceFilesCapabilityV1["readFile"]>((path, options) => new Promise((resolve, reject) => {
    requests.push({ path, signal: options?.signal ?? new AbortController().signal, resolve, reject });
  }));
  return {
    fn,
    request: (index: number) => {
      const request = requests[index];
      if (request === undefined) throw new Error(`Missing read ${String(index)}`);
      return request;
    },
  };
}

function controllableUploads(options: { rejectOnCancel?: boolean } = {}) {
  const calls: {
    options: Parameters<WorkspaceFilesCapabilityV1["uploadFile"]>[1];
    resolve: (value: WriteWorkspaceFileResponse) => void;
    reject: (error: unknown) => void;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  const fn = vi.fn<WorkspaceFilesCapabilityV1["uploadFile"]>((file, uploadOptions) => {
    let resolveTask: (value: WriteWorkspaceFileResponse) => void = () => undefined;
    let rejectTask: (error: unknown) => void = () => undefined;
    const completed = new Promise<WriteWorkspaceFileResponse>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const cancel = vi.fn(() => {
      if (options.rejectOnCancel === true) rejectTask(new DOMException("cancelled", "AbortError"));
    });
    calls.push({ options: uploadOptions, resolve: resolveTask, reject: rejectTask, cancel });
    return { path: `${uploadOptions?.destinationFolder ?? ".pi-web/uploads"}/${file.name}`, completed, cancel };
  });
  const call = (index: number) => {
    const entry = calls[index];
    if (entry === undefined) throw new Error(`Missing upload ${String(index)}`);
    return entry;
  };
  return {
    fn,
    options: (index: number) => call(index).options,
    progress: (index: number, progress: Parameters<NonNullable<NonNullable<Parameters<WorkspaceFilesCapabilityV1["uploadFile"]>[1]>["onProgress"]>>[0]) => { call(index).options?.onProgress?.(progress); },
    resolve: (index: number, response: WriteWorkspaceFileResponse) => { call(index).resolve(response); },
    reject: (index: number, error: unknown) => { call(index).reject(error); },
    cancel: (index: number) => call(index).cancel,
  };
}

function sequenceNow(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? "now";
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
