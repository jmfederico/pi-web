import { TextDecoder, TextEncoder } from "node:util";
import { ownEnvironmentValue } from "../environment.js";
import {
  decodeSystemdEscapes,
  inspectInstalledNativeServiceDefinitionEnvironment,
  type InstalledNativeServiceDefinition,
  type InstalledNativeServiceInspection,
} from "./serviceDoctor.js";
import type { NativeServiceBackend, NativeServiceId } from "./servicePlan.js";

export type InstalledNativeServiceDefinitionPurpose = "start" | "restart" | "doctor";

export interface InstalledNativeServiceDefinitionSource {
  id: NativeServiceId;
  path: string;
  systemdName: string;
  launchdTarget: string;
}

export interface InstalledNativeServiceDefinitionCommandResult {
  status: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  spawnError: string;
}

interface DecodedInstalledNativeServiceDefinitionCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface InstalledNativeServiceDefinitionDependencies {
  readFile: (path: string) => Uint8Array;
  realpath: (path: string) => string;
  capture: (command: string, args: string[]) => InstalledNativeServiceDefinitionCommandResult;
}

const systemdInspectionProperties = [
  "LoadState",
  "FragmentPath",
  "DropInPaths",
  "NeedDaemonReload",
  "EnvironmentFiles",
  "Environment",
] as const;

const systemdBusDestination = "org.freedesktop.systemd1";
const systemdUnitObjectPathPrefix = "/org/freedesktop/systemd1/unit/";
const legacySystemdUnprintableValue = "[unprintable]";

type SystemdInspectionProperty = typeof systemdInspectionProperties[number];

/**
 * Read installed definitions through a strict UTF-8 boundary, parse the
 * manager-relevant environment, and then bind that byte snapshot to the
 * service manager's effective context. Systemd must report the canonical
 * fragment, no unmodeled environment inputs, and the same effective
 * environment; legacy systemctl output is recovered losslessly from the
 * manager's D-Bus property. A loaded LaunchAgent must report the canonical
 * plist and the same PI_WEB_CONFIG. Launchd restart is the exception: its existing
 * bootout/bootstrap path deliberately replaces loaded state before probing.
 */
export function inspectInstalledNativeServiceDefinitions(
  backend: NativeServiceBackend,
  sources: readonly InstalledNativeServiceDefinitionSource[],
  dependencies: InstalledNativeServiceDefinitionDependencies,
  purpose: InstalledNativeServiceDefinitionPurpose,
): InstalledNativeServiceInspection<readonly InstalledNativeServiceDefinition[]> {
  const definitions: InstalledNativeServiceDefinition[] = [];
  for (const source of sources) {
    let bytes: Uint8Array;
    try {
      bytes = dependencies.readFile(source.path);
    } catch (error: unknown) {
      return {
        ok: false,
        message: `Could not read installed ${definitionLabel(backend, source.id)} ${source.path}: ${errorMessage(error)}`,
      };
    }

    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ok: false,
        message: `Installed ${definitionLabel(backend, source.id)} ${source.path} is not valid UTF-8.`,
      };
    }

    const definition = { id: source.id, contents } as const;
    const environment = inspectInstalledNativeServiceDefinitionEnvironment(backend, definition);
    if (!environment.ok) return environment;

    if (backend.kind === "systemd") {
      const managerInspection = inspectEffectiveSystemdDefinition(source, environment.value, dependencies);
      if (!managerInspection.ok) return managerInspection;
    } else if (purpose !== "restart") {
      const managerInspection = inspectLoadedLaunchdDefinition(source, environment.value, dependencies);
      if (!managerInspection.ok) return managerInspection;
    }
    definitions.push(definition);
  }
  return { ok: true, value: definitions };
}

