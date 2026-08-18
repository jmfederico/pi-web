#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPiWebConfigPath, defaultPiWebDataDir, examplePiWebConfig } from "./config.js";
import { piWebDockerCommand, type PiWebDockerMode } from "./docker/piWebDockerCommandPlan.js";
import { ownEnvironmentValue } from "./environment.js";
import { runPluginRecoveryCli, type SessionDaemonRestartPlan } from "./pluginRecoveryCli.js";
import {
  packageVersion,
  printPiWebVersionReport,
  probeRunningComponentReady,
  runningComponentsReady,
  type PiWebVersionReportOptions,
  type RunningComponentId,
} from "./piWebVersionReport.js";
import { checkNodePtyDarwinSpawnHelper, formatNodePtyDarwinSpawnHelperCheck } from "./server/diagnostics/nodePtySpawnHelper.js";
import { checkNodePtyNativeModule, formatNodePtyNativeModuleCheck } from "./server/diagnostics/nodePtyNativeModule.js";
import {
  installNativeServiceCandidate,
  nativeServiceInstallFailureNeedsPathAdvice,
  type NativeServiceInstallCandidate,
  type NativeServiceInstallFailure,
} from "./nativeServices/serviceInstall.js";
import {
  launchdBootoutArgs,
  launchdServiceTarget,
  orderServices,
  performServiceAction,
  serviceStartOrder,
  serviceStopOrder,
  settleLaunchdServiceUnload,
  startLaunchdService,
  type LaunchdServiceContext,
  type ServiceActionDeps,
  type ServiceActionInput,
  type ServiceActionResult,
  type ServiceLifecycleAction,
} from "./nativeServices/serviceAction.js";
import {
  minimumSupportedNodeVersion,
  nativeServiceManagerRefs,
  productionNativeServiceIds,
  type NativeServiceBackend,
  type NativeServiceId,
  type NativeServiceManagerRef,
  type NativeServicePlan,
  type NativeServiceShell,
  type ProductionNativeServicePlanInput,
} from "./nativeServices/servicePlan.js";
import {
  inspectInstalledNativeServiceDefinitions,
  type InstalledNativeServiceDefinitionCommandResult,
  type InstalledNativeServiceDefinitionPurpose,
  type InstalledNativeServiceDefinitionSource,
} from "./nativeServices/installedServiceDefinitions.js";
import {
  formatNativeServiceDoctorResult,
  inferInstalledNativeServiceMode,
  inspectInstalledDevelopmentServiceInput,
  inspectInstalledProductionServiceContext,
  runNativeServiceDoctor,
  selectManagedNativeServiceConfig,
  type InstalledNativeServiceDefinition,
  type InstalledNativeServiceInspection,
  type NativeServiceDoctorReport,
  type NativeServiceDoctorTarget,
} from "./nativeServices/serviceDoctor.js";
import {
  createNativeServiceAuthoritativeProbe,
  nativeServicePrerequisiteShellCheck,
} from "./nativeServices/serviceProbe.js";
import { renderLaunchdPlist, renderSystemdUnit } from "./nativeServices/serviceRendering.js";

const PI_WEB_PACKAGE_NAME = "@jmfederico/pi-web";

const systemdServiceDir = join(homedir(), ".config", "systemd", "user");
const launchdServiceDir = join(homedir(), "Library", "LaunchAgents");
const logDir = join(defaultPiWebDataDir(), "logs");

type InstallMode = "production" | "dev";
type ServiceId = NativeServiceId;
type ServiceBackend = NativeServiceBackend;
type Check = [string, string[]];

interface InstallOptions {
  host: string;
  port: string;
  mode: InstallMode;
  config?: string;
}

interface ServiceRef extends NativeServiceManagerRef {
  id: ServiceId;
}

type ServiceHealth = "running" | "stopped" | "not-installed" | "unknown";

interface ServiceRuntimeStatus {
  ref: ServiceRef;
  health: ServiceHealth;
  detail: string;
  target: string;
  filePath: string;
  pid?: string;
}

const serviceRefs: Record<ServiceId, ServiceRef> = {
  sessiond: { id: "sessiond", ...nativeServiceManagerRefs.sessiond },
  web: { id: "web", ...nativeServiceManagerRefs.web },
  uiDev: { id: "uiDev", ...nativeServiceManagerRefs.uiDev },
};

const productionServiceIds: ServiceId[] = [...productionNativeServiceIds];

function platformLabel(): string {
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "linux") return "Linux";
  if (process.platform === "win32") return "Windows";
  return process.platform;
}

export function serviceBackendForPlatform(platform: NodeJS.Platform): ServiceBackend | undefined {
  if (platform === "linux") return { kind: "systemd", label: "systemd user services" };
  if (platform === "darwin") return { kind: "launchd", label: "LaunchAgents" };
  return undefined;
}

function currentServiceBackend(): ServiceBackend | undefined {
  return serviceBackendForPlatform(process.platform);
}

function requireServiceBackend(command: string): ServiceBackend {
  const backend = currentServiceBackend();
  if (backend !== undefined) return backend;
  throw new Error(`\`${command}\` requires a supported per-user service manager (systemd user services or LaunchAgents) and is not supported on ${platformLabel()}.\n\n${manualRunAdvice()}`);
}

function manualRunAdvice(): string {
  return [
    "Run PI WEB manually from a checkout:",
    "  npm run start:sessiond",
    "  PI_WEB_PORT=8504 npm start",
    "",
    "For development in one terminal:",
    "  npm run dev",
    "",
    "For split development, keep sessiond separate and run web/API plus Vite UI separately:",
    "  npm run dev:sessiond",
    "  npm run dev:web",
    "  npm run dev:client",
  ].join("\n");
}

function run(command: string, args: string[], options: { check?: boolean } = {}): number {
  const result = spawnSync(command, args, { stdio: "inherit" });
  const status = result.status ?? 1;
  if (options.check === true && status !== 0) process.exit(status);
  return status;
}

function outputText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function capture(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const errorMessage = result.error instanceof Error ? result.error.message : "";
  const stderr = outputText(result.stderr);
  return { status: result.status ?? 1, stdout: outputText(result.stdout), stderr: stderr === "" ? errorMessage : stderr };
}

function captureInstalledServiceDefinitionCommand(
  command: string,
  args: string[],
): InstalledNativeServiceDefinitionCommandResult {
  const result = spawnSync(command, args);
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.error instanceof Error ? result.error.message : "",
  };
}

function runQuiet(command: string, args: string[]): number {
  return capture(command, args).status;
}

function hasCommand(command: string): boolean {
  return capture("/usr/bin/env", ["sh", "-c", `command -v ${shellSingleQuote(command)}`]).status === 0;
}

