import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { LogEntry } from "../src/browser/protocol.js";
import { logScope, LogStore } from "../src/store.js";

it("rejects symlinked records and replaces the link without modifying its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "captains-log-store-"));
  try {
    const store = new LogStore(root);
    const scope = logScope("project", "workspace");
    const record: LogEntry = {
      id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-09-01", sessionId: "session",
      question: "Retell", status: "completed", stages: [], text: "Original",
    };
    await store.save(scope, record);
    expect(await store.read(scope, record.id)).toEqual(record);
    const target = join(root, "outside.json");
    const path = join(root, scope, `${record.id}.json`);
    await writeFile(target, JSON.stringify(record));
    await rm(path);
    await symlink(target, path);
    await expect(store.read(scope, record.id)).rejects.toThrow("Invalid captain file");
    await expect(store.list(scope)).rejects.toThrow("Invalid captain file");
    await store.save(scope, { ...record, text: "Replacement" });
    expect(await store.read(scope, record.id)).toMatchObject({ text: "Replacement" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
