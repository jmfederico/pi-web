import type { PullRequestSnapshot } from "./github.js";

/** One reviewer action worth telling a session about. */
export interface ActivityItem {
  readonly key: string;
  readonly label: string;
  readonly excerpt: string;
  readonly url: string;
}

/** What one snapshot says, independently of what a subscriber has already seen. */
export interface Observation {
  /** Fingerprint of every tracked reviewer artifact, notifiable or not. */
  readonly fingerprints: Readonly<Record<string, string>>;
  /** Artifacts that should reach the session when their fingerprint is new. */
  readonly items: readonly ActivityItem[];
  /** A reviewer check on the head commit has not completed: more output is coming. */
  readonly reviewInProgress: boolean;
  readonly verdict: Verdict | null;
}

/** The reviewer's latest decisive review, which is what merge automation consults. */
export interface Verdict {
  readonly state: string;
  readonly commitId: string | null;
  readonly currentHead: boolean;
}

/** Per-subscriber progress. Times are epoch milliseconds. */
export interface WatchProgress {
  readonly seen: Readonly<Record<string, string>>;
  readonly pending: readonly ActivityItem[];
  readonly firstPendingAt: number | null;
  readonly lastActivityAt: number | null;
  readonly reviewInProgress: boolean;
}

export interface FlushPolicy {
  /** Wait this long after the last new item so a burst becomes one wake. */
  readonly quietMs: number;
  /** Deliver anyway when a reviewer check appears stuck in progress. */
  readonly maxHoldMs: number;
}

const SUMMARY_MARKER = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->";
const RATE_LIMIT_START = "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->";
const RATE_LIMIT_END = "<!-- end of auto-generated comment: rate limited by coderabbit.ai -->";
const DECISIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * Projects a snapshot onto the configured reviewer accounts. Bot logins such as
 * `coderabbitai[bot]` also select check runs from the App slug `coderabbitai`.
 * The walkthrough summary is rewritten on every review and is ignored, except
 * for its rate-limit notice, which tells the agent why no review is coming.
 */
export function observe(snapshot: PullRequestSnapshot, authors: readonly string[]): Observation {
  const logins = new Set(authors);
  const apps = new Set(authors.map((login) => login.replace(/\[bot\]$/u, "")));
  const fingerprints: Record<string, string> = {};
  const items: ActivityItem[] = [];
  const track = (key: string, fingerprint: string, item?: Omit<ActivityItem, "key">) => {
    fingerprints[key] = fingerprint;
    if (item !== undefined) items.push({ key, ...item });
  };

  for (const review of snapshot.reviews) {
    if (!logins.has(review.author)) continue;
    const summary = excerpt(review.body);
    // Automatic dismissals follow pushes; empty COMMENTED reviews only wrap thread replies listed separately.
    const notifiable = review.state !== "DISMISSED" && review.state !== "PENDING" && !(review.state === "COMMENTED" && summary === "");
    track(`review:${String(review.id)}`, review.state, notifiable
      ? { label: `Review ${review.state}${review.commitId === null ? "" : ` on ${shortSha(review.commitId)}`}`, excerpt: summary, url: review.url }
      : undefined);
  }
  for (const comment of snapshot.reviewComments) {
    if (!logins.has(comment.author)) continue;
    // Later edits mark findings addressed; only the original post needs attention.
    const location = `${comment.path}${comment.line === null ? "" : `:${String(comment.line)}`}`;
    track(`review-comment:${String(comment.id)}`, "posted", {
      label: comment.inReplyTo === null ? `Inline comment on ${location}` : `Thread reply on ${location}`,
      excerpt: excerpt(comment.body), url: comment.url,
    });
  }
  for (const comment of snapshot.issueComments) {
    if (!logins.has(comment.author)) continue;
    if (comment.body.includes(SUMMARY_MARKER)) {
      const notice = section(comment.body, RATE_LIMIT_START, RATE_LIMIT_END);
      if (notice !== undefined) track(`rate-limit:${String(comment.id)}`, "notice", { label: "Rate-limit notice", excerpt: excerpt(notice), url: comment.url });
      continue;
    }
    // Command replies are posted as placeholders and completed by edits.
    track(`comment:${String(comment.id)}`, comment.updatedAt, { label: "Comment", excerpt: excerpt(comment.body), url: comment.url });
  }
  let reviewInProgress = false;
  for (const run of snapshot.checkRuns) {
    if (run.app === null || !apps.has(run.app)) continue;
    const completed = run.status === "completed";
    if (!completed) reviewInProgress = true;
    track(`check:${String(run.id)}`, `${run.status}:${run.conclusion ?? ""}`, completed
      ? { label: `Check "${run.name}" ${run.conclusion ?? "completed"}`, excerpt: excerpt(run.title ?? ""), url: run.url }
      : undefined);
  }

  const decisive = snapshot.reviews.filter((review) => logins.has(review.author) && DECISIVE_REVIEW_STATES.has(review.state)).at(-1);
  return {
    fingerprints, items, reviewInProgress,
    verdict: decisive === undefined ? null : { state: decisive.state, commitId: decisive.commitId, currentHead: decisive.commitId === snapshot.headSha },
  };
}

