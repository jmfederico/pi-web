import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiWebCapability, PiWebComponentStatus, PiWebInstallationInfo, PiWebReleaseStatus, PiWebRuntimeComponent, PiWebRuntimeResponse, PiWebServiceComponent, PiWebStatusMessage, PiWebStatusResponse, PiWebVersionResponse } from "../shared/apiTypes.js";
import { effectivePiWebCapabilities, WEB_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { parsePiWebComponentStatus, parsePiWebRuntimeComponent } from "../shared/piWebStatusParsing.js";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import { effectiveAgentConfig } from "../config.js";

const PI_WEB_PACKAGE_NAME = "@jmfederico/pi-web";
const PI_WEB_NPM_SOURCE = `npm:${PI_WEB_PACKAGE_NAME}`;
const DEFAULT_VERSION = "0.0.0-dev";
const LATEST_RELEASE_CACHE_MS = 6 * 60 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 5000;

type ServiceId = "sessiond" | "web" | "uiDev";
type NativeServiceBackendKind = "systemd" | "launchd";

interface NativeServiceRef {
  id: ServiceId;
  systemdName: string;
  launchdLabel: string;
  launchdPlistName: string;
}

interface NativeServiceCommands {
  restart?: string;
  restartWeb?: string;
  restartSessiond?: string;
  status?: string;
}

const execFileAsync = promisify(execFile);

const serviceRefs: Record<ServiceId, NativeServiceRef> = {
  sessiond: {
    id: "sessiond",
    systemdName: "pi-web-sessiond.service",
    launchdLabel: "com.pi-web.sessiond",
    launchdPlistName: "com.pi-web.sessiond.plist",
  },
  web: {
    id: "web",
    systemdName: "pi-web.service",
    launchdLabel: "com.pi-web.web",
    launchdPlistName: "com.pi-web.web.plist",
  },
  uiDev: {
    id: "uiDev",
    systemdName: "pi-web-ui-dev.service",
    launchdLabel: "com.pi-web.ui-dev",
    launchdPlistName: "com.pi-web.ui-dev.plist",
  },
};

const startServiceOrder: ServiceId[] = ["sessiond", "web", "uiDev"];
// Restart web/UI before sessiond: when the restart command runs in a pi-web
// terminal (owned by sessiond), restarting sessiond kills the command, so any
// services listed after it would never be restarted.
const restartServiceOrder: ServiceId[] = ["web", "uiDev", "sessiond"];

interface PackageInfo {
  name: string;
  version: string;
  path: string;
}

interface PiWebStatusDaemon {
  request(method: string, path: string, body?: unknown): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
}

interface PiWebStatusOptions {
  agentCommand?: string;
  agentDir?: string;
  hasCommand?: (command: string) => Promise<boolean>;
}

function effectiveStatusAgentConfig(options: PiWebStatusOptions): { command: string; dir: string } {
  const agent = effectiveAgentConfig(process.env, {
    agent: {
      ...(options.agentCommand === undefined ? {} : { command: options.agentCommand }),
      ...(options.agentDir === undefined ? {} : { dir: options.agentDir }),
    },
  });
  return { command: agent.command, dir: agent.dir };
}

let latestReleaseCache: { checkedAtMs: number; latestVersion?: string; error?: string } | undefined;

const runtimePackageInfo = readPackageInfoSync();

export function getPiWebRuntimeComponent(component: PiWebServiceComponent, capabilities: readonly PiWebCapability[] = []): PiWebRuntimeComponent {
  return {
    component,
    label: component === "web" ? "Web/UI" : "Session daemon",
    runtimeVersion: runtimePackageInfo?.version ?? DEFAULT_VERSION,
    available: true,
    capabilities: [...capabilities],
  };
}

export async function getPiWebRuntime(daemon: PiWebStatusDaemon = new SessionDaemonClient()): Promise<PiWebRuntimeResponse> {
  const web = getPiWebRuntimeComponent("web", WEB_RUNTIME_CAPABILITIES);
  const sessiond = await getSessiondRuntimeComponent(daemon);
  return {
    packageName: PI_WEB_PACKAGE_NAME,
    generatedAt: new Date().toISOString(),
    components: { web, sessiond },
    capabilities: effectivePiWebCapabilities({ web, sessiond }),
  };
}

export async function getPiWebComponentStatus(component: PiWebServiceComponent, options: PiWebStatusOptions = {}): Promise<PiWebComponentStatus> {
  const [installed, installation] = await Promise.all([
    readInstalledPackageInfo(),
    detectPiWebInstallation(options.agentDir),
  ]);
  const runtimeVersion = runtimePackageInfo?.version ?? DEFAULT_VERSION;
  const installedVersion = installed?.version;
  return {
    component,
    label: component === "web" ? "Web/UI" : "Session daemon",
    runtimeVersion,
    ...(installedVersion === undefined ? {} : { installedVersion }),
    stale: isInstalledVersionNewer(installedVersion, runtimeVersion),
    available: true,
    installation,
  };
}

export async function getPiWebVersionStatus(daemon: PiWebStatusDaemon = new SessionDaemonClient(), options: PiWebStatusOptions = {}): Promise<PiWebVersionResponse> {
  const [web, sessiond] = await Promise.all([
    getPiWebComponentStatus("web", options),
    getSessiondComponentStatus(daemon, options),
  ]);
  return {
    packageName: PI_WEB_PACKAGE_NAME,
    generatedAt: new Date().toISOString(),
    components: { web, sessiond },
  };
}

export async function getPiWebStatus(daemon: PiWebStatusDaemon = new SessionDaemonClient(), options: PiWebStatusOptions = {}): Promise<PiWebStatusResponse> {
  const agent = effectiveStatusAgentConfig(options);
  const versionStatus = await getPiWebVersionStatus(daemon, { ...options, agentDir: agent.dir });
  const { web, sessiond } = versionStatus.components;
  const release = await getLatestReleaseStatus(web.installedVersion ?? web.runtimeVersion ?? DEFAULT_VERSION);
  const components = { web, sessiond };
  const commands = await commandsFor(components, { agentCommand: agent.command, hasCommand: options.hasCommand ?? hasCommand });
  const messages = buildMessages(components, release, commands);
  return {
    ...versionStatus,
    release,
    commands,
    messages,
  };
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
  const left = parsePackageVersion(leftVersion);
  const right = parsePackageVersion(rightVersion);
  if (left === undefined || right === undefined) return undefined;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function readPackageInfoSync(): PackageInfo | undefined {
  const path = packageJsonPath();
  try {
    return parsePackageInfo(JSON.parse(readFileSync(path, "utf8")), path);
  } catch {
    return undefined;
  }
}

async function readInstalledPackageInfo(): Promise<PackageInfo | undefined> {
  const path = packageJsonPath();
  try {
    await stat(path);
    return parsePackageInfo(JSON.parse(await readFile(path, "utf8")), path);
  } catch {
    return undefined;
  }
}

function packageJsonPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
}

function parsePackageInfo(value: unknown, path: string): PackageInfo | undefined {
  if (!isRecord(value)) return undefined;
  const name = value["name"];
  const version = value["version"];
  if (typeof name !== "string" || name === "" || typeof version !== "string" || version === "") return undefined;
  return { name, version, path };
}

async function detectPiWebInstallation(agentDir = effectiveAgentConfig().dir): Promise<PiWebInstallationInfo> {
  const root = packageRootPath();
  const realRoot = await realPathOrSelf(root);
  const piPackage = await detectPiPackageInstallation(realRoot, root, agentDir);
  if (piPackage !== undefined) return piPackage;
  const npmGlobal = await detectNpmGlobalInstallation(realRoot, root);
  if (npmGlobal !== undefined) return npmGlobal;
  return { kind: "local", path: root };
}

async function detectPiPackageInstallation(realRoot: string, displayPath: string, agentDir: string): Promise<PiWebInstallationInfo | undefined> {
  try {
    const packageManager = new DefaultPackageManager({
      cwd: process.cwd(),
      agentDir,
      settingsManager: SettingsManager.create(process.cwd(), agentDir),
    });
    for (const configuredPackage of packageManager.listConfiguredPackages()) {
      const installedPath = configuredPackage.installedPath ?? packageManager.getInstalledPath(configuredPackage.source, configuredPackage.scope);
      if (installedPath === undefined) continue;
      const realInstalledPath = await realPathOrSelf(installedPath);
      if (isSameOrWithin(realInstalledPath, realRoot) || isSameOrWithin(realRoot, realInstalledPath)) {
        return { kind: "pi-package", path: displayPath, source: configuredPackage.source, scope: configuredPackage.scope };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function detectNpmGlobalInstallation(realRoot: string, displayPath: string): Promise<PiWebInstallationInfo | undefined> {
  const npmRoot = await npmGlobalRoot();
  if (npmRoot === undefined) return undefined;
  const realNpmRoot = await realPathOrSelf(npmRoot);
  if (!isSameOrWithin(realNpmRoot, realRoot)) return undefined;
  return { kind: "npm-global", path: displayPath, npmRoot };
}

async function npmGlobalRoot(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], { encoding: "utf8" });
    const root = stdout.trim();
    return root === "" ? undefined : root;
  } catch {
    return undefined;
  }
}

function packageRootPath(): string {
  return dirname(packageJsonPath());
}

async function realPathOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function isSameOrWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

async function getSessiondRuntimeComponent(daemon: PiWebStatusDaemon): Promise<PiWebRuntimeComponent> {
  try {
    const upstream = await daemon.request("GET", "/runtime");
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      return await legacySessiondRuntimeComponent(daemon) ?? unavailableSessiondRuntime(`runtime check returned HTTP ${String(upstream.statusCode)}`);
    }
    const parsed: unknown = upstream.body === "" ? undefined : JSON.parse(upstream.body);
    const runtime = parsePiWebRuntimeComponent(parsed);
    if (runtime !== undefined) return runtime;
    const legacyVersion = isRecord(parsed) ? parsePiWebComponentStatus(parsed["version"]) : undefined;
    if (legacyVersion !== undefined) return runtimeComponentFromStatus(legacyVersion);
    return await legacySessiondRuntimeComponent(daemon) ?? unavailableSessiondRuntime("runtime response did not include valid runtime information");
  } catch (error) {
    return unavailableSessiondRuntime(error instanceof Error ? error.message : String(error));
  }
}

async function getSessiondComponentStatus(daemon: PiWebStatusDaemon, options: PiWebStatusOptions = {}): Promise<PiWebComponentStatus> {
  try {
    const upstream = await daemon.request("GET", "/runtime");
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      return await legacySessiondComponentStatus(daemon) ?? unavailableSessiond(`runtime check returned HTTP ${String(upstream.statusCode)}`);
    }
    const parsed: unknown = upstream.body === "" ? undefined : JSON.parse(upstream.body);
    const legacyVersion = isRecord(parsed) ? parsePiWebComponentStatus(parsed["version"]) : undefined;
    if (legacyVersion !== undefined) return legacyVersion;
    const runtime = parsePiWebRuntimeComponent(parsed);
    if (runtime?.available !== true) return await legacySessiondComponentStatus(daemon) ?? unavailableSessiond(runtime?.error ?? "runtime response did not include valid runtime information");
    const status = await getPiWebComponentStatus("sessiond", options);
    return { ...status, ...(runtime.runtimeVersion === undefined ? {} : { runtimeVersion: runtime.runtimeVersion }), available: true };
  } catch (error) {
    return unavailableSessiond(error instanceof Error ? error.message : String(error));
  }
}

