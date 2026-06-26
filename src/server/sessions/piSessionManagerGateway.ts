import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import type { PiSessionListEntry, PiSessionManager, PiSessionManagerGateway } from "./piSessionService.js";

export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

type SessionDirSource = "env" | "settings" | "pi-default";

export interface SessionDirResolution {
  source: SessionDirSource;
  sessionDir: string;
  usesConfiguredSessionDir: boolean;
}

export interface SessionDirResolverOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  sessionDirEnvKeys?: readonly string[];
}

export class SessionDirResolver {
  private readonly agentDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionDirEnvKeys: readonly string[];

  constructor(options: SessionDirResolverOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.env = options.env ?? process.env;
    this.sessionDirEnvKeys = options.sessionDirEnvKeys ?? [PI_SESSION_DIR_ENV];
  }

  defaultSessionsRoot(): string {
    return defaultPiSessionsRoot(this.agentDir);
  }

  globalEnvSessionDir(): string | undefined {
    const envSessionDir = this.envSessionDir();
    if (envSessionDir === undefined) return undefined;
    const expanded = expandTildePath(envSessionDir);
    return isAbsolute(expanded) ? expanded : undefined;
  }

  resolve(cwd: string): SessionDirResolution {
    const envSessionDir = this.envSessionDir();
    if (envSessionDir !== undefined) {
      return { source: "env", sessionDir: resolveConfiguredPath(envSessionDir, cwd), usesConfiguredSessionDir: true };
    }

    const settingsSessionDir = SettingsManager.create(cwd, this.agentDir).getSessionDir();
    if (settingsSessionDir !== undefined && settingsSessionDir !== "") {
      return { source: "settings", sessionDir: resolveConfiguredPath(settingsSessionDir, cwd), usesConfiguredSessionDir: true };
    }

    return { source: "pi-default", sessionDir: defaultPiSessionDir(cwd, this.agentDir), usesConfiguredSessionDir: false };
  }

  private envSessionDir(): string | undefined {
    return this.sessionDirEnvKeys.map((key) => this.env[key]).find((value) => value !== undefined && value !== "");
  }
}

export type PiSessionManagerGatewayOptions = SessionDirResolverOptions;

export function createPiSessionManagerGateway(options: PiSessionManagerGatewayOptions = {}): PiSessionManagerGateway {
  return new SettingsAwarePiSessionManagerGateway(new SessionDirResolver(options));
}

class SettingsAwarePiSessionManagerGateway implements PiSessionManagerGateway {
  constructor(private readonly resolver: SessionDirResolver) {}

  async list(cwd: string): Promise<PiSessionListEntry[]> {
    const resolution = this.resolver.resolve(cwd);
    return filterSessionsForCwd(await listSessionsInDir(resolution.sessionDir), cwd);
  }

  create(cwd: string, options?: { parentSession?: string }): PiSessionManager {
    const resolution = this.resolver.resolve(cwd);
    return SessionManager.create(cwd, resolution.sessionDir, options?.parentSession === undefined ? undefined : { parentSession: options.parentSession });
  }

  async listAll(): Promise<PiSessionListEntry[]> {
    const envSessionDir = this.resolver.globalEnvSessionDir();
    const [defaultSessions, envSessions] = await Promise.all([
      listSessionsInDefaultPiStore(this.resolver.defaultSessionsRoot()),
      envSessionDir === undefined ? Promise.resolve([]) : listSessionsInDir(envSessionDir),
    ]);
    return uniqueSessionsByPath([...defaultSessions, ...envSessions]);
  }

  open(path: string): PiSessionManager {
    return SessionManager.open(path, dirname(path));
  }
}

export async function listSessionsInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
  // listAll(sessionDir) lists without the SDK's internal cwd filter, which would
  // otherwise compare against this process's cwd and drop other projects' sessions.
  // Cwd filtering is applied explicitly by filterSessionsForCwd where needed.
  // Session file headers are written by external tools (Pi CLI, SDK consumers),
  // so their cwd is canonicalized here before it enters pi-web.
  const sessions = await SessionManager.listAll(sessionDir);
  return sessions.map((session) => ({ ...session, cwd: canonicalizeStoredCwd(session.cwd) }));
}

export async function listSessionsInDefaultPiStore(storeRoot = defaultPiSessionsRoot()): Promise<PiSessionListEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(storeRoot, entry.name));
  const sessions = (await Promise.all(sessionDirs.map((dir) => listSessionsInDir(dir)))).flat();
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function filterSessionsForCwd(sessions: readonly PiSessionListEntry[], cwd: string): PiSessionListEntry[] {
  // Sessions with an empty cwd (old session files) are excluded: resolve("") would
  // resolve to this process's cwd and produce false matches.
  return sessions.filter((session) => session.cwd !== "" && cwdPathsEqual(session.cwd, cwd));
}

function uniqueSessionsByPath(sessions: readonly PiSessionListEntry[]): PiSessionListEntry[] {
  const byPath = new Map<string, PiSessionListEntry>();
  for (const session of sessions) byPath.set(session.path, session);
  return [...byPath.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function defaultPiSessionsRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "sessions");
}

export function defaultPiSessionDir(cwd: string, agentDir = getAgentDir()): string {
  return sessionDirInDefaultPiStore(defaultPiSessionsRoot(agentDir), cwd);
}

export function sessionDirInDefaultPiStore(storeRoot: string, cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return join(storeRoot, safePath);
}

export function resolveConfiguredPath(path: string, cwd: string): string {
  const expanded = expandTildePath(path);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function expandTildePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
