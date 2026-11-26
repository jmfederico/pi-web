import { isAbsolute, resolve, sep } from "node:path";
import type {
  JsonValue, PluginCatalogV1, PluginWorkspaceSelection, ServerPluginLogger, ServerPluginNoticeInput,
} from "@jmfederico/pi-web/server-plugin-api";
import { applyObservation, clearPending, initialProgress, observe, readyToNotify, type Observation } from "./activity.js";
import type { Deliver } from "./delivery.js";
import { pullRequestLabel, type GitHubReader, type PullRequestRef, type PullRequestSnapshot } from "./github.js";
import { composeNotification } from "./message.js";
import { sessionPresence, type Presence } from "./presence.js";
import { boundedText, record } from "./protocol.js";
import type { WatchSettings } from "./settings.js";
import type { RemovalReason, Subscription, SubscriptionStore } from "./store.js";

export interface PrWatchDependencies {
  readonly store: SubscriptionStore;
  readonly github: GitHubReader;
  readonly catalog: PluginCatalogV1;
  readonly deliver: Deliver;
  readonly settings: WatchSettings;
  readonly logger: ServerPluginLogger;
  readonly notice?: (input: ServerPluginNoticeInput) => void;
  readonly now: () => number;
  readonly randomId: () => string;
}

const HOUR_MS = 3_600_000;
/** A missing session, workspace, or project must be confirmed by this many consecutive checks. */
const ABSENCE_CONFIRMATIONS = 2;
const FAILURES_BEFORE_NOTICE = 3;
const DELIVERY_ATTEMPTS_BEFORE_NOTICE = 5;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

/** Owns subscriptions: admission from companion tools and the periodic poll/validate/deliver cycle. */
export class PrWatchService {
  constructor(private readonly deps: PrWatchDependencies) {}

  async request(operation: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    const args = record(input ?? {});
    const sessionId = boundedText(args["sessionId"], "sessionId");
    switch (operation) {
      case "subscribe":
        return this.subscribe(sessionId, boundedText(args["cwd"], "cwd", 4096), boundedText(args["pr"], "pr"), signal);
      case "list":
        return this.list(sessionId);
      case "unsubscribe":
        return this.unsubscribe(sessionId, boundedText(args["subscriptionId"], "subscriptionId"));
      default:
        throw new Error(`Unknown pr-watch operation: ${operation}`);
    }
  }

  /** One pass: expire, validate sessions, poll open pull requests, then queue and deliver notifications. */
  async cycle(signal: AbortSignal): Promise<void> {
    const { store, settings } = this.deps;
    const now = this.deps.now();
    for (const subscription of store.list()) {
      if (now - subscription.createdAt > settings.maxAgeMs) this.remove(subscription, "expired");
    }
    await this.validate(signal);
    await this.poll(signal);
    for (const { id } of store.list()) {
      signal.throwIfAborted();
      await this.notify(id, signal);
    }
  }

  health(): { status: "healthy" | "degraded"; message?: string } {
    const failing = this.deps.store.list().filter((subscription) => subscription.fetchFailures >= FAILURES_BEFORE_NOTICE);
    if (failing.length === 0) return { status: "healthy" };
    return { status: "degraded", message: `GitHub reads failing for ${failing.map((subscription) => pullRequestLabel(subscription.pr)).join(", ")}` };
  }

