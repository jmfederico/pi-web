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
          if (operation !== "prepare" && operation !== "dispatch") throw new Error("Unknown Workflows operation");
          const details = operation === "dispatch" ? dispatchInput(input) : undefined;
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
          if (details === undefined) {
            const refs = await git(["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"]);
            const branches = [...new Set(refs.split(/\r?\n/u).filter(Boolean).map((ref) =>
              ref.replace(/^refs\/(?:heads|remotes)\//u, "")))].sort();
            const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
            if (current === "") throw new Error("Git returned an empty current branch");
            return { workspaceId: main.id, workspacePath: main.path, branches, defaultBase: current };
          }
          await git(["rev-parse", "--verify", "--end-of-options", `${details.base}^{commit}`]);
          signal.throwIfAborted();
          const run = await sessions.run({
            projectId: scope.project.id,
            workspaceId: main.id,
            prompt: worktreeCommand(details.base, details.description),
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

function dispatchInput(input: JsonValue): { base: string; description: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)
    || Object.keys(input).some((key) => key !== "base" && key !== "description")) {
    throw new Error("Dispatch input must contain only base and description");
  }
  return {
    base: boundedString(Reflect.get(input, "base"), "base", 1024),
    description: boundedString(Reflect.get(input, "description"), "description", 16 * 1024),
  };
}

function boundedString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Invalid ${name}: expected non-empty text of at most ${String(maxBytes)} UTF-8 bytes without NUL`);
  }
  return value;
}

function worktreeCommand(base: string, description: string): string {
  // Pi parses quotes before expanding $ARGUMENTS. Keep the formatted text in
  // one argument, switching to double quotes for literal apostrophes. These
  // transport quotes disappear during expansion; user text stays unchanged.
  const details = `base: ${base}\n\ndescription:\n${description}`;
  return `/worktree '${details.replaceAll("'", "'\"'\"'")}'`;
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
