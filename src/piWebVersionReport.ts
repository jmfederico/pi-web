import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { effectivePiWebConfig } from "./config.js";
import { SessionDaemonClient } from "./sessiond/sessionDaemonClient.js";
import type { PiWebComponentStatus, PiWebInstallationInfo, PiWebVersionResponse } from "./shared/apiTypes.js";
import { parsePiWebComponentStatus, parsePiWebVersionResponse } from "./shared/piWebStatusParsing.js";

const PI_WEB_PACKAGE_NAME = "@jmfederico/pi-web";
const PI_WEB_VERSION_TIMEOUT_MS = 2000;
const PI_WEB_VERSION_ENDPOINT_PATH = "/api/pi-web/version";
const PI_WEB_STATUS_ENDPOINT_PATH = "/api/pi-web/status";
const DEFAULT_PACKAGE_VERSION = "0.0.0-dev";

interface PackageInfo {
  name: string;
  version: string;
  path: string;
}

export interface RunningVersionInfo {
  generatedAt?: string;
  web?: PiWebComponentStatus;
  sessiond?: PiWebComponentStatus;
  webError?: string;
  sessiondError?: string;
}

export interface PiWebVersionReportOptions {
  /** Environment used only to select and resolve the web/API config. */
  configEnv?: NodeJS.ProcessEnv;
  /** A prior config-selection failure that makes a web/API probe untrustworthy. */
  webEndpointError?: string;
  /** Injectable HTTP boundary for deterministic readiness tests. */
  fetch?: typeof globalThis.fetch;
}

export type RunningComponentId = PiWebComponentStatus["component"];

/**
 * Readiness rule for `pi-web doctor`: an expected running component is ready
 * only when the report carries its status and that status is available and not
 * stale. A component missing from the report (an error-only entry) is not
 * ready. Components that are not expected stay informational regardless of
 * state.
 */
export function runningComponentsReady(info: RunningVersionInfo, expected: readonly RunningComponentId[]): boolean {
  return expected.every((id) => {
    const status = info[id];
    return status !== undefined && status.available && !status.stale;
  });
}

/**
 * Readiness probe for service lifecycle waits: the web component is ready when
 * the web/API version endpoint (or its legacy status fallback) serves a
 * parseable response; the session daemon is ready when its health endpoint
 * serves version information. Shares the version report's endpoints and
 * parsing so lifecycle readiness matches what `pi-web version` reports.
 */
export async function probeRunningComponentReady(
  component: RunningComponentId,
  options: Pick<PiWebVersionReportOptions, "configEnv" | "fetch"> = {},
): Promise<boolean> {
  if (component === "sessiond") {
    const sessiond = await collectRunningSessiondInfo();
    return sessiond.component !== undefined;
  }
  const endpoint = webVersionEndpoint(options.configEnv);
  if (endpoint.endpoint === undefined) return false;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  try {
    await fetchPiWebVersionResponse(endpoint.endpoint, fetchImplementation);
    return true;
  } catch (error) {
    const statusEndpoint = statusEndpointFor(endpoint.endpoint);
    if (!isHttpNotFound(error) || statusEndpoint === endpoint.endpoint) return false;
    try {
      await fetchPiWebVersionResponse(statusEndpoint, fetchImplementation);
      return true;
    } catch {
      return false;
    }
  }
}

export function packageVersion(): string {
  return readPackageInfo()?.version ?? DEFAULT_PACKAGE_VERSION;
}

export async function printPiWebVersionReport(options: PiWebVersionReportOptions = {}): Promise<RunningVersionInfo> {
  console.log("PI WEB version");
  printInstalledPackageVersions();
  const runningInfo = await collectRunningVersionInfo(options);
  printRunningVersionInfo(runningInfo);
  return runningInfo;
}

