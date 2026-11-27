import { resolveAppUrl } from "../appUrl";

/** A response-backed API failure, retaining the status needed at an ownership boundary. */
export class HttpRequestError extends Error {
  override name = "HttpRequestError";

  constructor(message: string, readonly status: number, options: ErrorOptions = {}) {
    super(message, options);
  }
}

/** A browser transport failure, distinct from HTTP, cancellation, and parsing failures. */
export class NetworkRequestError extends Error {
  override name = "NetworkRequestError";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
  }
}

export interface RequestOptions extends RequestInit {
  /** Opt-in transport deadline, including response body reads. No retries. */
  timeoutMs?: number;
}

export async function request<T>(url: string, parse: (value: unknown) => T, options?: RequestOptions): Promise<T> {
  const { timeoutMs, ...init } = options ?? {};
  const controller = timeoutMs === undefined ? undefined : new AbortController();
  const signal = controller?.signal ?? init.signal ?? undefined;
  const abort = () => controller?.abort(init.signal?.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const requestUrl = resolveAppUrl(url);
  let body: unknown;
  try {
    if (controller !== undefined && timeoutMs !== undefined) {
      if (init.signal?.aborted === true) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        controller.abort(new NetworkRequestError(`Request timed out after ${String(timeoutMs)}ms: ${url}`));
      }, timeoutMs);
    }
    signal?.throwIfAborted();
    const transport = (async () => {
      const response = await fetch(requestUrl, { ...init, headers, ...(signal === undefined ? {} : { signal }) });
      if (!response.ok) {
        const errorBody: unknown = await response.json().catch((): unknown => ({}));
        throw new HttpRequestError(errorMessage(errorBody) ?? response.statusText, response.status);
      }
      const body: unknown = await response.json();
      return body;
    })();
    // Racing also bounds transports that do not promptly settle after abort.
    body = signal === undefined ? await transport : await Promise.race([
      transport,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          // AbortSignal reasons may be arbitrary caller-provided values.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    if (error instanceof TypeError && error.name !== "AbortError") {
      throw new NetworkRequestError(error.message, { cause: error });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
  // Parser TypeErrors are not transport failures and must never become retryable.
  return parse(body);
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["error"] === "string" ? value["error"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
