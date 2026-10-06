import { execFile, spawn } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { effectivePiWebConfig, isHostAbsoluteAgentDir, PI_CODING_AGENT_DIR_ENV } from "./config.js";
import { detectPiWebInstallation } from "./server/piWebStatus.js";
import { SessionDaemonClient } from "./sessiond/sessionDaemonClient.js";
import type { PiWebInstallationInfo } from "./shared/apiTypes.js";
import { nativeServiceManagerRefs } from "./nativeServices/servicePlan.js";

const PACKAGE_NAME = "@jmfederico/pi-web";
const UPDATE_HANDOFF_LABEL_PREFIX = "com.pi-web.update";
const WARNING = "Updating PI WEB will restart services and interrupt active sessions and terminals, including this terminal.";
const HELP = "Usage: pi-web update [--yes]\nWithout --yes, an interactive confirmation is required. Nested Linux updates use a detached systemd user service. Nested macOS updates use a detached launchd user agent.";

export interface PiWebUpdateCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface LaunchdUpdateHandoff {
  domain: string;
  label: string;
  target: string;
  plistPath: string;
  logPath: string;
  plist: string;
  environment: NodeJS.ProcessEnv;
}

/** All process, profile, filesystem, and confirmation effects are replaceable in tests. */
export interface PiWebUpdateDependencies {
  env: NodeJS.ProcessEnv;
  nodeExecutable: string;
  platform: NodeJS.Platform;
  home: string;
  userId: number;
  cwd: string;
  uniqueId(): string;
  exists(path: string): boolean;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  piCliPath: string;
  interactive: boolean;
  agentDir(): Promise<string>;
  detectInstallation(agentDir: string): Promise<PiWebInstallationInfo>;
  realpath(path: string): Promise<string>;
  capture(command: PiWebUpdateCommand): Promise<string>;
  run(command: PiWebUpdateCommand): Promise<void>;
  confirm(message: string): Promise<boolean>;
  log(message: string): void;
}

function defaultDependencies(): PiWebUpdateDependencies {
  return {
    env: { ...process.env },
    nodeExecutable: process.execPath,
    platform: process.platform,
    home: homedir(),
    userId: userInfo().uid,
    cwd: process.cwd(),
    uniqueId: randomUUID,
    exists: existsSync,
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    writeFile: (path, contents) => writeFile(path, contents, { encoding: "utf8", mode: 0o600 }),
    removeFile: (path) => rm(path, { force: true }),
    // Use this installation's Pi, not an unrelated (or older) `pi` on PATH.
    piCliPath: fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
    interactive: isatty(0) && isatty(1),
    async agentDir() {
      const active = await new SessionDaemonClient().getActiveAgentProfile();
      if (active.status === "available") return active.profile.dir;
      if (active.status === "invalid") throw new Error(`Cannot safely resolve the active Pi profile: ${active.error}`);
      return effectivePiWebConfig().config.agent.dir;
    },
    detectInstallation: detectPiWebInstallation,
    realpath,
    async capture(command) {
      const result = await promisify(execFile)(command.executable, command.args, { env: command.env, encoding: "utf8" });
      return result.stdout.trim();
    },
    run(command) {
      return new Promise<void>((resolveRun, reject) => {
        const child = spawn(command.executable, command.args, { env: command.env, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolveRun();
          else reject(new Error(`${command.executable} failed (${signal ?? `exit ${String(code)}`}); no further update/restart steps were run.`));
        });
      });
    },
    async confirm(message) {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^(y|yes)$/i.test((await input.question(`${message} [y/N] `)).trim());
      } finally {
        input.close();
      }
    },
    log: console.log,
  };
}