function inspectEffectiveSystemdDefinition(
  source: InstalledNativeServiceDefinitionSource,
  expectedEnvironment: Readonly<Record<string, string>>,
  dependencies: InstalledNativeServiceDefinitionDependencies,
): InstalledNativeServiceInspection<null> {
  const args = [
    "--user",
    "--no-pager",
    "show",
    source.systemdName,
    "--all",
    ...systemdInspectionProperties.map((property) => `--property=${property}`),
  ];
  const captured = dependencies.capture("systemctl", args);
  const result = decodeCommandResult(captured);
  if (result === undefined) {
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName}: systemctl output is not valid UTF-8.`,
    };
  }
  if (result.status !== 0) {
    const detail = firstOutputLine(result.stderr, result.stdout);
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName}: systemctl exited with status ${String(result.status)}${detail === undefined ? "" : ` (${detail})`}.`,
    };
  }

  const parsed = parseSystemdInspectionProperties(result.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName}: ${parsed.message}`,
    };
  }

  const loadState = singleSystemdProperty(parsed.value.properties, "LoadState");
  const fragmentPath = singleSystemdProperty(parsed.value.properties, "FragmentPath");
  const dropInPaths = singleSystemdProperty(parsed.value.properties, "DropInPaths");
  const needDaemonReload = singleSystemdProperty(parsed.value.properties, "NeedDaemonReload");
  const effectiveEnvironmentValue = singleSystemdProperty(parsed.value.properties, "Environment");
  if (
    loadState === undefined
    || fragmentPath === undefined
    || dropInPaths === undefined
    || needDaemonReload === undefined
    || effectiveEnvironmentValue === undefined
  ) {
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName}: systemctl returned incomplete or duplicate unit metadata.`,
    };
  }
  if (loadState !== "loaded") {
    return {
      ok: false,
      message: `Systemd unit ${source.systemdName} has load state ${JSON.stringify(loadState)} instead of "loaded".`,
    };
  }
  if (needDaemonReload !== "no") {
    return {
      ok: false,
      message: needDaemonReload === "yes"
        ? `Systemd unit ${source.systemdName} has changed on disk; run \`systemctl --user daemon-reload\` before probing it.`
        : `Systemd unit ${source.systemdName} reports unrecognized NeedDaemonReload=${JSON.stringify(needDaemonReload)}.`,
    };
  }
  // Drop-ins (including package-owned global ones such as Fedora's
  // service.d/10-timeout-abort.conf) are tolerated: every drop-in-settable
  // property inspected here (Environment, EnvironmentFiles) is reported by
  // systemctl as the drop-in-merged effective value and is strictly verified
  // below, so a drop-in cannot silently alter what this inspection sees.
  const environmentFiles = parsed.value.properties.get("EnvironmentFiles") ?? [];
  const configuredEnvironmentFiles = environmentFiles.filter((value) => value !== "");
  if (configuredEnvironmentFiles.length > 0) {
    return {
      ok: false,
      message: `Systemd unit ${source.systemdName} uses EnvironmentFile inputs (${configuredEnvironmentFiles.join(", ")}); PI WEB cannot safely inspect their managed config values.`,
    };
  }

  let actualFragmentPath: string;
  let expectedFragmentPath: string;
  try {
    actualFragmentPath = dependencies.realpath(fragmentPath);
    expectedFragmentPath = dependencies.realpath(source.path);
  } catch (error: unknown) {
    return {
      ok: false,
      message: `Could not compare systemd fragment ${fragmentPath} with installed definition ${source.path}: ${errorMessage(error)}`,
    };
  }
  if (actualFragmentPath !== expectedFragmentPath) {
    return {
      ok: false,
      message: `Systemd loaded ${source.systemdName} from ${fragmentPath} instead of the installed PI WEB definition ${source.path}.`,
    };
  }

  const effectiveEnvironment = inspectEffectiveSystemdEnvironment(
    source,
    effectiveEnvironmentValue,
    parsed.value.propertiesWithAmbiguousTrailingCarriageReturn.has("Environment"),
    dependencies,
  );
  if (!effectiveEnvironment.ok) return effectiveEnvironment;
  if (!recordsEqual(effectiveEnvironment.value, expectedEnvironment)) {
    return {
      ok: false,
      message: `Systemd unit ${source.systemdName} has an effective environment that differs from installed definition ${source.path}; run \`systemctl --user daemon-reload\` or reinstall the managed services before probing it.`,
    };
  }
  return { ok: true, value: null };
}

