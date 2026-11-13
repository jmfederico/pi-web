import { describe, expect, it, vi } from "vitest";
import reconcile from "../.github/scripts/coderabbit-merge.cjs";

const sha = "a".repeat(40);
const repo = { full_name: "jmfederico/pi-web" };

function pull(overrides = {}) {
  return {
    number: 42,
    state: "open",
    draft: false,
    user: { login: "jmfederico" },
    head: { sha, repo },
    base: { sha: "b".repeat(40), ref: "main", repo },
    labels: [],
    mergeable: true,
    mergeable_state: "clean",
    changed_files: 1,
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    id: 10,
    user: { login: "coderabbitai[bot]", id: 136622811 },
    state: "APPROVED",
    commit_id: sha,
    submitted_at: "2026-11-01T10:00:00Z",
    ...overrides,
  };
}

function harness({ initial = pull(), current = initial, reviews = [review()], finalReviews = reviews,
  files = [{ filename: "src/server/index.ts" }] } = {}) {
  const pulls = {
    list: vi.fn(),
    listReviews: vi.fn(),
    listFiles: vi.fn(),
    get: vi.fn().mockResolvedValueOnce({ data: initial }).mockResolvedValue({ data: current }),
    merge: vi.fn().mockResolvedValue({ data: { merged: true } }),
  };
  let reviewReads = 0;
  const paginate = vi.fn(async (endpoint) => {
    if (endpoint === pulls.list) return [{ number: 42 }];
    if (endpoint === pulls.listReviews) return reviewReads++ === 0 ? reviews : finalReviews;
    if (endpoint === pulls.listFiles) return files;
    throw new Error("Unexpected endpoint");
  });
  const core = { notice: vi.fn(), info: vi.fn() };
  return { pulls, paginate, core, run: () => reconcile({ github: { rest: { pulls }, paginate }, core }) };
}

async function expectSkipped(options) {
  const h = harness(options);
  await h.run();
  expect(h.pulls.merge).not.toHaveBeenCalled();
  expect(h.core.notice).toHaveBeenCalled();
  return h;
}