/** CLI arguments exclude `update`. Throws on invalid/unsafe requests and failed commands. */
export async function runPiWebUpdate(args: readonly string[], injected?: PiWebUpdateDependencies): Promise<void> {
  const valid = args.length === 0 || (args.length === 1 && ["--yes", "--help", "-h"].includes(args[0] ?? ""));
  if (!valid) throw new Error(`Invalid update arguments. ${HELP}`);
  const deps = injected ?? defaultDependencies();
  if (args[0] === "--help" || args[0] === "-h") {
    deps.log(HELP);
    return;
  }
  const agentDir = await deps.agentDir();
  if (!isHostAbsoluteAgentDir(agentDir)) throw new Error("Cannot safely resolve the Pi profile: expected a host-absolute directory.");
  const installation = await deps.detectInstallation(agentDir);
  const nested = truthy(deps.env["PI_WEB_SESSION"]);
  if (installation.kind === "unknown") {
    deps.log("No automatic update for an unknown installation. Update using the installation's original tooling, then run pi-web restart from a host terminal. Nothing changed.");
    return;
  }
  if (installation.kind !== "docker" && nested && deps.platform !== "linux" && deps.platform !== "darwin") {
    throw new Error("Native update refused inside a PI WEB session: restarting its daemon could kill the updater. Open a host terminal outside PI WEB and run pi-web update there. --yes does not bypass this safety check.");
  }
  const command = (executable: string, commandArgs: string[], env = deps.env): PiWebUpdateCommand => ({ executable, args: commandArgs, env: { ...env } });
  let update: PiWebUpdateCommand;
  let updateAfterPull: PiWebUpdateCommand[] = [];
  let localCheckoutPull: PiWebUpdateCommand | undefined;
  let restart: PiWebUpdateCommand | undefined;
  if (installation.kind === "docker") {
    if (installation.dockerMode !== "runtime" && installation.dockerMode !== "dev") {
      throw new Error("Docker installation mode is unknown. Use the original pi-web-docker host installation to update; nothing changed.");
    }
    update = command("pi-web-docker", [...(installation.dockerMode === "dev" ? ["--dev"] : []), "update"]);
  } else {
    if (installation.path === undefined || !isAbsolute(installation.path)) throw new Error("Cannot safely locate this PI WEB installation; nothing changed.");
    restart = command(deps.nodeExecutable, [join(installation.path, "dist", "cli.js"), "restart"]);
    if (installation.kind === "local") {
      const localPlan = await planLocalCheckoutUpdate(deps, installation.path);
      localCheckoutPull = localPlan.pull;
      update = localPlan.pull;
      updateAfterPull = [localPlan.install, localPlan.build];
    } else if (installation.kind === "npm-global") {
      const root = installation.npmRoot;
      if (root === undefined || !isAbsolute(root)) throw new Error("Cannot safely locate this global npm installation; nothing changed.");
      // Unix npm prefixes use lib/node_modules; Windows prefixes use node_modules.
      const prefix = basename(dirname(root)) === "lib" ? dirname(dirname(root)) : dirname(root);
      const actualRoot = await deps.capture(command("npm", ["root", "--global", "--prefix", prefix]));
      if (await deps.realpath(actualRoot) !== await deps.realpath(root)
        || await deps.realpath(join(root, PACKAGE_NAME)) !== await deps.realpath(installation.path)) {
        throw new Error("Global npm target does not match this installation; nothing changed.");
      }
      update = command("npm", ["install", "--global", "--prefix", resolve(prefix), `${PACKAGE_NAME}@latest`, "--allow-scripts=node-pty"]);
    } else {
      if (installation.scope !== "user" || installation.source === undefined || installation.source === "" || !/^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(installation.source)) {
        throw new Error("Only user-scope remote Pi packages can be updated automatically. Update this package with its original tooling; nothing changed.");
      }
      // --no-approve excludes project settings even in previously trusted projects.
      // An explicit extension target cannot invoke Pi's universal/self updater.
      update = command(deps.nodeExecutable, [deps.piCliPath, "update", "--no-approve", "--extension", installation.source], {
        ...deps.env, [PI_CODING_AGENT_DIR_ENV]: agentDir,
      });
    }
  }
  let restartUnit: string | undefined;
  let launchdHandoff: LaunchdUpdateHandoff | undefined;
  if (restart !== undefined) {
    await preflightNativeServices(deps);
    if (nested && deps.platform === "linux") {
      restartUnit = `pi-web-update-restart-${deps.uniqueId()}`;
      const dispatchArgs = systemdDispatchArgs(deps);
      // Exercise the same external owner and environment without touching services.
      // --wait is only for this harmless probe, never for the actual restart.
      try {
        await deps.capture(command("systemd-run", [
          ...dispatchArgs, `--unit=${restartUnit}-preflight`, "--wait", "--",
          deps.nodeExecutable, "--eval", "process.exit(0)",
        ]));
      } catch (error) {
        throw new Error("Cannot safely dispatch a detached systemd restart. Use a host terminal outside PI WEB; nothing changed.", { cause: error });
      }
      restart = command("systemd-run", [...dispatchArgs, `--unit=${restartUnit}`, "--", restart.executable, ...restart.args]);
    } else if (nested && deps.platform === "darwin") {
      launchdHandoff = createLaunchdUpdateHandoff(deps, installation);
    }
  }
  deps.log(`Update target: ${installation.kind}${installation.path === undefined ? "" : ` at ${JSON.stringify(installation.path)}`}`);
  deps.log(`Install: ${[update, ...updateAfterPull].map((step) => [step.executable, ...step.args].map((value) => JSON.stringify(value)).join(" ")).join(" && ")}`);
  if (restart !== undefined) {
    const handoffDescription = restartUnit === undefined
      ? launchdHandoff === undefined ? "" : ` via detached launchd user agent ${launchdHandoff.target}`
      : ` via detached systemd user unit ${restartUnit}`;
    deps.log(`After install succeeds: ${JSON.stringify(deps.nodeExecutable)} ${JSON.stringify(join(installation.path ?? "", "dist", "cli.js"))} restart${handoffDescription}.`);
    if (launchdHandoff !== undefined) deps.log(`Detached update output: ${launchdHandoff.logPath}`);
  } else {
    deps.log("The Docker installer owns the update and service restart.");
  }
  deps.log(WARNING);
  if (args[0] !== "--yes") {
    if (!deps.interactive) throw new Error("Noninteractive update requires explicit --yes consent. Nothing changed.");
    if (!await deps.confirm("Proceed with the update and restart?")) {
      deps.log("Update cancelled. Nothing changed.");
      return;
    }
  }
  if (launchdHandoff !== undefined) {
    await dispatchLaunchdUpdate(deps, launchdHandoff);
    deps.log(`Update handed off to launchd user agent ${launchdHandoff.target}; completion is not verified. Inspect ${launchdHandoff.logPath}.`);
    return;
  }
  if (localCheckoutPull !== undefined) {
    try {
      await deps.run(localCheckoutPull);
    } catch (error: unknown) {
      throw new Error("Could not fast-forward the local checkout. Ensure it is clean, has a reachable upstream, and can be pulled without a merge; no install or restart was run.", { cause: error });
    }
    for (const step of updateAfterPull) await deps.run(step);
  } else {
    await deps.run(update);
  }
  if (restart !== undefined) {
    await deps.run(restart);
    if (restartUnit !== undefined) deps.log(`Restart dispatched, not verified complete. Inspect journalctl --user -u ${restartUnit}.`);
  }
}