async function legacySessiondRuntimeComponent(daemon: PiWebStatusDaemon): Promise<PiWebRuntimeComponent | undefined> {
  const status = await legacySessiondComponentStatus(daemon);
  return status === undefined ? undefined : runtimeComponentFromStatus(status);
}

async function legacySessiondComponentStatus(daemon: PiWebStatusDaemon): Promise<PiWebComponentStatus | undefined> {
  try {
    const upstream = await daemon.request("GET", "/health");
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) return undefined;
    const parsed: unknown = upstream.body === "" ? undefined : JSON.parse(upstream.body);
    return isRecord(parsed) ? parsePiWebComponentStatus(parsed["version"]) : undefined;
  } catch {
    return undefined;
  }
}

function runtimeComponentFromStatus(status: PiWebComponentStatus): PiWebRuntimeComponent {
  return {
    component: status.component,
    label: status.label,
    ...(status.runtimeVersion === undefined ? {} : { runtimeVersion: status.runtimeVersion }),
    available: status.available,
    capabilities: [],
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

function unavailableSessiondRuntime(error: string): PiWebRuntimeComponent {
  return {
    component: "sessiond",
    label: "Session daemon",
    available: false,
    capabilities: [],
    error,
  };
}

function unavailableSessiond(error: string): PiWebComponentStatus {
  return {
    component: "sessiond",
    label: "Session daemon",
    stale: false,
    available: false,
    error,
  };
}

async function getLatestReleaseStatus(currentVersion: string): Promise<PiWebReleaseStatus> {
  const checkedAtMs = Date.now();
  if (skipVersionCheck()) {
    return { packageName: PI_WEB_PACKAGE_NAME, updateAvailable: false, checkedAt: new Date(checkedAtMs).toISOString(), skipped: true };
  }

  if (latestReleaseCache !== undefined && checkedAtMs - latestReleaseCache.checkedAtMs < LATEST_RELEASE_CACHE_MS) {
    return releaseStatusFromCache(latestReleaseCache, currentVersion);
  }

  try {
    latestReleaseCache = { checkedAtMs, latestVersion: await fetchLatestNpmVersion(currentVersion) };
  } catch (error) {
    latestReleaseCache = { checkedAtMs, error: error instanceof Error ? error.message : String(error) };
  }
  return releaseStatusFromCache(latestReleaseCache, currentVersion);
}

function releaseStatusFromCache(cache: { checkedAtMs: number; latestVersion?: string; error?: string }, currentVersion: string): PiWebReleaseStatus {
  return {
    packageName: PI_WEB_PACKAGE_NAME,
    ...(cache.latestVersion === undefined ? {} : { latestVersion: cache.latestVersion }),
    updateAvailable: cache.latestVersion === undefined ? false : isNewerPackageVersion(cache.latestVersion, currentVersion),
    checkedAt: new Date(cache.checkedAtMs).toISOString(),
    ...(cache.error === undefined ? {} : { error: cache.error }),
  };
}

async function fetchLatestNpmVersion(currentVersion: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PI_WEB_PACKAGE_NAME)}/latest`, {
    headers: {
      accept: "application/json",
      "user-agent": `${PI_WEB_PACKAGE_NAME}/${currentVersion}`,
    },
    signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${String(response.status)}`);
  const data: unknown = await response.json();
  const version = isRecord(data) ? data["version"] : undefined;
  if (typeof version !== "string" || version === "") throw new Error("npm registry response did not include a version");
  return version;
}

