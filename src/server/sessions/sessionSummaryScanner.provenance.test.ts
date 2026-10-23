import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionSummaryScanner } from "./sessionSummaryScanner.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const line = (value: unknown) => JSON.stringify(value) + "\n";
const header = (id: string, parentSession?: string) => ({ type: "session", version: 3, id, cwd: "/workspace", timestamp: "2026-01-01T00:00:00.000Z", ...(parentSession === undefined ? {} : { parentSession }) });
const marker = (id: string) => ({ type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent", spawnedSessionId: id } });
const link = (id: string, path: string) => ({ type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent", spawnedSessionId: id, spawnedSessionFile: path } });

it("classifies only exact reciprocal tracked children on cold and memoized listings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-provenance-"));
  dirs.push(dir);
  const children = join(dir, "children");
  await mkdir(children);
  const parent = join(dir, "parent.jsonl"); // outside the listed directory
  const child = join(children, "child.jsonl");
  await writeFile(parent, line(header("parent")) + line(link("child", child)));
  await writeFile(child, line(header("child", parent)) + line(marker("child")));
  await writeFile(join(children, "clone.jsonl"), line(header("child", parent)) + line(marker("child")));
  await writeFile(join(children, "fork.jsonl"), line(header("fork", parent)) + line(marker("child")));
  await writeFile(join(children, "user.jsonl"), line(header("user", parent)));
  await writeFile(join(children, "unknown.jsonl"), line(header("unknown", parent)) + line(marker("unknown")));
  const scanner = new SessionSummaryScanner();
  for (let pass = 0; pass < 2; pass++) {
    const sessions = await scanner.scanSessionSummariesInDir(children);
    expect(sessions.filter((session) => session.agentSubsession === true).map((session) => session.path)).toEqual([child]);
    for (const session of sessions.filter((session) => session.path !== child)) expect(session).not.toHaveProperty("agentSubsession");
  }
  // Updating only the parent must refresh the child's classification.
  await appendFile(parent, line(link("unknown", join(children, "unknown.jsonl"))));
  expect((await scanner.scanSessionSummariesInDir(children)).find((session) => session.id === "unknown")?.agentSubsession).toBe(true);
  await writeFile(child, line(header("child")) + line(marker("child")));
  scanner.invalidate(child);
  expect((await scanner.scanSessionSummariesInDir(children)).find((session) => session.path === child)).not.toHaveProperty("agentSubsession");
  await writeFile(parent, line(header("different-parent")) + line(link("unknown", join(children, "unknown.jsonl"))));
  expect((await scanner.scanSessionSummariesInDir(children)).every((session) => session.agentSubsession === undefined)).toBe(true);
});