interface LocalCheckoutUpdatePlan {
  pull: PiWebUpdateCommand;
  install: PiWebUpdateCommand;
  build: PiWebUpdateCommand;
}

async function planLocalCheckoutUpdate(deps: PiWebUpdateDependencies, path: string): Promise<LocalCheckoutUpdatePlan> {
  const gitEnvironment = { ...deps.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]): PiWebUpdateCommand => ({ executable: "git", args: ["-C", path, ...args], env: { ...gitEnvironment } });
  const captureGit = async (args: string[], failure: string): Promise<string> => {
    try {
      return (await deps.capture(git(args))).trim();
    } catch (error: unknown) {
      throw new Error(`${failure} Nothing changed.`, { cause: error });
    }
  };
  const gitRoot = await captureGit(["rev-parse", "--show-toplevel"], "Cannot safely update the local installation: it is not a Git checkout or its root could not be inspected.");
  if (gitRoot === "" || await deps.realpath(gitRoot) !== await deps.realpath(path)) {
    throw new Error("Cannot safely update the local installation: the package root is not the Git checkout root. Nothing changed.");
  }
  const status = await captureGit(["status", "--porcelain=v1", "--untracked-files=all"], "Cannot inspect the local checkout status.");
  if (status !== "") {
    throw new Error("The local checkout has uncommitted or untracked changes. Commit, stash, or remove them before updating; nothing changed.");
  }
  const branch = await captureGit(["symbolic-ref", "--quiet", "--short", "HEAD"], "The local checkout is detached or its current branch could not be determined.");
  if (branch === "") throw new Error("The local checkout is detached; check out a branch with an upstream before updating. Nothing changed.");
  const upstream = await captureGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], `The local checkout branch ${JSON.stringify(branch)} has no upstream branch configured.`);
  if (upstream === "") throw new Error(`The local checkout branch ${JSON.stringify(branch)} has no upstream branch configured. Nothing changed.`);
  return {
    pull: git(["pull", "--ff-only"]),
    install: { executable: "npm", args: ["--prefix", path, "install"], env: { ...deps.env } },
    build: { executable: "npm", args: ["--prefix", path, "run", "build"], env: { ...deps.env } },
  };
}

