import type { CheckRun, IssueComment, PullRequestSnapshot, Review, ReviewComment } from "./github.js";

export const CODERABBIT = "coderabbitai[bot]";
export const PR_URL = "https://github.com/owner/repo/pull/7";
export const HEAD = "a".repeat(40);

export function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return { url: PR_URL, title: "Add feature", state: "open", headSha: HEAD, reviews: [], reviewComments: [], issueComments: [], checkRuns: [], ...overrides };
}

export function review(id: number, state: string, overrides: Partial<Review> = {}): Review {
  return { id, author: CODERABBIT, state, submittedAt: null, commitId: HEAD, body: "**Actionable comments posted: 1**", url: `${PR_URL}#pullrequestreview-${String(id)}`, ...overrides };
}

export function reviewComment(id: number, overrides: Partial<ReviewComment> = {}): ReviewComment {
  return { id, author: CODERABBIT, path: "src/a.ts", line: 3, inReplyTo: null, body: "**Use a guard.**", url: `${PR_URL}#discussion_r${String(id)}`, ...overrides };
}

export function issueComment(id: number, overrides: Partial<IssueComment> = {}): IssueComment {
  return { id, author: CODERABBIT, updatedAt: "2026-01-01T00:00:00Z", body: "Review finished.", url: `${PR_URL}#issuecomment-${String(id)}`, ...overrides };
}

export function checkRun(id: number, status: "in_progress" | "completed", overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    id, app: "coderabbitai", name: "CodeRabbit", status, conclusion: status === "completed" ? "success" : null,
    title: status === "completed" ? "Review completed" : null, url: `https://github.com/owner/repo/runs/${String(id)}`, ...overrides,
  };
}