  private async subscribe(sessionId: string, cwd: string, pr: string, signal: AbortSignal): Promise<JsonValue> {
    if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
    const target = await this.locateSession(sessionId, cwd, signal);
    const resolved = await this.deps.github.resolve(pr, target.path, signal);
    if (resolved.state !== "open") throw new Error(`${pullRequestLabel(resolved)} is already ${resolved.state}`);
    const existing = this.findExisting(sessionId, resolved);
    if (existing !== undefined) return { alreadySubscribed: true, subscription: describe(existing) };
    const snapshot = await this.deps.github.snapshot(resolved, signal);
    if (snapshot.state !== "open") throw new Error(`${pullRequestLabel(resolved)} is already ${snapshot.state}`);
    const observation = observe(snapshot, this.deps.settings.authors);
    // A concurrent subscribe may have won while GitHub was read.
    const raced = this.findExisting(sessionId, resolved);
    if (raced !== undefined) return { alreadySubscribed: true, subscription: describe(raced) };
    const subscription: Subscription = {
      id: this.deps.randomId(), sessionId, projectId: target.projectId, workspaceId: target.workspaceId,
      pr: { host: resolved.host, owner: resolved.owner, repo: resolved.repo, number: resolved.number, url: snapshot.url, title: snapshot.title },
      createdAt: this.deps.now(), progress: initialProgress(observation), headSha: snapshot.headSha, verdict: observation.verdict,
      ending: null, outbox: null, wakes: [], missing: null, fetchFailures: 0,
    };
    this.deps.store.add(subscription);
    this.deps.logger.info("PR watch subscribed", { subscriptionId: subscription.id, sessionId, pullRequest: pullRequestLabel(resolved) });
    return { alreadySubscribed: false, subscription: describe(subscription), current: currentActivity(observation) };
  }

  private list(sessionId: string): JsonValue {
    return {
      subscriptions: this.deps.store.list().filter((subscription) => subscription.sessionId === sessionId).map(describe),
      recentRemovals: this.deps.store.removals(sessionId).slice(-10).map((removal) => ({
        subscriptionId: removal.subscriptionId, pullRequest: removal.pullRequest, reason: removal.reason, at: new Date(removal.at).toISOString(),
      })),
    };
  }

  private unsubscribe(sessionId: string, subscriptionId: string): JsonValue {
    const subscription = this.deps.store.find(subscriptionId);
    if (subscription?.sessionId !== sessionId) throw new Error("No such subscription for this session");
    this.remove(subscription, "unsubscribed");
    return { removed: describe(subscription) };
  }

  private findExisting(sessionId: string, ref: PullRequestRef): Subscription | undefined {
    return this.deps.store.list().find((subscription) => subscription.sessionId === sessionId && sameRef(subscription.pr, ref));
  }

  /** Map the calling session to its registered workspace; the extension supplies only its own id and cwd. */
  private async locateSession(sessionId: string, cwd: string, signal: AbortSignal): Promise<PluginWorkspaceSelection & { path: string }> {
    const { catalog } = this.deps;
    let unreadable = 0;
    for (const project of await catalog.projects.list({ signal })) {
      let workspaces;
      try { workspaces = await catalog.workspaces.list(project.id, { signal }); } catch {
        signal.throwIfAborted();
        unreadable += 1;
        continue;
      }
      const workspace = workspaces.find((candidate) => samePath(candidate.path, cwd));
      if (workspace === undefined) continue;
      const selection = { projectId: project.id, workspaceId: workspace.id };
      const session = await catalog.sessions.get({ ...selection, sessionId }, { signal });
      if (session.archived) throw new Error("Archived sessions cannot subscribe");
      return { ...selection, path: workspace.path };
    }
    throw new Error(unreadable > 0
      ? "Could not read every project's workspaces; try again shortly"
      : "This session's directory is not a registered PI WEB workspace on this machine");
  }

  private async validate(signal: AbortSignal): Promise<void> {
    const groups = groupBy(this.deps.store.list(), (subscription) => JSON.stringify([subscription.projectId, subscription.workspaceId]));
    for (const subscriptions of groups.values()) {
      const [first] = subscriptions;
      if (first === undefined) continue;
      const presence = await sessionPresence(this.deps.catalog, first, subscriptions.map(({ sessionId }) => sessionId), signal);
      for (const subscription of subscriptions) {
        const state = presence.get(subscription.sessionId);
        if (state !== undefined) this.applyPresence(subscription.id, state);
      }
    }
  }