async function commandsFor(components: PiWebStatusResponse["components"], options: { agentCommand: string; hasCommand: (command: string) => Promise<boolean> }): Promise<PiWebStatusResponse["commands"]> {
  const installation = preferredInstallation(components);
  const [serviceCommands, cliCommands] = await Promise.all([
    nativeServiceCommands(),
    piWebCliCommands(installation),
  ]);
  const restart = restartCommandFor(installation, serviceCommands, cliCommands);
  const restartWeb = serviceCommands.restartWeb ?? cliCommands.restart;
  const restartSessiond = serviceCommands.restartSessiond ?? cliCommands.restart;
  const status = serviceCommands.status ?? cliCommands.status;
  const update = await updateCommandFor(installation, restart, options);

  return {
    ...(update === undefined ? {} : { update }),
    ...(restart === undefined ? {} : { restart }),
    ...(restartWeb === undefined ? {} : { restartWeb }),
    ...(restartSessiond === undefined ? {} : { restartSessiond }),
    ...(status === undefined ? {} : { status }),
  };
}

function preferredInstallation(components: PiWebStatusResponse["components"]): PiWebInstallationInfo | undefined {
  const web = components.web.installation;
  const sessiond = components.sessiond.installation;
  if (web?.kind === "local" || sessiond?.kind === "local") return web?.kind === "local" ? web : sessiond;
  return web ?? sessiond;
}

