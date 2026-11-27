import { Readable } from "node:stream";
import { WebSocket } from "ws";
import type { StoredMachine } from "./machineStore.js";

export interface MachineHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body?: NodeJS.ReadableStream;
}

export interface MachineJsonResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MachineRequestOptions {
  timeoutMs?: number;
  contentType?: string;
  signal?: AbortSignal;
  range?: string;
  /** Resource-only: retain caller cancellation and a deadline through body close. */
  streamLifetimeMs?: number;
}

export interface MachineClient {
  request(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineHttpResponse>;
  requestJson(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineJsonResponse>;
  connectWebSocket(path: string, options?: { maxPayload?: number }): WebSocket;
}

export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_REMOTE_HEALTH_TIMEOUT_MS = 3_000;

const REMOTE_RESPONSE_ACCEPT_ENCODING = "gzip, deflate";

const BLOCKED_CONFIGURED_HEADER_NAMES = new Set([
  "host",
  "connection",
  "upgrade",
  "transfer-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "authorization",
  "cookie",
]);

export class RemoteMachineRequestError extends Error {
  constructor(message: string, readonly statusCode: 502 | 504) {
    super(message);
    this.name = "RemoteMachineRequestError";
  }
}

export class RemoteMachineClient implements MachineClient {
  constructor(private readonly machine: Pick<StoredMachine, "baseUrl" | "token" | "headers">, private readonly fetchImpl: typeof fetch = fetch) {}

  async request(method: string, path: string, body?: unknown, options: MachineRequestOptions = {}): Promise<MachineHttpResponse> {
    return this.withResponse(method, path, body, options, (response, retain) => {
      const stream = response.body === null ? undefined : readableFromWebResponseBody(response.body);
      if (stream !== undefined && options.streamLifetimeMs !== undefined) retain(stream);
      return {
        statusCode: response.status,
        headers: decodedResponseHeaders(response.headers),
        ...(stream === undefined ? {} : { body: stream }),
      };
    });
  }

  async requestJson(method: string, path: string, body?: unknown, options: MachineRequestOptions = {}): Promise<MachineJsonResponse> {
    // Keep the deadline and caller cancellation attached until the entire JSON body is read.
    return this.withResponse(method, path, body, options, async (response) => {
      const text = await response.text();
      const parsed: unknown = text === "" ? undefined : JSON.parse(text);
      return { statusCode: response.status, headers: decodedResponseHeaders(response.headers), body: parsed };
    });
  }

  connectWebSocket(path: string, options: { maxPayload?: number } = {}): WebSocket {
    const url = this.remoteUrl(path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url, { headers: this.remoteHeaders(), ...options });
  }

  private async withResponse<T>(
    method: string, path: string, body: unknown, options: MachineRequestOptions,
    consume: (response: Response, retain: (stream: Readable) => void) => T | Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abortFromParent = (): void => {
      if (!controller.signal.aborted) controller.abort(abortReason(options.signal));
    };
    if (options.signal?.aborted === true) abortFromParent();
    else options.signal?.addEventListener("abort", abortFromParent, { once: true });

    const timeoutError = new RemoteMachineRequestError("Remote machine request timed out", 504);
    let timeout = setTimeout(() => { controller.abort(timeoutError); }, options.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS);
    timeout.unref();
    const lifetime = { retained: false };
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromParent);
    };
    const retain = (stream: Readable): void => {
      lifetime.retained = true;
      clearTimeout(timeout);
      timeout = setTimeout(() => { controller.abort(timeoutError); }, options.streamLifetimeMs);
      timeout.unref();
      const abortStream = (): void => { stream.destroy(abortReason(controller.signal)); };
      controller.signal.addEventListener("abort", abortStream, { once: true });
      stream.once("close", () => { cleanup(); controller.signal.removeEventListener("abort", abortStream); });
      if (controller.signal.aborted) abortStream();
    };
    try {
      const requestBody = serializeRequestBody(method, body);
      const init: RequestInit = {
        method,
        headers: this.requestHeaders(body, options),
        signal: controller.signal,
        redirect: "manual",
      };
      if (requestBody !== undefined) init.body = requestBody;
      const response = await this.fetchImpl(this.remoteUrl(path), init);
      return await consume(response, retain);
    } catch (error) {
      const reason: unknown = controller.signal.reason;
      if (reason instanceof RemoteMachineRequestError) throw reason;
      if (options.signal?.aborted === true || controller.signal.aborted || isAbortError(error)) {
        throw new RemoteMachineRequestError("Remote machine request cancelled", 502);
      }
      throw new RemoteMachineRequestError(error instanceof Error ? error.message : String(error), 502);
    } finally {
      if (!lifetime.retained) cleanup();
    }
  }

