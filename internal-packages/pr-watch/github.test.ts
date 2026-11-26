import { describe, expect, it, vi } from "vitest";
import type { ServerPluginExecFileRequest, ServerPluginExecFileResult } from "@jmfederico/pi-web/server-plugin-api";
import { createGitHubReader } from "./github.js";

const signal = new AbortController().signal;
const ok = (stdout: string): ServerPluginExecFileResult => ({ exitCode: 0, signal: null, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false });

describe("GitHub reader", () => {
  it("resolves a pull request in the workspace and reads paginated activity rows", async () => {
    const execFile = vi.fn((request: ServerPluginExecFileRequest) => {
      const args = request.args ?? [];
      if (args[0] === "pr") return Promise.resolve(ok(JSON.stringify({ number: 7, url: "https://ghe.example/owner/repo/pull/7", state: "OPEN", title: "Add feature" })));
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.startsWith("repos/owner/repo/pulls/7?")) return Promise.resolve(ok(JSON.stringify({ url: "https://ghe.example/owner/repo/pull/7", title: "Add feature", state: "closed", merged: true, head: "abc" })));
      if (path.includes("/reviews")) return Promise.resolve(ok(`${JSON.stringify({ id: 1, author: "coderabbitai[bot]", state: "APPROVED", submittedAt: "t", commitId: "abc", body: "", url: "u" })}\n`));
      if (path.includes("/check-runs")) {
        expect(path).toMatch(/^repos\/owner\/repo\/commits\/abc\/check-runs\?/u);
        return Promise.resolve(ok(""));
      }
      return Promise.resolve(ok(""));
    });
    const reader = createGitHubReader(execFile, "/bin/gh-agent");
    const resolved = await reader.resolve("7", "/work/feature", signal);
    expect(resolved).toEqual({ host: "ghe.example", owner: "owner", repo: "repo", number: 7, url: "https://ghe.example/owner/repo/pull/7", title: "Add feature", state: "open" });
    expect(execFile.mock.calls[0]?.[0]).toMatchObject({ file: "/bin/gh-agent", cwd: "/work/feature", args: ["pr", "view", "7", "--json", "number,url,state,title"] });

    const snapshot = await reader.snapshot(resolved, signal);
    expect(snapshot).toMatchObject({ state: "merged", headSha: "abc", reviews: [{ id: 1, state: "APPROVED" }], reviewComments: [], checkRuns: [] });
    // Enterprise hosts need an explicit hostname; every list is paginated.
    for (const [request] of execFile.mock.calls.slice(1)) expect(request.args?.slice(0, 3)).toEqual(["api", "--hostname", "ghe.example"]);
    expect(execFile.mock.calls.filter(([request]) => request.args?.includes("--paginate") === true)).toHaveLength(4);
  });

  it("rejects option-like input and surfaces command failures and truncation", async () => {
    const execFile = vi.fn<(request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult>>(() => Promise.resolve({ ...ok(""), exitCode: 1, stderr: "HTTP 401: Bad credentials" }));
    const reader = createGitHubReader(execFile, "gh");
    await expect(reader.resolve("--repo=evil/repo", "/work", signal)).rejects.toThrow("must be a number");
    expect(execFile).not.toHaveBeenCalled();
    await expect(reader.resolve("7", "/work", signal)).rejects.toThrow("HTTP 401");
    execFile.mockResolvedValue({ ...ok("{}"), stdoutTruncated: true });
    await expect(reader.snapshot({ host: "github.com", owner: "o", repo: "r", number: 1 }, signal)).rejects.toThrow("exceeded");
  });
});