async function piWebCliCommands(installation: PiWebInstallationInfo | undefined): Promise<NativeServiceCommands> {
  if (installation?.kind !== "npm-global" || !(await hasCommand("pi-web"))) return {};
  return { restart: "pi-web restart", status: "pi-web status" };
}

function restartCommandFor(installation: PiWebInstallationInfo | undefined, serviceCommands: NativeServiceCommands, cliCommands: NativeServiceCommands): string | undefined {
  if (installation?.kind === "local" || installation?.kind === "pi-package") return serviceCommands.restart ?? cliCommands.restart;
  return cliCommands.restart ?? serviceCommands.restart;
}

export async function updateCommandFor(installation: PiWebInstallationInfo | undefined, restartCommand: string | undefined, options: { agentCommand: string; hasCommand: (command: string) => Promise<boolean> }): Promise<string | undefined> {
  if (restartCommand === undefined) return undefined;
  if (installation?.kind === "pi-package") {
    if (!(await options.hasCommand(options.agentCommand))) return undefined;
    return `${shellQuote(options.agentCommand)} update ${shellQuote(installation.source ?? PI_WEB_NPM_SOURCE)} && ${restartCommand}`;
  }
  if (installation?.kind === "local" && installation.path !== undefined) {
    if (!(await hasCommand("npm")) || !(await isGitCheckoutWithUpstream(installation.path))) return undefined;
    return `cd ${shellQuote(installation.path)} && git pull --ff-only && npm install && npm run build && ${restartCommand}`;
  }
  if (installation?.kind !== "npm-global" || !(await hasCommand("npm"))) return undefined;
  return `npm install -g ${PI_WEB_PACKAGE_NAME} && ${restartCommand}`;
}