  private applyPresence(id: string, presence: Presence): void {
    const subscription = this.deps.store.find(id);
    if (subscription === undefined) return;
    switch (presence.kind) {
      case "present":
        if (subscription.missing !== null) this.deps.store.update(id, (current) => ({ ...current, missing: null }));
        return;
      case "archived":
        this.remove(subscription, "session-archived");
        return;
      case "absent": {
        const count = (subscription.missing?.count ?? 0) + 1;
        if (count >= ABSENCE_CONFIRMATIONS) this.remove(subscription, presence.reason);
        else this.deps.store.update(id, (current) => ({ ...current, missing: { count, reason: presence.reason } }));
        return;
      }
      case "unknown":
        this.deps.logger.warn("PR watch could not verify a session; keeping its subscription", { subscriptionId: id, error: presence.error });
        return;
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const open = this.deps.store.list().filter((subscription) => subscription.ending === null);
    for (const subscriptions of groupBy(open, (subscription) => refKey(subscription.pr)).values()) {
      const [first] = subscriptions;
      if (first === undefined) continue;
      let snapshot: PullRequestSnapshot;
      try {
        snapshot = await this.deps.github.snapshot(first.pr, signal);
      } catch (error) {
        signal.throwIfAborted();
        this.recordFetchFailure(subscriptions.map(({ id }) => id), error);
        continue;
      }
      const observation = observe(snapshot, this.deps.settings.authors);
      const now = this.deps.now();
      for (const { id } of subscriptions) {
        this.deps.store.update(id, (current) => ({
          ...current,
          pr: { ...current.pr, title: snapshot.title },
          progress: applyObservation(current.progress, observation, now),
          headSha: snapshot.headSha,
          verdict: observation.verdict,
          ending: snapshot.state === "open" ? null : snapshot.state,
          fetchFailures: 0,
        }));
      }
    }
  }

  private recordFetchFailure(ids: readonly string[], error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const id of ids) {
      const updated = this.deps.store.update(id, (current) => ({ ...current, fetchFailures: current.fetchFailures + 1 }));
      if (updated === undefined) continue;
      this.deps.logger.warn("PR watch could not read a pull request", { subscriptionId: id, pullRequest: pullRequestLabel(updated.pr), error: message });
      if (updated.fetchFailures === FAILURES_BEFORE_NOTICE) {
        this.report(updated, `PR watch cannot read ${pullRequestLabel(updated.pr)} from GitHub: ${message}`);
      }
    }
  }