function inspectLoadedLaunchdDefinition(
  source: InstalledNativeServiceDefinitionSource,
  expectedEnvironment: Readonly<Record<string, string>>,
  dependencies: InstalledNativeServiceDefinitionDependencies,
): InstalledNativeServiceInspection<null> {
  const captured = dependencies.capture("launchctl", ["print", source.launchdTarget]);
  const result = decodeCommandResult(captured);
  if (result === undefined) {
    return {
      ok: false,
      message: `Could not inspect loaded LaunchAgent ${source.launchdTarget}: launchctl output is not valid UTF-8.`,
    };
  }
  if (result.status !== 0) {
    if (launchdServiceIsMissing(result)) return { ok: true, value: null };
    const detail = firstOutputLine(result.stderr, result.stdout);
    return {
      ok: false,
      message: `Could not inspect loaded LaunchAgent ${source.launchdTarget}: launchctl exited with status ${String(result.status)}${detail === undefined ? "" : ` (${detail})`}.`,
    };
  }

  const loaded = parseLaunchdPrintDefinition(result.stdout, source.launchdTarget);
  if (loaded === undefined) {
    return {
      ok: false,
      message: `Could not inspect loaded LaunchAgent ${source.launchdTarget}: launchctl returned an unrecognized service definition.`,
    };
  }

  let actualPlistPath: string;
  let expectedPlistPath: string;
  try {
    actualPlistPath = dependencies.realpath(loaded.path);
    expectedPlistPath = dependencies.realpath(source.path);
  } catch (error: unknown) {
    return {
      ok: false,
      message: `Could not compare loaded LaunchAgent plist ${loaded.path} with installed definition ${source.path}: ${errorMessage(error)}`,
    };
  }
  if (actualPlistPath !== expectedPlistPath) {
    return {
      ok: false,
      message: `Launchd loaded ${source.launchdTarget} from ${loaded.path} instead of the installed PI WEB definition ${source.path}; run \`pi-web restart\` to reload the managed LaunchAgents.`,
    };
  }

  const expectedConfigPath = ownEnvironmentValue(expectedEnvironment, "PI_WEB_CONFIG");
  const loadedConfigPath = ownEnvironmentValue(loaded.environment, "PI_WEB_CONFIG");
  if (loadedConfigPath !== expectedConfigPath) {
    return {
      ok: false,
      message: `Loaded LaunchAgent ${source.launchdTarget} has PI_WEB_CONFIG ${JSON.stringify(loadedConfigPath)} instead of installed value ${JSON.stringify(expectedConfigPath)}; run \`pi-web restart\` to reload the managed LaunchAgents.`,
    };
  }
  return { ok: true, value: null };
}

interface ParsedSystemdInspectionProperties {
  properties: ReadonlyMap<SystemdInspectionProperty, readonly string[]>;
  propertiesWithAmbiguousTrailingCarriageReturn: ReadonlySet<SystemdInspectionProperty>;
}

function parseSystemdInspectionProperties(
  output: string,
): InstalledNativeServiceInspection<ParsedSystemdInspectionProperties> {
  const properties = new Map<SystemdInspectionProperty, string[]>();
  const propertiesWithAmbiguousTrailingCarriageReturn = new Set<SystemdInspectionProperty>();
  for (const property of systemdInspectionProperties) properties.set(property, []);

  const records = output.split("\n");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const hasAmbiguousTrailingCarriageReturn = index < records.length - 1 && record.endsWith("\r");
    const line = hasAmbiguousTrailingCarriageReturn ? record.slice(0, -1) : record;
    if (line === "") continue;
    const separator = line.indexOf("=");
    const name = line.slice(0, separator);
    if (separator < 0 || !isSystemdInspectionProperty(name)) {
      return { ok: false, message: "systemctl returned unrecognized unit metadata." };
    }
    properties.get(name)?.push(line.slice(separator + 1));
    if (hasAmbiguousTrailingCarriageReturn) propertiesWithAmbiguousTrailingCarriageReturn.add(name);
  }
  // systemctl's EnvironmentFiles formatter emits no line for an empty array,
  // even with --all. The other scalar/array properties must always be present.
  const requiredProperties = systemdInspectionProperties.filter((property) => property !== "EnvironmentFiles");
  if (requiredProperties.some((property) => (properties.get(property)?.length ?? 0) === 0)) {
    return { ok: false, message: "systemctl omitted required unit metadata." };
  }
  return {
    ok: true,
    value: { properties, propertiesWithAmbiguousTrailingCarriageReturn },
  };
}

function singleSystemdProperty(
  properties: ReadonlyMap<SystemdInspectionProperty, readonly string[]>,
  name: Exclude<SystemdInspectionProperty, "EnvironmentFiles">,
): string | undefined {
  const values = properties.get(name);
  return values?.length === 1 ? values[0] : undefined;
}

function isSystemdInspectionProperty(value: string): value is SystemdInspectionProperty {
  return systemdInspectionProperties.some((property) => property === value);
}

