import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ApiKeyCredential, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { lock } from "proper-lockfile";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const commandCache = new Map<string, string>();
const pendingCommands = new Map<string, Promise<string | undefined>>();

type CredentialFile = Record<string, unknown>;
type CredentialStoreChangeSource = "reload" | "modify" | "delete";
type CommandRunner = (command: string, env: Readonly<NodeJS.ProcessEnv>) => Promise<string>;
type LockHealthCheck = () => void;

export interface ProfileCredentialStoreChange {
  revision: number;
  source: CredentialStoreChangeSource;
  providerId?: string;
}

export interface ProfileCredentialStoreReloadResult {
  revision: number;
  changed: boolean;
  error?: ProfileCredentialStoreMalformedFileError;
}

export interface ProfileCredentialStoreLogger {
  error(details: Record<string, unknown>, message: string): void;
}

export interface ProfileCredentialStoreOptions {
  agentDir: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  logger?: ProfileCredentialStoreLogger;
  /** Test seam for command-backed keys. Production uses the host shell. */
  runCommand?: CommandRunner;
}

const noopLogger: ProfileCredentialStoreLogger = { error() { /* no-op */ } };

/**
 * A malformed canonical auth file is readable only through the last valid
 * in-memory snapshot. Mutations reject with this error rather than replacing
 * data that another process may still be repairing.
 */
export class ProfileCredentialStoreMalformedFileError extends Error {
  constructor(readonly authPath: string, options?: ErrorOptions) {
    super(`Credential file is malformed and was not changed: ${authPath}`, options);
    this.name = "ProfileCredentialStoreMalformedFileError";
  }
}

/**
 * Daemon-owned implementation of pi-ai's public app-storage contract.
 *
 * The canonical file remains Pi-compatible `auth.json`; this class owns only
 * persistence and config-value resolution while ModelRuntime owns login,
 * refresh, request auth, and logout orchestration.
 */
export class ProfileCredentialStore implements CredentialStore {
  readonly authPath: string;

  private readonly env: Readonly<NodeJS.ProcessEnv>;
  private readonly logger: ProfileCredentialStoreLogger;
  private readonly runCommand: CommandRunner;
  private readonly listeners = new Set<(change: ProfileCredentialStoreChange) => void | Promise<void>>();
  private readonly providerQueues = new Map<string, Promise<void>>();
  private diskQueue: Promise<void> = Promise.resolve();
  private snapshot: CredentialFile = emptyCredentialFile();
  private snapshotRevision = 0;
  private malformedFileError: ProfileCredentialStoreMalformedFileError | undefined;

  private constructor(options: ProfileCredentialStoreOptions) {
    this.authPath = join(options.agentDir, "auth.json");
    this.env = options.env ?? process.env;
    this.logger = options.logger ?? noopLogger;
    this.runCommand = options.runCommand ?? runShellCommand;
  }

  static async create(options: ProfileCredentialStoreOptions): Promise<ProfileCredentialStore> {
    const store = new ProfileCredentialStore(options);
    await store.reload();
    return store;
  }

  get revision(): number {
    return this.snapshotRevision;
  }

  get reloadError(): ProfileCredentialStoreMalformedFileError | undefined {
    return this.malformedFileError;
  }

