/**
 * Line-level parsing and branch derivation shared by the readers of Pi
 * session files: the summary scanner, the header reader, and the transcript
 * snapshot gateway. All follow the SDK's rule that a session file is a
 * stream of JSON object entries, one per line, where an unparseable line is
 * skipped rather than fatal.
 */

/**
 * The entry a session-file line carries, or undefined when the line is blank,
 * not JSON, or not a JSON object. Scalars are not entries: the SDK's readers
 * index into the parsed value, so only objects can be classified.
 */
export function tryParseEntry(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `value` can be indexed by key, i.e. a non-null object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The active branch of a session file's entries, oldest first: the walk from
 * the last id-bearing entry through `parentId` links. Mirrors the SDK's
 * `_buildIndex`, which resumes a session at its newest entry, so a file's
 * active branch is the one ending at its last entry — not simply its file
 * order, which abandoned tree branches also occupy. A window that starts
 * mid-file can cut the walk short: the result is then the tail suffix of the
 * full branch. Headers are not entries, so a `session` record is skipped.
 */
export function deriveActiveBranchEntries(entries: readonly unknown[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  let leafId: string | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry["type"] === "session") continue;
    const id = entry["id"];
    if (typeof id !== "string") continue;
    byId.set(id, entry);
    leafId = id;
  }
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let currentId = leafId;
  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    const entry = byId.get(currentId);
    if (entry === undefined) break;
    branch.push(entry);
    currentId = typeof entry["parentId"] === "string" ? entry["parentId"] : undefined;
  }
  return branch.reverse();
}
