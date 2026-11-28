import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, PluginCatalogV1, PluginSessionSnapshot, ServerPluginNoticeInput } from "@jmfederico/pi-web/server-plugin-api";
import type { Deliver } from "./delivery.js";
import type { GitHubReader, PullRequestSnapshot, ResolvedPullRequest } from "./github.js";
import { PrWatchService } from "./service.js";
import { parseSettings } from "./settings.js";
import { SubscriptionStore, type RemovalReason } from "./store.js";
import { checkRun, issueComment, PR_URL, review, reviewComment, snapshot } from "./testSupport.js";

const roots: string[] = [];
const stores: SubscriptionStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const project = { id: "project", name: "Project", path: "/work/main" };
const workspace = { id: "workspace", projectId: project.id, path: "/work/feature", label: "feature", isMain: false };
const SESSION = "session-1";
const MINUTE = 60_000;

function sessionRow(id: string, archived = false): PluginSessionSnapshot {
  return { id, cwd: workspace.path, archived, created: null, modified: null, archivedAt: null, pinned: false, runtime: "not-hosted" };
}

interface Host {
  sessions: PluginSessionSnapshot[];
  workspaces: (typeof workspace)[];
  projects: (typeof project)[];
  sessionsError?: Error;
  projectsError?: Error;
}
type HostChange = (host: Host) => void;

async function fixture(settings: Record<string, JsonValue> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pr-watch-"));
  roots.push(root);
  const path = join(root, "subscriptions.json");
  const store = await SubscriptionStore.open(path, (error) => { throw error; });
  stores.push(store);
  let now = 1_000_000_000;
  let current: PullRequestSnapshot = snapshot();
  const resolved: ResolvedPullRequest = { host: "github.com", owner: "owner", repo: "repo", number: 7, url: PR_URL, title: "Add feature", state: "open" };
  const github = {
    resolve: vi.fn<GitHubReader["resolve"]>(() => Promise.resolve(resolved)),
    snapshot: vi.fn<GitHubReader["snapshot"]>(() => Promise.resolve(current)),
  };
  const host: Host = { sessions: [sessionRow(SESSION)], workspaces: [workspace], projects: [project] };
  const catalog: PluginCatalogV1 = {
    version: 1,
    projects: {
      list: () => host.projectsError === undefined ? Promise.resolve(host.projects) : Promise.reject(host.projectsError),
      get: () => Promise.reject(new Error("unused")),
    },
    workspaces: { list: () => Promise.resolve(host.workspaces), get: () => Promise.reject(new Error("unused")) },
    sessions: {
      list: () => host.sessionsError === undefined ? Promise.resolve(host.sessions) : Promise.reject(host.sessionsError),
      get: ({ sessionId }) => {
        const found = host.sessions.find((session) => session.id === sessionId);
        return found === undefined ? Promise.reject(new Error("Catalog selected session is stale or unavailable")) : Promise.resolve(found);
      },
    },
  };
  const deliver = vi.fn<Deliver>(() => Promise.resolve(true));
  const notice = vi.fn<(input: ServerPluginNoticeInput) => void>();
  let ids = 0;
  const service = new PrWatchService({
    store, github, catalog, deliver, notice,
    settings: parseSettings(settings),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => now,
    randomId: () => `id-${String(++ids)}`,
  });
  const signal = new AbortController().signal;
  const call = (operation: string, input: Record<string, JsonValue> = {}) => service.request(operation, { sessionId: SESSION, ...input }, signal);
  return {
    service, store, path, github, host, deliver, notice, call,
    subscribe: () => call("subscribe", { cwd: `${workspace.path}/`, pr: "7" }),
    cycle: () => service.cycle(signal),
    advance(ms: number) { now += ms; },
    setSnapshot(value: PullRequestSnapshot) { current = value; },
    delivered: () => deliver.mock.calls.map(([, message]) => message),
  };
}

