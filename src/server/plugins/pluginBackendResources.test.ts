import { buffer } from "node:stream/consumers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPluginPeerResourceContextV5, ServerPluginResourceResponse } from "../../server-plugin-api.js";
import type { Project } from "../types.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import { PluginBackendRegistry, type PluginBackendRegistryOptions } from "./pluginBackendRegistry.js";
import type { ServerPluginPairedBackendContribution } from "./serverPluginRuntime.js";

const request = { pluginId: "files", moduleRevision: "r1", operation: "read", scope: "machine" as const, input: null };
const bytes = new Uint8Array([1, 2, 3]);
const project: Project = { id: "p", name: "Project", path: "/repo", createdAt: "2026-01-01T00:00:00Z" };
const registries: PluginBackendRegistry[] = [];
const response = (): ServerPluginResourceResponse => ({ body: bytes, contentType: "application/octet-stream" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function registry(
  resource: (context: ServerPluginPeerResourceContextV5) => unknown = response,
  options: Partial<PluginBackendRegistryOptions> = {},
) {
  const contribution: ServerPluginPairedBackendContribution = {
    pluginId: "files", pluginName: "Files", packageRoot: "/plugins/files", source: "fixture", scope: "local",
    // @ts-expect-error Model an untyped plugin callback so validation can be exercised.
    moduleRevision: "r1", apiVersion: 5, backend: { resource },
  };
  const value = new PluginBackendRegistry({
    contributions: [contribution], workspaces: { lookup: vi.fn(() => { throw new Error("Unexpected workspace resolution"); }) },
    ...options,
  });
  registries.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(registries.splice(0).map((value) => value.closeAll()));
  vi.useRealTimers();
});

describe("plugin backend resources", () => {
  it("returns byte bodies and only allowlisted metadata, keeping the callback signal live until consumed", async () => {
    let context!: ServerPluginPeerResourceContextV5;
    const value = registry((invocation) => {
      context = invocation;
      return { ...response(), contentLength: 3, acceptRanges: "bytes", headers: { "Set-Cookie": "unsafe" } };
    });
    const result = await value.resource({ ...request, range: "bytes=0-2", input: { nested: true } });
    expect(context).toMatchObject({ scope: { kind: "machine" }, range: "bytes=0-2" });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.input)).toBe(true);
    expect(context.signal.aborted).toBe(false);
    expect(result).toMatchObject({ statusCode: 200, contentLength: 3, acceptRanges: "bytes" });
    expect(result).not.toHaveProperty("headers");
    expect(await buffer(result.body)).toEqual(Buffer.from(bytes));
    expect(context.signal.aborted).toBe(true);
  });

  it("streams asynchronously under backpressure with partial range metadata", async () => {
    const next = deferred<undefined>();
    let context!: ServerPluginPeerResourceContextV5;
    const value = registry((invocation) => {
      context = invocation;
      return {
        body: (async function* () { yield bytes.subarray(0, 1); await next.promise; yield bytes.subarray(1); })(),
        contentType: "video/mp4", contentLength: 3, statusCode: 206, contentRange: "bytes 1-3/10",
      };
    });
    const result = await value.resource(request);
    const consuming = buffer(result.body);
    expect(context.signal.aborted).toBe(false);
    next.resolve(undefined);
    expect(await consuming).toEqual(Buffer.from(bytes));
    expect(context.signal.aborted).toBe(true);
  });

  it("resolves scoped workspace authority and rejects stale, mismatched, and unavailable selections", async () => {
    const workspaces = new WorkspaceProviderRegistry({ contributions: [], logger: { warn: vi.fn() } });
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Missing test workspace");
    const callback = vi.fn((context: ServerPluginPeerResourceContextV5) => {
      expect(context.scope).toMatchObject({ kind: "workspace", project: { id: "p" }, workspace: { id: workspaceId } });
      expect(Object.isFrozen(context.scope)).toBe(true);
      return response();
    });
    const value = registry(callback, { workspaces });
    const scoped = { ...request, scope: "workspace" as const, project, workspaceId };
    const result = await value.resource(scoped);
    await buffer(result.body);
    await expect(value.resource({ ...scoped, moduleRevision: "old" })).rejects.toMatchObject({ code: "stale-plugin-revision" });
    await expect(value.resource({ ...scoped, workspaceId: "missing" })).rejects.toMatchObject({ code: "workspace-not-found" });
    await expect(value.resource({ ...request, project })).rejects.toMatchObject({ code: "invalid-scope" });
    await expect(value.resource({ ...request, pluginId: "unknown" })).rejects.toMatchObject({ code: "inactive-plugin" });
    await expect(value.resource({ ...request, operation: "bad operation" })).rejects.toMatchObject({ code: "invalid-operation" });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("supports project scope without workspace resolution, but never resources on legacy peers", async () => {
    const callback = vi.fn(response);
    const value = registry(callback);
    await buffer((await value.resource({ ...request, scope: "project", project })).body);
    expect(callback).toHaveBeenCalledOnce();
    const legacy = registry(response, { contributions: [{
      pluginId: "files", pluginName: "Files", packageRoot: "/files", source: "fixture", scope: "local",
      moduleRevision: "r1", apiVersion: 3, backend: { resource: response },
    }] });
    await expect(legacy.resource(request)).rejects.toMatchObject({ code: "operation-unavailable" });
  });

  it.each([
    { contentType: "text/plain\r\nSet-Cookie: bad" }, { contentType: "text/plain, text/html" },
    { contentType: "text" }, { contentLength: -1 }, { contentLength: 1.5 },
    { contentLength: Number.MAX_SAFE_INTEGER + 1 }, { contentLength: 4 },
    { statusCode: 201 }, { statusCode: 206 }, { statusCode: 416, contentRange: "bytes 0-2/3" },
    { statusCode: 206, contentRange: "bytes 2-1/3" }, { statusCode: 206, contentRange: "bytes 0-3/3" },
    { statusCode: 206, contentRange: "bytes 0-2/3\n" }, { statusCode: 416, contentRange: "bytes */3\r\n" },
    { statusCode: 206, contentRange: "bytes 0-1/3", contentLength: 3 },
    { contentRange: "bytes 0-2/3" }, { acceptRanges: "none" },
  ])("rejects invalid resource metadata %j", async (invalid) => {
    const value = registry(() => ({ ...response(), ...invalid }));
    await expect(value.resource(request)).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("accepts an unsatisfied range with a finite empty body", async () => {
    const value = registry(() => ({ body: new Uint8Array(), contentType: "text/plain; charset=utf-8", statusCode: 416, contentRange: "bytes */3", contentLength: 0 }));
    const result = await value.resource(request);
    expect(result.statusCode).toBe(416);
    expect(await buffer(result.body)).toHaveLength(0);
  });

  it.each(["truncated", "overflow", "non-bytes", "throws"])("fails %s streaming safely and closes the iterator", async (kind) => {
    const closed = vi.fn();
    const value = registry(() => ({
      contentType: "application/octet-stream", contentLength: kind === "truncated" ? 4 : 2,
      body: (async function* () {
        try {
          if (kind === "throws") throw new Error("Source failed");
          yield await Promise.resolve(kind === "non-bytes" ? "text" : bytes);
        } finally { closed(); }
      })(),
    }));
    await expect(buffer((await value.resource(request)).body)).rejects.toThrow();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("cancels a streaming body promptly and calls return even with a pending next", async () => {
    let context!: ServerPluginPeerResourceContextV5;
    const started = deferred<undefined>();
    const next = deferred<IteratorResult<Uint8Array>>();
    const close = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    const value = registry((invocation) => {
      context = invocation;
      return { contentType: "application/octet-stream", body: {
        [Symbol.asyncIterator]: () => ({ next: () => { started.resolve(undefined); return next.promise; }, return: close }),
      } };
    }, { resourceMaxTotal: 1 });
    const cancel = new AbortController();
    const result = await value.resource(request, cancel.signal);
    const consuming = buffer(result.body);
    const rejected = expect(consuming).rejects.toMatchObject({ code: "request-cancelled" });
    await started.promise;
    cancel.abort();
    await rejected;
    expect(context.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    // A cancelled but uncooperative read still consumes capacity.
    await expect(value.resource(request)).rejects.toMatchObject({ statusCode: 503 });
    next.resolve({ done: true, value: undefined });
  });

  it("cleans up late callback bodies after cancellation and holds admission until they settle", async () => {
    const started = deferred<undefined>();
    const callback = deferred<ServerPluginResourceResponse>();
    const close = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    const value = registry(() => { started.resolve(undefined); return callback.promise; }, { resourceMaxTotal: 1 });
    const cancel = new AbortController();
    const pending = value.resource(request, cancel.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "request-cancelled" });
    await started.promise;
    cancel.abort();
    await rejected;
    await expect(value.resource(request)).rejects.toMatchObject({ statusCode: 503 });
    callback.resolve({ contentType: "application/octet-stream", body: {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }), return: close }),
    } });
    await value.closeAll();
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds callback timeout and still cleans up its late return", async () => {
    vi.useFakeTimers();
    const started = deferred<undefined>();
    const callback = deferred<ServerPluginResourceResponse>();
    const value = registry(() => { started.resolve(undefined); return callback.promise; }, { callbackTimeoutMs: 10 });
    const pending = value.resource(request);
    const rejected = expect(pending).rejects.toMatchObject({ code: "request-timeout" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    callback.resolve(response());
  });

  it("expires unconsumed bodies, releases admission, and cancels bodies at shutdown", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const value = registry((context) => { signals.push(context.signal); return response(); }, { resourceMaxTotal: 1, resourceLifetimeMs: 100 });
    const first = await value.resource(request);
    await expect(value.resource(request)).rejects.toMatchObject({ statusCode: 503 });
    await vi.advanceTimersByTimeAsync(100);
    expect(first.body.destroyed).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    const second = await value.resource(request);
    await value.closeAll();
    expect(second.body.destroyed).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    await expect(value.resource(request)).rejects.toMatchObject({ code: "shutdown" });
  });

  it("aborts pending callbacks at shutdown and closes their cooperative late bodies", async () => {
    const started = deferred<undefined>();
    const close = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    const value = registry((context) => new Promise<ServerPluginResourceResponse>((resolve) => {
      context.signal.addEventListener("abort", () => {
        resolve({ contentType: "text/plain", body: {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }), return: close }),
        } });
      }, { once: true });
      started.resolve(undefined);
    }));
    const pending = value.resource(request);
    const rejected = expect(pending).rejects.toMatchObject({ code: "shutdown" });
    await started.promise;
    await value.closeAll();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes iterators when response metadata is invalid", async () => {
    const close = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    const value = registry(() => ({ contentType: "bad", body: {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }), return: close }),
    } }));
    await expect(value.resource(request)).rejects.toMatchObject({ code: "invalid-result" });
    await value.closeAll();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports callback failures and skips callbacks for already-cancelled requests", async () => {
    const callback = vi.fn(() => { throw new Error("broken"); });
    const value = registry(callback);
    await expect(value.resource(request)).rejects.toMatchObject({ code: "request-failed" });
    const controller = new AbortController();
    controller.abort();
    await expect(value.resource(request, controller.signal)).rejects.toMatchObject({ code: "request-cancelled" });
    expect(callback).toHaveBeenCalledOnce();
  });
});
