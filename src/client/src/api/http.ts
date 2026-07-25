import { resolveAppUrl } from "../appUrl";
import { storedToken, clearToken } from "../passwordAuth";

const AUTH_LOGIN_EVENT = "pi-web:auth-required";

/**
 * Emit a global event asking the app to show the password login overlay.
 * Called when the server responds 401 to any API request.
 */
export function dispatchAuthRequired(): void {
  clearToken();
  window.dispatchEvent(new CustomEvent(AUTH_LOGIN_EVENT));
}

export async function request<T>(url: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = storedToken();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(resolveAppUrl(url), { ...init, headers });
  if (response.status === 401) {
    // Only trigger the login overlay for API routes (not auth routes themselves)
    if (!url.startsWith("api/auth/")) dispatchAuthRequired();
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new Error(errorMessage(body) ?? response.statusText);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new Error(errorMessage(body) ?? response.statusText);
  }
  const body: unknown = await response.json();
  return parse(body);
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["error"] === "string" ? value["error"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
