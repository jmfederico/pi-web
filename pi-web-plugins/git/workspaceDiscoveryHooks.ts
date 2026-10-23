import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ProjectInput,
  ServerPluginActivationContext,
  ServerPluginExecFileResult,
  WorkspaceProviderIntegration,
} from "@jmfederico/pi-web/server-plugin-api";

type RunGit = (cwd: string, args: readonly string[], signal: AbortSignal) => Promise<ServerPluginExecFileResult>;
interface ConfigValue { scope: string; value: string }
const EVENT = "post-checkout";

/** Git owns the hook policy; the host owns settings snapshots and notification attribution/transport. */
export function createWorkspaceDiscoveryHooks(
  context: ServerPluginActivationContext,
  runGit: RunGit,
  nodeExecutable = process.execPath,
  instanceNamespace = "",
): WorkspaceProviderIntegration {
  if (instanceNamespace !== "" && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u.test(instanceNamespace)) {
    throw new Error("PI_WEB_INSTANCE_NAMESPACE must be 1–32 letters, digits, underscores or hyphens, starting with a letter or digit");
  }
  if (!isAbsolute(nodeExecutable)) throw new Error("Git hook runtime must be an absolute executable path");
  // Serialize this activation's config edits, including registrations sharing a
  // common Git config. Git itself locks writes from other processes.
  let pending = Promise.resolve();
  return Object.freeze({
    reconcile(project: ProjectInput, signal: AbortSignal): Promise<void> {
      const operation = pending.then(() => reconcile(project, signal));
      pending = operation.catch(() => { /* The caller still receives the failure; do not poison the queue. */ });
      return operation;
    },
    async acceptNotification(project: ProjectInput, signal: AbortSignal): Promise<boolean> {
      return await enabled(project, signal) && (context.workspaceNotifications?.command(project.id).length ?? 0) > 0;
    },
  });

  async function enabled(project: ProjectInput, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const settings = context.resolveProjectSettings === undefined
      ? context.settings
      : await context.resolveProjectSettings(project, signal);
    const value = settings["workspaceDiscoveryHooks"];
    if (value === undefined) return true;
    if (typeof value !== "boolean") throw new Error("Git setting workspaceDiscoveryHooks must be a boolean");
    return value;
  }

  async function reconcile(project: ProjectInput, signal: AbortSignal): Promise<void> {
    const isEnabled = await enabled(project, signal);
    // Separate projects/instances may share Git config. This identity belongs
    // to the packaged-helper implementation; older generated helpers are untouched.
    const identity = createHash("sha256")
      .update(JSON.stringify(["packaged-helper", context.pluginId, resolve(context.dataDirectory), project.id]))
      .digest("hex");
    // Keep the unnamespaced production identity byte-for-byte compatible.
    // The name also scopes ownership records; never adopt another instance's hook.
    const prefix = instanceNamespace === "" ? "" : `${instanceNamespace}-`;
    const name = `pi-web-workspace-discovery-${prefix}${identity}`;
    const helper = join(context.packageRoot, "workspace-discovery-notify.cjs");
    const registration = join(context.dataDirectory, "workspace-discovery", `${name}.registration.json`);
    const notifier = context.workspaceNotifications?.command(project.id);
    const command = registrationCommand(helper, nodeExecutable, notifier ?? []);
    const ownedCommands = new Set([command, ...await readRegistrationCommands(registration, signal)]);
    const install = isEnabled && notifier !== undefined && notifier.length > 0;
    if (install && !await supportsNamedHooks(project, signal)) return;

    const commandKey = `hook.${name}.command`;
    const eventKey = `hook.${name}.event`;
    const commands = await readConfig(project, commandKey, signal);
    const events = await readConfig(project, eventKey, signal);
    if (commands.some((entry) => entry.scope !== "local" || !ownedCommands.has(entry.value))
      || events.some((entry) => entry.scope !== "local" || (entry.value !== EVENT && commands.length === 0))) {
      // We only install local keys. A same-name global/worktree registration is
      // external even if its values happen to match ours; never override it or
      // remove the local command on which its inherited event might depend.
      throw new Error(`Git workspace discovery hook conflict: ${name} has unexpected configuration`);
    }

    if (!install) {
      // Disconnect the event first: an event without a command makes Git fail.
      // Installation uses the reverse order for the same reason.
      await unsetLocal(project, eventKey, events, signal);
      await unsetLocal(project, commandKey, commands, signal);
      signal.throwIfAborted();
      await rm(registration, { force: true });
      return;
    }

    // Routing/runtime arguments live in Git config, not generated executable
    // files. Preserve exact ownership before changing config, including either
    // side of a failed update, then compact after installation succeeds.
    await writeRegistration([...new Set([...commands.map((entry) => entry.value), command])]);
    await setLocal(project, commandKey, command, commands, signal);
    await setLocal(project, eventKey, EVENT, events, signal);
    await writeRegistration([command]);

    async function writeRegistration(owned: readonly string[]): Promise<void> {
      await writeOwnedFileIfChanged(registration, `${JSON.stringify({ version: 1, commands: owned })}\n`, signal);
    }
  }

  async function supportsNamedHooks(project: ProjectInput, signal: AbortSignal): Promise<boolean> {
    // Detect Git's advertised named-config facility, not its version. `hook
    // list` is unsuitable here: a missing command in an existing registration
    // makes it fail, preventing precisely the repair we need to perform.
    const result = await runGit(project.path, ["help", "--config"], signal);
    if (result.signal !== null) throw new Error(`Git named-hook detection ended from signal ${result.signal}`);
    const keys = result.stdout.split(/\r?\n/u);
    const supported = result.exitCode === 0
      && keys.includes("hook.<friendly-name>.command") && keys.includes("hook.<friendly-name>.event");
    if (!supported) context.logger.debug("Git named configuration hooks unavailable; workspace discovery remains on catalog access", { projectId: project.id });
    return supported;
  }

  async function readConfig(project: ProjectInput, key: string, signal: AbortSignal): Promise<ConfigValue[]> {
    const result = await runGit(project.path, ["config", "--null", "--show-scope", "--get-all", key], signal);
    if (result.signal === null && result.exitCode === 1) return [];
    requireSuccess(result, `read ${key}`);
    const fields = result.stdout.split("\0");
    if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error(`Malformed Git config output for ${key}`);
    const entries: ConfigValue[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      entries.push({ scope: fields[index] ?? "", value: fields[index + 1] ?? "" });
    }
    return entries;
  }

  async function setLocal(project: ProjectInput, key: string, value: string, entries: ConfigValue[], signal: AbortSignal): Promise<void> {
    const local = entries.filter((entry) => entry.scope === "local");
    if (local.length === 1 && local[0]?.value === value) return;
    requireSuccess(await runGit(project.path, ["config", "--local", "--replace-all", key, value], signal), `set ${key}`);
  }

  async function unsetLocal(project: ProjectInput, key: string, entries: ConfigValue[], signal: AbortSignal): Promise<void> {
    if (!entries.some((entry) => entry.scope === "local")) return;
    requireSuccess(await runGit(project.path, ["config", "--local", "--unset-all", key], signal), `remove ${key}`);
  }
}

