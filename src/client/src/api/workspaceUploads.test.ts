import { describe, expect, it } from "vitest";
import {
  effectiveWorkspaceUploadFolder,
  uploadWorkspaceFile,
  uploadWorkspaceFiles,
  workspaceEffectiveUploadFolder,
  workspaceUploadPath,
  WorkspaceUploadBatchError,
  WorkspaceUploadCancelledError,
  type WorkspaceUploadBatchProgress,
  type WorkspaceFileUploadProgress,
  type WorkspaceUploadXhr,
} from "./workspaceUploads";

describe("workspace upload helpers", () => {
  it("resolves effective upload defaults and workspace-relative paths", () => {
    expect(effectiveWorkspaceUploadFolder(undefined)).toBe(".pi-web/uploads");
    expect(effectiveWorkspaceUploadFolder({ uploads: { defaultFolder: "manual/uploads" } })).toBe("manual/uploads");
    expect(workspaceEffectiveUploadFolder({ uploads: { defaultFolder: "project/uploads" } }, "global/uploads")).toBe("project/uploads");
    expect(workspaceEffectiveUploadFolder(undefined, "global/uploads")).toBe("global/uploads");
    expect(workspaceUploadPath(" uploads\\manual// ", "./report.txt")).toBe("uploads/manual/report.txt");
    expect(workspaceUploadPath("", "report.txt")).toBe("report.txt");

    expect(() => workspaceUploadPath("/tmp", "report.txt")).toThrow("workspace-relative");
    expect(() => workspaceUploadPath("uploads", "../secret.txt")).toThrow("path traversal");
    expect(() => workspaceUploadPath("uploads", " ")).toThrow("must not be empty");
  });

  it("uploads one workspace file through XHR with progress and parses the final response", async () => {
    const xhrs = new FakeXhrQueue();
    const progress: WorkspaceFileUploadProgress[] = [];
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    const task = uploadWorkspaceFile("p 1", "w/1", { path: "manual/hello.txt", file }, {
      machineId: "remote a",
      overwrite: false,
      xhrFactory: xhrs.factory,
      onProgress: (event) => { progress.push(event); },
    });

    const xhr = xhrs.only();
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("api/machines/remote%20a/projects/p%201/workspaces/w%2F1/file?path=manual%2Fhello.txt&overwrite=false");
    expect(xhr.headers.get("content-type")).toBe("text/plain");
    expect(xhr.body).toBe(file);

    xhr.emitUploadProgress(2, 5);
    xhr.respondJson(200, { path: "manual/hello.txt", size: 5, modifiedAt: "2026-06-25T00:00:00.000Z", created: true });

    await expect(task.promise).resolves.toEqual({ path: "manual/hello.txt", size: 5, modifiedAt: "2026-06-25T00:00:00.000Z", created: true });
    expect(progress).toEqual([
      { loaded: 2, total: 5, percent: 0.4, lengthComputable: true },
      { loaded: 5, total: 5, percent: 1, lengthComputable: true },
    ]);
  });

  it("cancels an in-flight workspace file upload", async () => {
    const xhrs = new FakeXhrQueue();
    const file = new File(["hello"], "hello.txt");

    const task = uploadWorkspaceFile("p1", "w1", { path: "uploads/hello.txt", file }, { xhrFactory: xhrs.factory });
    task.cancel();

    await expect(task.promise).rejects.toBeInstanceOf(WorkspaceUploadCancelledError);
    expect(xhrs.only().aborted).toBe(true);
  });

  it("uploads a batch sequentially and reports aggregate progress", async () => {
    const xhrs = new FakeXhrQueue();
    const progress: WorkspaceUploadBatchProgress[] = [];
    const files = [new File(["ab"], "a.txt", { type: "text/plain" }), new File(["cde"], "b.txt")];

    const task = uploadWorkspaceFiles("p 1", "w/1", files, {
      destinationFolder: "uploads//manual",
      machineId: "remote a",
      xhrFactory: xhrs.factory,
      onProgress: (event) => { progress.push(event); },
    });

    const first = xhrs.at(0);
    expect(first.url).toBe("api/machines/remote%20a/projects/p%201/workspaces/w%2F1/file?path=uploads%2Fmanual%2Fa.txt");
    first.emitUploadProgress(1, 2);
    first.respondJson(200, { path: "uploads/manual/a.txt", size: 2, modifiedAt: "2026-06-25T00:00:00.000Z", created: true });
    await Promise.resolve();

    const second = xhrs.at(1);
    expect(second.url).toBe("api/machines/remote%20a/projects/p%201/workspaces/w%2F1/file?path=uploads%2Fmanual%2Fb.txt");
    second.emitUploadProgress(3, 3);
    second.respondJson(200, { path: "uploads/manual/b.txt", size: 3, modifiedAt: "2026-06-25T00:00:01.000Z", created: true });

    await expect(task.promise).resolves.toEqual([
      { path: "uploads/manual/a.txt", size: 2, modifiedAt: "2026-06-25T00:00:00.000Z", created: true },
      { path: "uploads/manual/b.txt", size: 3, modifiedAt: "2026-06-25T00:00:01.000Z", created: true },
    ]);
    expect(progress[0]).toMatchObject({ currentFileIndex: 0, loaded: 1, total: 5, percent: 0.2, done: false });
    expect(progress.at(-1)).toMatchObject({ currentFileIndex: 1, loaded: 5, total: 5, percent: 1, done: true });
    expect(progress.at(-1)?.files.map((file) => ({ path: file.path, loaded: file.loaded, total: file.total, done: file.done }))).toEqual([
      { path: "uploads/manual/a.txt", loaded: 2, total: 2, done: true },
      { path: "uploads/manual/b.txt", loaded: 3, total: 3, done: true },
    ]);
  });

  it("forwards createDirs through batch upload requests", async () => {
    const xhrs = new FakeXhrQueue();
    const file = new File(["hello"], "nested.txt", { type: "text/plain" });

    const task = uploadWorkspaceFiles("p1", "w1", [file], {
      destinationFolder: "uploads",
      createDirs: false,
      xhrFactory: xhrs.factory,
    });

    const xhr = xhrs.only();
    expect(xhr.url).toBe("api/machines/local/projects/p1/workspaces/w1/file?path=uploads%2Fnested.txt&createDirs=false");
    xhr.respondJson(200, { path: "uploads/nested.txt", size: 5, modifiedAt: "2026-06-25T00:00:00.000Z", created: true });

    await expect(task.promise).resolves.toEqual([
      { path: "uploads/nested.txt", size: 5, modifiedAt: "2026-06-25T00:00:00.000Z", created: true },
    ]);
  });

  it("cancels an in-flight batch upload without starting remaining files", async () => {
    const xhrs = new FakeXhrQueue();
    const files = [new File(["ab"], "a.txt"), new File(["cde"], "b.txt")];

    const task = uploadWorkspaceFiles("p1", "w1", files, {
      destinationFolder: "uploads",
      xhrFactory: xhrs.factory,
    });
    const first = xhrs.only();
    const cancellation = expect(task.promise).rejects.toBeInstanceOf(WorkspaceUploadCancelledError);

    task.cancel();

    await cancellation;
    expect(first.aborted).toBe(true);
    expect(xhrs.count()).toBe(1);
  });

  it("continues batch uploads after per-file failures and reports the failed file only", async () => {
    const xhrs = new FakeXhrQueue();
    const progress: WorkspaceUploadBatchProgress[] = [];
    const files = [new File(["ab"], "duplicate.txt"), new File(["cde"], "new.txt")];

    const task = uploadWorkspaceFiles("p1", "w1", files, {
      destinationFolder: "uploads",
      overwrite: false,
      xhrFactory: xhrs.factory,
      onProgress: (event) => { progress.push(event); },
    });

    xhrs.at(0).respondJson(409, { error: "File already exists: uploads/duplicate.txt" }, "Conflict");
    await Promise.resolve();
    xhrs.at(1).respondJson(200, { path: "uploads/new.txt", size: 3, modifiedAt: "2026-06-25T00:00:01.000Z", created: true });

    await expect(task.promise).rejects.toBeInstanceOf(WorkspaceUploadBatchError);
    await task.promise.catch((error: unknown) => {
      if (!(error instanceof WorkspaceUploadBatchError)) throw error;
      expect(error.failures).toEqual([{ index: 0, name: "duplicate.txt", path: "uploads/duplicate.txt", error: "File already exists: uploads/duplicate.txt" }]);
      expect(error.responses).toEqual([{ path: "uploads/new.txt", size: 3, modifiedAt: "2026-06-25T00:00:01.000Z", created: true }]);
    });
    expect(progress.at(-1)?.files.map((file) => ({ path: file.path, done: file.done, error: file.error }))).toEqual([
      { path: "uploads/duplicate.txt", done: true, error: "File already exists: uploads/duplicate.txt" },
      { path: "uploads/new.txt", done: true, error: undefined },
    ]);
  });
});

