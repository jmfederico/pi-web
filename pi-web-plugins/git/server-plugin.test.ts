import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderWorkspace,
  ServerPluginActivationContext,
  ServerPluginExecFileResult,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";
import type { Project } from "../../src/shared/apiTypes.js";
import { createServerPluginExecFile } from "../../src/server/plugins/serverPluginExec.js";
import type { ServerPluginProviderContribution } from "../../src/server/plugins/serverPluginRuntime.js";
import { WorkspaceProviderRegistry } from "../../src/server/workspaces/workspaceProviderRegistry.js";
import {
  GIT_DIFF_OPERATION,
  GIT_STATUS_OPERATION,
} from "./git-backend.js";
import plugin, { parseGitWorktreeList } from "./server-plugin.js";

const tempRoots: string[] = [];
const gitLocalEnvironmentKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bundled Git workspace provider", () => {
  it("is a fallback provider and passes plain folders", async () => {
    const folder = await temporaryDirectory("plain folder");
    const workspaceProvider = await providerFor(createServerPluginExecFile({ env: cleanGitEnvironment() }));

    await expect(workspaceProvider.probe(project(folder), new AbortController().signal)).resolves.toBe("pass");
    expect(workspaceProvider.fallback).toBe(true);
  });

  it("lists roots, paths with spaces, detached worktrees, and hides prunable entries", async () => {
    const repository = await createRepository("repo with spaces");
    const linked = join(repository.parent, "feature worktree");
    const detached = join(repository.parent, "detached worktree");
    const gone = join(repository.parent, "gone worktree");
    runGit(repository.path, ["worktree", "add", "-b", "feature/with-space", linked]);
    runGit(repository.path, ["worktree", "add", "--detach", detached]);
    runGit(repository.path, ["worktree", "add", "-b", "gone", gone]);
    await rm(gone, { recursive: true, force: true });

    // Poison repository-local variables at the host boundary. The bundled
    // plugin must use the public unsetEnv capability rather than ambient state.
    const workspaceProvider = await providerFor(createServerPluginExecFile({
      env: {
        ...cleanGitEnvironment(),
        GIT_DIR: "/missing/poisoned-git-dir",
        GIT_WORK_TREE: "/missing/poisoned-work-tree",
      },
    }));
    const input = project(repository.path);

    await expect(workspaceProvider.probe(input, new AbortController().signal)).resolves.toBe("claim");
    const workspaces = await workspaceProvider.list(input, new AbortController().signal);

    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: repository.path,
        path: repository.path,
        label: "main",
        isMain: true,
        publicMetadata: { isGitRepo: true, isGitWorktree: true, branch: "main" },
      }),
      expect.objectContaining({
        key: linked,
        path: linked,
        label: "feature/with-space",
        isMain: false,
        publicMetadata: { isGitRepo: true, isGitWorktree: true, branch: "feature/with-space" },
        removal: {
          actionLabel: "Delete workspace",
          confirmation: `Delete workspace feature/with-space?\n\nThis will run git worktree remove and delete:\n${linked}\n\nThe Git branch will not be deleted.`,
        },
      }),
      expect.objectContaining({
        key: detached,
        path: detached,
        label: "detached",
        isMain: false,
        publicMetadata: { isGitRepo: true, isGitWorktree: true, detached: true },
      }),
    ]));
    expect(workspaces.map(({ path }) => path)).not.toContain(gone);
    expect(workspaces.filter(({ isMain }) => isMain)).toHaveLength(1);
    expect(workspaces.find(({ isMain }) => isMain)).not.toHaveProperty("removal");
  });

  it("selects the registered checkout as main when linked worktrees use a bare backing repository", async () => {
    const seed = await createRepository("bare seed");
    const bare = join(seed.parent, "backing.git");
    const checkout = join(seed.parent, "main checkout");
    const linked = join(seed.parent, "feature checkout");
    runGit(seed.parent, ["clone", "--bare", seed.path, bare]);
    runGit(bare, ["worktree", "add", checkout, "main"]);
    runGit(checkout, ["worktree", "add", "-b", "feature", linked]);
    const workspaceProvider = await providerFor(createServerPluginExecFile({ env: cleanGitEnvironment() }));
    const registry = new WorkspaceProviderRegistry({
      contributions: [contribution("git", workspaceProvider)],
      logger: { warn: vi.fn() },
    });

    const resolution = await registry.resolve(project(checkout));

    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "git" });
    expect(resolution.workspaces).toHaveLength(2);
    expect(resolution.workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: checkout, isMain: true, label: "main" }),
      expect.objectContaining({ path: linked, isMain: false, label: "feature" }),
    ]));
    expect(resolution.workspaces.map(({ path }) => path)).not.toContain(bare);
    expect(resolution.workspaces.filter(({ isMain }) => isMain)).toHaveLength(1);
  });

  it("serves status and diff schemas through provider request using sanitized bounded commands", async () => {
    const repository = await createRepository("changes repo");
    await Promise.all([
      writeFile(join(repository.path, "tracked.txt"), "tracked\nchanged\n", "utf8"),
      writeFile(join(repository.path, "new file.txt"), "new\n", "utf8"),
    ]);
    const workspaceProvider = await providerFor(createServerPluginExecFile({
      env: {
        ...cleanGitEnvironment(),
        GIT_DIR: "/missing/poisoned-git-dir",
        GIT_WORK_TREE: "/missing/poisoned-work-tree",
      },
    }));
    const input = project(repository.path);
    const registry = new WorkspaceProviderRegistry({
      contributions: [contribution("git", workspaceProvider)],
      logger: { warn: vi.fn() },
    });
    const workspaceId = (await registry.resolve(input)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected Git workspace backend");

    const status = await registry.request({
      pluginId: "git",
      moduleRevision: "1",
      project: input,
      workspaceId,
      operation: GIT_STATUS_OPERATION,
      input: null,
    });
    const diff = await registry.request({
      pluginId: "git",
      moduleRevision: "1",
      project: input,
      workspaceId,
      operation: GIT_DIFF_OPERATION,
      input: { path: "tracked.txt", staged: false },
    });

    const statusRecord = requireRecord(status);
    expect(statusRecord).toMatchObject({ isGitRepo: true, submodules: [] });
    expect(statusRecord["files"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tracked.txt", workingTree: "modified" }),
      expect.objectContaining({ path: "new file.txt", workingTree: "untracked" }),
    ]));
    const diffRecord = requireRecord(diff);
    expect(diffRecord).toMatchObject({ path: "tracked.txt", staged: false, truncated: false });
    expect(diffRecord["diff"]).toContain("changed");
  });

  it("preserves the Git command timeout, environment sanitization, and diff truncation signal", async () => {
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>(() => Promise.resolve(commandResult({
      stdout: "diff --git a/tracked.txt b/tracked.txt\n",
      stdoutTruncated: true,
    })));
    const workspaceProvider = await providerFor(execFile);
    const request = workspaceProvider.request?.bind(workspaceProvider);
    if (request === undefined) throw new Error("Expected Git workspace backend");
    const signal = new AbortController().signal;

    await expect(request({
      project: project("/repo"),
      workspace: providerWorkspace("root", "/repo", true),
      operation: GIT_DIFF_OPERATION,
      input: {},
      signal,
    })).resolves.toMatchObject({ staged: false, truncated: true });
    expect(execFile).toHaveBeenCalledWith({
      file: "git",
      args: ["diff", "--no-ext-diff", "--color=never"],
      cwd: "/repo",
      unsetEnv: gitLocalEnvironmentKeys,
      timeoutMs: 10_000,
      signal,
    });
  });

  it("rejects unknown operations and malformed private inputs before command execution", async () => {
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>();
    const workspaceProvider = await providerFor(execFile);
    const request = workspaceProvider.request?.bind(workspaceProvider);
    if (request === undefined) throw new Error("Expected Git workspace backend");
    const context = {
      project: project("/repo"),
      workspace: providerWorkspace("root", "/repo", true),
      signal: new AbortController().signal,
    };

    await expect(request({ ...context, operation: "history", input: null })).rejects.toThrow("Unsupported Git workspace backend operation");
    await expect(request({ ...context, operation: GIT_STATUS_OPERATION, input: {} })).rejects.toThrow("status input must be null");
    await expect(request({ ...context, operation: GIT_DIFF_OPERATION, input: { path: "/outside" } })).rejects.toThrow("Absolute paths are not allowed");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("performs live Git validation and builds the quoted native removal command", async () => {
    const repository = await createRepository("removal repo");
    const linked = join(repository.parent, "feature's worktree");
    runGit(repository.path, ["worktree", "add", "-b", "feature/remove", linked]);
    const workspaceProvider = await providerFor(createServerPluginExecFile({ env: cleanGitEnvironment() }));
    const input = project(repository.path);
    const target = (await workspaceProvider.list(input, new AbortController().signal))
      .find(({ path }) => path === linked);
    if (target === undefined || workspaceProvider.prepareRemove === undefined) {
      throw new Error("Expected removable Git worktree");
    }

    await expect(workspaceProvider.prepareRemove({
      project: input,
      workspace: target,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      title: "Delete workspace: feature/remove",
      command: `git worktree remove '${linked.replaceAll("'", "'\\''")}'`,
    });
  });

  it("keeps current raw worktree paths for a registered subdirectory", async () => {
    const repository = await createRepository("monorepo", "packages/app/tracked.txt");
    const linked = join(repository.parent, "linked checkout");
    runGit(repository.path, ["worktree", "add", "-b", "feature", linked]);
    const projectPath = join(repository.path, "packages", "app");
    const input = project(projectPath);
    const workspaceProvider = await providerFor(createServerPluginExecFile({ env: cleanGitEnvironment() }));

    const workspaces = await workspaceProvider.list(input, new AbortController().signal);

    expect(workspaces).toEqual([
      expect.objectContaining({ path: repository.path, isMain: true, label: "main" }),
      expect.objectContaining({ path: linked, isMain: false, label: "feature" }),
    ]);
    expect(workspaces.map(({ path, label }) => ({ path, label }))).toEqual([
      { path: repository.path, label: "main" },
      { path: linked, label: "feature" },
    ]);
  });

  it("claims a Git submodule as its own repository", async () => {
    const origin = await createRepository("submodule origin");
    const superproject = await createRepository("super project");
    const submodulePath = join(superproject.path, "modules", "sub module");
    runGit(superproject.path, ["-c", "protocol.file.allow=always", "submodule", "add", origin.path, "modules/sub module"]);
    runGit(superproject.path, ["add", "."]);
    commit(superproject.path, "add submodule");
    const workspaceProvider = await providerFor(createServerPluginExecFile({ env: cleanGitEnvironment() }));
    const input = project(submodulePath);
    const submoduleWorkspacePath = resolve(submodulePath, runGit(submodulePath, ["rev-parse", "--git-common-dir"]).trim());

    await expect(workspaceProvider.probe(input, new AbortController().signal)).resolves.toBe("claim");
    const workspaces = await workspaceProvider.list(input, new AbortController().signal);

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ path: submoduleWorkspacePath, isMain: true });
    expect(workspaces[0]?.publicMetadata).toMatchObject({ isGitRepo: true, isGitWorktree: true });
  });

  it("stays resolvable through the host registry when a linked branch lacks the registered subdirectory", async () => {
    const repository = await createRepository("changing monorepo", "packages/app/tracked.txt");
    const linked = join(repository.parent, "branch without app");
    runGit(repository.path, ["worktree", "add", "-b", "without-app", linked]);
    runGit(linked, ["rm", "-r", "packages/app"]);
    commit(linked, "remove app");
    const input = project(join(repository.path, "packages", "app"));
    const workspaceProvider = await providerFor(createServerPluginExecFile({ env: cleanGitEnvironment() }));
    const registry = new WorkspaceProviderRegistry({
      contributions: [contribution("git", workspaceProvider)],
      logger: { warn: vi.fn() },
    });

    const resolution = await registry.resolve(input);

    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "git" });
    expect(resolution.workspaces.map(({ path }) => path)).toEqual([repository.path, linked]);
  });

  it("allows a primary provider to suppress the real fallback Git provider without invoking Git", async () => {
    const execFile = vi.fn(createServerPluginExecFile({ env: cleanGitEnvironment() }));
    const gitProvider = await providerFor(execFile);
    const primaryProvider: WorkspaceProvider = {
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([providerWorkspace("root", "/repo", true)]),
    };
    const registry = new WorkspaceProviderRegistry({
      contributions: [contribution("git", gitProvider), contribution("primary", primaryProvider)],
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });

    const input = project("/repo");
    const resolution = await registry.resolve(input);
    const workspaceId = resolution.workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected primary workspace");

    await expect(registry.request({
      pluginId: "git",
      moduleRevision: "1",
      project: input,
      workspaceId,
      operation: GIT_STATUS_OPERATION,
      input: null,
    })).rejects.toMatchObject({ code: "owner-mismatch", statusCode: 409 });
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "primary" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("surfaces claim-then-list command failure for host-owned degradation", async () => {
    const execFile = vi.fn((request: { args?: readonly string[] }): Promise<ServerPluginExecFileResult> => {
      const args = request.args ?? [];
      if (args.includes("--is-inside-work-tree")) return Promise.resolve(commandResult({ stdout: "true\n" }));
      if (args.includes("--show-toplevel")) return Promise.resolve(commandResult({ stdout: "/repo\n" }));
      if (args.includes("--git-common-dir")) return Promise.resolve(commandResult({ stdout: "/repo/.git\n" }));
      return Promise.resolve(commandResult({ exitCode: 128, stderr: "worktree metadata unavailable" }));
    });
    const workspaceProvider = await providerFor(execFile);
    const input = project("/repo");

    await expect(workspaceProvider.probe(input, new AbortController().signal)).resolves.toBe("claim");
    await expect(workspaceProvider.list(input, new AbortController().signal)).rejects.toThrow(
      "Unable to list Git worktrees (exit 128): worktree metadata unavailable",
    );
  });
});

