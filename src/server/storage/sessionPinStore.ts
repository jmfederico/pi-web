import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";
import type { NavigationPreference, NavigationPreferenceWrite } from "../../shared/navigationPreferences.js";
import { NavigationPreferenceStore, navigationPreferenceStorePath, type NavigationPreferenceScope } from "./navigationPreferenceStore.js";

export interface SessionPinScope {
  projectId: string;
  workspaceId: string;
}

export function sessionPinStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "session-pins.json");
}

/** Single daemon-owned writer. File existence is the durable migration-complete marker,
 * including an empty import. Legacy navigation state is never consulted afterward.
 */
export class SessionPinStore {
  private readonly store: NavigationPreferenceStore;
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly filePath = sessionPinStorePath(),
    private readonly legacyFilePath = navigationPreferenceStorePath(),
    private readonly onChange?: (scope: SessionPinScope, revision: number) => void,
  ) {
    this.store = new NavigationPreferenceStore(filePath);
  }

  get(scope: SessionPinScope): Promise<NavigationPreference> {
    return this.exclusive(() => this.store.get(pinScope(scope)));
  }

  put(scope: SessionPinScope, value: NavigationPreferenceWrite): Promise<NavigationPreference> {
    return this.exclusive(async () => {
      const selected = pinScope(scope);
      const result = await this.store.put(selected, value);
      this.onChange?.({ projectId: selected.projectId, workspaceId: selected.workspaceId }, result.revision);
      return result;
    });
  }

  setPinned(scope: SessionPinScope, sessionId: string, pinned: boolean): Promise<NavigationPreference> {
    return this.exclusive(async () => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") throw new Error("Session ID must be a non-empty string");
      if (typeof pinned !== "boolean") throw new Error("Pinned must be a boolean");
      const selected = pinScope(scope);
      const current = await this.store.get(selected);
      const present = current.ids.includes(sessionId);
      if (present === pinned) return current;
      const result = await this.store.put(selected, {
        ids: pinned ? [...current.ids, sessionId] : current.ids.filter((id) => id !== sessionId),
        revision: current.revision,
      });
      this.onChange?.({ projectId: selected.projectId, workspaceId: selected.workspaceId }, result.revision);
      return result;
    });
  }

  pinnedSessionIds(): Promise<string[]> {
    return this.exclusive(() => this.store.pinnedSessionIds());
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.initialize();
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await readFile(this.filePath, "utf8");
      // Validate existing state; corruption must never trigger a legacy re-import.
      await this.store.sessionPinSnapshot();
      this.initialized = true;
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const entries = await new NavigationPreferenceStore(this.legacyFilePath).sessionPinSnapshot();
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    this.initialized = true;
  }
}

function pinScope(scope: SessionPinScope): NavigationPreferenceScope & { kind: "session-pins" } {
  if (typeof scope.projectId !== "string" || scope.projectId === "" || typeof scope.workspaceId !== "string" || scope.workspaceId === "") {
    throw new Error("Session pin scope requires projectId and workspaceId");
  }
  return { kind: "session-pins", projectId: scope.projectId, workspaceId: scope.workspaceId };
}
