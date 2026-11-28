import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "pi-web-typebox";
import { Check } from "pi-web-typebox/value";
import type { Verdict, WatchProgress } from "./activity.js";
import type { PullRequestRef } from "./github.js";

const removalReason = Type.Union([
  Type.Literal("unsubscribed"), Type.Literal("session-archived"), Type.Literal("session-deleted"),
  Type.Literal("workspace-removed"), Type.Literal("project-removed"), Type.Literal("pr-merged"),
  Type.Literal("pr-closed"), Type.Literal("expired"),
]);
export type RemovalReason = Static<typeof removalReason>;

/** One notification awaiting acknowledgement. Times are epoch milliseconds. */
export interface Outbox {
  readonly id: string;
  readonly content: string;
  readonly createdAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  /** Whether repeated failure has already been reported as a notice. */
  readonly reported: boolean;
  /** The merged/closed message; only its acknowledgement ends the subscription. */
  readonly final: boolean;
}

export interface Subscription {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly pr: PullRequestRef & { readonly url: string; readonly title: string };
  readonly createdAt: number;
  readonly progress: WatchProgress;
  readonly headSha: string | null;
  readonly verdict: Verdict | null;
  /** Set once the pull request is merged or closed; removal follows the final delivery. */
  readonly ending: "merged" | "closed" | null;
  readonly outbox: Outbox | null;
  /** Delivery times within the rate-limit window. */
  readonly wakes: readonly number[];
  /** Consecutive confirmed absences of the session, workspace, or project. */
  readonly missing: { readonly count: number; readonly reason: RemovalReason } | null;
  readonly fetchFailures: number;
}

export interface Removal {
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly pullRequest: string;
  readonly reason: RemovalReason;
  readonly at: number;
}

interface StoreData {
  version: 1;
  subscriptions: Subscription[];
  removals: Removal[];
}

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableTime = Type.Union([Type.Number(), Type.Null()]);
const storeSchema = Type.Object({
  version: Type.Literal(1),
  subscriptions: Type.Array(Type.Object({
    id: Type.String(), sessionId: Type.String(), projectId: Type.String(), workspaceId: Type.String(),
    pr: Type.Object({
      host: Type.String(), owner: Type.String(), repo: Type.String(), url: Type.String(), title: Type.String(),
      number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    }),
    createdAt: Type.Number(),
    progress: Type.Object({
      seen: Type.Record(Type.String(), Type.String()),
      pending: Type.Array(Type.Object({ key: Type.String(), label: Type.String(), excerpt: Type.String(), url: Type.String() })),
      firstPendingAt: nullableTime, lastActivityAt: nullableTime, reviewInProgress: Type.Boolean(),
    }),
    headSha: nullableString,
    verdict: Type.Union([Type.Null(), Type.Object({ state: Type.String(), commitId: nullableString, currentHead: Type.Boolean() })]),
    ending: Type.Union([Type.Null(), Type.Literal("merged"), Type.Literal("closed")]),
    outbox: Type.Union([Type.Null(), Type.Object({
      id: Type.String(), content: Type.String(), createdAt: Type.Number(),
      attempts: Type.Integer({ minimum: 0 }), nextAttemptAt: Type.Number(), reported: Type.Boolean(), final: Type.Boolean(),
    })]),
    wakes: Type.Array(Type.Number()),
    missing: Type.Union([Type.Null(), Type.Object({ count: Type.Integer({ minimum: 0 }), reason: removalReason })]),
    fetchFailures: Type.Integer({ minimum: 0 }),
  })),
  removals: Type.Array(Type.Object({
    subscriptionId: Type.String(), sessionId: Type.String(), pullRequest: Type.String(), reason: removalReason, at: Type.Number(),
  })),
});

const MAX_REMOVALS = 50;

/**
 * Plugin-owned JSON state for one daemon process. Mutations are synchronous in
 * memory; writes are serialized and atomic (temporary file plus rename).
 */
export class SubscriptionStore {
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private data: StoreData, private readonly onWriteError: (error: unknown) => void) {}

  static async open(path: string, onWriteError: (error: unknown) => void): Promise<SubscriptionStore> {
    let text: string | undefined;
    try { text = await readFile(path, "utf8"); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return new SubscriptionStore(path, text === undefined ? { version: 1, subscriptions: [], removals: [] } : parseStore(text, path), onWriteError);
  }

  list(): readonly Subscription[] {
    return this.data.subscriptions;
  }

  find(id: string): Subscription | undefined {
    return this.data.subscriptions.find((subscription) => subscription.id === id);
  }

  removals(sessionId: string): readonly Removal[] {
    return this.data.removals.filter((removal) => removal.sessionId === sessionId);
  }

  add(subscription: Subscription): void {
    this.data = { ...this.data, subscriptions: [...this.data.subscriptions, subscription] };
    this.persist();
  }

  /** Applies a change when the subscription still exists; concurrent removal wins. */
  update(id: string, change: (subscription: Subscription) => Subscription): Subscription | undefined {
    const current = this.find(id);
    if (current === undefined) return undefined;
    const next = change(current);
    this.data = { ...this.data, subscriptions: this.data.subscriptions.map((subscription) => subscription.id === id ? next : subscription) };
    this.persist();
    return next;
  }

  remove(id: string, reason: RemovalReason, at: number): Removal | undefined {
    const current = this.find(id);
    if (current === undefined) return undefined;
    const removal: Removal = {
      subscriptionId: id, sessionId: current.sessionId, at, reason,
      pullRequest: `${current.pr.owner}/${current.pr.repo}#${String(current.pr.number)}`,
    };
    this.data = {
      ...this.data,
      subscriptions: this.data.subscriptions.filter((subscription) => subscription.id !== id),
      removals: [...this.data.removals, removal].slice(-MAX_REMOVALS),
    };
    this.persist();
    return removal;
  }

  /** Resolves once every write requested so far has finished. */
  flush(): Promise<void> {
    return this.writing;
  }

  private persist(): void {
    this.writing = this.writing.then(async () => {
      // Serialize the latest state when this write runs; earlier queued writes become redundant but harmless.
      const temporary = `${this.path}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    }).catch(this.onWriteError);
  }
}

function parseStore(text: string, path: string): StoreData {
  const diagnosis = `Unrecognized PR watch state in ${path}; move it aside to start empty`;
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(diagnosis, { cause: error }); }
  if (!Check(storeSchema, value)) throw new Error(diagnosis);
  return value;
}