function createLaunchdUpdateHandoff(
  deps: PiWebUpdateDependencies,
  installation: PiWebInstallationInfo,
): LaunchdUpdateHandoff {
  if (installation.path === undefined || !isAbsolute(installation.path)) {
    throw new Error("Cannot safely locate this PI WEB installation for a launchd handoff; nothing changed.");
  }
  if (!isAbsolute(deps.home) || !isAbsolute(deps.cwd) || !isAbsolute(deps.nodeExecutable)) {
    throw new Error("Cannot safely create a launchd handoff from a relative path; nothing changed.");
  }
  if (!Number.isInteger(deps.userId) || deps.userId < 0) {
    throw new Error("Cannot safely resolve the macOS user domain for a launchd handoff; nothing changed.");
  }
  const id = deps.uniqueId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("Cannot safely create a launchd handoff with an invalid identifier; nothing changed.");
  }
  const label = `${UPDATE_HANDOFF_LABEL_PREFIX}-${id}`;
  const domain = `gui/${String(deps.userId)}`;
  const environment = launchdHandoffEnvironment(deps.env);
  const plistPath = join(deps.home, ".pi-web", "update-handoffs", `${label}.plist`);
  const logPath = join(deps.home, ".pi-web", "logs", `${label}.log`);
  return {
    domain,
    label,
    target: `${domain}/${label}`,
    plistPath,
    logPath,
    environment,
    plist: renderLaunchdUpdatePlist({
      label,
      nodeExecutable: deps.nodeExecutable,
      cliPath: join(installation.path, "dist", "cli.js"),
      workingDirectory: deps.cwd,
      environment,
      logPath,
    }),
  };
}

