/**
 * Cheap, stable, order-sensitive fingerprint of source text, used to detect
 * when the content under a pending comment has changed (staleness). FNV-1a
 * 32-bit; not cryptographic.
 */
export function hashSource(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
