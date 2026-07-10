import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  machineId: string;
  createdAt: string;
  userAgent?: string;
}

interface PushSubscriptionFile {
  subscriptions: PushSubscriptionRecord[];
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseKeys(value: unknown): PushSubscriptionRecord["keys"] {
  if (!isRecord(value)) throw new Error("Invalid push subscription keys");
  const p256dh = value["p256dh"];
  const auth = value["auth"];
  if (typeof p256dh !== "string" || typeof auth !== "string") throw new Error("Invalid push subscription keys");
  return { p256dh, auth };
}

function parseSubscription(value: unknown): PushSubscriptionRecord {
  if (!isRecord(value)) throw new Error("Invalid push subscription");
  const endpoint = value["endpoint"];
  const machineId = value["machineId"];
  const createdAt = value["createdAt"];
  const userAgent = value["userAgent"];
  if (typeof endpoint !== "string" || typeof machineId !== "string" || typeof createdAt !== "string") throw new Error("Invalid push subscription");
  if (userAgent !== undefined && typeof userAgent !== "string") throw new Error("Invalid push subscription");
  return {
    endpoint,
    keys: parseKeys(value["keys"]),
    machineId,
    createdAt,
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

function parseSubscriptionFile(value: unknown): PushSubscriptionFile {
  if (!isRecord(value) || !Array.isArray(value["subscriptions"])) throw new Error("Invalid push subscription file");
  return { subscriptions: value["subscriptions"].map(parseSubscription) };
}

export function defaultPushSubscriptionStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "push-subscriptions.json");
}

/**
 * File-based push subscription storage shared between the web server
 * (subscribe/unsubscribe writes) and the session daemon (reads to know who
 * to push to). No in-memory cache — every call re-reads from disk so the
 * daemon always sees subscriptions added via the web server without IPC.
 */
export class PushSubscriptionStore {
  constructor(private readonly filePath = defaultPushSubscriptionStorePath()) {}

  async list(): Promise<PushSubscriptionRecord[]> {
    return (await this.read()).subscriptions;
  }

  async add(subscription: PushSubscriptionRecord): Promise<void> {
    const data = await this.read();
    const deduped = data.subscriptions.filter((existing) => existing.endpoint !== subscription.endpoint);
    deduped.push(subscription);
    await this.write({ subscriptions: deduped });
  }

  async remove(endpoint: string): Promise<void> {
    const data = await this.read();
    await this.write({ subscriptions: data.subscriptions.filter((existing) => existing.endpoint !== endpoint) });
  }

  async clear(): Promise<void> {
    await this.write({ subscriptions: [] });
  }

  private async read(): Promise<PushSubscriptionFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseSubscriptionFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { subscriptions: [] };
      throw error;
    }
  }

  private async write(data: PushSubscriptionFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // Temp-file-then-rename so a concurrent read from the other process
    // never observes a partially-written file.
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
