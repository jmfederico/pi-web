import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { normalizeSafeTunnelLocalPiWebUrl } from "./safeTunnelState.js";

const maximumFrpcConfigCharacters = 32_000;
const minimumFrpcSecretCharacters = 32;
const maximumFrpcSecretCharacters = 4_096;
const maximumFrpcNameCharacters = 253;
const maximumFrpcPathCharacters = 4_096;

// The hosted fail-closed machine identity key: the frps NewProxy plugin
// authorizes an exact machine/proxy/domain from this global metadata value.
const frpcMachineTokenMetadataKey = "pi_web_machine_token";

const rootKeys = new Set([
  "auth",
  "metadatas",
  "proxies",
  "serverAddr",
  "serverPort",
  "transport",
  "user",
]);
const authKeys = new Set(["method", "token"]);
const machineMetadataKeys = new Set([frpcMachineTokenMetadataKey]);
const transportKeys = new Set(["tls"]);
const providerTlsKeys = new Set(["enable"]);
const preparedTlsKeys = new Set(["enable", "serverName", "trustedCaFile"]);
const proxyKeys = new Set([
  "customDomains",
  "localIP",
  "localPort",
  "name",
  "type",
]);

export interface SafeTunnelFrpcConfigInput {
  readonly frpcConfigToml: string;
  readonly localPiWebUrl: string;
  readonly proxyName: string;
  readonly publicHostname: string;
}

export interface SafeTunnelFrpcTransportTrust {
  /** Absolute PI WEB-owned CA bundle path; provider TOML never selects this path. */
  readonly trustedCaFile: string;
  /**
   * Persisted machine credential used for the tunnel-config request. The
   * provider TOML must carry it as global metadatas.pi_web_machine_token so
   * the fail-closed frps NewProxy plugin authorizes this exact machine;
   * the [auth].token transport credential alone is intentionally
   * insufficient. Never logged or returned to the browser.
   */
  readonly machineToken: string;
}

/**
 * Treat provider TOML as an untrusted transport shape. Only the minimal frpc
 * client contract PI WEB needs is retained, and the sole proxy's local target
 * is generated from PI WEB-owned desired state rather than copied from the
 * provider response.
 */
export function prepareSafeTunnelFrpcConfig(
  input: SafeTunnelFrpcConfigInput,
  desiredLocalPiWebUrl: string,
  trust: SafeTunnelFrpcTransportTrust,
): string {
  if (input.frpcConfigToml.length > maximumFrpcConfigCharacters) throw invalidConfig();
  assertNoFrpcTemplateActions(input.frpcConfigToml);
  const trustedCaFile = requireTrustedCaFile(trust.trustedCaFile);

  let parsed: TomlTable;
  try {
    parsed = parse(input.frpcConfigToml);
  } catch {
    throw invalidConfig();
  }

  assertOnlyKeys(parsed, rootKeys);
  const serverAddr = requireServerAddress(parsed["serverAddr"]);
  const serverPort = requirePort(parsed["serverPort"]);
  requireHostedMachineIdentity(parsed, trust.machineToken);
  const auth = requireTable(parsed["auth"]);
  assertOnlyKeys(auth, authKeys);
  const authMethod = auth["method"] === undefined
    ? "token"
    : requireBoundedString(auth["method"], maximumFrpcNameCharacters);
  if (authMethod !== "token") throw invalidConfig();
  const authToken = requireFrpcCredential(auth["token"]);

  const transport = parsed["transport"] === undefined
    ? undefined
    : requireTable(parsed["transport"]);
  if (transport !== undefined) {
    assertOnlyKeys(transport, transportKeys);
    const tls = transport["tls"] === undefined ? undefined : requireTable(transport["tls"]);
    if (tls !== undefined) {
      // The provider can require TLS but cannot choose a local trust path or a
      // certificate identity. PI WEB binds those below to its own CA bundle
      // and the validated relay endpoint.
      assertOnlyKeys(tls, providerTlsKeys);
      if (tls["enable"] !== undefined && tls["enable"] !== true) throw invalidConfig();
    }
  }

  const proxies = parsed["proxies"];
  if (!Array.isArray(proxies) || proxies.length !== 1) throw invalidConfig();
  const proxy = requireTable(proxies[0]);
  assertOnlyKeys(proxy, proxyKeys);
  const proxyName = requireBoundedString(proxy["name"], maximumFrpcNameCharacters);
  if (proxyName !== input.proxyName || proxy["type"] !== "http") throw invalidConfig();

  const publicHostname = requireHostname(input.publicHostname);
  const customDomains = proxy["customDomains"];
  if (!Array.isArray(customDomains)
    || customDomains.length !== 1
    || customDomains[0] !== publicHostname) throw invalidConfig();

  const providerTarget = localTarget(input.localPiWebUrl);
  if (proxy["localIP"] !== providerTarget.localIP
    || proxy["localPort"] !== providerTarget.localPort) throw invalidConfig();
  const desiredTarget = localTarget(desiredLocalPiWebUrl);

  const prepared = stringify({
    serverAddr,
    serverPort,
    user: "",
    metadatas: { [frpcMachineTokenMetadataKey]: trust.machineToken },
    auth: {
      method: "token",
      token: authToken,
    },
    transport: {
      tls: {
        enable: true,
        serverName: serverAddr,
        trustedCaFile,
      },
    },
    proxies: [{
      name: proxyName,
      type: "http",
      localIP: desiredTarget.localIP,
      localPort: desiredTarget.localPort,
      customDomains: [publicHostname],
    }],
  });
  // frpc renders Go templates before parsing TOML. Check the serialized output
  // too, so TOML escapes cannot turn into executable template actions here.
  assertNoFrpcTemplateActions(prepared);
  validateSafeTunnelFrpcConfig(prepared, trust);
  return prepared;
}