  subscribe(listener: (change: ProfileCredentialStoreChange) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async reload(): Promise<ProfileCredentialStoreReloadResult> {
    return this.enqueueDiskOperation(async () => {
      await this.ensureParentDirectory();
      try {
        const latest = await this.readCredentialFile();
        this.malformedFileError = undefined;
        const changed = this.commitSnapshot(latest, { source: "reload" });
        return { revision: this.snapshotRevision, changed };
      } catch (error: unknown) {
        if (!(error instanceof ProfileCredentialStoreMalformedFileError)) throw error;
        this.malformedFileError = error;
        return { revision: this.snapshotRevision, changed: false, error };
      }
    });
  }

  async read(providerId: string): Promise<Credential | undefined> {
    await this.reload();
    const credential = publicCredential(this.snapshot[providerId]);
    if (credential === undefined) return undefined;
    if (credential.type === "oauth") return cloneCredential(credential);

    const resolvedKey = credential.key === undefined
      ? undefined
      : await resolveApiKeyConfigValue(credential.key, credential.env, this.env, this.runCommand);
    const resolved: ApiKeyCredential = {
      type: "api_key",
      ...(resolvedKey === undefined ? {} : { key: resolvedKey }),
      ...(credential.env === undefined ? {} : { env: { ...credential.env } }),
    };
    return resolved;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    await this.reload();
    const credentials: CredentialInfo[] = [];
    for (const [providerId, value] of Object.entries(this.snapshot)) {
      const credential = publicCredential(value);
      if (credential !== undefined) credentials.push({ providerId, type: credential.type });
    }
    return credentials;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueueProvider(providerId, () => this.enqueueDiskOperation(async () => {
      const result = await this.withFileLock(async (assertLockHealthy) => {
        const latest = await this.readCredentialFileForMutation();
        const current = publicCredential(latest[providerId]);
        const next = await fn(current === undefined ? undefined : cloneCredential(current));
        if (next === undefined) return { latest, result: current, wrote: false } as const;
        if (publicCredential(next) === undefined) throw new Error(`Invalid credential returned for provider: ${providerId}`);

        const updated = cloneCredentialFile(latest);
        setCredentialFileEntry(updated, providerId, cloneCredential(next));
        await this.writeCredentialFile(updated, assertLockHealthy);
        return { latest: updated, result: next, wrote: true } as const;
      });

      this.malformedFileError = undefined;
      this.commitSnapshot(result.latest, {
        source: result.wrote ? "modify" : "reload",
        ...(result.wrote ? { providerId } : {}),
      }, result.wrote);
      return result.result === undefined ? undefined : cloneCredential(result.result);
    }));
  }

  delete(providerId: string): Promise<void> {
    return this.enqueueProvider(providerId, () => this.enqueueDiskOperation(async () => {
      const result = await this.withFileLock(async (assertLockHealthy) => {
        const latest = await this.readCredentialFileForMutation();
        if (!Object.hasOwn(latest, providerId)) return { latest, wrote: false } as const;

        const updated = credentialFileWithout(latest, providerId);
        await this.writeCredentialFile(updated, assertLockHealthy);
        return { latest: updated, wrote: true } as const;
      });

      this.malformedFileError = undefined;
      this.commitSnapshot(result.latest, {
        source: result.wrote ? "delete" : "reload",
        ...(result.wrote ? { providerId } : {}),
      }, result.wrote);
    }));
  }

  private enqueueProvider<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.providerQueues.get(providerId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.providerQueues.set(providerId, settled);
    void settled.finally(() => {
      if (this.providerQueues.get(providerId) === settled) this.providerQueues.delete(providerId);
    });
    return result;
  }

  private enqueueDiskOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.diskQueue.catch(() => undefined).then(operation);
    this.diskQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withFileLock<T>(operation: (assertLockHealthy: LockHealthCheck) => Promise<T>): Promise<T> {
    await this.ensureParentDirectory();
    let compromised: Error | undefined;
    const release = await lock(this.authPath, {
      realpath: false,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      // OAuth refresh intentionally runs under this lock and may involve a slow
      // network exchange. Wait for the owner (or stale recovery) rather than
      // allowing an ordinary long refresh to surface as ELOCKED.
      retries: { forever: true, factor: 1.2, minTimeout: 100, maxTimeout: 1_000, randomize: true },
      onCompromised: (error) => {
        compromised = error;
        this.logLockCompromise(error);
      },
    });
    const assertLockHealthy = () => {
      if (compromised !== undefined) throw compromised;
    };
    const outcome = await (async () => {
      try {
        const value = await operation(assertLockHealthy);
        assertLockHealthy();
        return { ok: true, value } as const;
      } catch (error: unknown) {
        return { ok: false, error } as const;
      }
    })();
    let releaseFailure: { error: unknown } | undefined;
    try {
      await release();
    } catch (error: unknown) {
      releaseFailure = { error };
    }

    // A compromised lock is surfaced as an operation failure without relying
    // on proper-lockfile's process-terminating default callback.
    assertLockHealthy();
    if (releaseFailure !== undefined) {
      if (outcome.ok) throw releaseFailure.error;
      throw new AggregateError([outcome.error, releaseFailure.error], "Credential mutation and lock release failed");
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async ensureParentDirectory(): Promise<void> {
    const parent = dirname(this.authPath);
    await mkdir(parent, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(parent, DIRECTORY_MODE);
  }

  private async readCredentialFileForMutation(): Promise<CredentialFile> {
    try {
      return await this.readCredentialFile();
    } catch (error: unknown) {
      if (error instanceof ProfileCredentialStoreMalformedFileError) this.malformedFileError = error;
      throw error;
    }
  }

  private async readCredentialFile(): Promise<CredentialFile> {
    let content: string;
    try {
      content = await readFile(this.authPath, "utf8");
      await chmod(this.authPath, FILE_MODE);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyCredentialFile();
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed)) throw new Error("Credential file root must be an object");
      return cloneCredentialFile(parsed);
    } catch (error: unknown) {
      throw new ProfileCredentialStoreMalformedFileError(this.authPath, { cause: error });
    }
  }

  private async writeCredentialFile(credentials: CredentialFile, assertLockHealthy: LockHealthCheck): Promise<void> {
    const parent = dirname(this.authPath);
    const temporaryPath = join(parent, `.auth.json.${String(process.pid)}.${randomUUID()}.tmp`);
    let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
    try {
      temporaryFile = await open(temporaryPath, "wx", FILE_MODE);
      await temporaryFile.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      assertLockHealthy();
      await rename(temporaryPath, this.authPath);
      await syncDirectory(parent);
    } finally {
      await temporaryFile?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private commitSnapshot(
    next: CredentialFile,
    change: Omit<ProfileCredentialStoreChange, "revision">,
    forceRevision = false,
  ): boolean {
    if (!forceRevision && isDeepStrictEqual(this.snapshot, next)) return false;
    this.snapshot = cloneCredentialFile(next);
    this.snapshotRevision += 1;
    this.notifyListeners({ ...change, revision: this.snapshotRevision });
    return true;
  }

  private notifyListeners(change: ProfileCredentialStoreChange): void {
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(change);
        if (isPromiseLike(result)) {
          void result.catch((error: unknown) => {
            this.logListenerError(error, change);
          });
        }
      } catch (error: unknown) {
        this.logListenerError(error, change);
      }
    }
  }

  private logListenerError(error: unknown, change: ProfileCredentialStoreChange): void {
    try {
      this.logger.error({ err: error, ...change }, "credential-store listener failed");
    } catch {
      // Diagnostics run after durable mutation and cannot change its result.
    }
  }

  private logLockCompromise(error: Error): void {
    try {
      this.logger.error({ err: error, authPath: this.authPath }, "credential-store file lock compromised");
    } catch {
      // The lock health check, not diagnostics, controls mutation failure.
    }
  }
}

async function resolveApiKeyConfigValue(
  value: string,
  credentialEnv: Readonly<Record<string, string>> | undefined,
  processEnv: Readonly<NodeJS.ProcessEnv>,
  runCommand: CommandRunner,
): Promise<string | undefined> {
  if (value.startsWith("!")) {
    const command = value.slice(1);
    const cached = commandCache.get(command);
    if (cached !== undefined) return cached;
    const inFlight = pendingCommands.get(command);
    if (inFlight !== undefined) return inFlight;

    const execution = runCommand(command, processEnv)
      .then((output) => output.trim())
      .catch(() => undefined);
    pendingCommands.set(command, execution);
    try {
      const output = await execution;
      if (output !== undefined) commandCache.set(command, output);
      return output;
    } finally {
      if (pendingCommands.get(command) === execution) pendingCommands.delete(command);
    }
  }

  let resolved = "";
  for (let index = 0; index < value.length;) {
    const character = value.charAt(index);
    if (character !== "$") {
      resolved += character;
      index += 1;
      continue;
    }

    const next = value[index + 1];
    if (next === "$" || next === "!") {
      resolved += next;
      index += 2;
      continue;
    }

    if (next === "{") {
      const end = value.indexOf("}", index + 2);
      if (end === -1) {
        resolved += "$";
        index += 1;
        continue;
      }
      const name = value.slice(index + 2, end);
      if (!isEnvironmentName(name)) {
        resolved += value.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      const replacement = environmentValue(name, credentialEnv, processEnv);
      if (replacement === undefined) return undefined;
      resolved += replacement;
      index = end + 1;
      continue;
    }

    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let end = index + 2;
      while (end < value.length && /[A-Za-z0-9_]/.test(value[end] ?? "")) end += 1;
      const name = value.slice(index + 1, end);
      const replacement = environmentValue(name, credentialEnv, processEnv);
      if (replacement === undefined) return undefined;
      resolved += replacement;
      index = end;
      continue;
    }

    resolved += "$";
    index += 1;
  }
  return resolved;
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  return error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EPERM" || error.code === "EISDIR";
}

function environmentValue(
  name: string,
  credentialEnv: Readonly<Record<string, string>> | undefined,
  processEnv: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
  return credentialEnv?.[name] ?? processEnv[name];
}

function isEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function runShellCommand(command: string, env: Readonly<NodeJS.ProcessEnv>): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { env: { ...env }, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });
}