function requireSuccess(result: ServerPluginExecFileResult, action: string): void {
  if (result.signal === null && result.exitCode === 0) return;
  const outcome = result.signal === null ? `exit ${String(result.exitCode)}` : `signal ${result.signal}`;
  throw new Error(`Unable to ${action} (${outcome}): ${result.stderr.trim()}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function registrationCommand(helper: string, nodeExecutable: string, notificationCommand: readonly string[]): string {
  // Git itself supplies the shell and appends quoted hook argv to the function
  // call. No extra `sh` executable is required on the user's PATH. The final
  // return preserves best-effort behavior even when our helper/runtime is gone.
  const shellHelper = process.platform === "win32" ? helper.replaceAll("\\", "/") : helper;
  const shellNode = process.platform === "win32" ? nodeExecutable.replaceAll("\\", "/") : nodeExecutable;
  return `pi_web_workspace_notify () { if test -r ${shellQuote(shellHelper)}; then ${shellQuote(shellNode)} ${shellQuote(shellHelper)} ${shellQuote(JSON.stringify(notificationCommand))} "$@" >/dev/null 2>&1; fi; return 0; }; pi_web_workspace_notify`;
}

async function readRegistrationCommands(path: string, signal: AbortSignal): Promise<readonly string[]> {
  let source: string;
  try {
    source = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Reflect.get(value, "version") !== 1) throw new Error(`Invalid PI WEB Git hook registration record: ${path}`);
  const commands: unknown = Reflect.get(value, "commands");
  if (!Array.isArray(commands) || !commands.every((command: unknown): command is string => typeof command === "string" && command.length > 0)) {
    throw new Error(`Invalid PI WEB Git hook command record: ${path}`);
  }
  return commands;
}

async function writeOwnedFileIfChanged(path: string, source: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  try {
    if (await readFile(path, { encoding: "utf8", signal }) === source) return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  // Atomic per-project ownership records never contain executable code.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { flag: "wx", mode: 0o600, signal });
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