function isLingerEnabled(): boolean | undefined {
  if (!hasCommand("loginctl")) return undefined;
  const result = capture("loginctl", ["show-user", userInfo().username, "-p", "Linger"]);
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  if (value === "Linger=yes") return true;
  if (value === "Linger=no") return false;
  return undefined;
}

function parseInstallOptions(args: string[]): InstallOptions {
  const options: InstallOptions = { host: "127.0.0.1", port: "8504", mode: "production" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--host") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--host requires a value");
      options.host = value;
      i += 1;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--port requires a value");
      options.port = value;
      i += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
    } else if (arg === "--config") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--config requires a value");
      options.config = value;
      i += 1;
    } else if (arg.startsWith("--config=")) {
      options.config = arg.slice("--config=".length);
    } else if (arg === "--dev") {
      options.mode = "dev";
    } else if (arg === "--user-systemd") {
      // Accepted for backwards-compatible readability; PI WEB chooses the native user service backend automatically.
    } else {
      throw new Error(`Unknown install option: ${arg}`);
    }
  }
  return options;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fishSingleQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function packageRootPath(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function packageEntrypointPath(name: "server" | "sessiond"): string {
  return join(packageRootPath(), "dist", "server", name === "server" ? "index.js" : "sessiond.js");
}

export function regularFileExists(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function detectServiceShell(): NativeServiceShell {
  const userShell = userInfo().shell ?? undefined;
  const envShell = process.env["SHELL"]?.trim();
  const detected = envShell === undefined || envShell === "" ? userShell : envShell;
  const name = basename(detected ?? "").replace(/^-/, "");
  if (name === "bash" || name === "zsh" || name === "fish") {
    return {
      name,
      executable: detected ?? name,
      source: "detected",
      detectedExecutable: detected ?? name,
    };
  }
  return {
    name: "bash",
    executable: "bash",
    source: "fallback",
    detectedExecutable: detected ?? null,
  };
}

function serviceShellCommand(command: string, cwd?: string): string[] {
  const fullCommand = cwd === undefined ? command : `cd ${serviceShellQuote(cwd)} && ${command}`;
  return ["/usr/bin/env", detectServiceShell().executable, "-lc", fullCommand];
}

function serviceShellQuote(value: string): string {
  return detectServiceShell().name === "fish" ? fishSingleQuote(value) : shellSingleQuote(value);
}

function describeServiceShell(): string {
  const shell = detectServiceShell();
  if (shell.source === "fallback") {
    return shell.detectedExecutable === null
      ? "could not detect a supported login shell; using bash"
      : `detected ${shell.detectedExecutable}; using bash because PI WEB currently supports bash, zsh, and fish`;
  }
  return shell.detectedExecutable === null ? shell.name : `${shell.name} (${shell.detectedExecutable})`;
}

function configEnvironment(options: InstallOptions, configPath: string): Record<string, string> {
  return options.config === undefined ? {} : { PI_WEB_CONFIG: configPath };
}

function serviceRefList(ids: ServiceId[]): ServiceRef[] {
  return ids.map((id) => serviceRefs[id]);
}

function allServiceRefs(): ServiceRef[] {
  return serviceRefList(["sessiond", "web", "uiDev"]);
}

function productionServiceRefs(): ServiceRef[] {
  return serviceRefList(productionServiceIds);
}

function startOrder(refs: ServiceRef[]): ServiceRef[] {
  return orderServices(refs, serviceStartOrder);
}

function stopOrder(refs: ServiceRef[]): ServiceRef[] {
  return orderServices(refs, serviceStopOrder);
}

function devRootPath(): string {
  return resolve(process.cwd());
}

function validateDevCheckout(root: string): void {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Development mode must be installed from a PI WEB checkout. Missing package.json: ${packageJsonPath}`);
  }

  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!isRecord(parsed) || parsed["name"] !== PI_WEB_PACKAGE_NAME) {
    throw new Error(`Development mode must be installed from a PI WEB checkout. ${packageJsonPath} is not ${PI_WEB_PACKAGE_NAME}.`);
  }
}

function launchdLogPath(ref: ServiceRef): string {
  return join(logDir, ref.logName);
}

function installConfigPath(options: InstallOptions): string {
  return options.config === undefined ? defaultPiWebConfigPath() : resolve(options.config);
}

async function writeInitialConfig(options: InstallOptions, configPath: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  if (!existsSync(configPath)) {
    await writeFile(configPath, examplePiWebConfig({ host: options.host, port: Number(options.port) }));
  }
}

function systemdServicePath(ref: ServiceRef): string {
  return join(systemdServiceDir, ref.systemdName);
}

function launchdPlistPath(ref: ServiceRef): string {
  return join(launchdServiceDir, ref.launchdPlistName);
}

function serviceFilePath(backend: ServiceBackend, ref: ServiceRef): string {
  return backend.kind === "systemd" ? systemdServicePath(ref) : launchdPlistPath(ref);
}

function serviceFileExists(backend: ServiceBackend, ref: ServiceRef): boolean {
  return existsSync(serviceFilePath(backend, ref));
}

function installedServiceIds(backend: ServiceBackend): Set<ServiceId> {
  return new Set(allServiceRefs().filter((ref) => serviceFileExists(backend, ref)).map((ref) => ref.id));
}

function installedServiceRefs(backend: ServiceBackend): ServiceRef[] {
  const installed = startOrder(allServiceRefs().filter((ref) => serviceFileExists(backend, ref)));
  return installed.length === 0 ? productionServiceRefs() : installed;
}

async function installSystemdServices(plan: NativeServicePlan): Promise<void> {
  const selected = new Set<ServiceId>(plan.services.map((service) => service.id));
  const obsolete = stopOrder(allServiceRefs().filter((ref) => !selected.has(ref.id)));

  for (const ref of obsolete) {
    runQuiet("systemctl", ["--user", "disable", "--now", ref.systemdName]);
    await rm(systemdServicePath(ref), { force: true });
  }

  await mkdir(systemdServiceDir, { recursive: true });
  for (const service of plan.services) {
    await writeFile(join(systemdServiceDir, service.manager.systemdName), renderSystemdUnit(plan, service));
  }

  const names = plan.services.map((service) => service.manager.systemdName);
  run("systemctl", ["--user", "daemon-reload"], { check: true });
  run("systemctl", ["--user", "enable", ...names], { check: true });
  run("systemctl", ["--user", "restart", ...names], { check: true });
}

function launchdDomain(): string {
  return `gui/${String(userInfo().uid)}`;
}

function currentLaunchdServiceTarget(ref: ServiceRef): string {
  return launchdServiceTarget(launchdDomain(), ref);
}

function launchdActionContext(): LaunchdServiceContext {
  return { domain: launchdDomain(), plistPath: launchdPlistPath };
}

function serviceActionDeps(
  backend: ServiceBackend,
  probeEnvironment: NodeJS.ProcessEnv = process.env,
): ServiceActionDeps {
  return {
    run: (command, args) => run(command, args),
    runQuiet,
    sleep: (ms) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
    isServiceRunning: (ref) => runtimeStatus(backend, ref).health === "running",
    isComponentReady: (component) => probeRunningComponentReady(component, { configEnv: probeEnvironment }),
  };
}

async function installLaunchdServices(plan: NativeServicePlan): Promise<void> {
  const selected = new Set<ServiceId>(plan.services.map((service) => service.id));

  await mkdir(launchdServiceDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  for (const ref of stopOrder(allServiceRefs())) {
    runQuiet("launchctl", launchdBootoutArgs(currentLaunchdServiceTarget(ref)));
  }

  for (const ref of allServiceRefs().filter((candidate) => !selected.has(candidate.id))) {
    await rm(launchdPlistPath(ref), { force: true });
  }

  for (const service of plan.services) {
    const plistPath = join(launchdServiceDir, service.manager.launchdPlistName);
    await writeFile(plistPath, renderLaunchdPlist(plan, service, logDir));
  }

  // Settle each bootout before deciding bootstrap vs kickstart: acting on a
  // label launchd is still asynchronously unloading races the teardown and can
  // lose the service entirely (the same defect the restart path had).
  const context = launchdActionContext();
  const deps = serviceActionDeps(plan.backend);
  for (const service of plan.services) {
    const ref = serviceRefFromPlan(service.id, service.manager);
    await settleLaunchdServiceUnload(currentLaunchdServiceTarget(ref), deps);
    startLaunchdService(ref, context, deps);
  }
}

async function installNativeServices(plan: NativeServicePlan): Promise<void> {
  if (plan.backend.kind === "systemd") await installSystemdServices(plan);
  else await installLaunchdServices(plan);
}

function serviceRefFromPlan(id: ServiceId, manager: NativeServiceManagerRef): ServiceRef {
  return { id, ...manager };
}

async function uninstallSystemdServices(): Promise<void> {
  for (const ref of stopOrder(allServiceRefs())) {
    runQuiet("systemctl", ["--user", "disable", "--now", ref.systemdName]);
    await rm(systemdServicePath(ref), { force: true });
  }
  runQuiet("systemctl", ["--user", "daemon-reload"]);
}

async function uninstallLaunchdServices(): Promise<void> {
  for (const ref of stopOrder(allServiceRefs())) {
    runQuiet("launchctl", launchdBootoutArgs(currentLaunchdServiceTarget(ref)));
    await rm(launchdPlistPath(ref), { force: true });
  }
}

async function uninstallNativeServices(backend: ServiceBackend): Promise<void> {
  if (backend.kind === "systemd") await uninstallSystemdServices();
  else await uninstallLaunchdServices();
}

function serviceDisplayName(ref: ServiceRef): string {
  if (ref.id === "sessiond") return "session daemon";
  if (ref.id === "uiDev") return "UI/API dev server";
  return "web server";
}

function statusServiceRefs(backend: ServiceBackend): ServiceRef[] {
  const ids = installedServiceIds(backend);
  if (ids.size === 0) return [];
  if (ids.has("web") && ids.has("uiDev")) return startOrder(allServiceRefs());
  if (ids.has("uiDev")) return serviceRefList(["sessiond", "uiDev"]);
  if (ids.has("web")) return productionServiceRefs();
  return serviceRefList(["sessiond"]);
}

function serviceInstallMode(backend: ServiceBackend): string {
  const ids = installedServiceIds(backend);
  if (ids.size === 0) return "not installed";
  const hasSessiond = ids.has("sessiond");
  const hasWeb = ids.has("web");
  const hasUiDev = ids.has("uiDev");
  if (hasWeb && hasUiDev) return "mixed";
  if (hasUiDev) return hasSessiond ? "development" : "development (incomplete)";
  if (hasWeb) return hasSessiond ? "production" : "production (incomplete)";
  return "partial";
}

function makeServiceRuntimeStatus(ref: ServiceRef, health: ServiceHealth, detail: string, target: string, filePath: string, pid?: string): ServiceRuntimeStatus {
  return {
    ref,
    health,
    detail,
    target,
    filePath,
    ...(pid === undefined ? {} : { pid }),
  };
}

function firstOutputLine(...values: string[]): string | undefined {
  for (const value of values) {
    const line = value.trim().split("\n").find((candidate) => candidate.trim() !== "");
    if (line !== undefined) return line.trim();
  }
  return undefined;
}

function systemdMainPid(ref: ServiceRef): string | undefined {
  const result = capture("systemctl", ["--user", "--no-pager", "show", ref.systemdName, "--property=MainPID", "--value"]);
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value === "" || value === "0" ? undefined : value;
}

function systemdRuntimeStatus(backend: ServiceBackend, ref: ServiceRef): ServiceRuntimeStatus {
  const target = ref.systemdName;
  const filePath = serviceFilePath(backend, ref);
  if (!serviceFileExists(backend, ref)) return makeServiceRuntimeStatus(ref, "not-installed", "not installed", target, filePath);

  const result = capture("systemctl", ["--user", "--no-pager", "is-active", target]);
  const state = firstOutputLine(result.stdout, result.stderr) ?? "unknown";
  if (result.status === 0 && state === "active") return makeServiceRuntimeStatus(ref, "running", "running", target, filePath, systemdMainPid(ref));
  return makeServiceRuntimeStatus(ref, state === "unknown" ? "unknown" : "stopped", state, target, filePath);
}

function parseLaunchdField(output: string, field: string): string | undefined {
  const match = new RegExp(`^\\s*${field}\\s=\\s(.+)$`, "m").exec(output);
  return match?.[1]?.trim();
}

export function launchdRuntimeDetails(output: string): { state: string; detail: string; pid: string | undefined } {
  const state = parseLaunchdField(output, "state") ?? "unknown";
  const pid = parseLaunchdField(output, "pid");
  const lastExitCode = parseLaunchdField(output, "last exit code");
  const detail = state === "running"
    ? "running"
    : lastExitCode === undefined ? state : `${state} (last exit code ${lastExitCode})`;
  return { state, detail, pid };
}

function launchdRuntimeStatus(backend: ServiceBackend, ref: ServiceRef): ServiceRuntimeStatus {
  const target = currentLaunchdServiceTarget(ref);
  const filePath = serviceFilePath(backend, ref);
  if (!serviceFileExists(backend, ref)) return makeServiceRuntimeStatus(ref, "not-installed", "not installed", target, filePath);

  const result = capture("launchctl", ["print", target]);
  if (result.status !== 0) {
    return makeServiceRuntimeStatus(ref, "stopped", firstOutputLine(result.stderr, result.stdout) ?? "not loaded", target, filePath);
  }

  const details = launchdRuntimeDetails(result.stdout);
  const health: ServiceHealth = details.state === "running" ? "running" : details.state === "unknown" ? "unknown" : "stopped";
  return makeServiceRuntimeStatus(ref, health, details.detail, target, filePath, details.pid);
}

function runtimeStatus(backend: ServiceBackend, ref: ServiceRef): ServiceRuntimeStatus {
  return backend.kind === "systemd" ? systemdRuntimeStatus(backend, ref) : launchdRuntimeStatus(backend, ref);
}

function printServiceStatus(status: ServiceRuntimeStatus): void {
  const icon = status.health === "running" ? "✓" : "✗";
  const pid = status.pid === undefined ? "" : `, pid ${status.pid}`;
  console.log(`${icon} ${serviceDisplayName(status.ref)}: ${status.detail} (${status.target}${pid})`);
  if (status.health === "not-installed") console.log(`  missing service file: ${status.filePath}`);
}

function printServiceStatusReport(backend: ServiceBackend): boolean {
  const refs = statusServiceRefs(backend);
  console.log(`PI WEB services: ${serviceInstallMode(backend)} (${backend.label})`);
  if (refs.length === 0) {
    console.log("✗ no PI WEB service files found");
    console.log("  Run `pi-web install` or `pi-web install --dev`.");
    return false;
  }

  const statuses = refs.map((ref) => runtimeStatus(backend, ref));
  for (const status of statuses) printServiceStatus(status);
  console.log("\nUse `pi-web logs` for service logs.");
  return statuses.every((status) => status.health === "running");
}

function configuredServiceCommand(name: "PI_WEB_SERVER_EXEC" | "PI_WEB_SESSIOND_EXEC"): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function productionNativeServicePlanInput(
  backend: ServiceBackend,
  shell: NativeServiceShell,
  environment: Readonly<Record<string, string>>,
): ProductionNativeServicePlanInput {
  return {
    backend,
    shell,
    environment,
    executables: {
      sessiond: {
        configuredCommand: configuredServiceCommand("PI_WEB_SESSIOND_EXEC"),
        namedCommand: "pi-web-sessiond",
        bundledEntrypointPath: packageEntrypointPath("sessiond"),
      },
      web: {
        configuredCommand: configuredServiceCommand("PI_WEB_SERVER_EXEC"),
        namedCommand: "pi-web-server",
        bundledEntrypointPath: packageEntrypointPath("server"),
      },
    },
  };
}

function nativeServiceInstallCandidate(
  options: InstallOptions,
  backend: ServiceBackend,
  configPath: string,
  devRoot: string | undefined,
): NativeServiceInstallCandidate {
  const shell = detectServiceShell();
  const environment = configEnvironment(options, configPath);
  if (options.mode === "production") {
    return {
      mode: "production",
      input: productionNativeServicePlanInput(backend, shell, environment),
    };
  }

  const root = devRoot ?? devRootPath();
  return {
    mode: "development",
    input: {
      backend,
      shell,
      environment,
      workingDirectory: root,
      packageJsonPath: join(root, "package.json"),
    },
  };
}

function printNativeServiceInstallFailure(failure: NativeServiceInstallFailure): void {
  if (failure.kind === "plan-resolution") {
    for (const item of failure.failures) {
      if (item.kind === "probe-infrastructure") {
        console.log(`✗ Service-manager probe infrastructure failure (${item.reason}): ${item.message}`);
      } else if (item.kind === "entrypoint-inspection-failure") {
        console.log(`✗ Could not inspect bundled ${item.serviceId} entrypoint ${item.entrypointPath}: ${item.message}`);
      } else {
        console.log(`✗ ${item.namedCommand} is unavailable to the service manager, and bundled entrypoint ${item.bundledEntrypointPath} is missing.`);
        if (item.namedCommandFailure !== null) console.log(`  ${item.namedCommandFailure}`);
      }
    }
    return;
  }

  for (const item of failure.failures) {
    if (item.kind === "probe-infrastructure") {
      console.log(`✗ Service-manager probe infrastructure failure (${item.reason}): ${item.message}`);
    } else {
      console.log(`✗ ${item.prerequisite.description}`);
      if (item.detail !== null && item.detail !== item.prerequisite.description) console.log(`  ${item.detail}`);
    }
  }
}

async function install(args: string[]): Promise<void> {
  const backend = requireServiceBackend("pi-web install");
  const options = parseInstallOptions(args);
  const devRoot = options.mode === "dev" ? devRootPath() : undefined;
  if (devRoot !== undefined) validateDevCheckout(devRoot);
  const configPath = installConfigPath(options);
  const candidate = nativeServiceInstallCandidate(options, backend, configPath, devRoot);

  console.log(`Running PI WEB ${options.mode} install preflight checks...`);
  console.log(`Service backend: ${backend.label}`);
  console.log(`Service shell: ${describeServiceShell()}`);
  if (!printNodePtyNativeModuleCheck()) {
    throw new Error("Install preflight checks failed without changing config or services. Fix the failure above, then run `pi-web doctor` for more detail.");
  }
  const result = await installNativeServiceCandidate(candidate, {
    probe: createNativeServiceAuthoritativeProbe(),
    fileExists: regularFileExists,
    writeInitialConfig: () => writeInitialConfig(options, configPath),
    replaceServices: installNativeServices,
  });
  if (!result.ok) {
    printNativeServiceInstallFailure(result.failure);
    if (nativeServiceInstallFailureNeedsPathAdvice(result.failure)) printPathSetupAdvice();
    throw new Error("Install preflight checks failed without changing config or services. Fix the failure above, then run `pi-web doctor` for more detail.");
  }
  for (const service of result.plan.services.filter((item) => item.strategy.kind === "configured-override")) {
    console.log(`! ${service.description} uses a configured command override; preflight did not execute that arbitrary command.`);
  }

  console.log(`\nPI WEB ${options.mode} services are installed and starting.`);
  console.log(`Config: ${configPath}`);
  if (options.mode === "dev") {
    console.log("Open: http://127.0.0.1:8505");
  } else {
    console.log(`Open: http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${options.port}`);
  }

  if (backend.kind === "systemd") {
    const linger = isLingerEnabled();
    if (linger === false) {
      console.log("\nRecommended for server use: keep user services running after logout/reboot:");
      console.log(`  sudo loginctl enable-linger ${userInfo().username}`);
    } else if (linger === undefined) {
      console.log("\nRecommended for server use: enable systemd user lingering so services survive logout/reboot:");
      console.log(`  sudo loginctl enable-linger ${userInfo().username}`);
    }
  }

  console.log("\nUseful commands:");
  console.log("  pi-web status");
  console.log("  pi-web logs");
  console.log("  pi-web restart");
}

async function uninstall(): Promise<void> {
  const backend = requireServiceBackend("pi-web uninstall");
  await uninstallNativeServices(backend);
  console.log(`PI WEB ${backend.label} removed. Production and development service files were removed; config and data were left in place.`);
}

async function serviceAction(action: "stop" | "status"): Promise<void> {
  const backend = requireServiceBackend(`pi-web ${action}`);
  if (action === "status") {
    if (!printServiceStatusReport(backend)) process.exitCode = 1;
    return;
  }
  await performLifecycleServiceAction(backend, action, process.env);
}

async function performLifecycleServiceAction(
  backend: ServiceBackend,
  action: ServiceLifecycleAction,
  probeEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
  const refs = installedServiceRefs(backend);
  const input: ServiceActionInput = { backend, action, refs, launchdContext: launchdActionContext() };
  const result: ServiceActionResult = await performServiceAction(input, serviceActionDeps(backend, probeEnvironment));
  if (result.unreadyServices.length > 0) {
    for (const ref of result.unreadyServices) {
      const target = backend.kind === "systemd" ? ref.systemdName : currentLaunchdServiceTarget(ref);
      console.log(`✗ ${serviceDisplayName(ref)} did not become ready (${target}).`);
    }
    console.log("  Check `pi-web status` and `pi-web logs` for details.");
    process.exitCode = 1;
  }
}

export interface SessionDaemonRestartPlanOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  configPath?: string;
  explicitConfigPath?: boolean;
  serviceFileExists?: (path: string) => boolean;
  runCommand?: (command: string, args: string[]) => void;
  uid?: number;
}

/** Offline restart guidance used only after a recovery config mutation. */
export function sessionDaemonRestartPlan(options: SessionDaemonRestartPlanOptions = {}): SessionDaemonRestartPlan {
  const env = options.env ?? process.env;
  if (options.explicitConfigPath === true && options.configPath !== undefined) {
    return {
      kind: "manual",
      guidance: `Restart the session daemon process configured with PI_WEB_CONFIG=${JSON.stringify(options.configPath)}.`,
    };
  }
  const dockerMode = activeDockerMode(env);
  const runCommand = options.runCommand ?? ((command, args) => { run(command, args, { check: true }); });
  if (dockerMode !== undefined) {
    const command = piWebDockerCommand(dockerMode, "restart-sessiond");
    return {
      kind: "automatic",
      command,
      guidance: "Run the Docker control command from the PI WEB Docker host.",
      perform: () => {
        runCommand("pi-web-docker", [...(dockerMode === "dev" ? ["--dev"] : []), "restart-sessiond"]);
      },
    };
  }

  const backend = serviceBackendForPlatform(options.platform ?? process.platform);
  const fileExists = options.serviceFileExists ?? existsSync;
  if (backend?.kind === "systemd" && fileExists(systemdServicePath(serviceRefs.sessiond))) {
    const args = ["--user", "restart", serviceRefs.sessiond.systemdName];
    return {
      kind: "automatic",
      command: `systemctl ${args.join(" ")}`,
      guidance: "Run:",
      perform: () => { runCommand("systemctl", args); },
    };
  }
  if (backend?.kind === "launchd" && fileExists(launchdPlistPath(serviceRefs.sessiond))) {
    const target = `gui/${String(options.uid ?? userInfo().uid)}/${serviceRefs.sessiond.launchdLabel}`;
    const args = ["kickstart", "-k", target];
    return {
      kind: "automatic",
      command: `launchctl ${args.join(" ")}`,
      guidance: "Run:",
      perform: () => { runCommand("launchctl", args); },
    };
  }
  return {
    kind: "manual",
    guidance: "Stop and rerun the process that owns sessiond (from a checkout: `npm run start:sessiond`).",
  };
}

function activeDockerMode(env: NodeJS.ProcessEnv): PiWebDockerMode | undefined {
  if (!truthyEnvValue(ownEnvironmentValue(env, "PI_WEB_DOCKER_RUNTIME"))) return undefined;
  if (ownEnvironmentValue(env, "PI_WEB_DOCKER_MODE") === "dev") return "dev";
  return "runtime";
}

function truthyEnvValue(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function logs(): void {
  const backend = requireServiceBackend("pi-web logs");
  const refs = installedServiceRefs(backend);
  if (backend.kind === "systemd") {
    run("journalctl", ["--user", ...refs.flatMap((ref) => ["-u", ref.systemdName]), "-f"]);
    return;
  }
  run("tail", ["-F", ...refs.map((ref) => launchdLogPath(ref))]);
}

function serviceShellLabel(): string {
  return `${detectServiceShell().name} -lc`;
}

function commandCheck(command: string): string {
  return `command -v ${serviceShellQuote(command)}`;
}

export function commandWithVersionCheck(command: string): string {
  const found = commandCheck(command);
  const commandWord = serviceShellQuote(command);
  if (detectServiceShell().name === "fish") {
    return `${found} && begin; ${commandWord} --version 2>&1 || true; end`;
  }
  return `${found} && (${commandWord} --version 2>&1 || true)`;
}

export function nodeVersionCheck(): string {
  return nativeServicePrerequisiteShellCheck(detectServiceShell().name, {
    id: "caller.node",
    kind: "node-version",
    command: "node",
    minimumVersion: minimumSupportedNodeVersion,
    description: `node >= ${minimumSupportedNodeVersion}`,
  });
}

export function generalDoctorChecks(): Check[] {
  const shell = serviceShellLabel();
  return [
    [`Caller login ${shell} can find node >= ${minimumSupportedNodeVersion}`, serviceShellCommand(nodeVersionCheck())],
    [`Caller login ${shell} can find npm`, serviceShellCommand(commandWithVersionCheck("npm"))],
    // Sessions run on the bundled pi SDK; the only CLI check is a hardcoded
    // `pi` PATH probe — nothing names or locates a configurable command.
    [`Caller login ${shell} can find pi`, serviceShellCommand(commandWithVersionCheck("pi"))],
  ];
}

function runChecks(checks: Check[]): boolean {
  let failed = false;
  for (const [label, command] of checks) {
    const [bin, ...args] = command;
    if (bin === undefined) continue;
    const result = capture(bin, args);
    const ok = result.status === 0;
    failed ||= !ok;
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    printCheckOutput(result.stdout || result.stderr);
  }
  return !failed;
}

function printCheckOutput(output: string): void {
  const trimmed = output.trim();
  if (trimmed === "") return;
  const lines = trimmed.split("\n");
  for (const line of lines.slice(0, 3)) console.log(`  ${line}`);
  if (lines.length > 3) console.log("  ...");
}

function optionalDoctorChecks(): Check[] {
  const shell = serviceShellLabel();
  return [[`Caller login ${shell} can find optional ripgrep (rg)`, serviceShellCommand(commandCheck("rg"))]];
}

function printOptionalDoctorChecks(): void {
  let missingOptionalTool = false;
  for (const [label, command] of optionalDoctorChecks()) {
    const [bin, ...args] = command;
    if (bin === undefined) continue;
    const result = capture(bin, args);
    const ok = result.status === 0;
    missingOptionalTool ||= !ok;
    console.log(`${ok ? "✓" : "!"} ${label}`);
    printCheckOutput(result.stdout || result.stderr);
  }
  if (missingOptionalTool) {
    console.log("  Install ripgrep, or make rg visible to the service shell, for faster all-file @ suggestions.");
    console.log("  PI WEB falls back to a bounded filesystem scan when rg is unavailable.");
  }
}

function installedServiceDefinitions(
  backend: ServiceBackend,
  ids: readonly ServiceId[],
  purpose: InstalledNativeServiceDefinitionPurpose,
): InstalledNativeServiceInspection<readonly InstalledNativeServiceDefinition[]> {
  const sources: InstalledNativeServiceDefinitionSource[] = ids.map((id) => ({
    id,
    path: serviceFilePath(backend, serviceRefs[id]),
    systemdName: serviceRefs[id].systemdName,
    launchdTarget: currentLaunchdServiceTarget(serviceRefs[id]),
  }));
  return inspectInstalledNativeServiceDefinitions(backend, sources, {
    readFile: (path) => readFileSync(path),
    realpath: realpathSync,
    capture: captureInstalledServiceDefinitionCommand,
  }, purpose);
}

/** Build an isolated probe environment without mutating the caller or process. */
export function managedServiceProbeEnvironment(
  backend: ServiceBackend,
  definitions: readonly InstalledNativeServiceDefinition[],
  callerEnvironment: NodeJS.ProcessEnv,
): InstalledNativeServiceInspection<NodeJS.ProcessEnv> {
  const selection = selectManagedNativeServiceConfig(
    backend,
    definitions,
    ownEnvironmentValue(callerEnvironment, "PI_WEB_CONFIG"),
  );
  if (!selection.ok) return selection;
  if (selection.value.source === "installed") {
    return {
      ok: true,
      value: { ...callerEnvironment, PI_WEB_CONFIG: selection.value.configPath },
    };
  }
  if (selection.value.source === "default" && definitions.length > 0) {
    // An own empty value preserves default resolution while masking any
    // prototype-inherited PI_WEB_CONFIG from downstream environment lookups.
    return { ok: true, value: { ...callerEnvironment, PI_WEB_CONFIG: "" } };
  }
  return { ok: true, value: callerEnvironment };
}

function installedServiceProbeEnvironment(
  backend: ServiceBackend,
  ids: ReadonlySet<ServiceId>,
  callerEnvironment: NodeJS.ProcessEnv,
  purpose: InstalledNativeServiceDefinitionPurpose,
  inspectDefinitions: (
    backend: ServiceBackend,
    ids: readonly ServiceId[],
    purpose: InstalledNativeServiceDefinitionPurpose,
  ) => InstalledNativeServiceInspection<readonly InstalledNativeServiceDefinition[]>,
): InstalledNativeServiceInspection<NodeJS.ProcessEnv> {
  // The explicit caller override wins without requiring installed definitions
  // to be readable or canonical.
  const callerConfigPath = ownEnvironmentValue(callerEnvironment, "PI_WEB_CONFIG");
  if (callerConfigPath !== undefined && callerConfigPath !== "") {
    return { ok: true, value: callerEnvironment };
  }
  if (ids.size === 0) return { ok: true, value: callerEnvironment };

  const definitions = inspectDefinitions(backend, [...ids], purpose);
  if (!definitions.ok) return definitions;
  return managedServiceProbeEnvironment(backend, definitions.value, callerEnvironment);
}

function managedServiceProbeFailure(backend: ServiceBackend, message: string): string {
  return [
    `Could not select managed PI_WEB_CONFIG from installed ${backend.label}: ${message}`,
    "Repair the reported service-manager override or definition, then re-run `pi-web install` (or `pi-web install --dev`); a nonempty PI_WEB_CONFIG explicitly overrides managed config selection for this command.",
  ].join("\n");
}

export type ReadinessCliCommand = "start" | "restart" | "doctor" | "version";

export interface ReadinessDoctorCommandContext {
  backend: ServiceBackend | undefined;
  installedIds: ReadonlySet<ServiceId>;
  environment: NodeJS.ProcessEnv;
  versionReportOptions: PiWebVersionReportOptions;
  managedInspectionFailed: boolean;
}

export interface ReadinessCliCommandDependencies {
  environment: NodeJS.ProcessEnv;
  currentBackend: () => ServiceBackend | undefined;
  requireBackend: (command: string) => ServiceBackend;
  installedServiceIds: (backend: ServiceBackend) => ReadonlySet<ServiceId>;
  inspectDefinitions: (
    backend: ServiceBackend,
    ids: readonly ServiceId[],
    purpose: InstalledNativeServiceDefinitionPurpose,
  ) => InstalledNativeServiceInspection<readonly InstalledNativeServiceDefinition[]>;
  runLifecycle: (
    backend: ServiceBackend,
    action: "start" | "restart",
    probeEnvironment: NodeJS.ProcessEnv,
  ) => Promise<void>;
  runDoctor: (context: ReadinessDoctorCommandContext) => Promise<void>;
  printVersion: () => Promise<void>;
}

/**
 * Dispatch commands whose probes may need managed config. The service-manager,
 * definition, lifecycle, doctor, and version boundaries are injected so this
 * exact orchestration can be tested without mutating live services or process
 * environment.
 */
export async function runReadinessCliCommand(
  command: ReadinessCliCommand,
  dependencies: ReadinessCliCommandDependencies,
): Promise<void> {
  if (command === "version") {
    await dependencies.printVersion();
    return;
  }

  const environment = dependencies.environment;
  if (command === "start" || command === "restart") {
    const backend = dependencies.requireBackend(`pi-web ${command}`);
    const installedIds = dependencies.installedServiceIds(backend);
    const probeEnvironment = installedServiceProbeEnvironment(
      backend,
      installedIds,
      environment,
      command,
      dependencies.inspectDefinitions,
    );
    if (!probeEnvironment.ok) throw new Error(managedServiceProbeFailure(backend, probeEnvironment.message));
    await dependencies.runLifecycle(backend, command, probeEnvironment.value);
    return;
  }

  const backend = dependencies.currentBackend();
  const installedIds = backend === undefined
    ? new Set<ServiceId>()
    : dependencies.installedServiceIds(backend);
  let versionReportOptions: PiWebVersionReportOptions = { configEnv: environment };
  let managedInspectionFailed = false;
  if (backend !== undefined && activeDockerMode(environment) === undefined) {
    const probeEnvironment = installedServiceProbeEnvironment(
      backend,
      installedIds,
      environment,
      "doctor",
      dependencies.inspectDefinitions,
    );
    if (probeEnvironment.ok) {
      versionReportOptions = { configEnv: probeEnvironment.value };
    } else {
      managedInspectionFailed = true;
      versionReportOptions = { webEndpointError: managedServiceProbeFailure(backend, probeEnvironment.message) };
    }
  }
  await dependencies.runDoctor({
    backend,
    installedIds,
    environment,
    versionReportOptions,
    managedInspectionFailed,
  });
}

function readinessCliCommandDependencies(): ReadinessCliCommandDependencies {
  return {
    environment: process.env,
    currentBackend: currentServiceBackend,
    requireBackend: requireServiceBackend,
    installedServiceIds,
    inspectDefinitions: installedServiceDefinitions,
    runLifecycle: performLifecycleServiceAction,
    runDoctor: doctor,
    printVersion: async () => { await printPiWebVersionReport(); },
  };
}

function nativeServiceDoctorTarget(
  backend: ServiceBackend,
  ids: ReadonlySet<ServiceId>,
): NativeServiceDoctorTarget {
  const mode = inferInstalledNativeServiceMode(ids);
  if (mode === "ambiguous") {
    return {
      kind: "inspection-failure",
      message: `installed service IDs do not identify one mode (${[...ids].join(", ") || "none"}).`,
    };
  }
  if (mode === "none") {
    return {
      kind: "prospective-production",
      input: productionNativeServicePlanInput(backend, detectServiceShell(), {}),
      reason: "no installed service strategy is available",
    };
  }
  const expectedIds = mode === "production"
    ? productionNativeServiceIds
    : (["sessiond", "uiDev"] as const);
  const missingId = expectedIds.find((id) => !ids.has(id));
  if (missingId !== undefined) {
    return {
      kind: "inspection-failure",
      message: `installed ${mode} service set is incomplete; ${missingId} is missing.`,
    };
  }

  const definitions = installedServiceDefinitions(backend, expectedIds, "doctor");
  if (!definitions.ok) return { kind: "inspection-failure", message: definitions.message };

  if (mode === "development") {
    const inspection = inspectInstalledDevelopmentServiceInput(backend, definitions.value);
    return inspection.ok
      ? { kind: "installed-development", input: inspection.value }
      : { kind: "inspection-failure", message: inspection.message };
  }

  const inspection = inspectInstalledProductionServiceContext(backend, definitions.value);
  return inspection.ok
    ? {
        kind: "prospective-production",
        input: productionNativeServicePlanInput(backend, inspection.value.shell, inspection.value.environment),
        reason: "installed executable strategy is not recorded",
      }
    : { kind: "inspection-failure", message: inspection.message };
}

async function printNativeServiceDoctorChecks(
  backend: ServiceBackend,
  installedIds: ReadonlySet<ServiceId>,
): Promise<NativeServiceDoctorReport> {
  const result = await runNativeServiceDoctor(nativeServiceDoctorTarget(backend, installedIds), {
    probe: createNativeServiceAuthoritativeProbe(),
    fileExists: regularFileExists,
  });
  const report = formatNativeServiceDoctorResult(result);
  for (const line of report.lines) console.log(line);
  printCallerContextComparisons(report);
  return report;
}

function printCallerContextComparisons(report: NativeServiceDoctorReport): void {
  if (report.plan === null || report.failedPrerequisites.length === 0) return;
  const seen = new Set<string>();
  for (const prerequisite of report.failedPrerequisites) {
    if (seen.has(prerequisite.id)) continue;
    seen.add(prerequisite.id);
    const service = report.plan.services.find((candidate) => candidate.prerequisites.some((item) => item.id === prerequisite.id));
    const command = nativeServicePrerequisiteShellCheck(report.plan.shell.name, prerequisite);
    const result = captureServiceShell(report.plan.shell, command, service?.workingDirectory ?? null);
    console.log(
      `  Caller-invoked ${report.plan.shell.name} -lc ${result.status === 0 ? "satisfies" : "also does not satisfy"} ${prerequisite.description}; the service-manager result is authoritative.`,
    );
  }
}

function captureServiceShell(
  shell: NativeServiceShell,
  command: string,
  workingDirectory: string | null,
): { status: number; stdout: string; stderr: string } {
  const fullCommand = workingDirectory === null
    ? command
    : `cd ${shellQuoteFor(shell.name, workingDirectory)} && ${command}`;
  return capture("/usr/bin/env", [shell.executable, "-lc", fullCommand]);
}

function shellQuoteFor(shell: NativeServiceShell["name"], value: string): string {
  return shell === "fish" ? fishSingleQuote(value) : shellSingleQuote(value);
}

function printPathSetupAdvice(shell: NativeServiceShell = detectServiceShell()): void {
  console.log("\nPATH setup advice:");
  if (shell.name === "bash") {
    console.log("  Detected bash. Put PATH setup for node/version managers/tools in ~/.bash_profile or ~/.profile.");
    console.log("  If ~/.bash_profile exists, bash will not read ~/.profile unless you source it from ~/.bash_profile.");
    console.log("  Do not rely only on ~/.bashrc or prompt hooks for tools needed by services or agents.");
  } else if (shell.name === "zsh") {
    console.log("  Detected zsh. Put PATH setup for node/version managers/tools in ~/.zprofile, not only ~/.zshrc.");
    console.log("  Avoid relying on prompt hooks; PI WEB services run non-interactive login shells.");
  } else {
    console.log("  Detected fish. Prefer universal PATH setup such as `fish_add_path -U ...` for tools needed by services or agents.");
    console.log("  Avoid relying on prompt hooks; PI WEB services run non-interactive login shells.");
  }
}

/**
 * Running components an installed deployment must keep ready: the API-serving
 * component whenever the web or UI dev service file is installed (the version
 * endpoint probes the API port in both modes), and the session daemon whenever
 * its service file is installed. Docker deployments have no native service
 * files, so the Docker runtime marker expects both components. A machine with
 * nothing installed expects nothing: doctor's manual-run guidance stays a
 * passing outcome there.
 */
export function expectedRunningComponents(
  installedServices: ReadonlySet<NativeServiceId>,
  env: NodeJS.ProcessEnv,
): RunningComponentId[] {
  if (activeDockerMode(env) !== undefined) return ["web", "sessiond"];
  const expected: RunningComponentId[] = [];
  if (installedServices.has("web") || installedServices.has("uiDev")) expected.push("web");
  if (installedServices.has("sessiond")) expected.push("sessiond");
  return expected;
}

export function doctorExitCode(
  generalReadinessOk: boolean,
  nativeServicePlanOk: boolean,
  nodePtyRuntimeOk: boolean,
  runningComponentsOk: boolean,
): 0 | 1 {
  return generalReadinessOk && nativeServicePlanOk && nodePtyRuntimeOk && runningComponentsOk ? 0 : 1;
}

async function doctor(context: ReadinessDoctorCommandContext): Promise<void> {
  const { backend, installedIds, environment, versionReportOptions, managedInspectionFailed } = context;
  console.log(`Platform: ${platformLabel()}`);
  console.log(`Service backend: ${backend?.label ?? "manual run only"}`);
  console.log(`Service shell: ${describeServiceShell()}`);
  if (backend === undefined) {
    console.log(`- Native user service plan checks skipped on ${platformLabel()}; no native-service drift is reported.`);
  }
  console.log("");

  const runningVersionInfo = await printPiWebVersionReport(versionReportOptions);
  const expectedComponents = expectedRunningComponents(installedIds, environment);
  const runningComponentsOk = runningComponentsReady(runningVersionInfo, expectedComponents);
  if (!runningComponentsOk) {
    console.log("\n✗ Installed PI WEB services are unavailable or stale (see \"Running services\" above).");
    console.log("  Run `pi-web restart`, then check `pi-web status`.");
  }

  console.log("\nGeneral login-shell readiness (separate from native-service requirements):");
  const generalReadinessOk = runChecks(generalDoctorChecks());
  printOptionalDoctorChecks();

  console.log("\nNative terminal runtime readiness:");
  const nodePtyNativeModuleOk = printNodePtyNativeModuleCheck();
  const nodePtySpawnHelperOk = nodePtyNativeModuleOk ? printNodePtyDarwinSpawnHelperCheck() : true;

  let nativeServiceReport: NativeServiceDoctorReport | null = null;
  if (backend !== undefined) {
    console.log("\nNative service plan checks (service-manager context):");
    if (managedInspectionFailed) {
      console.log("✗ Installed native-service plan could not be inspected consistently with the readiness probe (see \"Running services\" above).");
      console.log("  Repair the reported service-manager definition before relying on doctor results.");
    } else {
      nativeServiceReport = await printNativeServiceDoctorChecks(backend, installedIds);
    }
  }

  if (backend?.kind === "systemd") {
    const linger = isLingerEnabled();
    if (linger === true) {
      console.log("✓ systemd user lingering enabled");
    } else if (linger === false) {
      console.log("✗ systemd user lingering disabled");
      console.log(`  Recommended on servers: sudo loginctl enable-linger ${userInfo().username}`);
    } else {
      console.log("? systemd user lingering unknown");
      console.log(`  Recommended on servers: sudo loginctl enable-linger ${userInfo().username}`);
    }
  } else if (backend?.kind === "launchd") {
    console.log("- user services start at login with LaunchAgents");
  } else {
    console.log(`- systemd user lingering skipped on ${platformLabel()}`);
  }

  const nativeServicePlanOk = !managedInspectionFailed && (nativeServiceReport?.ok ?? true);
  const pathFailure = !generalReadinessOk || nativeServiceReport?.pathAdviceRecommended === true;
  if (pathFailure) {
    console.log("\nIf a command works in your terminal but fails in the service-manager check, compare the caller and manager contexts above.");
    const adviceShell = nativeServiceReport?.pathAdviceRecommended === true && nativeServiceReport.adviceShell !== null
      ? nativeServiceReport.adviceShell
      : detectServiceShell();
    printPathSetupAdvice(adviceShell);
  }

  if (generalReadinessOk && backend === undefined) {
    console.log(`\n${manualRunAdvice()}`);
  }

  if (doctorExitCode(generalReadinessOk, nativeServicePlanOk, nodePtyNativeModuleOk && nodePtySpawnHelperOk, runningComponentsOk) !== 0) process.exitCode = 1;
}

function printNodePtyNativeModuleCheck(): boolean {
  const result = formatNodePtyNativeModuleCheck(checkNodePtyNativeModule());
  for (const line of result.lines) console.log(line);
  return result.ok;
}

function printNodePtyDarwinSpawnHelperCheck(): boolean {
  const result = formatNodePtyDarwinSpawnHelperCheck(checkNodePtyDarwinSpawnHelper());
  for (const line of result.lines) console.log(line);
  return result.ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function help(): void {
  console.log(`PI WEB

Usage:
  pi-web install [--dev] [--host 127.0.0.1] [--port 8504] [--config ~/.config/pi-web/config.json]
  pi-web uninstall
  pi-web start|stop|restart|status|logs
  pi-web plugins disable <plugin-id> [--config <path>] [--restart]
  pi-web plugins safe-start show|clear|set <bundled-only|none> [--config <path>] [--restart]
  pi-web doctor
  pi-web version

Recommended install:
  npm install -g @jmfederico/pi-web --allow-scripts=node-pty
  pi-web install

Development service install from a checkout:
  pi-web install --dev
`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "install") await install(args);
  else if (command === "uninstall") await uninstall();
  else if (command === "start" || command === "restart" || command === "doctor" || command === "version") {
    await runReadinessCliCommand(command, readinessCliCommandDependencies());
  } else if (command === "stop" || command === "status") await serviceAction(command);
  else if (command === "logs") logs();
  else if (command === "plugins") runPluginRecoveryCli(args, { restartPlan: (context) => sessionDaemonRestartPlan(context) });
  else if (command === "--version" || command === "-v") console.log(packageVersion());
  else if (command === "help" || command === "--help" || command === "-h") help();
  else throw new Error(`Unknown command: ${command}`);
}

export function isCliEntrypoint(entrypoint: string | undefined = process.argv[1], modulePath: string = fileURLToPath(import.meta.url)): boolean {
  if (entrypoint === undefined) return false;
  if (entrypoint === modulePath) return true;
  try {
    return realpathSync(entrypoint) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
