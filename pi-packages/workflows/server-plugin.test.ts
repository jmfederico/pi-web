import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type JsonValue,
  type PiWebHostPiSessionRunCompletion,
  type PiWebHostPiSessionsV1,
  type PluginCatalogWorkspace,
  type ServerPluginActivationContextV5,
  type ServerPluginExecFileRequest,
  type ServerPluginExecFileResult,
  type ServerPluginPeerScope,
} from "@jmfederico/pi-web/server-plugin-api";
import plugin from "./server-plugin.js";

// Pi does not export these helpers publicly; test its real argument expansion.
import { parseCommandArgs, substituteArgs } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";

const project = { id: "opaque-project", name: "Project", path: "/not-the-main" };
const main: PluginCatalogWorkspace = {
  id: "host-main-id", projectId: project.id, path: "/actual main", label: "Main", isMain: true,
};
const signal = new AbortController().signal;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function success(stdout = ""): ServerPluginExecFileResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false };
}

async function fixture(exec?: ServerPluginActivationContextV5["execFile"]) {
  const list = vi.fn((): Promise<readonly PluginCatalogWorkspace[]> => Promise.resolve([
    { ...main, id: "linked-id", isMain: false, path: "/linked" }, main,
  ]));
  const run = vi.fn<PiWebHostPiSessionsV1["run"]>(() => Promise.resolve({ sessionId: "fresh-session", completion: Promise.resolve<PiWebHostPiSessionRunCompletion>({ status: "completed" }) }));
  const execFile = vi.fn(exec ?? (({ args }) => {
    if (args?.includes("--is-inside-work-tree") === true) return Promise.resolve(success("true\n"));
    if (args?.includes("--is-bare-repository") === true) return Promise.resolve(success("false\n"));
    if (args?.includes("for-each-ref") === true) return Promise.resolve(success("refs/heads/main\nrefs/remotes/origin/main\nrefs/heads/main\n"));
    if (args?.includes("--abbrev-ref") === true) return Promise.resolve(success("main\n"));
    return Promise.resolve(success("commit\n"));
  }));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const activation = await plugin.activate({
    apiVersion: 5, pluginId: "workflows", packageRoot: "/package", dataDirectory: "/data",
    settings: {}, signal, lifetimeSignal: signal, logger, execFile,
  });
  await activation.start?.({
    signal,
    capabilities: {
      resolve(capability) {
        return capability.parse(capability.id === "catalog" ? {
          version: 1,
          projects: { list: () => Promise.resolve([project]), get: () => Promise.resolve(project) },
          workspaces: { list, get: () => Promise.resolve(main) },
          sessions: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("Unused")) },
        } : { version: 1, run, create: () => Promise.resolve({ sessionId: "unused" }) });
      },
    },
  });
  const peer = activation.peer;
  if (peer?.request === undefined) throw new Error("Expected request peer");
  return {
    list, run, execFile, logger,
    request: (operation: string, input: JsonValue = null, scope: ServerPluginPeerScope = { kind: "project", project }) =>
      peer.request({ operation, input, scope, signal }),
  };
}

