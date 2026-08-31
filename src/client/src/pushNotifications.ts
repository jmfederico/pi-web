/**
 * Decode a base64url-encoded VAPID application server key for `pushManager.subscribe`.
 * Kept pure (global atob only) so it is unit-testable in the node environment.
 */
export function vapidKeyFromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob !== "function") throw new Error("Base64 decoding is unavailable in this environment");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