export function initialProgress(observation: Observation): WatchProgress {
  return { seen: { ...observation.fingerprints }, pending: [], firstPendingAt: null, lastActivityAt: null, reviewInProgress: observation.reviewInProgress };
}

/**
 * Queues items whose fingerprint changed since the last observation. `seen` is
 * replaced rather than merged so that a disappearing notice can appear again.
 */
export function applyObservation(progress: WatchProgress, observation: Observation, now: number): WatchProgress {
  const fresh = observation.items.filter((item) => progress.seen[item.key] !== observation.fingerprints[item.key]);
  if (fresh.length === 0) return { ...progress, seen: { ...observation.fingerprints }, reviewInProgress: observation.reviewInProgress };
  const freshKeys = new Set(fresh.map((item) => item.key));
  return {
    seen: { ...observation.fingerprints },
    pending: [...progress.pending.filter((item) => !freshKeys.has(item.key)), ...fresh],
    firstPendingAt: progress.firstPendingAt ?? now,
    lastActivityAt: now,
    reviewInProgress: observation.reviewInProgress,
  };
}

export function readyToNotify(progress: WatchProgress, now: number, policy: FlushPolicy): boolean {
  if (progress.pending.length === 0 || progress.firstPendingAt === null || progress.lastActivityAt === null) return false;
  if (progress.reviewInProgress && now - progress.firstPendingAt < policy.maxHoldMs) return false;
  return now - progress.lastActivityAt >= policy.quietMs;
}

export function clearPending(progress: WatchProgress): WatchProgress {
  return { ...progress, pending: [], firstPendingAt: null, lastActivityAt: null };
}

/**
 * Plain-text excerpt of a GitHub Markdown/HTML body without hidden content.
 * Collapsed sections are dropped unless they hold all visible text, as in
 * CodeRabbit's command replies.
 */
export function excerpt(body: string, max = 240): string {
  const text = plainText(body, true) || plainText(body, false);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function plainText(body: string, dropCollapsed: boolean): string {
  let text = body.replace(/<!--[\s\S]*?(?:-->|$)/gu, " ");
  if (dropCollapsed) {
    let previous: string;
    do {
      previous = text;
      text = text.replace(/<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/giu, " ");
    } while (text !== previous);
    text = text.replace(/<details\b[\s\S]*$/iu, " ");
  }
  return text
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gu, " ")
    .replace(/(^|\s)(?:>|#{1,6}|-{3,})(?=\s)/gu, "$1")
    .replace(/[*_`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function section(body: string, start: string, end: string): string | undefined {
  const from = body.indexOf(start);
  if (from === -1) return undefined;
  const to = body.indexOf(end, from + start.length);
  return body.slice(from + start.length, to === -1 ? undefined : to);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