describe("Workflows v5 project peer", () => {
  it("prepares using the catalog main, deduplicates local/remote branches, and sanitizes Git", async () => {
    const f = await fixture();
    expect(plugin.apiVersion).toBe(5);
    await expect(f.request("prepare")).resolves.toEqual({
      workspaceId: main.id, workspacePath: main.path, branches: ["main", "origin/main"], defaultBase: "main",
    });
    expect(f.list).toHaveBeenCalledWith(project.id, { signal });
    for (const [command] of f.execFile.mock.calls) {
      expect(command).toMatchObject({ file: "git", cwd: main.path, signal, timeoutMs: 10_000 });
      expect(command.unsetEnv).toEqual(expect.arrayContaining(["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_COUNT", "GIT_INDEX_FILE"]));
    }
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rediscovers main for dispatch and invokes /worktree in a fresh session",  async () => {
    const f = await fixture();
    await f.request("prepare");
    const replacement = { ...main, id: "new-authoritative-id", path: "/new main" };
    f.list.mockResolvedValue([replacement]);
    const base = "--upload-pack=$(touch /tmp/never);main";
    const description = "Investigate user's <worktree_request>, \"quotes\", $1 and $ARGUMENTS\nwithout losing spacing  or backslashes \\";
    await expect(f.request("dispatch", { base, description })).resolves.toEqual({ workspaceId: replacement.id, sessionId: "fresh-session" });
    expect(f.execFile).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: replacement.path, args: ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    }));
    expect(f.run).toHaveBeenCalledOnce();
    const submission = f.run.mock.calls[0]?.[0];
    expect(submission).toMatchObject({ projectId: project.id, workspaceId: replacement.id });
    const command = submission?.prompt;
    if (command === undefined) throw new Error("Missing worktree command");
    expect(command).toMatch(/^\/worktree /u);
    const args = parseCommandArgs(command.slice("/worktree ".length));
    expect(args).toHaveLength(1);
    expect(substituteArgs("$ARGUMENTS", args)).toBe(`base: ${base}\n\ndescription:\n${description}`);
  });

  it.each([
    null, [], {}, { base: "", description: "purpose" }, { base: "main", description: "  " },
    { base: "main\0", description: "purpose" }, { base: "a".repeat(1025), description: "purpose" },
    { base: "main", description: "é".repeat(8193) }, { base: "main", description: "purpose", workspaceId: "guessed" },
  ].map((input) => ({ input })))("rejects invalid dispatch input without creating a session: %j", async ({ input }) => {
    const f = await fixture();
    await expect(f.request("dispatch", input)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.execFile).not.toHaveBeenCalled();
  });

  it("rejects wrong scopes and unknown operations", async () => {
    const f = await fixture();
    for (const scope of [{ kind: "machine" }, { kind: "workspace", project, workspace: main }] as const) {
      await expect(f.request("prepare", null, scope)).rejects.toThrow("project scope");
    }
    await expect(f.request("unknown")).rejects.toThrow("Unknown");
    expect(f.list).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [main, { ...main, id: "second" }] }, { rows: [{ ...main, projectId: "other" }] }])("fails closed on invalid main authority: %j", async ({ rows }) => {
    const f = await fixture();
    f.list.mockResolvedValue(rows);
    await expect(f.request("dispatch", { base: "main", description: "purpose" })).rejects.toThrow();
    expect(f.execFile).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([
    { ...success(), exitCode: 128, stderr: "not a repository or missing revision" },
    { ...success(), signal: "SIGTERM" },
    { ...success(), stdoutTruncated: true },
    { ...success(), stderrTruncated: true },
  ])("rejects unsuccessful or incomplete Git results: %j", async (result) => {
    const f = await fixture(() => Promise.resolve(result));
    await expect(f.request("dispatch", { base: "main", description: "purpose" })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["failed", "rejected", "cancelled"])("logs observable initial completion %s", async (status) => {
    const f = await fixture();
    const completion: Promise<PiWebHostPiSessionRunCompletion> = status === "rejected"
      ? Promise.reject(new Error("provider unavailable"))
      : Promise.resolve(status === "failed" ? { status, error: "provider unavailable" } : { status: "cancelled" });
    // Attach immediately before the run consumes this already-settled promise.
    void completion.catch(() => undefined);
    f.run.mockResolvedValue({ sessionId: "fresh-session", completion });
    await f.request("dispatch", { base: "main", description: "purpose" });
    await vi.waitFor(() => {
      expect(status === "cancelled" ? f.logger.warn : f.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Workflows initial worktree task"), expect.objectContaining({ projectId: project.id, workspaceId: main.id, sessionId: "fresh-session" }),
      );
    });
  });

  it("propagates catalog and session admission errors", async () => {
    const f = await fixture();
    f.list.mockRejectedValueOnce(new Error("catalog unavailable"));
    await expect(f.request("prepare")).rejects.toThrow("catalog unavailable");
    expect(f.run).not.toHaveBeenCalled();
    f.run.mockRejectedValueOnce(new Error("admission denied"));
    await expect(f.request("dispatch", { base: "main", description: "purpose" })).rejects.toThrow("admission denied");
  });
});

// Real Git owns detached HEAD, bare detection, and revision-option semantics.
const execAsync = promisify(nodeExecFile);
async function realGit(request: ServerPluginExecFileRequest): Promise<ServerPluginExecFileResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: "/poisoned", GIT_WORK_TREE: "/poisoned" };
  for (const key of request.unsetEnv ?? []) Reflect.deleteProperty(env, key);
  try {
    const { stdout, stderr } = await execAsync(request.file, [...request.args ?? []], { cwd: request.cwd, env, signal: request.signal });
    return { ...success(stdout), stderr };
  } catch (error) {
    return { ...success(), exitCode: 128, stderr: error instanceof Error ? error.message : String(error) };
  }
}

it("supports detached HEAD and remote branches, rejects missing/malicious bases and bare/non-Git directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflows-test-"));
  roots.push(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) Reflect.deleteProperty(env, key);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git("init", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "--detach");
  const f = await fixture(realGit);
  f.list.mockResolvedValue([{ ...main, path: root }]);
  await expect(f.request("prepare")).resolves.toMatchObject({ branches: ["main", "origin/main"], defaultBase: "HEAD" });
  for (const base of ["missing-branch", "--help", "main; touch never"]) {
    await expect(f.request("dispatch", { base, description: "purpose" })).rejects.toThrow("Git command failed");
  }
  expect(f.run).not.toHaveBeenCalled();
  await expect(f.request("dispatch", { base: "HEAD", description: "purpose" })).resolves.toMatchObject({ sessionId: "fresh-session" });
  f.run.mockClear();
  git("init", "--bare", join(root, "bare.git"));
  for (const path of [join(root, "bare.git"), tmpdir()]) {
    f.list.mockResolvedValue([{ ...main, path }]);
    await expect(f.request("dispatch", { base: "HEAD", description: "purpose" })).rejects.toThrow();
  }
  expect(f.run).not.toHaveBeenCalled();
});
