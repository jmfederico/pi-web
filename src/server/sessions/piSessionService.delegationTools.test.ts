import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiWebCustomToolDefinitions, sessionAllowsDelegationTools, type PiSessionManager } from "./piSessionService.js";
import type { SubsessionToolDeps } from "./spawnSubsessionTool.js";
import { fakeSessionManager } from "./piSessionService.testSupport.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function delegationDeps() {
  const spawn = vi.fn(() => Promise.resolve({ sessionId: "independent-1", cwd: "/workspace" }));
  const subsessionSpawn = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace" }));
  const subsessions: SubsessionToolDeps = {
    spawn: subsessionSpawn,
    list: vi.fn(() => Promise.resolve([])),
    check: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace", status: "idle" as const, finalText: "", messageCount: 0 })),
    read: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace", status: "idle" as const, entries: [], total: 0, matched: 0, start: 0, hasMore: false })),
  };
  return { spawn, subsessions, subsessionSpawn };
}

function toolNames(definitions: ReturnType<typeof createPiWebCustomToolDefinitions>): string[] {
  return definitions.map((definition) => definition.name);
}

function manager(id: string, file: string | undefined, entries: readonly unknown[] = []): PiSessionManager {
  return fakeSessionManager("/workspace", {
    getSessionId: () => id,
    getSessionFile: () => file,
    getEntries: () => entries,
  });
}

const dispatchModel = { provider: "anthropic", id: "claude-sonnet" };

function ctxFor(sessionId: string, sessionFile: string | undefined, model?: unknown): ExtensionContext {
  // The delegation tools only read sessionManager and model from the context.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tools read.
  return { sessionManager: manager(sessionId, sessionFile), ...(model === undefined ? {} : { model }) } as unknown as ExtensionContext;
}

function findTool(definitions: ReturnType<typeof createPiWebCustomToolDefinitions>, name: string) {
  const tool = definitions.find((definition) => definition.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("delegation tool capability boundary", () => {
  it("provides every globally enabled delegation tool to unrestricted sessions", () => {
    const { spawn, subsessions } = delegationDeps();

    expect(toolNames(createPiWebCustomToolDefinitions("/workspace", true, spawn, subsessions))).toEqual([
      "edit",
      "spawn_session",
      "spawn_subsession",
      "list_subsessions",
      "check_subsession",
      "read_subsession",
      "yield_to_subsessions",
    ]);
  });

  it("continues to honor global delegation feature flags for unrestricted sessions", () => {
    const { spawn } = delegationDeps();

    expect(toolNames(createPiWebCustomToolDefinitions("/workspace", true, spawn))).toEqual(["edit", "spawn_session"]);
    expect(toolNames(createPiWebCustomToolDefinitions("/workspace", true))).toEqual(["edit"]);
  });

  it("removes every delegation tool but retains ordinary tools for restricted tracked children", () => {
    const { spawn, subsessions } = delegationDeps();

    expect(toolNames(createPiWebCustomToolDefinitions("/workspace", false, spawn, subsessions))).toEqual(["edit"]);
  });

  it("wires the dispatching session identity, inherited model, and model spec into spawn_session", async () => {
    const { spawn, subsessions } = delegationDeps();
    const spawnTool = findTool(createPiWebCustomToolDefinitions("/workspace", true, spawn, subsessions), "spawn_session");

    await spawnTool.execute("call-1", { prompt: "go", model: "openai/gpt-5" }, undefined, undefined, ctxFor("spawner-7", "/sessions/spawner-7.jsonl", dispatchModel));

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/workspace",
      spawningSessionId: "spawner-7",
      prompt: "go",
      cwd: undefined,
      model: dispatchModel,
      modelSpec: "openai/gpt-5",
    });
  });

  it("wires the parent identity, inherited model, and model spec into spawn_subsession", async () => {
    const { spawn, subsessions, subsessionSpawn } = delegationDeps();
    const spawnTool = findTool(createPiWebCustomToolDefinitions("/workspace", true, spawn, subsessions), "spawn_subsession");

    await spawnTool.execute("call-2", { prompt: "go", model: "openai/gpt-5" }, undefined, undefined, ctxFor("parent-9", "/sessions/parent-9.jsonl", dispatchModel));

    expect(subsessionSpawn).toHaveBeenCalledWith({
      spawningCwd: "/workspace",
      parentSessionId: "parent-9",
      parentSessionFile: "/sessions/parent-9.jsonl",
      prompt: "go",
      model: dispatchModel,
      modelSpec: "openai/gpt-5",
    });
  });

  it.each(["human-created", "spawn_session-created"])("allows delegation for a %s session without tracked-child provenance", async () => {
    const sessionManager = manager("session-1", undefined);
    const open = vi.fn(() => { throw new Error("no parent session should be opened"); });

    await expect(sessionAllowsDelegationTools(sessionManager, { open })).resolves.toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("removes delegation when persisted records verify exact tracked-child provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-delegation-provenance-"));
    tempDirs.push(dir);
    const parentFile = join(dir, "parent.jsonl");
    const childFile = join(dir, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace", parentSession: parentFile })}\n`, "utf8");

    const childManager = manager("child-1", childFile, [
      { type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } },
    ]);
    const parentManager = manager("parent-1", parentFile, [
      { type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace" } },
    ]);

    await expect(sessionAllowsDelegationTools(childManager, { open: () => parentManager })).resolves.toBe(false);
  });

  it("does not treat a copied child marker as tracked provenance without an exact reciprocal file link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-delegation-copy-"));
    tempDirs.push(dir);
    const parentFile = join(dir, "parent.jsonl");
    const originalChildFile = join(dir, "original-child.jsonl");
    const copiedChildFile = join(dir, "copied-child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
    await writeFile(copiedChildFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace", parentSession: parentFile })}\n`, "utf8");

    const copiedChildManager = manager("child-1", copiedChildFile, [
      { type: "custom", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" } },
    ]);
    const parentManager = manager("parent-1", parentFile, [
      { type: "custom", customType: "pi-web.subsession.link", data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: originalChildFile, cwd: "/workspace" } },
    ]);

    await expect(sessionAllowsDelegationTools(copiedChildManager, { open: () => parentManager })).resolves.toBe(true);
  });
});