describe("PR watch subscriptions", () => {
  it("baselines existing activity, then wakes once per quiet burst of CodeRabbit activity", async () => {
    const f = await fixture();
    f.setSnapshot(snapshot({ reviews: [review(1, "CHANGES_REQUESTED")] }));
    await expect(f.subscribe()).resolves.toMatchObject({
      alreadySubscribed: false,
      subscription: { subscriptionId: "id-1", pullRequest: "owner/repo#7" },
      current: { itemCount: 1, latestDecisiveReview: { state: "CHANGES_REQUESTED" } },
    });
    expect(f.github.resolve).toHaveBeenCalledWith("7", workspace.path, expect.any(AbortSignal));
    await expect(f.subscribe()).resolves.toMatchObject({ alreadySubscribed: true });
    expect(f.store.list()).toHaveLength(1);

    await f.cycle();
    expect(f.deliver).not.toHaveBeenCalled();

    const reviewing = { reviews: [review(1, "CHANGES_REQUESTED")], reviewComments: [reviewComment(10)], issueComments: [issueComment(20, { author: "jmfederico", body: "@coderabbitai review" })] };
    f.setSnapshot(snapshot({ ...reviewing, checkRuns: [checkRun(30, "in_progress")] }));
    f.advance(MINUTE);
    await f.cycle();
    f.advance(MINUTE);
    await f.cycle();
    expect(f.deliver).not.toHaveBeenCalled();

    f.setSnapshot(snapshot({ ...reviewing, reviews: [review(1, "CHANGES_REQUESTED"), review(2, "APPROVED", { body: "" })], checkRuns: [checkRun(30, "completed")] }));
    f.advance(MINUTE);
    await f.cycle();
    expect(f.deliver).not.toHaveBeenCalled();
    f.advance(MINUTE);
    await f.cycle();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    const [target, message] = f.deliver.mock.calls[0] ?? [];
    expect(target).toEqual({ projectId: project.id, workspaceId: workspace.id, sessionId: SESSION });
    expect(message?.details).toEqual({ notificationId: "id-2", subscriptionId: "id-1", pullRequest: PR_URL });
    expect(message?.content).toContain("Inline comment on src/a.ts:3");
    expect(message?.content).toContain("Review APPROVED");
    expect(message?.content).toContain('Check "CodeRabbit" success');
    expect(message?.content).toContain("latest decisive review: APPROVED on aaaaaaa (current head)");
    expect(message?.content).not.toContain("@coderabbitai review");

    f.advance(MINUTE);
    await f.cycle();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    await f.store.flush();
    const reopened = await SubscriptionStore.open(f.path, (error) => { throw error; });
    expect(reopened.list()).toMatchObject([{ id: "id-1", outbox: null, progress: { pending: [] } }]);
  });

  it("rejects malformed persisted entries at open without changing the file", async () => {
    const f = await fixture();
    await f.subscribe();
    await f.store.flush();
    const subscription = f.store.list()[0];
    if (subscription === undefined) throw new Error("Expected a persisted subscription");
    const invalid = [
      { subscriptions: [null], removals: [] },
      { subscriptions: [], removals: [null] },
      { subscriptions: [{ ...subscription, progress: { ...subscription.progress, seen: { review: null } } }], removals: [] },
      { subscriptions: [{ ...subscription, outbox: { id: "note" } }], removals: [] },
    ];
    for (const data of invalid) {
      const text = JSON.stringify({ version: 1, ...data });
      await writeFile(f.path, text);
      await expect(SubscriptionStore.open(f.path, (error) => { throw error; })).rejects.toThrow(`Unrecognized PR watch state in ${f.path}; move it aside to start empty`);
      expect(await readFile(f.path, "utf8")).toBe(text);
    }
  });

  it("rejects sessions outside registered workspaces and pull requests that are no longer open", async () => {
    const f = await fixture();
    await expect(f.call("subscribe", { cwd: "/elsewhere", pr: "7" })).rejects.toThrow("not a registered PI WEB workspace");
    f.github.resolve.mockResolvedValueOnce({ host: "github.com", owner: "owner", repo: "repo", number: 7, url: PR_URL, title: "Add feature", state: "merged" });
    await expect(f.subscribe()).rejects.toThrow("already merged");
    f.host.sessions = [sessionRow(SESSION, true)];
    await expect(f.subscribe()).rejects.toThrow("Archived");
    expect(f.store.list()).toEqual([]);
  });

  it("retries unconfirmed deliveries with the same notification and reports persistent failure once", async () => {
    const f = await fixture();
    await f.subscribe();
    f.setSnapshot(snapshot({ reviewComments: [reviewComment(10)] }));
    await f.cycle();
    f.advance(MINUTE);
    f.deliver.mockResolvedValue(false);
    await f.cycle();
    await f.cycle(); // Backoff: no immediate retry.
    expect(f.deliver).toHaveBeenCalledTimes(1);
    for (const delay of [1, 2, 4, 8]) {
      f.advance(delay * MINUTE);
      await f.cycle();
    }
    expect(f.deliver).toHaveBeenCalledTimes(5);
    expect(new Set(f.delivered().map((message) => message.notificationId))).toEqual(new Set(["id-2"]));
    expect(f.notice).toHaveBeenCalledTimes(1);
    expect(f.notice.mock.calls[0]?.[0]).toMatchObject({ severity: "warning", scope: { sessionId: SESSION } });

    // New activity waits behind the unacknowledged notification instead of racing it.
    f.setSnapshot(snapshot({ reviewComments: [reviewComment(10), reviewComment(11)] }));
    f.deliver.mockResolvedValue(true);
    f.advance(15 * MINUTE);
    await f.cycle();
    expect(f.delivered().at(-1)?.notificationId).toBe("id-2");
    f.advance(MINUTE);
    await f.cycle();
    expect(f.delivered().at(-1)?.notificationId).toBe("id-3");
    expect(f.delivered().at(-1)?.content).toContain("discussion_r11");
    expect(f.notice).toHaveBeenCalledTimes(1);
  });

  it("keeps busy deliveries pending without failure backoff or warnings", async () => {
    const f = await fixture();
    await f.subscribe();
    f.setSnapshot(snapshot({ reviewComments: [reviewComment(10)] }));
    await f.cycle();
    f.deliver.mockResolvedValue("busy");
    for (let poll = 0; poll < 6; poll++) {
      f.advance(MINUTE);
      await f.cycle();
    }
    expect(f.deliver).toHaveBeenCalledTimes(6);
    expect(f.store.list()[0]?.outbox).toMatchObject({ id: "id-2", attempts: 0 });
    expect(f.notice).not.toHaveBeenCalled();
    f.deliver.mockResolvedValue(true);
    f.advance(MINUTE);
    await f.cycle();
    expect(f.delivered().at(-1)?.notificationId).toBe("id-2");
    expect(f.store.list()[0]?.outbox).toBeNull();
  });

  it("caps wakes per hour without dropping activity", async () => {
    const f = await fixture({ maxWakesPerHour: 1 });
    await f.subscribe();
    f.setSnapshot(snapshot({ reviewComments: [reviewComment(10)] }));
    await f.cycle();
    f.advance(MINUTE);
    await f.cycle();
    f.setSnapshot(snapshot({ reviewComments: [reviewComment(10), reviewComment(11)] }));
    f.advance(MINUTE);
    await f.cycle();
    f.advance(30 * MINUTE);
    await f.cycle();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    f.advance(30 * MINUTE);
    await f.cycle();
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.delivered()[1]?.content).toContain("discussion_r11");
  });

  it("sends a final message when the pull request closes and then ends the subscription", async () => {
    const f = await fixture();
    await f.subscribe();
    f.setSnapshot(snapshot({ state: "merged", reviewComments: [reviewComment(10)] }));
    await f.cycle();
    expect(f.delivered()).toHaveLength(1);
    expect(f.delivered()[0]?.content).toContain("owner/repo#7 was merged");
    expect(f.delivered()[0]?.content).toContain("discussion_r10");
    expect(f.store.list()).toEqual([]);
    await expect(f.call("list")).resolves.toMatchObject({ subscriptions: [], recentRemovals: [{ reason: "pr-merged" }] });
  });

  it("keeps the subscription when an ordinary message is acknowledged after the pull request ends", async () => {
    const f = await fixture();
    await f.subscribe();
    f.setSnapshot(snapshot({ reviewComments: [reviewComment(10)] }));
    await f.cycle();
    f.advance(MINUTE);
    f.deliver.mockResolvedValueOnce(false);
    await f.cycle();
    f.setSnapshot(snapshot({ state: "closed", reviewComments: [reviewComment(10), reviewComment(11)] }));
    f.advance(MINUTE);
    await f.cycle(); // Retries the ordinary message; the pull request is now closed.
    expect(f.delivered().map((message) => message.notificationId)).toEqual(["id-2", "id-2"]);
    expect(f.store.list()).toHaveLength(1);
    await f.cycle();
    expect(f.delivered().at(-1)?.content).toContain("owner/repo#7 was closed");
    expect(f.delivered().at(-1)?.content).toContain("discussion_r11");
    expect(f.store.list()).toEqual([]);
  });

  it("rejects a subscription whose baseline shows the pull request already ended", async () => {
    const f = await fixture();
    f.setSnapshot(snapshot({ state: "merged" }));
    await expect(f.subscribe()).rejects.toThrow("already merged");
    expect(f.store.list()).toEqual([]);
  });

  it("reports GitHub read failures once per failure streak", async () => {
    const f = await fixture();
    await f.subscribe();
    f.github.snapshot.mockRejectedValue(new Error("HTTP 401"));
    for (let cycle = 0; cycle < 4; cycle += 1) await f.cycle();
    expect(f.notice).toHaveBeenCalledTimes(1);
    expect(f.notice.mock.calls[0]?.[0]).toMatchObject({ severity: "warning" });
    expect(f.notice.mock.calls[0]?.[0].message).toContain("HTTP 401");
    expect(f.service.health()).toMatchObject({ status: "degraded" });
    f.github.snapshot.mockResolvedValue(snapshot());
    await f.cycle();
    expect(f.service.health()).toEqual({ status: "healthy" });
  });

  it("unsubscribes only the caller's subscription and expires old ones", async () => {
    const f = await fixture({ maxAgeDays: 1 });
    await f.subscribe();
    await expect(f.service.request("unsubscribe", { sessionId: "other", subscriptionId: "id-1" }, new AbortController().signal)).rejects.toThrow("No such subscription");
    await expect(f.call("unsubscribe", { subscriptionId: "id-1" })).resolves.toMatchObject({ removed: { subscriptionId: "id-1" } });
    await f.subscribe();
    f.advance(24 * 60 * MINUTE + 1);
    await f.cycle();
    expect(f.github.snapshot).toHaveBeenCalledTimes(2); // Subscribe baselines only; expired ones are not polled.
    await expect(f.call("list")).resolves.toMatchObject({ recentRemovals: [{ reason: "unsubscribed" }, { reason: "expired" }] });
  });
});