async function dispatchLaunchdUpdate(deps: PiWebUpdateDependencies, handoff: LaunchdUpdateHandoff): Promise<void> {
  let wrotePlist = false;
  try {
    await deps.mkdir(dirname(handoff.plistPath));
    await deps.mkdir(dirname(handoff.logPath));
    // Treat a failed write as potentially leaving a partial file behind.
    wrotePlist = true;
    await deps.writeFile(handoff.plistPath, handoff.plist);
    // bootstrap loads the one-shot plist into the user's GUI launchd domain.
    // RunAtLoad starts it under launchd, outside the sessiond process group that
    // is about to be restarted. KeepAlive is explicitly false so an update
    // failure cannot turn into an automatic retry loop.
    await deps.run({
      executable: "launchctl",
      args: ["bootstrap", handoff.domain, handoff.plistPath],
      env: handoff.environment,
    });
  } catch (error: unknown) {
    if (wrotePlist) await removeHandoffPlist(deps, handoff.plistPath);
    throw new Error("Cannot safely dispatch a detached launchd update. Use a host terminal outside PI WEB; nothing changed.", { cause: error });
  }

  // The plist is deliberately outside ~/Library/LaunchAgents, so it is not
  // loaded again at the next login. launchd has already parsed it after a
  // successful bootstrap; retaining only the log keeps the handoff ephemeral.
  await removeHandoffPlist(deps, handoff.plistPath);
}

async function removeHandoffPlist(deps: PiWebUpdateDependencies, path: string): Promise<void> {
  try {
    await deps.removeFile(path);
  } catch (error: unknown) {
    deps.log(`Warning: could not remove temporary launchd handoff ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function launchdHandoffEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const portableKeys = new Set([
    "HOME",
    "PATH",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "NODE_EXTRA_CA_CERTS",
  ]);
  for (const key of Object.keys(source).sort()) {
    if (key === "PI_WEB_SESSION" || (!key.startsWith("PI_WEB_") && !key.startsWith("PI_CODING_AGENT_") && !portableKeys.has(key))) continue;
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

interface LaunchdUpdatePlistInput {
  label: string;
  nodeExecutable: string;
  cliPath: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  logPath: string;
}

function renderLaunchdUpdatePlist(input: LaunchdUpdatePlistInput): string {
  const programArguments = [input.nodeExecutable, input.cliPath, "update", "--yes"];
  const environmentEntries = Object.keys(input.environment)
    .sort()
    .map((key) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(input.environment[key] ?? "")}</string>\n`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => `    <string>${xmlEscape(argument)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentEntries}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logPath)}</string>
</dict>
</plist>
`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function preflightNativeServices(deps: PiWebUpdateDependencies): Promise<void> {
  if (deps.platform !== "linux" && deps.platform !== "darwin") throw new Error("Automatic native update requires Linux or macOS services; nothing changed.");
  const installed = Object.entries(nativeServiceManagerRefs).filter(([, ref]) => deps.exists(deps.platform === "linux"
    ? join(deps.home, ".config", "systemd", "user", ref.systemdName)
    : join(deps.home, "Library", "LaunchAgents", ref.launchdPlistName)));
  if (!installed.some(([id]) => id === "sessiond") || !installed.some(([id]) => id === "web" || id === "uiDev")) {
    throw new Error("Native services are missing or incomplete. Run pi-web install from a host terminal, or update manually with the original tooling; nothing changed.");
  }
  if (deps.platform === "linux") {
    for (const [, ref] of installed) {
      const state = await deps.capture({ executable: "systemctl", args: ["--user", "show", ref.systemdName, "--property=LoadState", "--value"], env: { ...deps.env } });
      if (state.trim() !== "loaded") throw new Error(`Native service ${ref.systemdName} is not loaded. Repair services before updating; nothing changed.`);
    }
  }
}

function systemdDispatchArgs(deps: PiWebUpdateDependencies): string[] {
  // User-manager services do not inherit the caller's environment. Propagate
  // configuration/runtime selection deliberately, not terminal/session secrets.
  // Preserve cwd too: config and data overrides may be relative paths.
  const keys = Object.keys(deps.env).filter((key) =>
    /^(PI_WEB_|PI_CODING_AGENT_)/.test(key)
    || ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "NODE_EXTRA_CA_CERTS"].includes(key));
  return ["--user", "--collect", "--expand-environment=no", `--working-directory=${deps.cwd}`,
    ...keys.filter((key) => deps.env[key] !== undefined).map((key) => `--setenv=${key}`)];
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