function inspectEffectiveSystemdEnvironment(
  source: InstalledNativeServiceDefinitionSource,
  systemctlValue: string,
  systemctlValueHasAmbiguousTrailingCarriageReturn: boolean,
  dependencies: InstalledNativeServiceDefinitionDependencies,
): InstalledNativeServiceInspection<Readonly<Record<string, string>>> {
  const serialized = parseSystemdSerializedWords(systemctlValue);
  const systemctlEnvironment = serialized === undefined
    ? undefined
    : environmentFromAssignments(serialized.words);
  if (
    serialized !== undefined
    && serialized.demonstrablyLossless
    && !systemctlValueHasAmbiguousTrailingCarriageReturn
    && !serialized.words.includes(legacySystemdUnprintableValue)
    && systemctlEnvironment !== undefined
  ) {
    return { ok: true, value: systemctlEnvironment };
  }

  // systemctl 239-245 redacts entries containing spaces or newlines, but can
  // emit other shell-significant bytes raw. A raw quote can make parsing fail,
  // while a raw backslash or tab can parse as a different set of assignments.
  // A carriage return immediately before the record's line feed is ambiguous
  // with CRLF framing. busctl reads the same manager property in a counted,
  // C-escaped form without any of these ambiguities.
  const captured = dependencies.capture("busctl", [
    "--user",
    "get-property",
    systemdBusDestination,
    systemdUnitObjectPath(source.systemdName),
    `${systemdBusDestination}.Service`,
    "Environment",
  ]);
  const result = decodeCommandResult(captured);
  if (result === undefined) {
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName} losslessly: busctl output is not valid UTF-8.`,
    };
  }
  if (result.status !== 0) {
    const detail = firstOutputLine(result.stderr, result.stdout);
    const systemctlDetail = serialized?.words.includes(legacySystemdUnprintableValue) === true
      ? `systemctl returned ${legacySystemdUnprintableValue}`
      : "systemctl returned an Environment value that was not demonstrably lossless";
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName} losslessly: ${systemctlDetail}, and busctl exited with status ${String(result.status)}${detail === undefined ? "" : ` (${detail})`}.`,
    };
  }

  const assignments = parseBusctlStringArray(result.stdout);
  if (assignments === undefined) return unrecognizedSystemdEnvironment(source, "busctl");
  const environment = environmentFromAssignments(assignments);
  return environment === undefined
    ? unrecognizedSystemdEnvironment(source, "busctl")
    : { ok: true, value: environment };
}

function unrecognizedSystemdEnvironment(
  source: InstalledNativeServiceDefinitionSource,
  command: "systemctl" | "busctl",
): InstalledNativeServiceInspection<never> {
  return {
    ok: false,
    message: `Could not inspect effective systemd unit ${source.systemdName}: ${command} returned an unrecognized Environment value.`,
  };
}

function environmentFromAssignments(assignments: readonly string[]): Readonly<Record<string, string>> | undefined {
  const environment = new Map<string, string>();
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const key = assignment.slice(0, separator);
    if (
      separator <= 0
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
      || environment.has(key)
    ) return undefined;
    environment.set(key, assignment.slice(separator + 1));
  }
  return Object.fromEntries(environment);
}

function parseBusctlStringArray(output: string): string[] | undefined {
  // busctl's terse array format is `as <count> "<C-escaped value>" ...`.
  let line = output;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line.includes("\r") || line.includes("\n")) return undefined;

  const header = /^as (0|[1-9][0-9]*)(.*)$/u.exec(line);
  if (header === null) return undefined;
  const count = Number(header[1]);
  if (!Number.isSafeInteger(count)) return undefined;

  const serializedWords = header[2] ?? "";
  const words: string[] = [];
  let offset = 0;
  while (offset < serializedWords.length) {
    if (serializedWords[offset] !== " " || serializedWords[offset + 1] !== "\"") return undefined;
    const parsed = systemdQuotedWord(serializedWords, offset + 1, "\"");
    if (parsed === undefined) return undefined;
    const decoded = decodeSystemdEscapes(parsed.raw);
    if (decoded === undefined) return undefined;
    words.push(decoded);
    offset = parsed.nextOffset;
  }
  return words.length === count ? words : undefined;
}

function systemdUnitObjectPath(unitName: string): string {
  // Mirror systemd's stable bus_label_escape() byte encoding for unit objects.
  let label = "";
  let index = 0;
  for (const byte of new TextEncoder().encode(unitName)) {
    const isAsciiLetter = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    const isNoninitialDigit = index > 0 && byte >= 0x30 && byte <= 0x39;
    label += isAsciiLetter || isNoninitialDigit
      ? String.fromCharCode(byte)
      : `_${byte.toString(16).padStart(2, "0")}`;
    index += 1;
  }
  return `${systemdUnitObjectPathPrefix}${label === "" ? "_" : label}`;
}