function packageRootPath(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function packageJsonPath(): string {
  return join(packageRootPath(), "package.json");
}

function readPackageInfo(): PackageInfo | undefined {
  const path = packageJsonPath();
  try {
    return parsePackageInfo(JSON.parse(readFileSync(path, "utf8")), path);
  } catch {
    return undefined;
  }
}

function parsePackageInfo(value: unknown, path: string): PackageInfo | undefined {
  if (!isRecord(value)) return undefined;
  const name = value["name"];
  const version = value["version"];
  if (typeof name !== "string" || name === "" || typeof version !== "string" || version === "") return undefined;
  return { name, version, path };
}

function webVersionEndpoint(configEnv: NodeJS.ProcessEnv | undefined): { endpoint?: string; error?: string } {
  try {
    const { config } = effectivePiWebConfig(configEnv === undefined ? {} : { env: configEnv });
    const host = httpClientHost(config.host);
    const port = config.port ?? 8504;
    return { endpoint: `http://${urlHost(host)}:${String(port)}${PI_WEB_VERSION_ENDPOINT_PATH}` };
  } catch (error) {
    return { error: `could not read PI WEB config: ${errorMessage(error)}` };
  }
}

function httpClientHost(configuredHost: string | undefined): string {
  const host = configuredHost === undefined || configuredHost === "" ? "127.0.0.1" : configuredHost;
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host;
}

function urlHost(host: string): string {
  if (host.startsWith("[") || !host.includes(":")) return host;
  return `[${host}]`;
}

function statusEndpointFor(versionEndpoint: string): string {
  if (!versionEndpoint.endsWith(PI_WEB_VERSION_ENDPOINT_PATH)) return versionEndpoint;
  return `${versionEndpoint.slice(0, -PI_WEB_VERSION_ENDPOINT_PATH.length)}${PI_WEB_STATUS_ENDPOINT_PATH}`;
}

async function fetchPiWebVersionResponse(
  endpoint: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<PiWebVersionResponse> {
  const response = await fetchImplementation(endpoint, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PI_WEB_VERSION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const parsed: unknown = await response.json();
  const status = parsePiWebVersionResponse(parsed);
  if (status === undefined) throw new Error("response did not include PI WEB version information");
  return status;
}

async function collectRunningVersionInfo(options: PiWebVersionReportOptions): Promise<RunningVersionInfo> {
  const endpoint = options.webEndpointError === undefined
    ? webVersionEndpoint(options.configEnv)
    : { error: options.webEndpointError };
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (endpoint.endpoint !== undefined) {
    try {
      const status = await fetchPiWebVersionResponse(endpoint.endpoint, fetchImplementation);
      return { generatedAt: status.generatedAt, web: status.components.web, sessiond: status.components.sessiond };
    } catch (error) {
      let webError = `${endpoint.endpoint}: ${errorMessage(error)}`;
      const statusEndpoint = statusEndpointFor(endpoint.endpoint);
      if (statusEndpoint !== endpoint.endpoint && isHttpNotFound(error)) {
        try {
          const status = await fetchPiWebVersionResponse(statusEndpoint, fetchImplementation);
          return { generatedAt: status.generatedAt, web: status.components.web, sessiond: status.components.sessiond };
        } catch (statusError) {
          webError = `${webError}; ${statusEndpoint}: ${errorMessage(statusError)}`;
        }
      }
      return runningVersionInfoWithSessiondFallback({ webError });
    }
  }

  return runningVersionInfoWithSessiondFallback({ webError: endpoint.error ?? "web/API status endpoint unavailable" });
}

async function runningVersionInfoWithSessiondFallback(base: { webError: string }): Promise<RunningVersionInfo> {
  const sessiond = await collectRunningSessiondInfo();
  return {
    webError: base.webError,
    ...(sessiond.component === undefined ? {} : { sessiond: sessiond.component }),
    ...(sessiond.error === undefined ? {} : { sessiondError: sessiond.error }),
  };
}

async function collectRunningSessiondInfo(): Promise<{ component?: PiWebComponentStatus; error?: string }> {
  try {
    const response = await withTimeout(
      new SessionDaemonClient().request("GET", "/health"),
      PI_WEB_VERSION_TIMEOUT_MS,
      "session daemon health check timed out",
    );
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${String(response.statusCode)}`);
    const parsed: unknown = response.body === "" ? undefined : JSON.parse(response.body);
    const version = isRecord(parsed) ? parsed["version"] : undefined;
    const component = parsePiWebComponentStatus(version);
    if (component === undefined) throw new Error("health response did not include version information");
    return { component };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isHttpNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === "HTTP 404";
}

function printInstalledPackageVersions(): void {
  const info = readPackageInfo();
  console.log("Installed packages:");
  if (info === undefined) {
    console.log(`? ${PI_WEB_PACKAGE_NAME}: unknown`);
    console.log(`  missing package metadata: ${packageJsonPath()}`);
    return;
  }
  console.log(`✓ ${info.name}: ${info.version}`);
  console.log(`  ${info.path}`);
}

function printRunningVersionInfo(info: RunningVersionInfo): void {
  console.log("Running services:");
  if (info.web === undefined) printUnavailableComponent("Web/UI", info.webError);
  else printComponentVersion(info.web);
  if (info.sessiond === undefined) printUnavailableComponent("Session daemon", info.sessiondError);
  else printComponentVersion(info.sessiond);
  if (info.generatedAt !== undefined) console.log(`  reported by web/API at ${info.generatedAt}`);
}

function printComponentVersion(component: PiWebComponentStatus): void {
  const icon = component.available ? component.stale ? "!" : "✓" : "?";
  const status = !component.available ? "unavailable" : component.stale ? "restart needed" : "current";
  console.log(`${icon} ${component.label}: ${status}`);
  if (component.available || component.runtimeVersion !== undefined || component.installedVersion !== undefined) {
    console.log(`  running: ${formatVersion(component.runtimeVersion)}; installed: ${formatVersion(component.installedVersion)}`);
  }
  if (component.piVersion !== undefined) console.log(`  pi: ${component.piVersion}`);
  const installation = installationLabel(component.installation);
  if (installation !== undefined) console.log(`  installation: ${installation}`);
  if (component.error !== undefined) console.log(`  ${component.error}`);
}

function printUnavailableComponent(label: string, error: string | undefined): void {
  console.log(`? ${label}: unavailable`);
  if (error !== undefined && error !== "") console.log(`  ${error}`);
}

function installationLabel(installation: PiWebInstallationInfo | undefined): string | undefined {
  if (installation === undefined) return undefined;
  if (installation.kind === "pi-package") {
    const source = installation.source ?? "Pi package";
    const scope = installation.scope === undefined ? "" : ` · ${installation.scope}`;
    const path = installation.path === undefined ? "" : ` · ${installation.path}`;
    return `${source}${scope}${path}`;
  }
  if (installation.kind === "npm-global") {
    const npmRoot = installation.npmRoot === undefined ? "" : ` · ${installation.npmRoot}`;
    const path = installation.path === undefined ? "" : ` · ${installation.path}`;
    return `global npm package${npmRoot}${path}`;
  }
  if (installation.kind === "local") return installation.path === undefined ? "local checkout" : `local checkout · ${installation.path}`;
  if (installation.kind === "docker") {
    const mode = installation.dockerMode === "dev" ? "Docker development runtime" : "Docker runtime";
    return installation.path === undefined ? mode : `${mode} · ${installation.path}`;
  }
  return installation.path === undefined ? "installation unknown" : `installation unknown · ${installation.path}`;
}

function formatVersion(version: string | undefined): string {
  return version === undefined || version === "" ? "unknown" : version;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
