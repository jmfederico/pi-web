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
}

export interface MachineClient {
  request(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineHttpResponse>;
  requestJson(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineJsonResponse>;
  connectWebSocket(path: string): WebSocket;
}

export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_REMOTE_HEALTH_TIMEOUT_MS = 3_000;

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
    const response = await this.fetchResponse(method, path, body, options);
    return {
      statusCode: response.status,
      headers: headersToRecord(response.headers),
      ...(response.body === null ? {} : { body: readableFromWebResponseBody(response.body) }),
    };
  }

  async requestJson(method: string, path: string, body?: unknown, options: MachineRequestOptions = {}): Promise<MachineJsonResponse> {
    const response = await this.fetchResponse(method, path, body, options);
    const text = await response.text();
    const parsed: unknown = text === "" ? undefined : JSON.parse(text);
    return {
      statusCode: response.status,
      headers: headersToRecord(response.headers),
      body: parsed,
    };
  }

  connectWebSocket(path: string): WebSocket {
    const url = this.remoteUrl(path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url, { headers: this.remoteHeaders() });
  }

  private async fetchResponse(method: string, path: string, body: unknown, options: MachineRequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, options.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS);
    try {
      const init: RequestInit = {
        method,
        headers: this.requestHeaders(body),
        signal: controller.signal,
        redirect: "manual",
      };
      if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = JSON.stringify(body);
      return await this.fetchImpl(this.remoteUrl(path), init);
    } catch (error) {
      if (isAbortError(error)) throw new RemoteMachineRequestError("Remote machine request timed out", 504);
      throw new RemoteMachineRequestError(error instanceof Error ? error.message : String(error), 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  private requestHeaders(body: unknown): HeadersInit {
    return {
      ...this.remoteHeaders(),
      accept: "*/*",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    };
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

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function readableFromWebResponseBody(body: Response["body"]): NodeJS.ReadableStream {
  if (body === null) throw new Error("Response body is not readable");
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Node fetch returns a web stream that is runtime-compatible with Readable.fromWeb, but DOM and node:stream/web types are not structurally identical in this TS config.
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