describe("parseGitWorktreeList", () => {
  it("parses NUL-delimited paths without losing spaces and records detached/prunable facts", () => {
    const output = [
      "worktree /repo with spaces", "HEAD abc", "branch refs/heads/main", "",
      "worktree /linked detached", "HEAD def", "detached", "",
      "worktree /gone", "HEAD fed", "branch refs/heads/gone", "prunable gitdir file points to non-existent location", "",
    ].join("\0");

    expect(parseGitWorktreeList(output)).toEqual([
      { path: "/repo with spaces", branch: "main" },
      { path: "/linked detached", detached: true },
      { path: "/gone", branch: "gone", prunable: true },
    ]);
  });

  it("keeps bare facts and ignores records without a worktree path", () => {
    const output = ["worktree /repo.git", "bare", "", "HEAD abc", "", ""].join("\0");

    expect(parseGitWorktreeList(output)).toEqual([{ path: "/repo.git", bare: true }]);
  });
});

async function providerFor(execFile: ServerPluginActivationContext["execFile"]): Promise<WorkspaceProvider> {
  const activation = await plugin.activate({
    apiVersion: 1,
    pluginId: "git",
    packageRoot: resolve("pi-web-plugins/git"),
    logger: {
      debug() { /* no-op */ },
      info() { /* no-op */ },
      warn() { /* no-op */ },
      error() { /* no-op */ },
    },
    settings: {},
    execFile,
    signal: new AbortController().signal,
  });
  const workspaceProvider = activation.workspaceProvider;
  if (workspaceProvider === undefined) throw new Error("Bundled Git did not activate its workspace provider");
  return workspaceProvider;
}

