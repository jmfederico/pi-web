import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionHeaderSummary } from "./sessionFileHeader.js";

// Mirrors the private HEADER_READ_CAP_BYTES in sessionFileHeader.ts: how far
// the reader looks for the first parseable line.
const HEADER_READ_CAP_BYTES = 262144;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-session-header-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("readSessionHeaderSummary", () => {
  it("reads id, cwd, and parent session from a real session file header", async () => {
    const sessionFile = await sessionFileWithLines([
      { type: "session", version: 3, id: "child-id", cwd: "/srv/dev/pi-web-feature", parentSession: "/sessions/parent.jsonl" },
      { type: "model_change", id: "abc", parentId: null },
    ]);

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({
      id: "child-id",
      cwd: "/srv/dev/pi-web-feature",
      parentSession: "/sessions/parent.jsonl",
    });
  });

  it("omits absent and empty optional fields", async () => {
    const sessionFile = await sessionFileWithLines([{ type: "session", version: 3, id: "root-id", cwd: "" }]);

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({ id: "root-id" });
  });

  it("returns undefined for a missing file", async () => {
    expect(await readSessionHeaderSummary(join(tempDir, "absent.jsonl"))).toBeUndefined();
  });

  it("returns undefined when no line is valid JSON", async () => {
    const sessionFile = join(tempDir, "broken.jsonl");
    await writeFile(sessionFile, "not json\n", "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toBeUndefined();
  });

  it("returns undefined when the first parseable line is not a session header", async () => {
    const sessionFile = await sessionFileWithLines([{ type: "model_change", id: "abc" }]);

    expect(await readSessionHeaderSummary(sessionFile)).toBeUndefined();
  });

  it("returns undefined when the header carries no session id", async () => {
    const sessionFile = await sessionFileWithLines([{ type: "session", version: 3, cwd: "/srv/dev/pi-web" }]);

    expect(await readSessionHeaderSummary(sessionFile)).toBeUndefined();
  });

  it("returns undefined when the header id is an empty string", async () => {
    const sessionFile = await sessionFileWithLines([{ type: "session", version: 3, id: "", cwd: "/srv/dev/pi-web" }]);

    expect(await readSessionHeaderSummary(sessionFile)).toBeUndefined();
  });

  it("does not read beyond the header line of a large transcript", async () => {
    const sessionFile = join(tempDir, "large.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "big-id", cwd: "/srv/dev/pi-web" });
    const bulk = Array.from({ length: 500 }, (_unused, index) => JSON.stringify({ type: "message", id: String(index), text: "x".repeat(200) }));
    await writeFile(sessionFile, `${[header, ...bulk].join("\n")}\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({ id: "big-id", cwd: "/srv/dev/pi-web" });
  });

  it("reads a header longer than the old 4 KiB window (4,168-byte repro)", async () => {
    const { line, id, cwd } = paddedSessionHeader(4168);
    const sessionFile = join(tempDir, "long-header.jsonl");
    await writeFile(sessionFile, `${line}\n${JSON.stringify({ type: "message", id: "m1" })}\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({ id, cwd });
  });

  it("reads a header line that spans several read chunks", async () => {
    const { line, id, cwd } = paddedSessionHeader(20000);
    const sessionFile = join(tempDir, "multi-chunk-header.jsonl");
    await writeFile(sessionFile, `${line}\n${JSON.stringify({ type: "message", id: "m1" })}\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({ id, cwd });
  });

  it("skips garbage and blank lines before the header", async () => {
    const header = { type: "session", version: 3, id: "after-garbage", cwd: "/srv/dev/pi-web" };
    const sessionFile = join(tempDir, "garbage-prefix.jsonl");
    await writeFile(sessionFile, ["not json at all", "", "   ", JSON.stringify(header), ""].join("\n"), "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({ id: "after-garbage", cwd: "/srv/dev/pi-web" });
  });

  it("skips parseable non-object lines the way the scanner does", async () => {
    const header = { type: "session", version: 3, id: "after-scalars" };
    const sessionFile = join(tempDir, "scalar-prefix.jsonl");
    await writeFile(sessionFile, `42\n"just a string"\n${JSON.stringify(header)}\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({ id: "after-scalars" });
  });

  it("rejects a parseable JSON array before the header, like the scanner", async () => {
    const header = { type: "session", version: 3, id: "after-array" };
    const sessionFile = join(tempDir, "array-prefix.jsonl");
    await writeFile(sessionFile, `[1,2]\n${JSON.stringify(header)}\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toBeUndefined();
  });

  it("tolerates CRLF line endings before and on the header", async () => {
    const header = JSON.stringify({ type: "session", version: 3, id: "crlf-id" });
    const sessionFile = join(tempDir, "crlf.jsonl");
    await writeFile(sessionFile, `garbage\r\n\r\n${header}\r\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({ id: "crlf-id" });
  });

  it("rejects a file whose first parseable entry is a non-session line, even with a later session header", async () => {
    const sessionFile = await sessionFileWithLines([
      { type: "message", id: "m1" },
      { type: "session", version: 3, id: "too-late" },
    ]);

    expect(await readSessionHeaderSummary(sessionFile)).toBeUndefined();
  });

  it("gives up at the cap when only garbage precedes the header", async () => {
    const garbage = Array.from({ length: 300 }, (_unused, index) => garbageLineOfSize(1024, index));
    const { line } = paddedSessionHeader(200);
    const sessionFile = join(tempDir, "cap-garbage.jsonl");
    await writeFile(sessionFile, `${garbage.join("\n")}\n${line}\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toBeUndefined();
  });

  it("leaves a header unclassified when its line only completes past the cap", async () => {
    const garbage = garbageLineOfSize(HEADER_READ_CAP_BYTES - 100);
    const { line } = paddedSessionHeader(200);
    const sessionFile = join(tempDir, "cap-crossing.jsonl");
    await writeFile(sessionFile, `${garbage}\n${line}\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toBeUndefined();
  });

  it("still finds a header that completes just inside the cap", async () => {
    const garbage = garbageLineOfSize(HEADER_READ_CAP_BYTES - 400);
    const { line, id, cwd } = paddedSessionHeader(300);
    const sessionFile = join(tempDir, "cap-inside.jsonl");
    await writeFile(sessionFile, `${garbage}\n${line}\n`, "utf8");

    expect(await readSessionHeaderSummary(sessionFile)).toEqual({ id, cwd });
  });
});

async function sessionFileWithLines(lines: readonly Record<string, unknown>[]): Promise<string> {
  const sessionFile = join(tempDir, `session-${String(lines.length)}-${Math.random().toString(36).slice(2)}.jsonl`);
  await writeFile(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return sessionFile;
}

/** A one-line session header whose serialized form is exactly `totalBytes` long. */
function paddedSessionHeader(totalBytes: number): { line: string; id: string; cwd: string } {
  const id = "sized-header-id";
  const skeleton = { type: "session", version: 3, id, cwd: "" };
  const cwd = "0".repeat(totalBytes - JSON.stringify(skeleton).length);
  const line = JSON.stringify({ ...skeleton, cwd });
  if (line.length !== totalBytes) throw new Error(`padded header is ${String(line.length)} bytes, expected ${String(totalBytes)}`);
  return { line, id, cwd };
}

/** An unparseable line of exactly `totalBytes` bytes. */
function garbageLineOfSize(totalBytes: number, index = 0): string {
  const prefix = `garbage ${String(index)} `;
  return `${prefix}${"x".repeat(totalBytes - prefix.length)}`;
}