interface ParsedSystemdSerializedWords {
  words: readonly string[];
  demonstrablyLossless: boolean;
}

function parseSystemdSerializedWords(value: string): ParsedSystemdSerializedWords | undefined {
  const words: string[] = [];
  let demonstrablyLossless = true;
  let offset = 0;
  while (offset < value.length) {
    while (value[offset] === " " || value[offset] === "\t") {
      if (value[offset] === "\t") demonstrablyLossless = false;
      offset += 1;
    }
    if (offset >= value.length) break;

    let raw: string;
    let decodeEscapes = true;
    const first = value[offset];
    if (first === '"' || first === "'") {
      const parsed = systemdQuotedWord(value, offset, first);
      if (parsed === undefined) return undefined;
      raw = parsed.raw;
      offset = parsed.nextOffset;
      decodeEscapes = first === '"';
    } else if (first === "$" && value[offset + 1] === "'") {
      const parsed = systemdQuotedWord(value, offset + 1, "'");
      if (parsed === undefined) return undefined;
      raw = parsed.raw;
      offset = parsed.nextOffset;
    } else {
      const start = offset;
      while (offset < value.length && value[offset] !== " " && value[offset] !== "\t") offset += 1;
      raw = value.slice(start, offset);
      if (raw.includes('"') || raw.includes("'")) return undefined;
      if (raw.includes("\\")) demonstrablyLossless = false;
    }

    if (offset < value.length && value[offset] !== " " && value[offset] !== "\t") return undefined;
    const decoded = decodeEscapes ? decodeSystemdPrintedEscapes(raw) : raw;
    if (decoded === undefined || decoded.includes("\u0000")) return undefined;
    words.push(decoded);
  }
  return { words, demonstrablyLossless };
}

function decodeSystemdPrintedEscapes(value: string): string | undefined {
  // systemctl serializes string arrays with shell_maybe_quote(), whose
  // double-quoted form additionally escapes shell-significant $ and `.
  return decodeSystemdEscapes(value.replaceAll("\\$", "$").replaceAll("\\`", "`"));
}

function systemdQuotedWord(
  value: string,
  quoteOffset: number,
  quote: '"' | "'",
): { raw: string; nextOffset: number } | undefined {
  let escaped = false;
  for (let offset = quoteOffset + 1; offset < value.length; offset += 1) {
    const character = value[offset];
    if (quote === '"' || value[quoteOffset - 1] === "$") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
    }
    if (character === quote) {
      return { raw: value.slice(quoteOffset + 1, offset), nextOffset: offset + 1 };
    }
  }
  return undefined;
}

interface LaunchdPrintDefinition {
  path: string;
  environment: Readonly<Record<string, string>>;
}

interface LaunchdPrintGroup {
  name: string;
  records: LaunchdPrintRecord[];
}

type LaunchdPrintRecord =
  | { kind: "scalar"; value: string }
  | { kind: "group"; value: LaunchdPrintGroup };

function parseLaunchdPrintDefinition(
  output: string,
  expectedTarget: string,
): LaunchdPrintDefinition | undefined {
  const root = parseLaunchdPrintDocument(output, expectedTarget);
  if (root === undefined) return undefined;

  const pathPrefix = "path = ";
  const paths = root.records.flatMap((record) => (
    record.kind === "scalar" && record.value.startsWith(pathPrefix)
      ? [record.value.slice(pathPrefix.length)]
      : []
  ));
  const environments = root.records.flatMap((record) => (
    record.kind === "group" && record.value.name === "environment"
      ? [record.value]
      : []
  ));
  if (paths.length !== 1 || paths[0] === "" || environments.length !== 1) return undefined;

  const environment = parseLaunchdPrintEnvironment(environments[0]?.records ?? []);
  return environment === undefined
    ? undefined
    : { path: paths[0] ?? "", environment };
}

/**
 * Parse launchctl's complete, tab-indented service representation. Its scalar
 * records are LF-framed, so a carriage return is indistinguishable from
 * transport framing when it follows a scalar value; reject any such output
 * rather than silently changing a path or environment value.
 */