/** Revalidates the exact constrained configuration passed to frpc. */
export function validateSafeTunnelFrpcConfig(
  toml: string,
  trust: SafeTunnelFrpcTransportTrust,
): void {
  if (toml.length > maximumFrpcConfigCharacters) throw invalidConfig();
  assertNoFrpcTemplateActions(toml);

  let parsed: TomlTable;
  try {
    parsed = parse(toml);
  } catch {
    throw invalidConfig();
  }

  assertOnlyKeys(parsed, rootKeys);
  const serverAddr = requireServerAddress(parsed["serverAddr"]);
  requirePort(parsed["serverPort"]);
  // Re-run the hosted machine-identity checks on the exact pre-launch TOML.
  requireHostedMachineIdentity(parsed, trust.machineToken);

  const auth = requireTable(parsed["auth"]);
  assertOnlyKeys(auth, authKeys);
  if (auth["method"] !== "token") throw invalidConfig();
  requireFrpcCredential(auth["token"]);

  const transport = requireTable(parsed["transport"]);
  assertOnlyKeys(transport, transportKeys);
  const tls = requireTable(transport["tls"]);
  assertOnlyKeys(tls, preparedTlsKeys);
  const serverName = requireServerAddress(tls["serverName"]);
  const trustedCaFile = requireTrustedCaFile(tls["trustedCaFile"]);
  if (tls["enable"] !== true
    || serverName !== serverAddr
    || trustedCaFile !== requireTrustedCaFile(trust.trustedCaFile)) {
    throw invalidConfig();
  }

  const proxies = parsed["proxies"];
  if (!Array.isArray(proxies) || proxies.length !== 1) throw invalidConfig();
  const proxy = requireTable(proxies[0]);
  assertOnlyKeys(proxy, proxyKeys);
  requireBoundedString(proxy["name"], maximumFrpcNameCharacters);
  if (proxy["type"] !== "http") throw invalidConfig();
  requireServerAddress(proxy["localIP"]);
  requirePort(proxy["localPort"]);
  const customDomains = proxy["customDomains"];
  if (!Array.isArray(customDomains) || customDomains.length !== 1) throw invalidConfig();
  const publicHostname = requireHostname(customDomains[0]);
  if (publicHostname !== customDomains[0]) throw invalidConfig();
}

interface LocalTarget {
  readonly localIP: string;
  readonly localPort: number;
}

/**
 * Requires the hosted machine identity exactly as the fail-closed frps
 * NewProxy authorization contract needs it: root user = "" (so frp does not
 * prefix the assigned proxy name) and exactly the pi_web_machine_token global
 * metadata equal to the persisted machine credential. Parsed structure is
 * compared, so a TOML [metadatas] table is accepted only where it is
 * equivalent to the hosted dotted key.
 */
function requireHostedMachineIdentity(parsed: TomlTable, machineToken: string): void {
  if (parsed["user"] !== "") throw invalidConfig();
  const metadatas = requireTable(parsed["metadatas"]);
  assertOnlyKeys(metadatas, machineMetadataKeys);
  if (metadatas[frpcMachineTokenMetadataKey] !== machineToken) throw invalidConfig();
}

function localTarget(value: string): LocalTarget {
  let normalized: string;
  try {
    normalized = normalizeSafeTunnelLocalPiWebUrl(value);
  } catch {
    throw invalidConfig();
  }
  const url = new URL(normalized);
  return {
    localIP: url.hostname.replace(/^\[|\]$/gu, ""),
    // Normalization requires an explicit port and restores canonical :80, but
    // WHATWG omits that default from URL.port when parsed again.
    localPort: url.port === "" ? 80 : Number.parseInt(url.port, 10),
  };
}

function requireServerAddress(value: unknown): string {
  const source = requireBoundedString(value, maximumFrpcNameCharacters);
  if (isIP(source) === 0 && !isDnsHostname(source)) throw invalidConfig();
  return source;
}

function requireHostname(value: unknown): string {
  const source = requireBoundedString(value, maximumFrpcNameCharacters);
  if (!isDnsHostname(source)) throw invalidConfig();
  return source;
}

function isDnsHostname(value: string): boolean {
  return value === value.toLowerCase()
    && value.length <= maximumFrpcNameCharacters
    && value.split(".").every((label) => (
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
    ));
}

function requirePort(value: unknown): number {
  if (typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > 65_535) throw invalidConfig();
  return value;
}

function requireBoundedString(value: unknown, maximumCharacters: number): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > maximumCharacters) throw invalidConfig();
  return value;
}

function requireFrpcCredential(value: unknown): string {
  if (typeof value !== "string"
    || value.length < minimumFrpcSecretCharacters
    || value.length > maximumFrpcSecretCharacters
    || !isVisibleAscii(value)) throw invalidConfig();
  return value;
}

function requireTrustedCaFile(value: unknown): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > maximumFrpcPathCharacters
    || !isAbsolute(value)
    || hasTerminalControl(value)) throw invalidConfig();
  return value;
}

function assertNoFrpcTemplateActions(value: string): void {
  if (value.includes("{{")) throw invalidConfig();
}

function isVisibleAscii(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) return false;
  }
  return true;
}

function hasTerminalControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined
      || codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function requireTable(value: unknown): TomlTable {
  if (!isTable(value)) throw invalidConfig();
  return value;
}

function assertOnlyKeys(value: TomlTable, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidConfig();
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfig(): Error {
  return new Error("Safe Tunnel provider frpc configuration is invalid.");
}