class FakeXhrQueue {
  private readonly instances: FakeXMLHttpRequest[] = [];

  readonly factory = (): WorkspaceUploadXhr => {
    const xhr = new FakeXMLHttpRequest();
    this.instances.push(xhr);
    return xhr;
  };

  only(): FakeXMLHttpRequest {
    expect(this.instances).toHaveLength(1);
    return this.instances[0] ?? failTest("missing XHR instance");
  }

  at(index: number): FakeXMLHttpRequest {
    return this.instances[index] ?? failTest(`missing XHR instance ${String(index)}`);
  }

  count(): number {
    return this.instances.length;
  }
}

class FakeXMLHttpRequest implements WorkspaceUploadXhr {
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  readonly headers = new Map<string, string>();
  method = "";
  url = "";
  async = true;
  body: XMLHttpRequestBodyInit | Document | null = null;
  responseType: XMLHttpRequestResponseType = "";
  response: unknown;
  responseText = "";
  status = 0;
  statusText = "";
  aborted = false;
  onload: ((event: ProgressEvent) => void) | null = null;
  onerror: ((event: ProgressEvent) => void) | null = null;
  onabort: ((event: ProgressEvent) => void) | null = null;

  open(method: string, url: string, async = true): void {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body?: XMLHttpRequestBodyInit | Document | null): void {
    this.body = body ?? null;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.(fakeProgressEvent());
  }

  emitUploadProgress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.(fakeProgressEvent(loaded, total, lengthComputable));
  }

  respondJson(status: number, body: unknown, statusText = "OK"): void {
    this.status = status;
    this.statusText = statusText;
    this.response = body;
    this.responseText = JSON.stringify(body);
    this.onload?.(fakeProgressEvent());
  }
}

function fakeProgressEvent(loaded = 0, total = 0, lengthComputable = false): ProgressEvent {
  return new FakeProgressEvent(loaded, total, lengthComputable);
}

class FakeProgressEvent extends Event implements ProgressEvent {
  readonly loaded: number;
  readonly total: number;
  readonly lengthComputable: boolean;

  constructor(loaded: number, total: number, lengthComputable: boolean) {
    super("progress");
    this.loaded = loaded;
    this.total = total;
    this.lengthComputable = lengthComputable;
  }
}

function failTest(message: string): never {
  throw new Error(message);
}
