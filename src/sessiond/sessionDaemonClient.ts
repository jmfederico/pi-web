import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import { WebSocket } from "ws";
import { isHostAbsoluteAgentDir } from "../config.js";
import type { ActiveAgentProfileDescriptor } from "../shared/apiTypes.js";
import { parsePiWebRuntimeComponent } from "../shared/piWebStatusParsing.js";
import { sessiondHttpUrl, sessiondSocketPath } from "./config.js";
import { daemonRequestIdHeaders } from "./gatewayRequestContext.js";

export type SessionDaemonAgentProfileResult =
  | { status: "available"; profile: ActiveAgentProfileDescriptor }
  | { status: "unavailable"; error: string }
  | { status: "invalid"; error: string };

export interface SessionDaemonClientOptions {
  baseUrl?: string;
  /** An explicit socket suppresses the inherited client URL unless baseUrl is also supplied. */
  socketPath?: string;
}

export interface SessionDaemonRequestOptions {
  signal?: AbortSignal;
  /** Selected stream request headers only; never arbitrary browser headers. */
  headers?: { range?: string };
  timeoutMs?: number;
}

export interface SessionDaemonStreamResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Readable;
}

export interface SessionDaemonRequestClient {
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: SessionDaemonRequestOptions,
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
}

export class SessionDaemonClient {
  private readonly baseUrl: string | undefined;
  private readonly socketPath: string;

  constructor(options: SessionDaemonClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? (options.socketPath === undefined ? sessiondHttpUrl() : undefined);
    this.socketPath = options.socketPath ?? sessiondSocketPath();
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options: SessionDaemonRequestOptions = {},
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (this.baseUrl !== undefined && this.baseUrl !== "") {
      return this.requestUrl(method, daemonUrl(path, this.baseUrl), payload, options.signal);
    }
    return this.requestSocket(method, path, payload, options.signal);
  }

  /** Stream binary resources without UTF-8 decoding or buffering the response. */
  requestStream(path: string, options: SessionDaemonRequestOptions = {}): Promise<SessionDaemonStreamResponse> {
    const range = options.headers?.range;
    if (range !== undefined && (range.length > 256 || /[\r\n]/u.test(range))) return Promise.reject(new Error("Invalid resource Range header"));
    return new Promise((resolve, reject) => {
      const onResponse = (response: http.IncomingMessage): void => {
        clearTimeout(headerTimeout);
        resolve({
          statusCode: response.statusCode ?? 500,
          headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
          body: response,
        });
      };
      const requestOptions: http.RequestOptions = {
        method: "GET",
        headers: { ...daemonRequestIdHeaders(), "accept-encoding": "identity", ...(range === undefined ? {} : { range }) },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      const url = this.baseUrl === undefined || this.baseUrl === "" ? undefined : daemonUrl(path, this.baseUrl);
      const request = url === undefined
        ? http.request({ ...requestOptions, socketPath: this.socketPath, path }, onResponse)
        : (url.protocol === "https:" ? https : http).request(url, requestOptions, onResponse);
      request.on("error", (error) => { clearTimeout(headerTimeout); reject(error); });
      const headerTimeout = setTimeout(() => { request.destroy(new DOMException("Session daemon resource headers timed out", "TimeoutError")); }, options.timeoutMs ?? 30_000);
      headerTimeout.unref();
      request.end();
    });
  }

  getActiveAgentProfile(): Promise<SessionDaemonAgentProfileResult> {
    return getSessionDaemonActiveAgentProfile(this);
  }

  connectWebSocket(path: string, options: { maxPayload?: number } = {}): WebSocket {
    const wsOptions = {
      ...(options.maxPayload === undefined ? {} : { maxPayload: options.maxPayload }),
      headers: daemonRequestIdHeaders(),
    };
    if (this.baseUrl !== undefined && this.baseUrl !== "") {
      const url = daemonUrl(path, this.baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url, wsOptions);
    }
    // Resolve path segments separately so they cannot change the socket portion of a ws+unix URL.
    const url = daemonUrl(path, "http://localhost");
    return new WebSocket(`ws+unix:${this.socketPath}:${url.pathname}${url.search}`, wsOptions);
  }

  private async requestUrl(method: string, url: URL, payload?: string, signal?: AbortSignal) {
    const headers = daemonRequestIdHeaders();
    const init: RequestInit = { method, ...(signal === undefined ? {} : { signal }) };
    // Fetch preserves custom headers across redirects. Never send the ID to a second hop.
    if (headers !== undefined) {
      init.headers = headers;
      init.redirect = "manual";
    }
    if (payload !== undefined && payload !== "") {
      init.headers = { ...headers, "content-type": "application/json" };
      init.body = payload;
    }
    const response = await fetch(url, init);
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  }

  private requestSocket(method: string, path: string, payload?: string, signal?: AbortSignal): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          ...(signal === undefined ? {} : { signal }),
          headers: {
            ...daemonRequestIdHeaders(),
            ...(payload === undefined || payload === "" ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          },
        },
        (response) => {
          const chunks: Uint8Array[] = [];
          response.on("error", reject);
          response.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode ?? 500,
              headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.on("error", reject);
      if (payload !== undefined && payload !== "") request.write(payload);
      request.end();
    });
  }
}

function daemonUrl(path: string, baseUrl: string): URL {
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== base.origin) {
    throw new Error("Session daemon path must resolve to the configured daemon origin");
  }
  return url;
}

export async function getSessionDaemonActiveAgentProfile(client: SessionDaemonRequestClient): Promise<SessionDaemonAgentProfileResult> {
  let response: Awaited<ReturnType<SessionDaemonRequestClient["request"]>>;
  try {
    response = await client.request("GET", "/runtime");
  } catch (error) {
    return { status: "unavailable", error: errorMessage(error) };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { status: "unavailable", error: `session daemon runtime request returned HTTP ${String(response.statusCode)}` };
  }

  let value: unknown;
  try {
    value = response.body === "" ? undefined : JSON.parse(response.body);
  } catch {
    return { status: "invalid", error: "session daemon runtime response was not valid JSON" };
  }

  const runtime = parsePiWebRuntimeComponent(value);
  if (runtime?.component !== "sessiond") {
    return { status: "invalid", error: "session daemon runtime response was invalid" };
  }
  if (runtime.activeAgentProfile === undefined) {
    return { status: "invalid", error: "session daemon runtime response did not include an active agent profile" };
  }
  if (!isHostAbsoluteAgentDir(runtime.activeAgentProfile.dir)) {
    return { status: "invalid", error: "session daemon active agent profile was not valid for this host" };
  }
  return { status: "available", profile: runtime.activeAgentProfile };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