  private requestHeaders(body: unknown, options: MachineRequestOptions): Headers {
    const headers = new Headers(this.remoteHeaders());
    headers.set("accept", "*/*");
    headers.set("accept-encoding", options.streamLifetimeMs === undefined ? REMOTE_RESPONSE_ACCEPT_ENCODING : "identity");
    if (options.range !== undefined) {
      if (options.range.length > 256 || /[\r\n]/u.test(options.range)) throw new Error("Invalid resource Range header");
      headers.set("range", options.range);
    }
    if (body !== undefined) headers.set("content-type", options.contentType ?? defaultContentTypeForBody(body));
    return headers;
  }

  private remoteHeaders(): Record<string, string> {
    return {
      ...(this.machine.token === undefined || this.machine.token === "" ? {} : { authorization: `Bearer ${this.machine.token}` }),
      ...filterConfiguredHeaders(this.machine.headers),
    };
  }

  private remoteUrl(path: string): URL {
    const url = new URL(this.machine.baseUrl);
    const separator = path.indexOf("?");
    const rawPath = separator === -1 ? path : path.slice(0, separator);
    const rawQuery = separator === -1 ? "" : path.slice(separator + 1);
    const basePath = url.pathname.replace(/\/$/u, "");
    const nextPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    url.pathname = `${basePath}${nextPath}`;
    url.search = rawQuery === "" ? "" : `?${rawQuery}`;
    url.hash = "";
    return url;
  }
}

export function validateConfiguredMachineHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const name = key.trim();
    if (name === "") throw new Error("Machine header names must not be empty");
    if (typeof value !== "string") throw new Error("Machine headers must be strings");
    if (BLOCKED_CONFIGURED_HEADER_NAMES.has(name.toLowerCase())) throw new Error(`Machine header is not allowed: ${name}`);
    return [name, value];
  }));
}

function filterConfiguredHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !BLOCKED_CONFIGURED_HEADER_NAMES.has(key.toLowerCase())));
}

function decodedResponseHeaders(headers: Headers): Record<string, string> {
  const values: Record<string, string> = Object.fromEntries(headers.entries());
  const contentEncoding = values["content-encoding"];
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    // Fetch decodes response bodies but retains headers for the encoded wire
    // representation. The outer HTTP edge must negotiate and frame the decoded body.
    delete values["content-encoding"];
    delete values["content-length"];
  }
  return values;
}

function serializeRequestBody(method: string, body: unknown): NonNullable<RequestInit["body"]> | undefined {
  if (body === undefined || method === "GET" || method === "HEAD") return undefined;
  if (isRawRequestBody(body)) return body;
  if (ArrayBuffer.isView(body)) return copyArrayBufferView(body);
  const serialized: string = JSON.stringify(body);
  return serialized;
}

function defaultContentTypeForBody(body: unknown): string {
  return isRawRequestBody(body) || ArrayBuffer.isView(body) ? "application/octet-stream" : "application/json";
}

function isRawRequestBody(body: unknown): body is NonNullable<RequestInit["body"]> {
  return typeof body === "string"
    || body instanceof URLSearchParams
    || body instanceof Blob
    || body instanceof FormData
    || body instanceof ReadableStream
    || body instanceof ArrayBuffer;
}

function copyArrayBufferView(view: ArrayBufferView): ArrayBuffer {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function readableFromWebResponseBody(body: Response["body"]): Readable {
  if (body === null) throw new Error("Response body is not readable");
  // oxlint-disable-next-line typescript/consistent-type-assertions -- Node fetch returns a web stream that is runtime-compatible with Readable.fromWeb, but DOM and node:stream/web types are not structurally identical in this TS config.
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("Remote machine request cancelled", "AbortError");
}
