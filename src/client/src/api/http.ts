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

export async function request<T>(url: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const requestUrl = resolveAppUrl(url);
  let body: unknown;
  try {
    const response = await fetch(requestUrl, { ...init, headers });
    if (!response.ok) {
      const errorBody: unknown = await response.json().catch((): unknown => ({}));
      throw new HttpRequestError(errorMessage(errorBody) ?? response.statusText, response.status);
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof TypeError && error.name !== "AbortError" && init?.signal?.aborted !== true) {
      throw new NetworkRequestError(error.message, { cause: error });
    }
    throw error;
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
