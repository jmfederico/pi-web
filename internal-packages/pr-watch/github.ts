import type { ServerPluginExecFileRequest, ServerPluginExecFileResult } from "@jmfederico/pi-web/server-plugin-api";
import { record } from "./protocol.js";

export interface PullRequestRef {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface ResolvedPullRequest extends PullRequestRef {
  readonly url: string;
  readonly title: string;
  readonly state: PullRequestState;
}

export type PullRequestState = "open" | "closed" | "merged";

export interface Review {
  readonly id: number;
  readonly author: string;
  readonly state: string;
  readonly submittedAt: string | null;
  readonly commitId: string | null;
  readonly body: string;
  readonly url: string;
}

export interface ReviewComment {
  readonly id: number;
  readonly author: string;
  readonly path: string;
  readonly line: number | null;
  readonly inReplyTo: number | null;
  readonly body: string;
  readonly url: string;
}

export interface IssueComment {
  readonly id: number;
  readonly author: string;
  readonly updatedAt: string;
  readonly body: string;
  readonly url: string;
}

export interface CheckRun {
  readonly id: number;
  readonly app: string | null;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly title: string | null;
  readonly url: string;
}

/** Everything one poll reads about a pull request, already projected to small fields. */
export interface PullRequestSnapshot {
  readonly url: string;
  readonly title: string;
  readonly state: PullRequestState;
  readonly headSha: string;
  readonly reviews: readonly Review[];
  readonly reviewComments: readonly ReviewComment[];
  readonly issueComments: readonly IssueComment[];
  readonly checkRuns: readonly CheckRun[];
}

export interface GitHubReader {
  resolve(pr: string, cwd: string, signal: AbortSignal): Promise<ResolvedPullRequest>;
  snapshot(ref: PullRequestRef, signal: AbortSignal): Promise<PullRequestSnapshot>;
}

type ExecFile = (request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult>;

// Bodies are only excerpted, but markers such as CodeRabbit's rate-limit
// notice sit near the top. The cap keeps paginated output within host bounds.
const BODY = "body: ((.body // \"\") | .[0:8000])";
const REVIEW = `{id, author: .user.login, state, submittedAt: .submitted_at, commitId: .commit_id, ${BODY}, url: .html_url}`;
const REVIEW_COMMENT = `{id, author: .user.login, path, line: (.line // .original_line), inReplyTo: .in_reply_to_id, ${BODY}, url: .html_url}`;
const ISSUE_COMMENT = `{id, author: .user.login, updatedAt: .updated_at, ${BODY}, url: .html_url}`;
const CHECK_RUN = "{id, app: .app.slug, name, status, conclusion, title: .output.title, url: .html_url}";

/** Reads GitHub through the configured `gh`-compatible command; never writes. */
export function createGitHubReader(execFile: ExecFile, command: string): GitHubReader {
  async function gh(args: readonly string[], signal: AbortSignal, cwd?: string): Promise<string> {
    const result = await execFile({
      file: command, args, signal, timeoutMs: 30_000,
      env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", CLICOLOR: "0" },
      ...(cwd === undefined ? {} : { cwd }),
    });
    if (result.exitCode !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode ?? result.signal)}`).slice(0, 500);
      throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${detail}`);
    }
    if (result.stdoutTruncated) throw new Error(`${command} ${args.slice(0, 2).join(" ")} output exceeded the host limit`);
    return result.stdout;
  }
  const api = (ref: PullRequestRef, path: string, jq: string, signal: AbortSignal, paginate = true) => gh([
    // Always explicit: an inherited GH_HOST must not redirect a github.com reference.
    "api", "--hostname", ref.host, ...(paginate ? ["--paginate"] : []),
    `${path}${path.includes("?") ? "&" : "?"}per_page=100`, "--jq", jq,
  ], signal);
  const base = (ref: PullRequestRef) => `repos/${ref.owner}/${ref.repo}`;

  return {
    async resolve(pr, cwd, signal) {
      if (pr.startsWith("-")) throw new Error("Pull request must be a number, URL, or branch name");
      const output = record(JSON.parse(await gh(["pr", "view", pr, "--json", "number,url,state,title"], signal, cwd)), "gh pr view output");
      const url = text(output["url"], "url");
      const ref = parsePullRequestUrl(url);
      if (ref.number !== output["number"]) throw new Error("gh returned a mismatched pull request");
      return { ...ref, url, title: text(output["title"], "title"), state: prState(output["state"]) };
    },
    async snapshot(ref, signal) {
      const pull = record(JSON.parse(await api(ref, `${base(ref)}/pulls/${String(ref.number)}`,
        "{url: .html_url, title, state, merged, head: .head.sha}", signal, false)), "pull request");
      const headSha = text(pull["head"], "head");
      const [reviews, reviewComments, issueComments, checkRuns] = await Promise.all([
        api(ref, `${base(ref)}/pulls/${String(ref.number)}/reviews`, `.[] | ${REVIEW}`, signal),
        api(ref, `${base(ref)}/pulls/${String(ref.number)}/comments`, `.[] | ${REVIEW_COMMENT}`, signal),
        api(ref, `${base(ref)}/issues/${String(ref.number)}/comments`, `.[] | ${ISSUE_COMMENT}`, signal),
        api(ref, `${base(ref)}/commits/${headSha}/check-runs`, `.check_runs[] | ${CHECK_RUN}`, signal),
      ]);
      return {
        url: text(pull["url"], "url"),
        title: text(pull["title"], "title"),
        state: pull["merged"] === true ? "merged" : pull["state"] === "open" ? "open" : "closed",
        headSha,
        reviews: lines(reviews).map((row) => ({
          id: id(row), author: login(row), state: text(row["state"], "state"),
          submittedAt: nullableText(row["submittedAt"]), commitId: nullableText(row["commitId"]), body: body(row), url: text(row["url"], "url"),
        })),
        reviewComments: lines(reviewComments).map((row) => ({
          id: id(row), author: login(row), path: text(row["path"], "path"),
          line: typeof row["line"] === "number" ? row["line"] : null,
          inReplyTo: typeof row["inReplyTo"] === "number" ? row["inReplyTo"] : null,
          body: body(row), url: text(row["url"], "url"),
        })),
        issueComments: lines(issueComments).map((row) => ({
          id: id(row), author: login(row), updatedAt: text(row["updatedAt"], "updatedAt"), body: body(row), url: text(row["url"], "url"),
        })),
        checkRuns: lines(checkRuns).map((row) => ({
          id: id(row), app: nullableText(row["app"]), name: text(row["name"], "name"), status: text(row["status"], "status"),
          conclusion: nullableText(row["conclusion"]), title: nullableText(row["title"]), url: text(row["url"], "url"),
        })),
      };
    },
  };
}

export function parsePullRequestUrl(url: string): PullRequestRef {
  const match = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/u.exec(url);
  if (match === null) throw new Error(`Not a pull request URL: ${url}`);
  const [, host = "", owner = "", repo = "", number = ""] = match;
  return { host, owner, repo, number: Number(number) };
}

export function pullRequestLabel(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`;
}

function prState(value: unknown): PullRequestState {
  if (value === "OPEN") return "open";
  if (value === "MERGED") return "merged";
  if (value === "CLOSED") return "closed";
  throw new Error("gh returned an unknown pull request state");
}

function lines(output: string): Record<string, unknown>[] {
  return output.split("\n").filter((line) => line.trim() !== "").map((line) => record(JSON.parse(line), "gh api row"));
}

function id(row: Record<string, unknown>): number {
  const value = row["id"];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("gh api row has no numeric id");
  return value;
}

function login(row: Record<string, unknown>): string {
  return typeof row["author"] === "string" ? row["author"] : "";
}

function body(row: Record<string, unknown>): string {
  return typeof row["body"] === "string" ? row["body"] : "";
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`gh output is missing ${label}`);
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
