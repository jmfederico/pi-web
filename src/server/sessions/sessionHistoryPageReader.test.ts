import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pageHostedSessionHistory, readSessionHistoryPage } from "./sessionHistoryPageReader.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("streamed session history pages", () => {
  it("pages an already-hosted parent-linked branch without calling getBranch", () => {
    const entries = new Map([
      ["u1", { type: "message", id: "u1", message: { role: "user", content: "first" } }],
      ["a1", { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer one" } }],
      ["u2", { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "second" } }],
      ["t2", { type: "thinking_level_change", id: "t2", parentId: "u2", thinkingLevel: "high" }],
      ["a2", { type: "message", id: "a2", parentId: "t2", message: { role: "assistant", content: "answer two" } }],
    ]);
    const getEntry = (id: string) => entries.get(id);
    const result = pageHostedSessionHistory({ getLeafId: () => "a2", getEntry }, { before: 4, limit: 1, maxBytes: 1024 });

    expect(result).toEqual({
      messages: [
        { role: "user", content: "second", entryId: "u2" },
        { role: "assistant", content: "answer two", thinkingLevel: "high", entryId: "a2" },
      ],
      start: 2,
      total: 4,
    });
  });

  it("reads the active parent-linked branch and preserves projection and safe turn boundaries", async () => {
    const path = await transcript([
      { type: "session", id: "header", cwd: "/workspace" },
      { type: "message", id: "u1", message: { role: "user", content: "first" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "first answer" } },
      { type: "message", id: "u2", parentId: "u1", message: { role: "user", content: "abandoned branch" } },
      { type: "message", id: "u2a", parentId: "u2", message: { role: "assistant", content: "abandoned answer" } },
      { type: "message", id: "u3", parentId: "a1", message: { role: "user", content: "active branch" } },
      { type: "thinking_level_change", id: "t1", parentId: "u3", thinkingLevel: "high" },
      { type: "message", id: "a3", parentId: "t1", message: { role: "assistant", thinkingLevel: "low", content: "answer" } },
      { type: "custom_message", id: "c1", parentId: "a3", display: true, content: "notice", customType: "notice" },
      { type: "compaction", id: "cm", parentId: "c1", summary: "compact" },
      { type: "branch_summary", id: "bs", parentId: "cm", summary: "branch" },
      { type: "message", id: "u4", parentId: "bs", message: { role: "user", content: "next turn" } },
      { type: "message", id: "a4", parentId: "u4", message: { role: "assistant", content: "next answer" } },
    ]);
    const before = createHash("sha256").update(await readFile(path)).digest("hex");
    const file = await open(path, "r");
    const result = await readSessionHistoryPage(file, { before: 7, limit: 1 });
    await file.close();

    expect(result).toEqual({
      messages: [
        { role: "user", content: "active branch", entryId: "u3" },
        { role: "assistant", thinkingLevel: "low", content: "answer", entryId: "a3" },
        { role: "custom", content: "notice", customType: "notice", details: undefined, entryId: "c1" },
        { role: "system", source: "compaction", content: "Compacted history:\n\ncompact", entryId: "cm" },
        { role: "system", source: "branch_summary", content: "Branch summary:\n\nbranch", entryId: "bs" },
      ],
      start: 2,
      total: 9,
    });
    expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(before);
  });

  it("defaults to the latest bounded page without loading the whole transcript into the result", async () => {
    const entries = Array.from({ length: 201 }, (_, index) => ({
      type: "message", id: `m${String(index)}`, ...(index === 0 ? {} : { parentId: `m${String(index - 1)}` }),
      message: { role: "user", content: `message ${String(index)}` },
    }));
    const path = await transcript(entries);
    const file = await open(path, "r");
    const result = await readSessionHistoryPage(file);
    await file.close();

    expect(result.total).toBe(201);
    expect(result.start).toBe(101);
    expect(result.messages).toHaveLength(100);
    expect(result.messages[0]).toMatchObject({ entryId: "m101" });
    expect(result.messages.at(-1)).toMatchObject({ entryId: "m200" });
  });

  it("fails closed on an entry exceeding the explicit line-size bound", async () => {
    const path = await transcript([{ type: "message", id: "large", message: { role: "user", content: "x".repeat(16 * 1024 * 1024) } }]);
    const file = await open(path, "r");
    await expect(readSessionHistoryPage(file)).rejects.toThrow("exceeds 16777216 bytes");
    await file.close();
  });

  it("aborts a cold transcript scan when its caller cancels", async () => {
    const path = await transcript([{ type: "message", id: "u1", message: { role: "user", content: "hello" } }]);
    const file = await open(path, "r");
    await expect(readSessionHistoryPage(file, undefined, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    await file.close();
  });

  it("keeps selected transcript reads under the byte response budget", async () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({
      type: "message", id: `m${String(index)}`, ...(index === 0 ? {} : { parentId: `m${String(index - 1)}` }),
      message: { role: index === 0 ? "user" : "assistant", content: "x".repeat(3 * 1024 * 1024) },
    }));
    const path = await transcript(entries);
    const file = await open(path, "r");
    await expect(readSessionHistoryPage(file, { limit: 3, maxBytes: 8 * 1024 * 1024 })).rejects.toThrow("exceeds 8388608 bytes");
    await file.close();
  });
});

async function transcript(entries: readonly unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-history-page-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}