async function nativeServiceCommands(): Promise<NativeServiceCommands> {
  const backend = await nativeServiceBackend();
  if (backend === undefined) return {};
  const installed = installedServiceIds(backend);
  if (installed.size === 0) return {};
  const web = installedServiceRefs(installed, ["web", "uiDev"]);
  const sessiond = installedServiceRefs(installed, ["sessiond"]);
  const restartable = web.length === 0 ? [] : installedServiceRefs(installed, restartServiceOrder, restartServiceOrder);
  const status = installedServiceRefs(installed);
  return {
    ...(restartable.length === 0 ? {} : { restart: restartNativeServicesCommand(backend, restartable, "pi-web-restart") }),
    ...(web.length === 0 ? {} : { restartWeb: restartNativeServicesCommand(backend, web, "pi-web-restart-web") }),
    ...(sessiond.length === 0 ? {} : { restartSessiond: restartNativeServicesCommand(backend, sessiond, "pi-web-restart-sessiond") }),
    ...(status.length === 0 ? {} : { status: statusNativeServicesCommand(backend, status) }),
  };
}

async function nativeServiceBackend(): Promise<NativeServiceBackendKind | undefined> {
  if (process.platform === "linux" && await hasCommand("systemctl")) return "systemd";
  if (process.platform === "darwin" && await hasCommand("launchctl")) return "launchd";
  return undefined;
}

function installedServiceIds(backend: NativeServiceBackendKind): Set<ServiceId> {
  return new Set(startServiceOrder.filter((id) => existsSync(serviceFilePath(backend, serviceRefs[id]))));
}

function installedServiceRefs(installed: Set<ServiceId>, candidates: ServiceId[] = startServiceOrder, order: ServiceId[] = startServiceOrder): NativeServiceRef[] {
  return order.filter((id) => candidates.includes(id) && installed.has(id)).map((id) => serviceRefs[id]);
}

function serviceFilePath(backend: NativeServiceBackendKind, ref: NativeServiceRef): string {
  return backend === "systemd" ? join(systemdServiceDir(), ref.systemdName) : join(launchdServiceDir(), ref.launchdPlistName);
}

function systemdServiceDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function launchdServiceDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function restartNativeServicesCommand(backend: NativeServiceBackendKind, refs: NativeServiceRef[], systemdUnit: string): string {
  // On systemd, run the restart inside a transient, detached `.service` unit
  // (the default `systemd-run` mode, not `--scope`). A scope would stay a child
  // of the calling shell and die with the terminal; a transient service is
  // reparented to the user service manager, so the restart finishes even when
  // restarting the session daemon kills the pi-web terminal that launched it.
  // `--collect` cleans the unit up afterwards, and the fixed `--unit` name makes
  // logs easy to find with `journalctl --user -u <unit>`.
  if (backend === "systemd") {
    const names = refs.map((ref) => ref.systemdName).join(" ");
    return `systemd-run --user --collect --unit=${systemdUnit} -- systemctl --user restart ${names}`;
  }
  return refs.map((ref) => `launchctl kickstart -k gui/$(id -u)/${ref.launchdLabel}`).join(" && ");
}

function statusNativeServicesCommand(backend: NativeServiceBackendKind, refs: NativeServiceRef[]): string {
  if (backend === "systemd") return `systemctl --user status ${refs.map((ref) => ref.systemdName).join(" ")}`;
  return refs.map((ref) => `launchctl print gui/$(id -u)/${ref.launchdLabel}`).join(" && ");
}