function publicCredential(value: unknown): Credential | undefined {
  if (!isRecord(value)) return undefined;
  if (value["type"] === "api_key") {
    const key = value["key"];
    const env = value["env"];
    if (key !== undefined && typeof key !== "string") return undefined;
    if (env !== undefined && !isStringRecord(env)) return undefined;
    return {
      ...structuredClone(value),
      type: "api_key",
      ...(key === undefined ? {} : { key }),
      ...(env === undefined ? {} : { env: { ...env } }),
    };
  }
  if (value["type"] === "oauth") {
    const refresh = value["refresh"];
    const access = value["access"];
    const expires = value["expires"];
    if (typeof refresh !== "string" || typeof access !== "string" || typeof expires !== "number") return undefined;
    return { ...structuredClone(value), type: "oauth", refresh, access, expires };
  }
  return undefined;
}

function cloneCredential<T extends Credential>(credential: T): T {
  return structuredClone(credential);
}

function emptyCredentialFile(): CredentialFile {
  return {};
}

function cloneCredentialFile(credentials: CredentialFile): CredentialFile {
  const clone = emptyCredentialFile();
  for (const [providerId, credential] of Object.entries(credentials)) {
    Object.defineProperty(clone, providerId, {
      value: structuredClone(credential),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return clone;
}

function setCredentialFileEntry(credentials: CredentialFile, providerId: string, credential: unknown): void {
  Object.defineProperty(credentials, providerId, {
    value: credential,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function credentialFileWithout(credentials: CredentialFile, excludedProviderId: string): CredentialFile {
  const clone = emptyCredentialFile();
  for (const [providerId, credential] of Object.entries(credentials)) {
    if (providerId === excludedProviderId) continue;
    Object.defineProperty(clone, providerId, {
      value: structuredClone(credential),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return clone;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isPromiseLike(value: unknown): value is PromiseLike<void> & { catch(onRejected: (error: unknown) => void): PromiseLike<void> } {
  return typeof value === "object" && value !== null && "then" in value && "catch" in value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
