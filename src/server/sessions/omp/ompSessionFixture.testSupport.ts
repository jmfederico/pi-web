import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Builds fixture OMP session JSONL files (format v3: optional title-slot line,
 * `{"type":"session"}` header, then a parentId-linked entry chain) for
 * `OmpSessionStore` tests. Mirrors the real on-disk shape observed under
 * `~/.omp/agent/sessions/<project>/<timestamp>_<uuid>.jsonl`.
 * This writer intentionally does not
 * reproduce the real 256-byte fixed-width title-slot padding: that padding
 * only matters to a concurrent in-place rewriter, and `OmpSessionStore` is
 * read-only.
 */
export interface OmpFixtureTitleSlot {
  title: string;
  source?: "user";
}

export interface OmpFixtureSessionOptions {
  id: string;
  cwd: string;
  timestamp?: string;
  /**
   * Omit entirely to simulate a legacy pre-title-slot session file (header
   * line is the very first line). Pass a slot (possibly with an empty
   * `title`) to simulate a v3 file that always carries a title-slot line.
   */
  titleSlot?: OmpFixtureTitleSlot;
  /** Embedded header-line title — used alone for legacy fallback, or alongside a titleSlot to prove the slot takes precedence over a stale header title. */
  headerTitle?: string;
  entries?: Record<string, unknown>[];
}

function titleSlotLine(slot: OmpFixtureTitleSlot): string {
  const record: Record<string, unknown> = { type: "title", v: 1, title: slot.title, updatedAt: "2026-01-01T00:00:00.000Z", pad: "" };
  if (slot.source) record["source"] = slot.source;
  return JSON.stringify(record);
}

/** Renders fixture session file lines without touching disk. */
export function ompSessionFixtureLines(options: OmpFixtureSessionOptions): string[] {
  const lines: string[] = [];
  if (options.titleSlot) lines.push(titleSlotLine(options.titleSlot));
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: options.id,
    timestamp: options.timestamp ?? "2026-01-01T00:00:00.000Z",
    cwd: options.cwd,
  };
  if (options.headerTitle !== undefined) header["title"] = options.headerTitle;
  lines.push(JSON.stringify(header));
  for (const entry of options.entries ?? []) lines.push(JSON.stringify(entry));
  return lines;
}

/** Writes a fixture session file at `<sessionsRoot>/<projectDir>/<fileName>.jsonl`. */
export async function writeOmpSessionFile(
  sessionsRoot: string,
  projectDir: string,
  fileName: string,
  options: OmpFixtureSessionOptions,
): Promise<string> {
  const dir = join(sessionsRoot, projectDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName.endsWith(".jsonl") ? fileName : `${fileName}.jsonl`);
  await writeFile(path, `${ompSessionFixtureLines(options).join("\n")}\n`, "utf8");
  return path;
}

/**
 * Writes a fixture file one level deeper than real root sessions ever go —
 * `<sessionsRoot>/<projectDir>/<parentSessionDirName>/<fileName>.jsonl` — the
 * exact shape of a subagent transcript living inside its parent session's own
 * per-session artifact directory. Used to prove `list()`/`resolve()` do not
 * mistake a nested, independently-valid session header for a root session.
 */
export async function writeOmpNestedArtifactSessionFile(
  sessionsRoot: string,
  projectDir: string,
  parentSessionDirName: string,
  fileName: string,
  options: OmpFixtureSessionOptions,
): Promise<string> {
  const dir = join(sessionsRoot, projectDir, parentSessionDirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName.endsWith(".jsonl") ? fileName : `${fileName}.jsonl`);
  await writeFile(path, `${ompSessionFixtureLines(options).join("\n")}\n`, "utf8");
  return path;
}

export function ompMessageEntry(options: {
  id: string;
  parentId: string | null;
  role: string;
  content: unknown;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    type: "message",
    id: options.id,
    parentId: options.parentId,
    timestamp: options.timestamp ?? "2026-01-01T00:01:00.000Z",
    message: { role: options.role, content: options.content },
  };
}
