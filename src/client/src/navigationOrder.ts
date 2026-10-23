/** Saved entries sort first; unknown items keep their existing default order. */
export function orderItems<T extends { id: string }>(items: readonly T[], savedIds: readonly string[]): T[] {
  const ranks = new Map<string, number>();
  for (const id of savedIds) if (!ranks.has(id)) ranks.set(id, ranks.size);
  return [...items].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}

/** Move a visible ID around its neighbor without pruning temporarily hidden entries.
 * visibleIds must be in the current displayed order (including default-order newcomers).
 */
export function moveOrderedId(
  savedIds: readonly string[], visibleIds: readonly string[], id: string,
  neighborId: string, placement: "before" | "after",
): string[] {
  const full = [...new Set([...savedIds, ...visibleIds])];
  if (id === neighborId || !visibleIds.includes(id) || !visibleIds.includes(neighborId)) return full;
  const remaining = full.filter((candidate) => candidate !== id);
  const index = remaining.indexOf(neighborId);
  remaining.splice(index + (placement === "after" ? 1 : 0), 0, id);
  return remaining;
}
