import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiSessionManagerGateway, defaultPiSessionDir, defaultPiSessionsRoot, filterSessionsForCwd, SessionDirResolver } from "./piSessionManagerGateway.js";
import type { PiSessionListEntry } from "./piSessionService.js";
import type { PiSessionManager } from "./piSessionService.js";
import { sep } from "node:path";

let tempDir: string;
let agentDir: string;
let cwd: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-session-gateway-test-"));
  agentDir = join(tempDir, "agent");
  cwd = join(tempDir, "workspace");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SessionDirResolver", () => {
  it("uses Pi default session storage when no Pi override is configured", () => {
    const resolver = new SessionDirResolver({ agentDir, env: {} });

    expect(resolver.resolve(cwd)).toMatchObject({ source: "pi-default", sessionDir: defaultPiSessionDir(cwd, agentDir), usesConfiguredSessionDir: false });
    expect(defaultPiSessionsRoot(agentDir)).toBe(join(agentDir, "sessions"));
  });

  it("uses Pi sessionDir settings and resolves relative paths against the session cwd", async () => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: ".pi/sessions" }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver({ agentDir, env: {} });

    expect(resolver.resolve(cwd)).toMatchObject({ source: "settings", sessionDir: join(cwd, ".pi", "sessions"), usesConfiguredSessionDir: true });
  });

  it("lets project-local Pi sessionDir settings override global Pi settings for that cwd", async () => {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "global-sessions") }, null, 2)}\n`, "utf8");
    await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify({ sessionDir: ".workspace-sessions" }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver({ agentDir, env: {} });

    expect(resolver.resolve(cwd)).toMatchObject({ source: "settings", sessionDir: join(cwd, ".workspace-sessions"), usesConfiguredSessionDir: true });
  });

  it("lets the Pi sessionDir environment override Pi settings", async () => {
    const envDir = join(tempDir, "env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: envDir } });

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: envDir, usesConfiguredSessionDir: true });
  });

  it("uses OMP sessionDir environment overrides before settings", async () => {
    const envDir = join(tempDir, "omp-env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver({ agentDir, env: { OMP_CODING_AGENT_SESSION_DIR: envDir }, sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR", "OMP_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"] });

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: envDir, usesConfiguredSessionDir: true });
  });
});

describe("Pi session manager gateway", () => {
  it("lists legacy id-only sessions from the default Pi session store", async () => {
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-a", cwd);
    await writeSessionFile(defaultPiSessionDir(otherCwd, agentDir), "session-b", otherCwd);
    const gateway = createPiSessionManagerGateway({ agentDir, env: {} });

    if (gateway.listAll === undefined) throw new Error("Expected legacy listing support");
    await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "session-a", cwd }), expect.objectContaining({ id: "session-b", cwd: otherCwd })]));
  });

  it("includes an absolute env-configured session directory in global listing", async () => {
    const envSessionDir = join(tempDir, "env-sessions");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "default-session", cwd);
    await writeSessionFile(envSessionDir, "env-session", cwd);
    const gateway = createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: envSessionDir } });

    if (gateway.listAll === undefined) throw new Error("Expected legacy listing support");
    await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "default-session", cwd }), expect.objectContaining({ id: "env-session", cwd })]));
  });

  it("includes command-specific env session directories in global listing", async () => {
    for (const envKey of ["PI_WEB_AGENT_SESSION_DIR", "OMP_CODING_AGENT_SESSION_DIR"]) {
      const envSessionDir = join(tempDir, `${envKey.toLowerCase()}-sessions`);
      await writeSessionFile(envSessionDir, `${envKey.toLowerCase()}-session`, cwd);
      const gateway = createPiSessionManagerGateway({
        agentDir,
        env: { [envKey]: envSessionDir },
        sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR", "OMP_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"],
      });

      if (gateway.listAll === undefined) throw new Error("Expected legacy listing support");
      await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: `${envKey.toLowerCase()}-session`, cwd })]));
    }
  });

  it("lists only sessions for the requested cwd when a custom Pi sessionDir is shared", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(sharedSessionDir, "session-a", cwd);
    await writeSessionFile(sharedSessionDir, "session-b", otherCwd);
    const gateway = createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: sharedSessionDir } });

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-a", cwd }]);
    const created = gateway.create(cwd);
    expect(hasSessionDir(created)).toBe(true);
    if (!hasSessionDir(created)) throw new Error("Expected SDK session manager");
    expect(created.getSessionDir()).toBe(sharedSessionDir);
  });

  it("lists sessions for cwds that differ from the server process cwd", async () => {
    // Regression: SessionManager.list("", dir) filtered against process.cwd(),
    // hiding every session outside the daemon's own launch directory.
    expect(cwd).not.toBe(process.cwd());
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-elsewhere", cwd);
    const gateway = createPiSessionManagerGateway({ agentDir, env: {} });

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-elsewhere", cwd }]);
  });
});

describe("filterSessionsForCwd", () => {
  it("matches cwds that differ only by trailing separator or redundant segments", () => {
    const sessions = [sessionEntry("a", cwd)];

    expect(filterSessionsForCwd(sessions, `${cwd}${sep}`)).toHaveLength(1);
    expect(filterSessionsForCwd(sessions, join(cwd, "."))).toHaveLength(1);
  });

  it("excludes sessions with an empty cwd instead of matching the process cwd", () => {
    expect(filterSessionsForCwd([sessionEntry("a", "")], process.cwd())).toHaveLength(0);
  });

  it("excludes sessions from other cwds", () => {
    expect(filterSessionsForCwd([sessionEntry("a", join(tempDir, "other"))], cwd)).toHaveLength(0);
  });
});

describe("session listing canonicalization", () => {
  it("canonicalizes session header cwds written by external tools", async () => {
    // Headers are written by the Pi CLI / SDK consumers and may contain
    // unnormalized paths (trailing separators, redundant segments).
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-messy", `${cwd}${sep}.${sep}`);
    const gateway = createPiSessionManagerGateway({ agentDir, env: {} });

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-messy", cwd }]);
  });
});

function hasSessionDir(manager: PiSessionManager): manager is PiSessionManager & { getSessionDir(): string } {
  return "getSessionDir" in manager && typeof manager.getSessionDir === "function";
}

function sessionEntry(id: string, sessionCwd: string): PiSessionListEntry {
  return { path: join(tempDir, `${id}.jsonl`), id, cwd: sessionCwd, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" };
}

async function writeSessionFile(dir: string, id: string, sessionCwd: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: sessionCwd })}\n`, "utf8");
}
