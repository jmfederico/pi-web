import type { PiWebComponentStatus, PiWebInstallationInfo, PiWebRuntimeComponent, PiWebRuntimeResponse, PiWebVersionResponse } from "./apiTypes.js";
import { parseKnownPiWebCapabilities } from "./capabilities.js";

export function parsePiWebVersionResponse(value: unknown): PiWebVersionResponse | undefined {
  if (!isRecord(value)) return undefined;
  const packageName = value["packageName"];
  const generatedAt = value["generatedAt"];
  const components = value["components"];
  if (typeof packageName !== "string" || packageName === "" || typeof generatedAt !== "string" || generatedAt === "" || !isRecord(components)) return undefined;
  const web = parsePiWebComponentStatus(components["web"]);
  const sessiond = parsePiWebComponentStatus(components["sessiond"]);
  if (web === undefined || sessiond === undefined) return undefined;
  return { packageName, generatedAt, components: { web, sessiond } };
}

export function parsePiWebRuntimeResponse(value: unknown): PiWebRuntimeResponse | undefined {
  if (!isRecord(value)) return undefined;
  const packageName = value["packageName"];
  const generatedAt = value["generatedAt"];
  const components = value["components"];
  const capabilities = parseKnownPiWebCapabilities(value["capabilities"]);
  if (typeof packageName !== "string" || packageName === "" || typeof generatedAt !== "string" || generatedAt === "" || !isRecord(components) || capabilities === undefined) return undefined;
  const web = parsePiWebRuntimeComponent(components["web"]);
  const sessiond = parsePiWebRuntimeComponent(components["sessiond"]);
  if (web === undefined || sessiond === undefined) return undefined;
  return { packageName, generatedAt, components: { web, sessiond }, capabilities };
}

export function parsePiWebRuntimeComponent(value: unknown): PiWebRuntimeComponent | undefined {
  if (!isRecord(value)) return undefined;
  const component = value["component"];
  const label = value["label"];
  const runtimeVersion = value["runtimeVersion"];
  const available = value["available"];
  const capabilities = parseKnownPiWebCapabilities(value["capabilities"]);
  const error = value["error"];
  if (component !== "web" && component !== "sessiond") return undefined;
  if (typeof label !== "string" || label === "" || typeof available !== "boolean" || capabilities === undefined) return undefined;
  return {
    component,
    label,
    ...(typeof runtimeVersion === "string" ? { runtimeVersion } : {}),
    available,
    capabilities,
    ...(typeof error === "string" ? { error } : {}),
  };
}

export function parsePiWebComponentStatus(value: unknown): PiWebComponentStatus | undefined {
  if (!isRecord(value)) return undefined;
  const component = value["component"];
  const label = value["label"];
  const runtimeVersion = value["runtimeVersion"];
  const installedVersion = value["installedVersion"];
  const stale = value["stale"];
  const available = value["available"];
  const error = value["error"];
  const installation = parsePiWebInstallationInfo(value["installation"]);
  if (component !== "web" && component !== "sessiond") return undefined;
  if (typeof label !== "string" || label === "" || typeof stale !== "boolean" || typeof available !== "boolean") return undefined;
  return {
    component,
    label,
    ...(typeof runtimeVersion === "string" ? { runtimeVersion } : {}),
    ...(typeof installedVersion === "string" ? { installedVersion } : {}),
    stale,
    available,
    ...(installation === undefined ? {} : { installation }),
    ...(typeof error === "string" ? { error } : {}),
  };
}

export function parsePiWebInstallationInfo(value: unknown): PiWebInstallationInfo | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  const path = value["path"];
  const source = value["source"];
  const scope = value["scope"];
  const npmRoot = value["npmRoot"];
  if (kind !== "pi-package" && kind !== "npm-global" && kind !== "local" && kind !== "unknown") return undefined;
  return {
    kind,
    ...(typeof path === "string" ? { path } : {}),
    ...(typeof source === "string" ? { source } : {}),
    ...(scope === "user" || scope === "project" ? { scope } : {}),
    ...(typeof npmRoot === "string" ? { npmRoot } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
