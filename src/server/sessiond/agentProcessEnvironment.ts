/**
 * Environment hygiene for agent-executed processes.
 *
 * Sessions run inside the session daemon process, so everything agents can
 * spawn — the bash tool, terminals, subsessions — inherits the daemon's
 * environment by default. That inheritance is deliberate: the daemon's
 * `PI_WEB_*` wiring stays visible so agent-facing tooling keeps working, and
 * a second PI WEB instance started from inside a session resolves the same
 * state and fails loudly at startup (see `sessiondStateOwnership`) instead of
 * silently corrupting the live daemon's data. `PI_WEB_SESSION=1` and the
 * session environment facts tell agents they are nested and which precautions
 * apply.
 *
 * The daemon captures its environment once at startup for its own use and
 * then removes the handful of keys that silently distort the tools agents
 * run, so all later spawns inherit a clean environment without per-call-site
 * filtering. Visibility rules:
 *
 * - Ordinary variables (`PATH`, `HOME`, `XDG_CONFIG_HOME`, proxy keys, …)
 *   stay.
 * - `PI_WEB_*` keys stay — including `PI_WEB_DOCKER_*` deployment descriptors
 *   the agent-facing `pi-web-docker` CLI reads, and the deprecated
 *   `PI_WEB_AGENT_*` aliases: the canonical `PI_CODING_AGENT_*` vars are
 *   exported with the fully resolved values, so both names resolve
 *   identically for anything started from here.
 * - `HOSTEXEC_*` stays: agents use `hostexec`.
 * - `PI_CODING_AGENT_DIR` stays so agent-spawned `pi` CLIs find the profile's
 *   auth and models; `PI_CODING_AGENT_SESSION_DIR` stays for the same reason:
 *   it is documented `pi` configuration, not daemon wiring, so a deployment
 *   that sets it wants every `pi` process — whether daemon-spawned or started
 *   by an agent — using the same session storage.
 * - `NODE_ENV` and `PORT` are app-runtime configuration and the only removals:
 *   `NODE_ENV=production` makes npm skip devDependencies and flips Node
 *   package-export conditions, and `PORT` leaks into the listener
 *   configuration of tools agents run.
 */

/**
 * Keys that configure the daemon or app runtime in ways that silently break
 * the tools agents run. Daemon configuration belongs in `PI_WEB_`-prefixed
 * keys, which stay visible; a key only belongs here when it cannot carry the
 * prefix (deployment conventions like `NODE_ENV`).
 */
const DAEMON_ONLY_ENV_KEYS = new Set(["NODE_ENV", "PORT"]);

export function isAgentVisibleEnvKey(key: string): boolean {
  return !DAEMON_ONLY_ENV_KEYS.has(key);
}

/**
 * Delete every non-agent-visible key from `env` — the daemon's `process.env`
 * at startup — and return the removed key names, sorted, for logging.
 */
export function scrubNonAgentVisibleEnvKeys(env: NodeJS.ProcessEnv): string[] {
  const scrubbed = Object.keys(env).filter((key) => !isAgentVisibleEnvKey(key));
  for (const key of scrubbed) {
    // process.env is a dynamic key/value bag; deleting the daemon-only keys is
    // the whole point of the scrub, and the keys cannot be known statically.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete env[key];
  }
  return scrubbed.sort();
}
