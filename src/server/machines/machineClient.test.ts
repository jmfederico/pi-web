import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { withGatewayRequestId } from "../../sessiond/gatewayRequestContext.js";
import { RemoteMachineClient } from "./machineClient.js";

describe("RemoteMachineClient", () => {
  it("forwards raw binary request bodies with the provided content type", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await withGatewayRequestId(randomUUID(), () => client.request("PUT", "/api/projects/p1/workspaces/w1/file?path=image.png", payload, { contentType: "image/png" }));

    const { input, init } = onlyFetchCall(fetchImpl);
    expect(fetchInputUrl(input)).toBe("https://remote.example.test/api/projects/p1/workspaces/w1/file?path=image.png");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("content-type")).toBe("image/png");
    expect(new Headers(init.headers).has("x-request-id")).toBe(false);
    if (!(init.body instanceof ArrayBuffer)) throw new Error("Expected binary request body");
    expect(Array.from(new Uint8Array(init.body))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serializes structured request bodies as JSON by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/base/", token: "secret" }, fetchImpl);

    await client.request("POST", "/api/sessions", { cwd: "/repo" });

    const { input, init } = onlyFetchCall(fetchImpl);
    expect(fetchInputUrl(input)).toBe("https://remote.example.test/base/api/sessions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ cwd: "/repo" }));
  });

  it("propagates caller cancellation into the remote fetch", async () => {
    let fetchSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      fetchSignal = init?.signal;
      return new Promise<Response>((_resolve, rejectPromise) => {
        init?.signal?.addEventListener("abort", () => {
          const reason: unknown = init.signal?.reason;
          rejectPromise(reason instanceof Error ? reason : new DOMException("Cancelled", "AbortError"));
        }, { once: true });
      });
    });
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);
    const controller = new AbortController();

    const pending = client.request("DELETE", "/api/projects/p1/workspaces/w1", { precondition: "v1.confirmed" }, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const expectation = expect(pending).rejects.toMatchObject({
      statusCode: 502,
      message: "Remote machine request cancelled",
    });
    controller.abort(new DOMException("Gateway request cancelled", "AbortError"));
    await expectation;

    expect(fetchSignal?.aborted).toBe(true);
  });

  it.each(["deadline", "caller cancellation"] as const)("bounds a stalled JSON body through %s after headers arrive", async (stop) => {
    let bodyReadStarted!: () => void;
    const bodyReading = new Promise<void>((resolve) => { bodyReadStarted = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"name":');
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
    const controller = new AbortController();
    const client = new RemoteMachineClient({ baseUrl: `http://127.0.0.1:${String(address.port)}` }, async (input, init) => {
      const response = await fetch(input, init);
      const readText = response.text.bind(response);
      vi.spyOn(response, "text").mockImplementation(() => { bodyReadStarted(); return readText(); });
      return response;
    });
    try {
      const pending = client.requestJson("GET", "/identity", undefined, { timeoutMs: stop === "deadline" ? 100 : 30_000, signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({
        statusCode: stop === "deadline" ? 504 : 502,
        message: stop === "deadline" ? "Remote machine request timed out" : "Remote machine request cancelled",
      });
      await bodyReading;
      if (stop === "caller cancellation") controller.abort();
      await rejected;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error); }); });
    }
  });

  it.each(["deadline", "caller cancellation"] as const)("retains resource cancellation through body close: %s", async (stop) => {
    vi.useFakeTimers();
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0xff])); } });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(source)));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);
    const controller = new AbortController();
    try {
      const response = await client.request("GET", "/resource", undefined, { signal: controller.signal, streamLifetimeMs: 1000, timeoutMs: 10, range: "bytes=0-" });
      const body = response.body;
      if (body === undefined) throw new Error("Missing body");
      const failed = new Promise<Error>((resolve) => { body.once("error", resolve); });
      expect(new Headers(onlyFetchCall(fetchImpl).init.headers).get("range")).toBe("bytes=0-");
      expect(new Headers(onlyFetchCall(fetchImpl).init.headers).get("accept-encoding")).toBe("identity");
      await vi.advanceTimersByTimeAsync(20);
      expect(onlyFetchCall(fetchImpl).init.signal?.aborted).toBe(false);
      if (stop === "caller cancellation") controller.abort();
      else await vi.advanceTimersByTimeAsync(1000);
      expect(await failed).toBeInstanceOf(Error);
      expect(onlyFetchCall(fetchImpl).init.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("requests compression for the remote hop even when configured headers use different casing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({
      baseUrl: "https://remote.example.test/",
      headers: { "Accept-Encoding": "identity" },
    }, fetchImpl);

    await client.request("GET", "/api/projects");

    const { init } = onlyFetchCall(fetchImpl);
    expect(new Headers(init.headers).get("accept-encoding")).toBe("gzip, deflate");
  });

  it("removes stale representation headers after Fetch decodes a compressed response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "31",
      },
    })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);

    const response = await client.requestJson("GET", "/api/projects");

    expect(response.body).toEqual({ ok: true });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
  });
});

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function onlyFetchCall(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): { input: RequestInfo | URL; init: RequestInit } {
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const call = fetchImpl.mock.calls[0];
  if (call === undefined) throw new Error("Expected fetch call");
  const [input, init] = call;
  if (init === undefined) throw new Error("Expected fetch init");
  return { input, init };
}