describe("PR watch subscription validation", () => {
  it("removes an archived session's subscription at the next check", async () => {
    const f = await fixture();
    await f.subscribe();
    f.host.sessions = [sessionRow(SESSION, true)];
    await f.cycle();
    expect(f.store.list()).toEqual([]);
    expect(f.github.snapshot).toHaveBeenCalledTimes(1);
    await expect(f.call("list")).resolves.toMatchObject({ recentRemovals: [{ reason: "session-archived" }] });
  });

  it.each<[RemovalReason, HostChange]>([
    ["session-deleted", (host: Host) => { host.sessions = []; }],
    ["workspace-removed", (host: Host) => { host.sessionsError = new Error("Catalog selected workspace is stale or unavailable"); host.workspaces = []; }],
    ["project-removed", (host: Host) => { host.sessionsError = new Error("Unknown project"); host.projects = []; }],
  ])("removes a subscription after two consecutive confirmations: %s", async (reason, change) => {
    const f = await fixture();
    await f.subscribe();
    change(f.host);
    await f.cycle();
    expect(f.store.list()).toMatchObject([{ missing: { count: 1, reason } }]);
    await f.cycle();
    expect(f.store.list()).toEqual([]);
    await expect(f.call("list")).resolves.toMatchObject({ recentRemovals: [{ reason }] });
  });

  it("does not let an inconclusive check interrupt an absence streak", async () => {
    const f = await fixture();
    await f.subscribe();
    f.host.sessions = [];
    await f.cycle();
    f.host.sessionsError = new Error("stale or unavailable");
    f.host.projectsError = new Error("daemon starting");
    await f.cycle();
    expect(f.store.list()).toMatchObject([{ missing: { count: 1 } }]);
    delete f.host.sessionsError;
    delete f.host.projectsError;
    await f.cycle();
    expect(f.store.list()).toEqual([]);
  });

  it("resets the absence count when the session reappears", async () => {
    const f = await fixture();
    await f.subscribe();
    f.host.sessions = [];
    await f.cycle();
    f.host.sessions = [sessionRow(SESSION)];
    await f.cycle();
    f.host.sessions = [];
    await f.cycle();
    expect(f.store.list()).toMatchObject([{ missing: { count: 1 } }]);
  });

  it.each<[string, HostChange]>([
    ["the catalog is unreadable", (host: Host) => { host.sessionsError = new Error("stale or unavailable"); host.projectsError = new Error("daemon starting"); }],
    ["the workspace still exists", (host: Host) => { host.sessionsError = new Error("Workspace discovery is not ready"); }],
  ])("keeps subscriptions when %s", async (_case, change) => {
    const f = await fixture();
    await f.subscribe();
    change(f.host);
    for (let cycle = 0; cycle < 3; cycle += 1) await f.cycle();
    expect(f.store.list()).toMatchObject([{ id: "id-1", missing: null }]);
  });

  it("does not deliver to a session archived after the cycle's validation", async () => {
    const f = await fixture();
    await f.subscribe();
    f.setSnapshot(snapshot({ reviewComments: [reviewComment(10)] }));
    await f.cycle();
    f.advance(MINUTE);
    f.github.snapshot.mockImplementationOnce(() => {
      f.host.sessions = [sessionRow(SESSION, true)];
      return Promise.resolve(snapshot({ reviewComments: [reviewComment(10)] }));
    });
    await f.cycle();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.store.list()).toEqual([]);
  });
});