async function createRepository(name: string, trackedPath = "tracked.txt"): Promise<{ parent: string; path: string }> {
  const parent = await temporaryDirectory("repository fixture");
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  runGit(path, ["init", "-b", "main"]);
  const file = join(path, trackedPath);
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, "tracked\n", "utf8");
  runGit(path, ["add", "."]);
  commit(path, "initial");
  return { parent, path };
}

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pi-web-git-provider-${label.replaceAll(" ", "-")}-`));
  // Git reports canonical worktree paths; on Windows the temp dir may use an
  // 8.3 short name, so compare against the real path.
  const canonical = await realpath(path);
  tempRoots.push(canonical);
  return canonical;
}

function commit(cwd: string, message: string): void {
  runGit(cwd, ["-c", "user.name=PI WEB Test", "-c", "user.email=pi-web@example.invalid", "commit", "-m", message]);
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: cleanGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of gitLocalEnvironmentKeys) Reflect.deleteProperty(env, key);
  return env;
}

function project(path: string): Project {
  return { id: "project-1", name: "Project", path, createdAt: "2026-07-27T00:00:00.000Z" };
}

function contribution(pluginId: string, workspaceProvider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision: "1",
    provider: workspaceProvider,
  };
}

function providerWorkspace(key: string, path: string, isMain: boolean): ProviderWorkspace {
  return { key, path, label: key, isMain };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected record");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandResult(overrides: Partial<ServerPluginExecFileResult> = {}): ServerPluginExecFileResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}
