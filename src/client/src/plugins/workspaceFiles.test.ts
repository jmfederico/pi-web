import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_INLINE_PREVIEW_BYTES } from "../../../shared/workspaceFiles";
import {
  uploadWorkspaceFile,
  WorkspaceUploadCancelledError,
  type FileContentResponse,
  type FileTreeResponse,
  type WriteWorkspaceFileResponse,
} from "../api";
import { createWorkspaceFiles, type CreateWorkspaceFilesOptions, type WorkspaceFilesApi } from "./workspaceFiles";
import type { WorkspaceInvalidation } from "./types";

const workspace = { id: "w-1", projectId: "p-1" };

const mutationInvalidation: WorkspaceInvalidation = {
  reason: "mutation",
  resources: ["workspace.files"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createWorkspaceFiles", () => {
  it("advertises v1 host policy and returns browser-ready bound preview references", () => {
    vi.stubEnv("BASE_URL", "./");
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/nested/pi-web/" });
    const files = createWorkspaceFiles(fakeApi(), workspace, "remote a", hostOptions({ defaultUploadFolder: "workspace/uploads" }));

    expect(files.capabilityVersion).toBe(1);
    expect(files.defaultUploadFolder).toBe("workspace/uploads");
    expect(files.maxInlinePreviewBytes).toBe(MAX_INLINE_PREVIEW_BYTES);
    expect(files.previewUrl("reports/a #1.html", { version: "2026-06-25T00:00:00.000Z" })).toBe(
      "https://pi.example.test/nested/pi-web/api/machines/remote%20a/projects/p-1/workspaces/w-1/file/preview?path=reports%2Fa+%231.html&v=2026-06-25T00%3A00%3A00.000Z",
    );
    expect(files.downloadUrl("reports/a #1.html")).toBe(
      "https://pi.example.test/nested/pi-web/api/machines/remote%20a/projects/p-1/workspaces/w-1/file/preview?path=reports%2Fa+%231.html&download=1",
    );
  });

  it("listFiles forwards cancellation to the bound workspace and machine", async () => {
    const tree = testFileTreeResponse();
    const workspaceTree = vi.fn<WorkspaceFilesApi["workspaceTree"]>(() => Promise.resolve(tree));
    const files = createWorkspaceFiles(fakeApi({ workspaceTree }), workspace, "remote-1", hostOptions());
    const controller = new AbortController();

    await expect(files.listFiles(".pi-web/relays", { signal: controller.signal })).resolves.toBe(tree);
    expect(workspaceTree).toHaveBeenCalledWith("p-1", "w-1", ".pi-web/relays", "remote-1", { signal: controller.signal });
  });

  it("listFiles rejects when the directory is missing, matching readFile error behavior", async () => {
    const workspaceTree = vi.fn<WorkspaceFilesApi["workspaceTree"]>(() => Promise.reject(new Error("Path not found: .pi-web/relays")));
    const files = createWorkspaceFiles(fakeApi({ workspaceTree }), workspace, "local", hostOptions());

    await expect(files.listFiles(".pi-web/relays")).rejects.toThrow("Path not found: .pi-web/relays");
  });

  it("readFile forwards cancellation through the bound workspace and machine", async () => {
    const content = testFileContent("README.md");
    const workspaceFile = vi.fn<WorkspaceFilesApi["workspaceFile"]>(() => Promise.resolve(content));
    const files = createWorkspaceFiles(fakeApi({ workspaceFile }), workspace, "remote-1", hostOptions());
    const controller = new AbortController();

    await expect(files.readFile("README.md", { signal: controller.signal })).resolves.toBe(content);
    expect(workspaceFile).toHaveBeenCalledWith("p-1", "w-1", "README.md", "remote-1", { signal: controller.signal });
  });

  it("publishes workspace.files only after successful write, delete, and move mutations", async () => {
    const writeWorkspaceFile = vi.fn<WorkspaceFilesApi["writeWorkspaceFile"]>(() => Promise.resolve(testWriteFileResponse("out.txt")));
    const deleteWorkspaceFile = vi.fn<WorkspaceFilesApi["deleteWorkspaceFile"]>(() => Promise.resolve({ path: "old.txt", existed: true }));
    const moveWorkspaceFile = vi.fn<WorkspaceFilesApi["moveWorkspaceFile"]>(() => Promise.resolve({ fromPath: "old.txt", toPath: "new.txt", size: 0, modifiedAt: "2026-06-14T10:00:00.000Z" }));
    const onInvalidate = vi.fn();
    const files = createWorkspaceFiles(
      fakeApi({ writeWorkspaceFile, deleteWorkspaceFile, moveWorkspaceFile }),
      workspace,
      "local",
      hostOptions({ onInvalidate }),
    );

    await files.writeFile("out.txt", "hi");
    await files.deleteFile("old.txt");
    await files.moveFile("old.txt", "new.txt");

    expect(writeWorkspaceFile).toHaveBeenCalledWith("p-1", "w-1", "out.txt", "hi", undefined, "local");
    expect(deleteWorkspaceFile).toHaveBeenCalledWith("p-1", "w-1", "old.txt", "local");
    expect(moveWorkspaceFile).toHaveBeenCalledWith("p-1", "w-1", "old.txt", "new.txt", undefined, "local");
    expect(onInvalidate).toHaveBeenCalledTimes(3);
    expect(onInvalidate).toHaveBeenNthCalledWith(1, mutationInvalidation);
    expect(onInvalidate).toHaveBeenNthCalledWith(2, mutationInvalidation);
    expect(onInvalidate).toHaveBeenNthCalledWith(3, mutationInvalidation);
  });

  it("does not publish invalidation when a mutation fails", async () => {
    const writeWorkspaceFile = vi.fn<WorkspaceFilesApi["writeWorkspaceFile"]>(() => Promise.reject(new Error("File exists: out.txt")));
    const onInvalidate = vi.fn();
    const files = createWorkspaceFiles(fakeApi({ writeWorkspaceFile }), workspace, "local", hostOptions({ onInvalidate }));

    await expect(files.writeFile("out.txt", "hi", { overwrite: false })).rejects.toThrow("File exists: out.txt");
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it("starts one bound upload with safe defaults, progress, and success invalidation", async () => {
    const response = testWriteFileResponse("workspace/uploads/report.txt");
    const sourceCancel = vi.fn();
    const upload = vi.fn<typeof uploadWorkspaceFile>(() => ({ promise: Promise.resolve(response), cancel: sourceCancel }));
    const onProgress = vi.fn();
    const onInvalidate = vi.fn();
    const files = createWorkspaceFiles(fakeApi(), workspace, "remote-1", hostOptions({
      defaultUploadFolder: "workspace/uploads",
      uploadWorkspaceFile: upload,
      onInvalidate,
    }));
    const file = new File(["report"], "report.txt", { type: "text/plain" });

    const task = files.uploadFile(file, { onProgress });
    expect(task.path).toBe("workspace/uploads/report.txt");
    expect(upload).toHaveBeenCalledWith("p-1", "w-1", { path: "workspace/uploads/report.txt", file }, {
      machineId: "remote-1",
      createDirs: true,
      overwrite: false,
      onProgress,
    });
    upload.mock.calls[0]?.[3]?.onProgress?.({ loaded: 3, total: 6, percent: 0.5, lengthComputable: true });
    expect(onProgress).toHaveBeenCalledWith({ loaded: 3, total: 6, percent: 0.5, lengthComputable: true });

    await expect(task.completed).resolves.toBe(response);
    expect(onInvalidate).toHaveBeenCalledOnce();
    expect(onInvalidate).toHaveBeenCalledWith(mutationInvalidation);
    expect(sourceCancel).not.toHaveBeenCalled();
  });

  it("maps upload cancellation to AbortError and publishes no failed-upload invalidation", async () => {
    let rejectUpload: (error: unknown) => void = () => undefined;
    const promise = new Promise<WriteWorkspaceFileResponse>((_resolve, reject) => { rejectUpload = reject; });
    const sourceCancel = vi.fn(() => { rejectUpload(new WorkspaceUploadCancelledError()); });
    const upload = vi.fn<typeof uploadWorkspaceFile>(() => ({ promise, cancel: sourceCancel }));
    const onInvalidate = vi.fn();
    const files = createWorkspaceFiles(fakeApi(), workspace, "local", hostOptions({ uploadWorkspaceFile: upload, onInvalidate }));

    const task = files.uploadFile(new File(["x"], "cancel.txt"));
    task.cancel();

    await expect(task.completed).rejects.toMatchObject({ name: "AbortError" });
    expect(sourceCancel).toHaveBeenCalledOnce();
    expect(onInvalidate).not.toHaveBeenCalled();
  });
});

function hostOptions(overrides: Partial<CreateWorkspaceFilesOptions> = {}): CreateWorkspaceFilesOptions {
  return { defaultUploadFolder: ".pi-web/uploads", ...overrides };
}

function fakeApi(overrides: Partial<WorkspaceFilesApi> = {}): WorkspaceFilesApi {
  const unexpected = (name: string) => () => Promise.reject(new Error(`Unexpected ${name} call`));
  return {
    workspaceFile: vi.fn<WorkspaceFilesApi["workspaceFile"]>(unexpected("workspaceFile")),
    workspaceTree: vi.fn<WorkspaceFilesApi["workspaceTree"]>(unexpected("workspaceTree")),
    writeWorkspaceFile: vi.fn<WorkspaceFilesApi["writeWorkspaceFile"]>(unexpected("writeWorkspaceFile")),
    deleteWorkspaceFile: vi.fn<WorkspaceFilesApi["deleteWorkspaceFile"]>(unexpected("deleteWorkspaceFile")),
    moveWorkspaceFile: vi.fn<WorkspaceFilesApi["moveWorkspaceFile"]>(unexpected("moveWorkspaceFile")),
    ...overrides,
  };
}

function testFileTreeResponse(path = ".pi-web/relays"): FileTreeResponse {
  return {
    path,
    entries: [{ name: "relays-panel-plugin", path: `${path}/relays-panel-plugin`, type: "directory", modifiedAt: "2026-06-14T10:00:00.000Z" }],
    scannedAt: "2026-06-14T10:00:01.000Z",
    truncated: false,
  };
}

function testFileContent(path: string): FileContentResponse {
  return {
    path,
    encoding: "utf8",
    size: 0,
    modifiedAt: "2026-06-14T10:00:00.000Z",
    content: "",
    truncated: false,
    binary: false,
  };
}

function testWriteFileResponse(path: string): WriteWorkspaceFileResponse {
  return {
    path,
    size: 2,
    modifiedAt: "2026-06-14T10:00:00.000Z",
    created: true,
  };
}