  /** Queue a notification when one is due, then attempt the queued delivery if its retry time has come. */
  private async notify(id: string, signal: AbortSignal): Promise<void> {
    const { store, settings } = this.deps;
    const now = this.deps.now();
    let subscription = store.find(id);
    if (subscription === undefined) return;
    if (subscription.outbox === null) {
      const recentWakes = subscription.wakes.filter((at) => now - at < HOUR_MS);
      // The final message is exempt from the hourly cap: it cannot loop, because it ends the subscription.
      const due = subscription.ending !== null
        || (readyToNotify(subscription.progress, now, settings) && recentWakes.length < settings.maxWakesPerHour);
      if (!due) return;
      const content = composeNotification({
        label: pullRequestLabel(subscription.pr), url: subscription.pr.url, title: subscription.pr.title,
        headSha: subscription.headSha, verdict: subscription.verdict, items: subscription.progress.pending,
        ...(subscription.ending === null ? {} : { ending: subscription.ending }),
      });
      const outbox = { id: this.deps.randomId(), content, createdAt: now, attempts: 0, nextAttemptAt: now, reported: false, final: subscription.ending !== null };
      subscription = store.update(id, (current) => ({ ...current, wakes: recentWakes, progress: clearPending(current.progress), outbox }));
    }
    const outbox = subscription?.outbox;
    if (subscription === undefined || outbox === undefined || outbox === null || outbox.nextAttemptAt > now) return;

    // The session may have been archived since validation at the start of this cycle.
    const selection = { projectId: subscription.projectId, workspaceId: subscription.workspaceId };
    const presence = (await sessionPresence(this.deps.catalog, selection, [subscription.sessionId], signal)).get(subscription.sessionId);
    if (presence?.kind === "archived") { this.remove(subscription, "session-archived"); return; }
    if (presence?.kind !== "present") return;

    let delivered = false;
    try {
      delivered = await this.deps.deliver({ ...selection, sessionId: subscription.sessionId }, {
        sessionId: subscription.sessionId, notificationId: outbox.id, content: outbox.content,
        details: { notificationId: outbox.id, subscriptionId: subscription.id, pullRequest: subscription.pr.url },
      }, signal);
    } catch (error) {
      signal.throwIfAborted();
      // Includes rejections reported by the companion extension, with their cause.
      this.deps.logger.warn("PR watch delivery failed", { subscriptionId: id, error: error instanceof Error ? error.message : String(error) });
    }
    const after = this.deps.now();
    const current = store.find(id);
    if (current?.outbox?.id !== outbox.id) return;
    if (delivered) {
      // An ordinary message acknowledged after the PR ended leaves the final message still to send.
      if (outbox.final && current.ending !== null) { this.remove(current, current.ending === "merged" ? "pr-merged" : "pr-closed"); return; }
      store.update(id, (latest) => ({ ...latest, outbox: null, wakes: [...latest.wakes.filter((at) => after - at < HOUR_MS), after] }));
      return;
    }
    const attempts = outbox.attempts + 1;
    const report = attempts >= DELIVERY_ATTEMPTS_BEFORE_NOTICE && !outbox.reported;
    store.update(id, (latest) => ({
      ...latest,
      outbox: { ...outbox, attempts, reported: outbox.reported || report, nextAttemptAt: after + Math.min(settings.pollIntervalMs * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS) },
    }));
    if (report) this.report(current, `PR watch could not deliver an update for ${pullRequestLabel(current.pr)} to its session after ${String(attempts)} attempts; it keeps retrying. Is the pr-watch Pi package loaded in that session?`);
  }

  private remove(subscription: Subscription, reason: RemovalReason): void {
    if (this.deps.store.remove(subscription.id, reason, this.deps.now()) === undefined) return;
    this.deps.logger.info("PR watch subscription removed", {
      subscriptionId: subscription.id, sessionId: subscription.sessionId, pullRequest: pullRequestLabel(subscription.pr), reason,
    });
  }

  private report(subscription: Subscription, message: string): void {
    try {
      this.deps.notice?.({
        severity: "warning", message,
        scope: { projectId: subscription.projectId, workspaceId: subscription.workspaceId, sessionId: subscription.sessionId },
      });
    } catch (error) {
      this.deps.logger.warn("PR watch could not record a notice", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function describe(subscription: Subscription): JsonValue {
  return {
    subscriptionId: subscription.id,
    pullRequest: pullRequestLabel(subscription.pr),
    url: subscription.pr.url,
    title: subscription.pr.title,
    subscribedAt: new Date(subscription.createdAt).toISOString(),
    pendingItems: subscription.progress.pending.length,
    awaitingDelivery: subscription.outbox !== null,
    ending: subscription.ending,
  };
}

function currentActivity(observation: Observation): JsonValue {
  return {
    reviewInProgress: observation.reviewInProgress,
    latestDecisiveReview: observation.verdict === null ? null : { ...observation.verdict },
    itemCount: observation.items.length,
    recentItems: observation.items.slice(-10).map((item) => ({ label: item.label, excerpt: item.excerpt, url: item.url })),
  };
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = groups.get(key(value));
    if (group === undefined) groups.set(key(value), [value]);
    else group.push(value);
  }
  return groups;
}

function refKey(ref: PullRequestRef): string {
  return JSON.stringify([ref.host, ref.owner.toLowerCase(), ref.repo.toLowerCase(), ref.number]);
}

function sameRef(left: PullRequestRef, right: PullRequestRef): boolean {
  return refKey(left) === refKey(right);
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => {
    const resolved = resolve(path);
    return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
  };
  return normalize(left) === normalize(right);
}