async function isGitCheckoutWithUpstream(path: string): Promise<boolean> {
  return await hasCommand("git")
    && await commandSucceeds("git", ["-C", path, "rev-parse", "--is-inside-work-tree"])
    && await commandSucceeds("git", ["-C", path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
}

function hasCommand(command: string): Promise<boolean> {
  return commandSucceeds("/usr/bin/env", ["sh", "-c", `command -v ${shellQuote(command)}`]);
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildMessages(components: PiWebStatusResponse["components"], release: PiWebReleaseStatus, commands: PiWebStatusResponse["commands"]): PiWebStatusMessage[] {
  const messages: PiWebStatusMessage[] = [];
  const installedVersion = components.web.installedVersion ?? components.web.runtimeVersion;

  if (release.updateAvailable && release.latestVersion !== undefined) {
    messages.push({
      id: "update-available",
      severity: "info",
      title: "PI WEB update available",
      body: commands.update === undefined
        ? `PI WEB ${release.latestVersion} is available${installedVersion === undefined ? "" : `; installed version is ${installedVersion}`}. Update PI WEB, then restart the services or processes for this installation.`
        : `PI WEB ${release.latestVersion} is available${installedVersion === undefined ? "" : `; installed version is ${installedVersion}`}. Run the update command to update PI WEB and restart its services.`,
      ...optionalMessageCommand(commands.update),
    });
  }

  if (components.web.stale) {
    const command = commands.restartWeb ?? commands.restart;
    messages.push({
      id: "web-stale",
      severity: "warning",
      title: "Web/UI service restart needed",
      body: command === undefined
        ? `The Web/UI service is running ${formatVersion(components.web.runtimeVersion)}, but ${formatVersion(components.web.installedVersion)} is installed. Restart the Web/UI service or process to use the installed version.`
        : `The Web/UI service is running ${formatVersion(components.web.runtimeVersion)}, but ${formatVersion(components.web.installedVersion)} is installed. Restart the service to use the installed version.`,
      ...optionalMessageCommand(command),
    });
  }

  if (!components.sessiond.available) {
    messages.push({
      id: "sessiond-unavailable",
      severity: "warning",
      title: "Session daemon version unavailable",
      body: commands.status === undefined
        ? `PI WEB could not check the session daemon version${components.sessiond.error === undefined ? "." : `: ${components.sessiond.error}`}. Check the session daemon service or process that runs this installation.`
        : `PI WEB could not check the session daemon version${components.sessiond.error === undefined ? "." : `: ${components.sessiond.error}`}`,
      ...optionalMessageCommand(commands.status),
    });
  } else if (components.sessiond.stale) {
    const command = commands.restartSessiond ?? commands.restart;
    messages.push({
      id: "sessiond-stale",
      severity: "warning",
      title: "Session daemon restart needed",
      body: command === undefined
        ? `The session daemon is running ${formatVersion(components.sessiond.runtimeVersion)}, but ${formatVersion(components.sessiond.installedVersion)} is installed. Restart the session daemon service or process to use the installed version.`
        : `The session daemon is running ${formatVersion(components.sessiond.runtimeVersion)}, but ${formatVersion(components.sessiond.installedVersion)} is installed. Restart the daemon to use the installed version.`,
      ...optionalMessageCommand(command),
    });
  }

  return messages;
}

function optionalMessageCommand(command: string | undefined): Pick<PiWebStatusMessage, "command"> | object {
  return command === undefined ? {} : { command };
}

function skipVersionCheck(): boolean {
  return ["PI_WEB_SKIP_VERSION_CHECK", "PI_WEB_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_OFFLINE"].some((key) => {
    const value = process.env[key];
    return value !== undefined && value !== "";
  });
}

function isInstalledVersionNewer(installedVersion: string | undefined, runtimeVersion: string | undefined): boolean {
  if (installedVersion === undefined || runtimeVersion === undefined) return false;
  return isNewerPackageVersion(installedVersion, runtimeVersion);
}

function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
  const comparison = comparePackageVersions(candidateVersion, currentVersion);
  if (comparison !== undefined) return comparison > 0;
  return candidateVersion.trim() !== currentVersion.trim();
}

function parsePackageVersion(version: string): { major: number; minor: number; patch: number; prerelease?: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/u.exec(version.trim());
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

function formatVersion(version: string | undefined): string {
  return version ?? "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
