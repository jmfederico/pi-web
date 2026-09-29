import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";

/** A stored Web Push subscription in the exact shape browsers report and web-push accepts. */
export interface PushSubscriptionRecord {
  readonly endpoint: string;
  /** Unix seconds after which the push service expects the endpoint to expire, or null when never. */
  readonly expirationTime?: number | null;
  /** VAPID keys as base64url strings (`p256dh`, `auth`). Never sent to browsers in this shape. */
  readonly keys: Readonly<Record<string, string>>;
}

interface PushSubscriptionsFile {
  version: number;
  subscriptions: unknown[];
}

export const PUSH_SUBSCRIPTION_FILE_VERSION = 1 as const;
const MAX_STORED_SUBSCRIPTIONS = 256;

/** Observability seam, mirroring SessionUnreadStore: persistence failures must be visible in the daemon log. */
export interface PushSubscriptionStoreOptions {
  onPersistenceError?: ((operation: "load" | "save", error: unknown) => void) | undefined;
}

/**
 * In-memory Web Push subscription set with file persistence under the PI WEB data dir.
 * Follows the atomic-write discipline of FileSessionUnreadPersistence (unique temp file + rename).
 * Subscriptions are re-creatable client state, not user content: a corrupted file throws from
 * {@link load} and callers decide to start empty rather than block daemon startup. Save failures
 * are reported through {@link PushSubscriptionStoreOptions.onPersistenceError} and otherwise kept
 * best-effort: in-memory state stays authoritative until the next load.
 */
export class PushSubscriptionStore {
  private readonly subscriptions = new Map<string, PushSubscriptionRecord>();
  /** In-flight saves; mutations are best-effort persisted fire-and-forget, but {@link flush} makes the settled state awaitable (used at tests and shutdown seams). */
  private readonly pendingSaves = new Set<Promise<void>>();
  /** Serializes atomic replacements so an older snapshot can never be renamed over a newer one. */
  private saveTail: Promise<void> = Promise.resolve();
  private readonly onPersistenceError: (operation: "load" | "save", error: unknown) => void;

  constructor(readonly filePath: string, options: PushSubscriptionStoreOptions = {}) {
    this.onPersistenceError = options.onPersistenceError ?? (() => undefined);
  }

  /** Load the persisted set; ENOENT starts empty. Reports and throws on unreadable, invalid JSON, or invalid shape — see class note. */
  async load(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      this.reportPersistenceError("load", error);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      this.reportPersistenceError("load", error);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`PI WEB push subscription store is not valid JSON (${reason}): ${this.filePath}`, { cause: error });
    }
    if (!isValidFile(parsed)) {
      const error = new Error(`PI WEB push subscription store is not a valid push subscriptions file: ${this.filePath}`);
      this.reportPersistenceError("load", error);
      throw error;
    }
    this.subscriptions.clear();
    for (const candidate of parsed.subscriptions) {
      const record = parseStoredSubscription(candidate);
      if (record !== undefined && !this.subscriptions.has(record.endpoint)) this.subscriptions.set(record.endpoint, record);
    }
  }

  /** Best-effort persist: failures are reported (never silent) but do not reject; in-memory state stays authoritative. */
  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid.toString()}-${randomUUID()}.tmp`;
      try {
        const file: PushSubscriptionsFile = { version: PUSH_SUBSCRIPTION_FILE_VERSION, subscriptions: [...this.subscriptions.values()] };
        await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(tempPath, this.filePath);
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      this.reportPersistenceError("save", error);
    }
  }

  list(): readonly PushSubscriptionRecord[] {
    return [...this.subscriptions.values()];
  }

  get size(): number {
    return this.subscriptions.size;
  }

  /** Wait for every best-effort save started so far to settle; resolution state is not propagated. */
  async flush(): Promise<void> {
    while (this.pendingSaves.size > 0) await Promise.all([...this.pendingSaves]);
  }

  /** Add a subscription. `duplicate` leaves state unchanged; `full` refuses without evicting anything. */
  add(subscription: PushSubscriptionRecord): "added" | "duplicate" | "full" {
    if (this.subscriptions.has(subscription.endpoint)) return "duplicate";
    if (this.size >= MAX_STORED_SUBSCRIPTIONS) return "full";
    this.subscriptions.set(subscription.endpoint, subscription);
    // Best-effort persistence: in-memory state is authoritative until the next load.
    this.trackSave();
    return "added";
  }

  remove(endpoint: string): boolean {
    const removed = this.subscriptions.delete(endpoint);
    if (removed) this.trackSave();
    return removed;
  }

  private trackSave(): void {
    const pending = this.saveTail.then(() => this.save());
    this.saveTail = pending;
    this.pendingSaves.add(pending);
    void pending.finally(() => {
      this.pendingSaves.delete(pending);
    });
  }

  /** Error reporting must not poison future serialized persistence work (same guard as SessionUnreadStore). */
  private reportPersistenceError(operation: "load" | "save", error: unknown): void {
    try {
      this.onPersistenceError(operation, error);
    } catch {
      // The callback itself failed; there is nowhere more specific to report it from here.
    }
  }
}

/** Default store location under the PI WEB-managed data dir. */
export function defaultPushSubscriptionFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "push-subscriptions.json");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidFile(value: unknown): value is PushSubscriptionsFile {
  return isRecord(value) && value["version"] === PUSH_SUBSCRIPTION_FILE_VERSION && Array.isArray(value["subscriptions"]);
}

function parseStoredSubscription(value: unknown): PushSubscriptionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  if (typeof record["endpoint"] !== "string" || record["endpoint"] === "") return undefined;
  const keys = parseKeys(record["keys"]);
  if (keys === undefined) return undefined;
  return { endpoint: record["endpoint"], ...expirationTimeOf(record), keys };
}

function parseKeys(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") return undefined;
    result[key] = item;
  }
  // A subscription without the VAPID key pair can never be delivered to.
  return typeof result["p256dh"] === "string" && typeof result["auth"] === "string" ? result : undefined;
}

function expirationTimeOf(record: Record<string, unknown>): { expirationTime?: number | null } {
  if (record["expirationTime"] === null || record["expirationTime"] === undefined) return {};
  const value = record["expirationTime"];
  return typeof value === "number" && Number.isFinite(value) ? { expirationTime: value } : {};
}
