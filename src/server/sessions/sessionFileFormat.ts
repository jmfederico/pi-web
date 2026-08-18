/**
 * Line-level parsing shared by the two readers of Pi session files: the
 * summary scanner and the header reader. Both follow the SDK's rule that a
 * session file is a stream of JSON object entries, one per line, where an
 * unparseable line is skipped rather than fatal.
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
