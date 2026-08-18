import { open, type FileHandle } from "node:fs/promises";
import { tryParseEntry } from "./sessionFileFormat.js";

/** Chunk size for streaming a session file's header region. */
const HEADER_READ_CHUNK_BYTES = 8192;

/**
 * How far to look for the first parseable line. Headers are single-line and
 * written at creation; the bound keeps a pathological file with a huge
 * non-header prefix from dragging the listing and open paths.
 */
const HEADER_READ_CAP_BYTES = 262144;

const NEWLINE = 0x0a; // `\n`
const CARRIAGE_RETURN = 0x0d; // `\r`

/**
 * The header fields PI WEB reads directly from a Pi session file.
 *
 * Pi writes this as the first line of the `.jsonl` session file when the
 * session is created and never rewrites it, except for `parentSession`, which
 * PI WEB itself can clear when detaching a child. `cwd` and `id` are therefore
 * safe to treat as immutable for a given path.
 */
export interface SessionHeaderSummary {
  id: string;
  /** Working directory the session was started in. Absent in very old session files. */
  cwd?: string;
  /** Session file of the parent session, when this session was spawned or forked from one. */
  parentSession?: string;
}

/** Reads a session file header; injected so lookups can replace or observe their header reads. */
export type SessionHeaderReader = (sessionFile: string) => Promise<SessionHeaderSummary | undefined>;

/**
 * Read a Pi session file's header without loading the whole transcript.
 *
 * Streams the file in chunks and stops at the first parseable line, mirroring
 * the SDK rule the summary scanner follows: unparseable lines are skipped
 * until one parses, and a parseable non-session entry disqualifies the file.
 * The search is bounded to the header region; if no parseable line completes
 * within the bound, the file is treated as headerless.
 *
 * Returns undefined for any unreadable file or file without a usable session
 * header: callers use this to verify links between sessions, so an unusable
 * header must behave the same as a missing one rather than throwing.
 */
export async function readSessionHeaderSummary(sessionFile: string): Promise<SessionHeaderSummary | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(sessionFile, "r");
    return await streamHeaderSummary(file);
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function streamHeaderSummary(file: FileHandle): Promise<SessionHeaderSummary | undefined> {
  let pending = Buffer.alloc(0); // bytes of the current line, not yet newline-terminated
  let position = 0;
  for (;;) {
    const chunk = Buffer.alloc(HEADER_READ_CHUNK_BYTES);
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) {
      // End of file: an unterminated tail is the final line (readline parity).
      const outcome = classifyHeaderLine(pending);
      return outcome === "skip" ? undefined : outcome;
    }
    position += bytesRead;
    let chunkStart = 0;
    for (;;) {
      const newlineAt = chunk.indexOf(NEWLINE, chunkStart);
      if (newlineAt === -1) {
        pending = Buffer.concat([pending, chunk.subarray(chunkStart, bytesRead)]);
        break;
      }
      const line = Buffer.concat([pending, chunk.subarray(chunkStart, newlineAt)]);
      const outcome = classifyHeaderLine(line);
      if (outcome !== "skip") return outcome;
      pending = Buffer.alloc(0);
      chunkStart = newlineAt + 1;
    }
    // Bounded search: once the cap is consumed, leave the unterminated tail
    // unclassified and report no header rather than reading without limit.
    if (position >= HEADER_READ_CAP_BYTES) return undefined;
  }
}

/**
 * Classify one candidate line, mirroring the SDK's first-parseable-entry rule
 * that the summary scanner applies: unparseable lines are skipped until one
 * parses, and the first parseable line decides the file's fate. Returns
 * "skip" to keep looking, undefined to reject, or the parsed header.
 */
function classifyHeaderLine(lineBytes: Buffer): SessionHeaderSummary | undefined | "skip" {
  // Readline parity: a CRLF file yields lines without their trailing `\r`.
  let end = lineBytes.length;
  if (end > 0 && lineBytes[end - 1] === CARRIAGE_RETURN) end -= 1;
  const entry = tryParseEntry(lineBytes.toString("utf8", 0, end));
  if (entry === undefined) return "skip";
  if (entry["type"] !== "session") return undefined;
  const id = entry["id"];
  // The scanner skips headers without a usable id; the reader must agree so a
  // link verified here can never point at an unusable session.
  if (typeof id !== "string" || id === "") return undefined;
  const cwd = nonEmptyStringField(entry, "cwd");
  const parentSession = nonEmptyStringField(entry, "parentSession");
  return {
    id,
    ...(cwd === undefined ? {} : { cwd }),
    ...(parentSession === undefined ? {} : { parentSession }),
  };
}

function nonEmptyStringField(header: Record<string, unknown>, key: string): string | undefined {
  const value = header[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
