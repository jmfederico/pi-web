import { comparePackageVersions } from "./packageVersions.js";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * PI WEB supports the latest Pi minor line it was tested with. The floor of the
 * Pi development dependency range in package.json is the single source of truth
 * for that minimum. package.json ships in the published package, so installed
 * copies read the same value their release was tested with.
 *
 * The minimum only drives advisory warnings: SDK peer ranges stay "*" and no
 * runtime version gate blocks an older Pi.
 */
export function supportedPiMinimumVersion(packageJson: unknown): string | undefined {
  if (!isRecord(packageJson)) return undefined;
  const devDependencies = packageJson["devDependencies"];
  if (!isRecord(devDependencies)) return undefined;
  const range = devDependencies[PI_CODING_AGENT_PACKAGE];
  return typeof range === "string" ? versionRangeFloor(range) : undefined;
}

/**
 * Lowest version admitted by a single-comparator range such as `^1.6.0`.
 * Compound, wildcard, and x-ranges have no single floor and return undefined.
 */
export function versionRangeFloor(range: string): string | undefined {
  return /^(?:\^|~|>=|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(range.trim())?.[1];
}

export type PiVersionSource = "sessiond" | "web" | "cli";

export interface LoadedPiVersion {
  source: PiVersionSource;
  version: string;
}

interface PiVersionReporter {
  available: boolean;
  piVersion?: string;
}

/**
 * The Pi version sessions run on: the session daemon's report. The web
 * process's Pi is used only when the daemon is unavailable; a running daemon
 * that does not report its Pi leaves the version unknown.
 */
export function loadedPiVersion(components: { web?: PiVersionReporter | undefined; sessiond?: PiVersionReporter | undefined }): LoadedPiVersion | undefined {
  const { web, sessiond } = components;
  if (sessiond?.available === true) return sessiond.piVersion === undefined ? undefined : { source: "sessiond", version: sessiond.piVersion };
  if (web?.available === true && web.piVersion !== undefined) return { source: "web", version: web.piVersion };
  return undefined;
}

/** True only when both versions parse and Pi is older; unknown versions never warn. */
export function isOlderThanSupportedPi(piVersion: string, minimum: string): boolean {
  const comparison = comparePackageVersions(piVersion, minimum);
  return comparison !== undefined && comparison < 0;
}

const sourceLabels: Record<PiVersionSource, string> = {
  sessiond: "The session daemon",
  web: "The Web/UI service",
  cli: "This pi-web command",
};

export function unsupportedPiSummary(loaded: LoadedPiVersion, minimum: string): string {
  return `This PI WEB version supports Pi ${minimum} or later. ${sourceLabels[loaded.source]} uses Pi ${loaded.version}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
