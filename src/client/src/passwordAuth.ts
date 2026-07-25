/**
 * Password auth client for PI WEB
 *
 * Stores the bearer token in sessionStorage and provides helpers
 * to check auth status and attach credentials to requests.
 *
 * Gracefully handles environments where sessionStorage is unavailable
 * (e.g., test runners like vitest, SSR).
 */

const TOKEN_KEY = "pi-web-auth-token";

function hasStorage(): boolean {
  try {
    return typeof sessionStorage !== "undefined";
  } catch {
    return false;
  }
}

export function storedToken(): string | null {
  if (!hasStorage()) return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  if (!hasStorage()) return;
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (!hasStorage()) return;
  sessionStorage.removeItem(TOKEN_KEY);
}
