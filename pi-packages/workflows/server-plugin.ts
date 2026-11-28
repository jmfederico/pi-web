import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  PI_WEB_HOST_CATALOG_CAPABILITY,
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  type JsonValue,
  type PiWebServerPluginV5,
  type PluginCatalogV1,
  type PiWebHostPiSessionsV1,
  type ServerPluginActivationContextV5,
} from "@jmfederico/pi-web/server-plugin-api";

// Repository-local overrides must not redirect commands away from catalog authority.
const GIT_LOCAL_ENV_VARS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CONFIG",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_WORK_TREE",
]);

const plugin: PiWebServerPluginV5 = {
  apiVersion: 5,
  name: "Workflows",
  requires: [PI_WEB_HOST_CATALOG_CAPABILITY, PI_WEB_HOST_PI_SESSIONS_CAPABILITY],
  activate(context) {
    let catalog: PluginCatalogV1 | undefined;
    let sessions: PiWebHostPiSessionsV1 | undefined;
    return {
      start({ capabilities }) {
        catalog = capabilities.resolve(PI_WEB_HOST_CATALOG_CAPABILITY);
        sessions = capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
      },
      peer: {
        async request({ scope, operation, input, signal }) {
          if (scope.kind !== "project") throw new Error("Workflows requires project scope");
          if (operation !== "prepare" && operation !== "dispatch" && operation !== "createWorktree") {
            throw new Error("Unknown Workflows operation");
          }
          const details = operation === "dispatch" ? dispatchInput(input) : undefined;
          const creation = operation === "createWorktree" ? createWorktreeInput(input) : undefined;
          if (catalog === undefined || sessions === undefined) throw new Error("Workflows has not started");
          // Always discover current authority, including when dispatch follows prepare.
          const workspaces = await catalog.workspaces.list(scope.project.id, { signal });
          if (workspaces.some((workspace) => workspace.projectId !== scope.project.id)) {
            throw new Error("Catalog workspace is outside the scoped project");
          }
          const mains = workspaces.filter((workspace) => workspace.isMain);
          const main = mains[0];
          if (mains.length !== 1 || main === undefined) throw new Error("Project must have exactly one main workspace");
          const git = (args: readonly string[]) => runGit(context, main.path, args, signal);
          if ((await git(["rev-parse", "--is-inside-work-tree"])).trim() !== "true"
            || (await git(["rev-parse", "--is-bare-repository"])).trim() !== "false") {
            throw new Error("Main workspace must be a non-bare Git worktree");
          }
          if (creation !== undefined) {
            if (!(await isCheckoutRoot(git, scope.project.path, main.path))) {
              throw new Error("Manual worktree creation requires a project registered at a Git checkout root");
            }
            return createWorktree(git, main.path, creation, signal);
          }
          if (details === undefined) {
            const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"]))
              .split(/\r?\n/u).filter(Boolean);
            const branches = [...new Set(refs.map((ref) => ref.replace(/^refs\/(?:heads|remotes)\//u, "")))].sort();
            const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
            if (current === "") throw new Error("Git returned an empty current branch");
            const manual = await isCheckoutRoot(git, scope.project.path, main.path) ? { startingRefs: refs } : null;
            return { workspaceId: main.id, workspacePath: main.path, branches, defaultBase: current, manual };
          }
          await git(["rev-parse", "--verify", "--end-of-options", `${details.base}^{commit}`]);
          signal.throwIfAborted();
          const run = await sessions.run({
            projectId: scope.project.id,
            workspaceId: main.id,
            prompt: worktreeCommand(details),
          });
          const logDetails = { projectId: scope.project.id, workspaceId: main.id, sessionId: run.sessionId };
          void run.completion.then((completion) => {
            if (completion.status === "failed") {
              context.logger.error("Workflows initial worktree task failed", { ...logDetails, error: completion.error });
            } else if (completion.status === "cancelled") {
              context.logger.warn("Workflows initial worktree task cancelled", logDetails);
            }
          }, (error: unknown) => {
            context.logger.error("Workflows initial worktree task completion rejected", {
              ...logDetails, error: error instanceof Error ? error.message : String(error),
            });
          });
          return { workspaceId: main.id, sessionId: run.sessionId };
        },
      },
    };
  },
};

export default plugin;

interface WorktreeDispatch {
  base: string;
  description: string;
  worktreeParent?: string;
}

function dispatchInput(input: JsonValue): WorktreeDispatch {
  if (typeof input !== "object" || input === null || Array.isArray(input)
    || Object.keys(input).some((key) => key !== "base" && key !== "description" && key !== "worktreeParent")) {
    throw new Error("Dispatch input must contain base and description, with an optional worktree parent");
  }
  const rawParent: unknown = Reflect.get(input, "worktreeParent");
  const worktreeParent = rawParent === undefined ? undefined : boundedString(rawParent, "worktree parent", 4096);
  if (worktreeParent !== undefined && !isAbsolute(worktreeParent)) throw new Error("Worktree parent must be an absolute path on the project machine");
  return {
    base: boundedString(Reflect.get(input, "base"), "base", 1024),
    description: boundedString(Reflect.get(input, "description"), "description", 16 * 1024),
    ...(worktreeParent === undefined ? {} : { worktreeParent }),
  };
}

interface WorktreeCreation {
  destination: string;
  branch: string;
  base: string;
}

function createWorktreeInput(input: JsonValue): WorktreeCreation {
  if (typeof input !== "object" || input === null || Array.isArray(input)
    || Object.keys(input).some((key) => key !== "destination" && key !== "branch" && key !== "base")) {
    throw new Error("Create worktree input must contain only destination, branch and base");
  }
  const destination = boundedString(Reflect.get(input, "destination"), "destination", 4096);
  if (!isAbsolute(destination)) throw new Error("Worktree destination must be an absolute path on the project machine");
  const branch = boundedString(Reflect.get(input, "branch"), "branch", 1024);
  if (branch.startsWith("-") || branch === "HEAD") throw new Error("Invalid new branch name");
  return { destination, branch, base: boundedString(Reflect.get(input, "base"), "base", 1024) };
}

type Git = (args: readonly string[]) => Promise<string>;

async function isCheckoutRoot(git: Git, projectPath: string, workspacePath: string): Promise<boolean> {
  const root = (await git(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/u, "");
  return isAbsolute(root) && resolve(root) === resolve(projectPath) && resolve(root) === resolve(workspacePath);
}

async function createWorktree(git: Git, cwd: string, input: WorktreeCreation, signal: AbortSignal): Promise<JsonValue> {
  // Check the literal ref: `check-ref-format --branch` can expand @{-1}.
  const branchRef = `refs/heads/${input.branch}`;
  await git(["check-ref-format", branchRef]);
  // Do not mistake a worktree that already uses this branch for a new one
  // when checking durable state after a failed add.
  const existingRefs = await git(["for-each-ref", "--format=%(refname)", branchRef]);
  if (existingRefs.split(/\r?\n/u).includes(branchRef)) throw new Error(`Branch already exists: ${input.branch}`);
  const commit = (await git(["rev-parse", "--verify", "--end-of-options", `${input.base}^{commit}`])).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) throw new Error("Git returned an invalid starting commit");
  const destination = resolve(cwd, input.destination);
  signal.throwIfAborted();
  // Git still owns the atomic collision check; the read above is not a lock.
  try {
    await git(["worktree", "add", "--no-track", "-b", input.branch, "--", destination, commit]);
  } catch (cause) {
    // A post-checkout hook can fail after Git has registered the worktree.
    // Keep the original diagnostic if we cannot confirm that outcome.
    if (!(await hasCreatedWorktree(git, destination, branchRef).catch(() => false))) throw cause;
    return { path: destination, warning: cause instanceof Error ? cause.message : String(cause) };
  }
  return { path: destination };
}

async function hasCreatedWorktree(git: Git, destination: string, branchRef: string): Promise<boolean> {
  const path = await realpath(destination);
  const output = await git(["worktree", "list", "--porcelain", "-z"]);
  return output.split("\0\0").some((record) => {
    const [worktree, ...fields] = record.split("\0");
    return worktree?.startsWith("worktree ") === true
      && resolve(worktree.slice("worktree ".length)) === path
      && fields.includes(`branch ${branchRef}`);
  });
}

function boundedString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Invalid ${name}: expected non-empty text of at most ${String(maxBytes)} UTF-8 bytes without NUL`);
  }
  return value;
}

function worktreeCommand({ base, description, worktreeParent }: WorktreeDispatch): string {
  // Pi 1.5.1+ parses quotes before expanding $ARGUMENTS. Keep the formatted
  // text in one single-quoted argument, where `\'` is a literal apostrophe.
  // A backslash before the closing quote would escape it, so trailing
  // backslashes follow the quote, where Pi keeps them as literal text.
  const parent = worktreeParent === undefined ? "" : `\nworktree parent: ${JSON.stringify(worktreeParent)}`;
  const details = `base: ${base}${parent}\n\ndescription:\n${description}`;
  const quoted = details.replace(/\\+$/u, "");
  return `/worktree '${quoted.replaceAll("'", "\\'")}'${details.slice(quoted.length)}`;
}

async function runGit(
  context: ServerPluginActivationContextV5,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const result = await context.execFile({
    file: "git", cwd, args, unsetEnv: GIT_LOCAL_ENV_VARS, timeoutMs: 10_000, signal,
  });
  if (result.stdoutTruncated || result.stderrTruncated) throw new Error("Git output exceeded the host limit");
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new Error(`Git command failed (${result.signal ?? String(result.exitCode)}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}