describe("CodeRabbit merge controller", () => {
  it("merges an eligible PR using a head precondition after fresh API reads", async () => {
    const h = harness();
    await h.run();
    expect(h.pulls.merge).toHaveBeenCalledExactlyOnceWith({
      owner: "jmfederico", repo: "pi-web", pull_number: 42, sha, merge_method: "merge",
    });
    expect(h.pulls.get).toHaveBeenCalledTimes(2);
    expect(h.paginate.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      h.pulls.list, h.pulls.listReviews, h.pulls.listFiles, h.pulls.listReviews,
    ]);
    for (const [, args] of h.paginate.mock.calls) expect(args.per_page).toBe(100);
    expect(h.pulls.merge.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.paginate.mock.invocationCallOrder.at(-1),
    );
  });

  it("merges the personal agent\'s PR only with independent CodeRabbit approval", async () => {
    const initial = pull({ user: { id: 356431845, login: "federico-agent[bot]", type: "Bot" } });
    const h = harness({ initial });
    await h.run();
    expect(h.pulls.merge).toHaveBeenCalledOnce();
    await expectSkipped({ initial, reviews: [review({ user: initial.user })] });
  });

  it.each([
    ["another author", { user: { login: "contributor" } }],
    ["a different bot with the agent name", { user: { id: 123, login: "federico-agent[bot]", type: "Bot" } }],
    ["an unexpected agent identity", { user: { id: 356431845, login: "other[bot]", type: "Bot" } }],
    ["a fork, even for the allowed author", { head: { sha, repo: { full_name: "other/pi-web" } } }],
    ["a deleted head repository", { head: { sha, repo: null } }],
    ["another base branch", { base: { ref: "release", repo } }],
    ["another base repository", { base: { ref: "main", repo: { full_name: "other/pi-web" } } }],
    ["a draft", { draft: true }],
    ["a closed PR", { state: "closed" }],
    ["the escape-hatch label", { labels: [{ name: "do-not-merge" }] }],
    ["unknown mergeability", { mergeable: null }],
    ["blocked checks or reviews", { mergeable_state: "blocked" }],
    ["unstable checks", { mergeable_state: "unstable" }],
    ["a merge conflict", { mergeable: false, mergeable_state: "dirty" }],
  ])("does not merge %s", async (_name, overrides) => {
    await expectSkipped({ initial: pull(overrides) });
  });

  it.each([
    ["missing review", []],
    ["stale approval", [review({ commit_id: "old-head" })]],
    ["comment-only review", [review({ state: "COMMENTED" })]],
    ["pending review", [review({ state: "PENDING" })]],
    ["dismissed approval", [review({ state: "DISMISSED" })]],
    ["changes requested", [review({ state: "CHANGES_REQUESTED" })]],
    ["unknown decision", [review({ state: "UNKNOWN" })]],
    ["a different account ID", [review({ user: { login: "coderabbitai[bot]", id: 123 } })]],
    ["a different account name", [review({ user: { login: "other[bot]", id: 136622811 } })]],
  ])("rejects %s", async (_name, reviews) => {
    await expectSkipped({ reviews });
  });

  it("honors the newest effective bot decision, not an old approval on an earlier page", async () => {
    const reviews = [review(), ...Array.from({ length: 100 }, (_, i) => review({
      id: 20 + i, state: "COMMENTED", user: { login: "someone-else", id: 1 },
    })), review({ id: 200, state: "CHANGES_REQUESTED", submitted_at: "2026-11-01T11:00:00Z" })];
    await expectSkipped({ reviews });
  });

  it("orders decisions by submission time rather than response position or creation ID", async () => {
    const h = harness({ reviews: [
      review({ id: 1, submitted_at: "2026-11-01T12:00:00Z" }),
      review({ id: 20, state: "CHANGES_REQUESTED" }),
      review({ id: 30, state: "COMMENTED", submitted_at: "2026-11-01T13:00:00Z" }),
    ] });
    await h.run();
    expect(h.pulls.merge).toHaveBeenCalledOnce();
  });

  it.each([".github/workflows/ci.yml", ".coderabbit.yaml", "AGENTS.md", ".agents/skills/policy.md"])(
    "requires manual merging for %s, including renames away from it", async (path) => {
      await expectSkipped({ files: [{ filename: path }] });
      await expectSkipped({ files: [{ filename: "ordinary-file.md", previous_filename: path }] });
    },
  );

  it("checks sensitive files beyond the first API page", async () => {
    const files = [...Array.from({ length: 100 }, (_, i) => ({ filename: `src/${i}.ts` })),
      { filename: ".github/scripts/controller.cjs" }];
    await expectSkipped({ initial: pull({ changed_files: files.length }), files });
  });

  it("requires a complete changed-file listing", async () => {
    await expectSkipped({ initial: pull({ changed_files: 3001 }) });
  });

  it.each([
    ["head push", { head: { sha: "c".repeat(40), repo } }],
    ["base update", { base: { sha: "d".repeat(40), ref: "main", repo } }],
    ["new escape-hatch label", { labels: [{ name: "do-not-merge" }] }],
    ["draft conversion", { draft: true }],
    ["retargeting", { base: { sha: "b".repeat(40), ref: "release", repo } }],
    ["new merge block", { mergeable_state: "blocked" }],
  ])("stops when a %s happens during inspection", async (_name, overrides) => {
    await expectSkipped({ current: pull(overrides) });
  });

  it.each(["DISMISSED", "CHANGES_REQUESTED"])("rechecks reviews and stops on %s", async (state) => {
    await expectSkipped({ finalReviews: [review({ state })] });
  });

  it.each([405, 409])("reports an expected merge race (HTTP %s) without claiming success", async (status) => {
    const h = harness();
    h.pulls.merge.mockRejectedValue(Object.assign(new Error("Not mergeable"), { status }));
    await h.run();
    expect(h.core.notice).toHaveBeenCalled();
    expect(h.core.info).not.toHaveBeenCalled();
  });

  it("reports a declined merge response without claiming success", async () => {
    const h = harness();
    h.pulls.merge.mockResolvedValue({ data: { merged: false, message: "Not ready" } });
    await h.run();
    expect(h.core.notice).toHaveBeenCalled();
    expect(h.core.info).not.toHaveBeenCalled();
  });

  it.each([401, 403, 422, 429, 500])("does not swallow unexpected merge errors (HTTP %s)", async (status) => {
    const h = harness();
    const error = Object.assign(new Error("API failure"), { status });
    h.pulls.merge.mockRejectedValue(error);
    await expect(h.run()).rejects.toBe(error);
  });

  it("fails closed on a review API error", async () => {
    const h = harness();
    const error = new Error("Review listing failed");
    h.paginate.mockResolvedValueOnce([{ number: 42 }]).mockRejectedValueOnce(error);
    await expect(h.run()).rejects.toBe(error);
    expect(h.pulls.merge).not.toHaveBeenCalled();
  });
});