function parseLaunchdPrintDocument(output: string, expectedTarget: string): LaunchdPrintGroup | undefined {
  if (output.includes("\r") || output.includes("\u0000")) return undefined;
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== `${expectedTarget} = {`) return undefined;

  const root: LaunchdPrintGroup = { name: expectedTarget, records: [] };
  const stack: LaunchdPrintGroup[] = [root];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const depth = stack.length;
    const closingIndent = "\t".repeat(depth - 1);
    if (line === `${closingIndent}}`) {
      stack.pop();
      if (stack.length === 0) return index === lines.length - 1 ? root : undefined;
      continue;
    }
    if (line === "") continue;

    const recordIndent = "\t".repeat(depth);
    if (!line.startsWith(recordIndent) || line.startsWith(`${recordIndent}\t`)) return undefined;
    const value = line.slice(recordIndent.length);
    if (value === "") return undefined;

    const current = stack.at(-1);
    if (current === undefined) return undefined;
    const groupName = launchdPrintGroupName(value);
    if (groupName === undefined || !launchdPrintRecordHasGroupBody(lines, index, depth)) {
      if (value === "}") return undefined;
      current.records.push({ kind: "scalar", value });
      continue;
    }

    const group: LaunchdPrintGroup = { name: groupName, records: [] };
    current.records.push({ kind: "group", value: group });
    stack.push(group);
  }
  return undefined;
}

function launchdPrintGroupName(value: string): string | undefined {
  const suffix = " = {";
  if (!value.endsWith(suffix)) return undefined;
  const name = value.slice(0, -suffix.length);
  return name === "" || name.includes("\t") ? undefined : name;
}

/**
 * launchctl does not quote scalar values, so a scalar may itself end in the
 * group-opening marker. A real group is distinguishable by the next nonblank
 * record: it is either a child one indentation level deeper or that group's
 * closing brace. The enclosing group's sibling or closing brace instead makes
 * the marker part of the scalar value.
 */
function launchdPrintRecordHasGroupBody(
  lines: readonly string[],
  recordIndex: number,
  depth: number,
): boolean {
  let nextIndex = recordIndex + 1;
  while (lines[nextIndex] === "") nextIndex += 1;
  const nextLine = lines[nextIndex];
  if (nextLine === undefined) return false;

  const groupIndent = "\t".repeat(depth);
  if (nextLine === `${groupIndent}}`) return true;
  const childIndent = `${groupIndent}\t`;
  return nextLine.startsWith(childIndent) && !nextLine.startsWith(`${childIndent}\t`);
}

function parseLaunchdPrintEnvironment(
  records: readonly LaunchdPrintRecord[],
): Readonly<Record<string, string>> | undefined {
  const environment = new Map<string, string>();
  const separator = " => ";
  for (const record of records) {
    if (record.kind !== "scalar") return undefined;
    const separatorOffset = record.value.indexOf(separator);
    const key = record.value.slice(0, separatorOffset);
    if (
      separatorOffset <= 0
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
      || environment.has(key)
    ) return undefined;
    environment.set(key, record.value.slice(separatorOffset + separator.length));
  }
  return Object.fromEntries(environment);
}

function decodeCommandResult(
  result: InstalledNativeServiceDefinitionCommandResult,
): DecodedInstalledNativeServiceDefinitionCommandResult | undefined {
  let stdout: string;
  let stderr: string;
  try {
    stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout);
    stderr = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stderr);
  } catch {
    return undefined;
  }
  return {
    status: result.status,
    stdout,
    stderr: stderr === "" ? result.spawnError : stderr,
  };
}

function launchdServiceIsMissing(result: DecodedInstalledNativeServiceDefinitionCommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return /could not find (?:specified )?service|service (?:was )?not found/iu.test(output);
}

function recordsEqual(
  first: Readonly<Record<string, string>>,
  second: Readonly<Record<string, string>>,
): boolean {
  const firstEntries = Object.entries(first);
  const secondEntries = Object.entries(second);
  return firstEntries.length === secondEntries.length
    && firstEntries.every(([key, value]) => Object.hasOwn(second, key) && second[key] === value);
}

function definitionLabel(backend: NativeServiceBackend, id: NativeServiceId): string {
  return backend.kind === "systemd" ? `${id} systemd unit` : `${id} LaunchAgent`;
}

function firstOutputLine(...values: readonly string[]): string | undefined {
  for (const value of values) {
    const line = value.trim().split("\n").find((candidate) => candidate.trim() !== "");
    if (line !== undefined) return line.trim();
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
