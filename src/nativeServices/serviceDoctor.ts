import { posix as posixPath } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { ownEnvironmentValue } from "../environment.js";
import {
  createDevelopmentNativeServicePlan,
  nativeServiceManagerRefs,
  nativeServicePrerequisiteNeedsPathAdvice,
  resolveProductionNativeServicePlan,
  validateNativeServicePlan,
  type DevelopmentNativeServicePlanInput,
  type NativeServiceBackend,
  type NativeServiceId,
  type NativeServicePlan,
  type NativeServicePlanDependencies,
  type NativeServicePlanFailure,
  type NativeServicePlanValidationFailure,
  type NativeServicePrerequisite,
  type NativeServiceShell,
  type ProductionNativeServicePlanInput,
} from "./servicePlan.js";

export type InstalledNativeServiceMode = "none" | "production" | "development" | "ambiguous";

export interface InstalledNativeServiceDefinition {
  id: NativeServiceId;
  contents: string;
}

export interface InstalledNativeServiceContext {
  shell: NativeServiceShell;
  environment: Readonly<Record<string, string>>;
}

export type ManagedNativeServiceConfigSelection =
  | { source: "caller" | "installed"; configPath: string }
  | { source: "default" };

export type InstalledNativeServiceInspection<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export type NativeServiceDoctorTarget =
  | {
      kind: "installed-development";
      input: DevelopmentNativeServicePlanInput;
    }
  | {
      kind: "prospective-production";
      input: ProductionNativeServicePlanInput;
      reason: string;
    }
  | {
      kind: "inspection-failure";
      message: string;
    };

interface NativeServiceDoctorScope {
  kind: "installed-development" | "prospective-production";
  reason: string | null;
  shell: NativeServiceShell;
}

export type NativeServiceDoctorResult =
  | {
      kind: "inspection-failure";
      message: string;
    }
  | {
      kind: "plan-resolution-failure";
      scope: NativeServiceDoctorScope;
      failures: readonly NativeServicePlanFailure[];
    }
  | {
      kind: "plan-validation";
      scope: NativeServiceDoctorScope;
      plan: NativeServicePlan;
      validation: { ok: true } | { ok: false; failures: readonly NativeServicePlanValidationFailure[] };
    };

export interface NativeServiceDoctorReport {
  ok: boolean;
  failureKind: "none" | "requirements" | "infrastructure" | "inspection";
  lines: readonly string[];
  plan: NativeServicePlan | null;
  adviceShell: NativeServiceShell | null;
  pathAdviceRecommended: boolean;
  failedPrerequisites: readonly NativeServicePrerequisite[];
}

interface ParsedServiceDefinition {
  id: NativeServiceId;
  shell: NativeServiceShell;
  environment: Readonly<Record<string, string>>;
  workingDirectory: string | null;
  shellCommand: string;
}

export function inferInstalledNativeServiceMode(serviceIds: ReadonlySet<NativeServiceId>): InstalledNativeServiceMode {
  if (serviceIds.size === 0) return "none";
  const hasProductionWeb = serviceIds.has("web");
  const hasDevelopmentUi = serviceIds.has("uiDev");
  if (hasProductionWeb && !hasDevelopmentUi) return "production";
  if (hasDevelopmentUi && !hasProductionWeb) return "development";
  return "ambiguous";
}

/**
 * Select the config path for a caller that is about to probe managed native
 * services. A nonempty caller value is an explicit override and deliberately
 * avoids interpreting installed files. Otherwise every relevant definition
 * must parse to one consistent environment before its persisted path is used.
 */
export function selectManagedNativeServiceConfig(
  backend: NativeServiceBackend,
  definitions: readonly InstalledNativeServiceDefinition[],
  callerConfigPath: string | undefined,
): InstalledNativeServiceInspection<ManagedNativeServiceConfigSelection> {
  if (callerConfigPath !== undefined && callerConfigPath !== "") {
    return { ok: true, value: { source: "caller", configPath: callerConfigPath } };
  }
  if (definitions.length === 0) return { ok: true, value: { source: "default" } };

  const parsed = parseConsistentDefinitions(backend, definitions);
  if (!parsed.ok) return parsed;
  const firstEnvironment = parsed.value[0]?.environment;
  const installedConfigPath = firstEnvironment === undefined
    ? undefined
    : ownEnvironmentValue(firstEnvironment, "PI_WEB_CONFIG");
  if (installedConfigPath === undefined || installedConfigPath === "") {
    return { ok: true, value: { source: "default" } };
  }
  if (!posixPath.isAbsolute(installedConfigPath)) {
    return {
      ok: false,
      message: `Installed service definitions declare relative PI_WEB_CONFIG ${JSON.stringify(installedConfigPath)}; managed config paths must be absolute.`,
    };
  }
  return { ok: true, value: { source: "installed", configPath: installedConfigPath } };
}

export function inspectInstalledNativeServiceDefinitionEnvironment(
  backend: NativeServiceBackend,
  definition: InstalledNativeServiceDefinition,
): InstalledNativeServiceInspection<Readonly<Record<string, string>>> {
  const parsed = backend.kind === "systemd"
    ? parseSystemdDefinition(definition)
    : parseLaunchdDefinition(definition);
  return parsed.ok ? { ok: true, value: parsed.value.environment } : parsed;
}

export function inspectInstalledProductionServiceContext(
  backend: NativeServiceBackend,
  definitions: readonly InstalledNativeServiceDefinition[],
): InstalledNativeServiceInspection<InstalledNativeServiceContext> {
  const parsed = parseConsistentDefinitions(backend, definitions);
  if (!parsed.ok) return parsed;
  const withWorkingDirectory = parsed.value.find((definition) => definition.workingDirectory !== null);
  if (withWorkingDirectory !== undefined) {
    return {
      ok: false,
      message: `Installed production service ${withWorkingDirectory.id} unexpectedly has working directory ${withWorkingDirectory.workingDirectory ?? ""}.`,
    };
  }
  return {
    ok: true,
    value: {
      shell: parsed.value[0]?.shell ?? impossibleMissingDefinition(),
      environment: parsed.value[0]?.environment ?? impossibleMissingDefinition(),
    },
  };
}

export function inspectInstalledDevelopmentServiceInput(
  backend: NativeServiceBackend,
  definitions: readonly InstalledNativeServiceDefinition[],
): InstalledNativeServiceInspection<DevelopmentNativeServicePlanInput> {
  const parsed = parseConsistentDefinitions(backend, definitions);
  if (!parsed.ok) return parsed;
  const first = parsed.value[0] ?? impossibleMissingDefinition();
  if (first.workingDirectory === null) {
    return { ok: false, message: "Installed development services do not declare a working directory." };
  }

  const input: DevelopmentNativeServicePlanInput = {
    backend,
    shell: first.shell,
    environment: first.environment,
    workingDirectory: first.workingDirectory,
    packageJsonPath: posixPath.join(first.workingDirectory, "package.json"),
  };
  const expectedPlan = createDevelopmentNativeServicePlan(input);
  for (const definition of parsed.value) {
    const expected = expectedPlan.services.find((service) => service.id === definition.id);
    if (expected?.shellCommand !== definition.shellCommand) {
      return {
        ok: false,
        message: `Installed ${definition.id} service command does not match the canonical development plan.`,
      };
    }
  }
  return { ok: true, value: input };
}

export async function runNativeServiceDoctor(
  target: NativeServiceDoctorTarget,
  dependencies: NativeServicePlanDependencies,
): Promise<NativeServiceDoctorResult> {
  if (target.kind === "inspection-failure") return target;

  const scope: NativeServiceDoctorScope = target.kind === "installed-development"
    ? { kind: target.kind, reason: null, shell: target.input.shell }
    : { kind: target.kind, reason: target.reason, shell: target.input.shell };
  let plan: NativeServicePlan;
  if (target.kind === "installed-development") {
    plan = createDevelopmentNativeServicePlan(target.input);
  } else {
    const resolution = await resolveProductionNativeServicePlan(target.input, dependencies);
    if (!resolution.ok) {
      return { kind: "plan-resolution-failure", scope, failures: resolution.failures };
    }
    plan = resolution.plan;
  }

  const validation = await validateNativeServicePlan(plan, dependencies.probe);
  return { kind: "plan-validation", scope, plan, validation };
}

export function formatNativeServiceDoctorResult(result: NativeServiceDoctorResult): NativeServiceDoctorReport {
  if (result.kind === "inspection-failure") {
    return {
      ok: false,
      failureKind: "inspection",
      lines: [
        `✗ Installed native-service plan could not be inspected: ${result.message}`,
        "  Run `pi-web install` or `pi-web install --dev` to replace mixed, partial, or outdated service definitions.",
      ],
      plan: null,
      adviceShell: null,
      pathAdviceRecommended: false,
      failedPrerequisites: [],
    };
  }

  const lines = [scopeHeading(result.scope)];
  if (result.kind === "plan-resolution-failure") {
    let infrastructure = false;
    for (const failure of result.failures) {
      if (failure.kind === "probe-infrastructure") {
        infrastructure = true;
        lines.push(`✗ Native service probe infrastructure failure (${failure.reason}): ${failure.message}`);
      } else if (failure.kind === "entrypoint-inspection-failure") {
        infrastructure = true;
        lines.push(`✗ Could not inspect bundled ${failure.serviceId} entrypoint ${failure.entrypointPath}: ${failure.message}`);
      } else {
        lines.push(`✗ ${failure.namedCommand} is unavailable to the native service manager, and bundled entrypoint ${failure.bundledEntrypointPath} is missing.`);
        if (failure.namedCommandFailure !== null) lines.push(`  ${failure.namedCommandFailure}`);
      }
    }
    if (infrastructure) lines.push("  This infrastructure failure is not proof of a PATH mismatch.");
    return {
      ok: false,
      failureKind: infrastructure ? "infrastructure" : "requirements",
      lines,
      plan: null,
      adviceShell: result.scope.shell,
      pathAdviceRecommended: !infrastructure
        && result.failures.some((failure) => failure.kind === "executable-unavailable"),
      failedPrerequisites: [],
    };
  }

  const configuredOverrides = result.plan.services.filter((service) => service.strategy.kind === "configured-override");
  for (const service of configuredOverrides) {
    lines.push(`! ${service.description} uses a configured command override; doctor does not execute arbitrary configured commands.`);
  }
  if (result.validation.ok) {
    lines.push("✓ All verifiable native-service plan requirements are satisfied in the service-manager context.");
    return {
      ok: true,
      failureKind: "none",
      lines,
      plan: result.plan,
      adviceShell: result.plan.shell,
      pathAdviceRecommended: false,
      failedPrerequisites: [],
    };
  }

  const failedPrerequisites: NativeServicePrerequisite[] = [];
  let infrastructure = false;
  for (const failure of result.validation.failures) {
    if (failure.kind === "probe-infrastructure") {
      infrastructure = true;
      lines.push(`✗ Native service probe infrastructure failure (${failure.reason}): ${failure.message}`);
    } else {
      failedPrerequisites.push(failure.prerequisite);
      lines.push(`✗ Native service requirement failed: ${failure.prerequisite.description}`);
      if (failure.detail !== null && failure.detail !== failure.prerequisite.description) lines.push(`  ${failure.detail}`);
    }
  }
  if (infrastructure) lines.push("  This infrastructure failure is not proof of a PATH mismatch.");
  return {
    ok: false,
    failureKind: infrastructure ? "infrastructure" : "requirements",
    lines,
    plan: result.plan,
    adviceShell: result.plan.shell,
    pathAdviceRecommended: !infrastructure
      && failedPrerequisites.some(nativeServicePrerequisiteNeedsPathAdvice),
    failedPrerequisites,
  };
}

function scopeHeading(scope: NativeServiceDoctorScope): string {
  if (scope.kind === "installed-development") return "Installed development native-service plan:";
  return `Prospective production native-service plan (${scope.reason ?? "installed strategy is unknown"}):`;
}

function parseConsistentDefinitions(
  backend: NativeServiceBackend,
  definitions: readonly InstalledNativeServiceDefinition[],
): InstalledNativeServiceInspection<readonly ParsedServiceDefinition[]> {
  if (definitions.length === 0) return { ok: false, message: "No installed service definitions were provided." };

  const parsed: ParsedServiceDefinition[] = [];
  for (const definition of definitions) {
    const result = backend.kind === "systemd"
      ? parseSystemdDefinition(definition)
      : parseLaunchdDefinition(definition);
    if (!result.ok) return result;
    parsed.push(result.value);
  }

  const first = parsed[0] ?? impossibleMissingDefinition();
  for (const definition of parsed.slice(1)) {
    if (definition.shell.executable !== first.shell.executable) {
      return { ok: false, message: "Installed service definitions use different login shells." };
    }
    if (!recordsEqual(definition.environment, first.environment)) {
      return { ok: false, message: "Installed service definitions use different environments." };
    }
    if (definition.workingDirectory !== first.workingDirectory) {
      return { ok: false, message: "Installed service definitions use different working directories." };
    }
  }
  return { ok: true, value: parsed };
}

interface ParsedSystemdDirective {
  name: string;
  value: string;
}

interface ParsedSystemdExecStart {
  shellArgument: string;
  shellCommandArgument: string;
}

interface ParsedSystemdExecArgument {
  value: string;
  endOffset: number;
}

function systemdServiceDirectives(contents: string): ParsedSystemdDirective[] | undefined {
  const allowed = new Set(["Type", "WorkingDirectory", "Environment", "ExecStart", "Restart", "RestartSec"]);
  const directives: ParsedSystemdDirective[] = [];
  let inServiceSection = false;
  let foundServiceSection = false;
  for (const line of contents.split(/\r?\n/u)) {
    // systemd syntax trims ASCII spaces and tabs here; JavaScript's trim/\s
    // would also consume Unicode whitespace that systemd treats as key text.
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/gu, "");
    if (/^\[[^\]]+\]$/u.test(trimmed)) {
      inServiceSection = trimmed === "[Service]";
      foundServiceSection ||= inServiceSection;
      continue;
    }
    if (!inServiceSection || trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    // Slice after the recognized prefix so JavaScript-only line separators remain directive data.
    const match = /^[ \t]*([A-Za-z][A-Za-z0-9]*)=/u.exec(line);
    const name = match?.[1];
    if (match === null || name === undefined || !allowed.has(name)) return undefined;
    directives.push({ name, value: line.slice(match[0].length) });
  }
  return foundServiceSection ? directives : undefined;
}

function hasSystemdPhysicalLineContinuation(line: string): boolean {
  let trailingBackslashes = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) trailingBackslashes += 1;
  return trailingBackslashes % 2 === 1;
}

/** Parse PI WEB's bounded ExecStart argument structure, including persisted legacy encodings. */
function parseSystemdExecStart(value: string): ParsedSystemdExecStart | undefined {
  const environmentPrefix = "/usr/bin/env ";
  const shellOffset = value.startsWith(environmentPrefix) ? environmentPrefix.length : 0;
  const shell = parseSystemdExecStartArgument(value, shellOffset);
  if (shell === undefined) return undefined;
  const loginShellSeparator = " -lc ";
  if (!value.startsWith(loginShellSeparator, shell.endOffset)) return undefined;

  const shellCommandOffset = shell.endOffset + loginShellSeparator.length;
  if (shellCommandOffset >= value.length) return undefined;
  return {
    shellArgument: shell.value,
    shellCommandArgument: value.slice(shellCommandOffset),
  };
}

/** Scan one systemd argument linearly so delimiters inside quoted values remain data. */
function parseSystemdExecStartArgument(value: string, offset: number): ParsedSystemdExecArgument | undefined {
  if (offset >= value.length || value[offset] === " " || value[offset] === "\t") return undefined;
  let quote: "\"" | "'" | null = null;
  for (let index = offset; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      if (index >= value.length) return undefined;
      continue;
    }
    if (quote === null && (character === " " || character === "\t")) {
      return { value: value.slice(offset, index), endOffset: index };
    }
    if (character !== "\"" && character !== "'") continue;
    if (quote === null) quote = character;
    else if (character === quote) quote = null;
  }
  return quote === null ? { value: value.slice(offset), endOffset: value.length } : undefined;
}

// Keep malformed installed input linear; overlapping escaped/raw regex alternatives can backtrack exponentially.
function isSingleSystemdQuotedValue(value: string): boolean {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return false;
  const closingQuoteIndex = value.length - 1;
  for (let index = 1; index < closingQuoteIndex; index += 1) {
    const character = value[index];
    if (character === '"') return false;
    if (character !== "\\") continue;
    index += 1;
    if (index >= closingQuoteIndex) return false;
  }
  return true;
}

function parseSystemdDefinition(
  definition: InstalledNativeServiceDefinition,
): InstalledNativeServiceInspection<ParsedServiceDefinition> {
  if (definition.contents.split(/\r?\n/u).some(hasSystemdPhysicalLineContinuation)) {
    return {
      ok: false,
      message: `Installed ${definition.id} systemd unit uses physical-line continuation, which cannot be inspected safely.`,
    };
  }

  const directives = systemdServiceDirectives(definition.contents);
  if (directives === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has unrecognized service directives.` };
  }
  const execStarts = directives.filter((directive) => directive.name === "ExecStart");
  const execStart = execStarts.length === 1
    ? parseSystemdExecStart(execStarts[0]?.value ?? "")
    : undefined;
  if (execStart === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit must have exactly one recognized ExecStart.` };
  }
  const shellExecutable = parseSystemdExecArgument(execStart.shellArgument);
  if (shellExecutable === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has an unrecognized login shell argument.` };
  }
  const shell = installedShell(shellExecutable);
  if (!shell.ok) return shell;
  const shellCommand = parseSystemdShellCommand(shell.value.name, execStart.shellCommandArgument);
  if (shellCommand === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has an unrecognized shell command.` };
  }

  const environment = new Map<string, string>();
  for (const directive of directives.filter((item) => item.name === "Environment")) {
    const rawValue = directive.value;
    if (!isSingleSystemdQuotedValue(rawValue)) {
      return { ok: false, message: `Installed ${definition.id} systemd unit has an unrecognized environment entry.` };
    }
    const assignment = parseSystemdDirectiveValue(rawValue);
    const separator = assignment?.indexOf("=") ?? -1;
    const key = assignment?.slice(0, separator) ?? "";
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || environment.has(key)) {
      return { ok: false, message: `Installed ${definition.id} systemd unit has a malformed environment entry.` };
    }
    environment.set(key, assignment?.slice(separator + 1) ?? "");
  }

  const workingDirectories = directives.filter((directive) => directive.name === "WorkingDirectory");
  if (workingDirectories.length > 1) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has duplicate working directories.` };
  }
  const rawWorkingDirectory = workingDirectories[0]?.value;
  if (rawWorkingDirectory?.startsWith('"') === true || rawWorkingDirectory?.startsWith("'") === true) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has an invalid quoted working directory.` };
  }
  const workingDirectory = rawWorkingDirectory === undefined
    ? null
    : parseSystemdDirectiveValue(rawWorkingDirectory);
  if (workingDirectories.length === 1 && workingDirectory === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has a malformed working directory.` };
  }

  return {
    ok: true,
    value: {
      id: definition.id,
      shell: shell.value,
      environment: Object.fromEntries(environment),
      workingDirectory: workingDirectory ?? null,
      shellCommand,
    },
  };
}

function parseLaunchdDefinition(
  definition: InstalledNativeServiceDefinition,
): InstalledNativeServiceInspection<ParsedServiceDefinition> {
  const plist = parseLaunchdPlistDocument(definition.contents);
  if (plist === undefined) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent is not a structurally valid property list.` };
  }

  const label = plistStringValue(plist.get("Label"));
  if (label === undefined) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has an unrecognized Label.` };
  }
  const expectedLabel = nativeServiceManagerRefs[definition.id].launchdLabel;
  if (label !== expectedLabel) {
    return {
      ok: false,
      message: `Installed ${definition.id} LaunchAgent declares Label ${JSON.stringify(label)} instead of ${JSON.stringify(expectedLabel)}.`,
    };
  }

  const arguments_ = plistStringArray(plist.get("ProgramArguments"));
  if (arguments_?.length !== 4 || arguments_[0] !== "/usr/bin/env" || arguments_[2] !== "-lc") {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has unrecognized ProgramArguments.` };
  }
  const shell = installedShell(arguments_[1] ?? "");
  if (!shell.ok) return shell;

  const rawEnvironment = plist.get("EnvironmentVariables");
  const environment = rawEnvironment === undefined ? {} : plistStringDictionary(rawEnvironment);
  if (environment === undefined) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has a malformed environment dictionary.` };
  }

  const rawWorkingDirectory = plist.get("WorkingDirectory");
  const workingDirectory = rawWorkingDirectory === undefined ? null : plistStringValue(rawWorkingDirectory);
  if (rawWorkingDirectory !== undefined && workingDirectory === undefined) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has a malformed working directory.` };
  }

  return {
    ok: true,
    value: {
      id: definition.id,
      shell: shell.value,
      environment,
      workingDirectory: workingDirectory ?? null,
      shellCommand: arguments_[3] ?? "",
    },
  };
}

function installedShell(executable: string): InstalledNativeServiceInspection<NativeServiceShell> {
  const name = posixPath.basename(executable).replace(/^-/, "");
  if (name !== "bash" && name !== "zsh" && name !== "fish") {
    return { ok: false, message: `Installed service definition uses unsupported login shell ${executable}.` };
  }
  return {
    ok: true,
    value: { name, executable, source: "detected", detectedExecutable: executable },
  };
}

function parseSystemdExecArgument(value: string): string | undefined {
  const quoted = value.startsWith('"') || value.endsWith('"');
  if (quoted ? !isSingleSystemdQuotedValue(value) : /["']/u.test(value)) return undefined;
  const decoded = decodeSystemdEscapes(quoted ? value.slice(1, -1) : value);
  return decoded === undefined ? undefined : decodeSystemdSubstitutions(decoded, true);
}

function parseSystemdDirectiveValue(value: string): string | undefined {
  const decoded = parseSystemdEscapedValue(value);
  return decoded === undefined ? undefined : decodeSystemdSubstitutions(decoded, false);
}

function parseSystemdEscapedValue(value: string): string | undefined {
  const quoted = value.startsWith('"') || value.endsWith('"');
  if (quoted && (!value.startsWith('"') || !value.endsWith('"'))) return undefined;
  return decodeSystemdEscapes(quoted ? value.slice(1, -1) : value);
}

export function decodeSystemdEscapes(value: string): string | undefined {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined || codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
      bytes.push(...encoder.encode(String.fromCodePoint(codePoint)));
      if (codePoint > 0xffff) index += 1;
      continue;
    }

    const escape = value[index + 1];
    if (escape === undefined) return undefined;
    const simpleEscapes: Readonly<Record<string, string>> = {
      "\\": "\\",
      '"': '"',
      "'": "'",
      a: "\u0007",
      b: "\b",
      e: "\u001b",
      f: "\f",
      n: "\n",
      r: "\r",
      s: " ",
      t: "\t",
      v: "\v",
    };
    const simple = simpleEscapes[escape];
    if (simple !== undefined) {
      bytes.push(...encoder.encode(simple));
      index += 1;
      continue;
    }

    if (/^[0-7]$/u.test(escape)) {
      const encoded = value.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/u.test(encoded)) return undefined;
      const decoded = Number.parseInt(encoded, 8);
      if (decoded === 0 || decoded > 0xff) return undefined;
      bytes.push(decoded);
      index += 3;
      continue;
    }

    const length = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
    if (length === 0) return undefined;
    const encoded = value.slice(index + 2, index + 2 + length);
    if (encoded.length !== length || !new RegExp(`^[0-9a-fA-F]{${String(length)}}$`, "u").test(encoded)) return undefined;
    const decoded = Number.parseInt(encoded, 16);
    if (decoded === 0 || decoded > 0x10ffff || (decoded >= 0xd800 && decoded <= 0xdfff)) return undefined;
    if (escape === "x") bytes.push(decoded);
    else bytes.push(...encoder.encode(String.fromCodePoint(decoded)));
    index += length + 1;
  }

  try {
    // Keep a BOM produced by an escape sequence as U+FEFF. The default
    // decoder behavior strips leading UTF-8 BOM bytes, which could turn an
    // invalid BOM-prefixed environment key into PI_WEB_CONFIG.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

function decodeSystemdSubstitutions(value: string, decodeDollars: boolean): string | undefined {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "%" && !(decodeDollars && character === "$")) {
      result += character ?? "";
      continue;
    }
    if (value[index + 1] !== character) return undefined;
    result += character;
    index += 1;
  }
  return result;
}

function parseSystemdShellCommand(shell: NativeServiceShell["name"], value: string): string | undefined {
  if (value.startsWith('"') || value.endsWith('"')) return parseSystemdExecArgument(value);
  if (!value.startsWith("'") || !value.endsWith("'")) return undefined;
  const inner = value.slice(1, -1);
  const unquoted = shell === "fish" ? fishSingleQuoteUnescape(inner) : inner.replaceAll("'\\''", "'");
  if (legacySystemdShellQuote(shell, unquoted) !== value) return undefined;
  // The pre-hardening renderer doubled percent specifiers, but its
  // replacement-string "$$" left dollar characters unchanged.
  return decodeSystemdSubstitutions(unquoted, false);
}

function legacySystemdShellQuote(shell: NativeServiceShell["name"], value: string): string {
  const escaped = shell === "fish"
    ? value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")
    : value.replaceAll("'", "'\\''");
  return `'${escaped}'`;
}

function fishSingleQuoteUnescape(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && index + 1 < value.length) {
      result += value[index + 1] ?? "";
      index += 1;
    } else {
      result += character ?? "";
    }
  }
  return result;
}

type ParsedPlistValue =
  | { kind: "string"; value: string }
  | { kind: "scalar"; value: string }
  | { kind: "array"; value: readonly ParsedPlistValue[] }
  | { kind: "dictionary"; value: ReadonlyMap<string, ParsedPlistValue> }
  | { kind: "boolean"; value: boolean };

type PlistScalarTag = "data" | "date" | "integer" | "real";
type PlistTextTag = "key" | "string" | PlistScalarTag;

interface PlistXmlCursor {
  readonly contents: string;
  offset: number;
}

const plistXmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';
const plistDoctype = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
const maximumPlistDepth = 32;

/** Parse the complete XML plist subset emitted by PI WEB, rejecting fragments and duplicate dictionary keys. */
function parseLaunchdPlistDocument(contents: string): ReadonlyMap<string, ParsedPlistValue> | undefined {
  const normalizedContents = normalizePlistXml(contents);
  if (normalizedContents === undefined) return undefined;
  const cursor: PlistXmlCursor = {
    contents: normalizedContents,
    offset: normalizedContents.startsWith("\uFEFF") ? 1 : 0,
  };
  skipPlistWhitespace(cursor);
  if (consumePlistToken(cursor, plistXmlDeclaration)) skipPlistWhitespace(cursor);
  else if (cursor.contents.startsWith("<?xml", cursor.offset)) return undefined;
  if (consumePlistToken(cursor, plistDoctype)) skipPlistWhitespace(cursor);
  else if (cursor.contents.startsWith("<!DOCTYPE", cursor.offset)) return undefined;
  if (!consumePlistToken(cursor, '<plist version="1.0">')) return undefined;

  const root = parsePlistValue(cursor, 0);
  if (root?.kind !== "dictionary") return undefined;
  skipPlistWhitespace(cursor);
  if (!consumePlistToken(cursor, "</plist>")) return undefined;
  skipPlistWhitespace(cursor);
  return cursor.offset === cursor.contents.length ? root.value : undefined;
}

function parsePlistValue(cursor: PlistXmlCursor, depth: number): ParsedPlistValue | undefined {
  if (depth > maximumPlistDepth) return undefined;
  skipPlistWhitespace(cursor);
  if (cursor.contents.startsWith("<string>", cursor.offset)) {
    const value = parsePlistTextElement(cursor, "string");
    return value === undefined ? undefined : { kind: "string", value };
  }
  for (const tag of ["data", "date", "integer", "real"] as const) {
    if (!cursor.contents.startsWith(`<${tag}>`, cursor.offset)) continue;
    const value = parsePlistTextElement(cursor, tag);
    return value === undefined || !isValidPlistScalarValue(tag, value)
      ? undefined
      : { kind: "scalar", value };
  }
  if (cursor.contents.startsWith("<array", cursor.offset)) return parsePlistArray(cursor, depth);
  if (cursor.contents.startsWith("<dict", cursor.offset)) return parsePlistDictionary(cursor, depth);
  if (consumePlistToken(cursor, "<true/>")) return { kind: "boolean", value: true };
  if (consumePlistToken(cursor, "<false/>")) return { kind: "boolean", value: false };
  return undefined;
}

function parsePlistArray(cursor: PlistXmlCursor, depth: number): ParsedPlistValue | undefined {
  if (consumePlistToken(cursor, "<array/>")) return { kind: "array", value: [] };
  if (!consumePlistToken(cursor, "<array>")) return undefined;
  const values: ParsedPlistValue[] = [];
  for (;;) {
    skipPlistWhitespace(cursor);
    if (consumePlistToken(cursor, "</array>")) return { kind: "array", value: values };
    const value = parsePlistValue(cursor, depth + 1);
    if (value === undefined) return undefined;
    values.push(value);
  }
}

function parsePlistDictionary(cursor: PlistXmlCursor, depth: number): ParsedPlistValue | undefined {
  if (consumePlistToken(cursor, "<dict/>")) return { kind: "dictionary", value: new Map() };
  if (!consumePlistToken(cursor, "<dict>")) return undefined;
  const values = new Map<string, ParsedPlistValue>();
  for (;;) {
    skipPlistWhitespace(cursor);
    if (consumePlistToken(cursor, "</dict>")) return { kind: "dictionary", value: values };
    const key = parsePlistTextElement(cursor, "key");
    if (key === undefined || values.has(key)) return undefined;
    const value = parsePlistValue(cursor, depth + 1);
    if (value === undefined) return undefined;
    values.set(key, value);
  }
}

function parsePlistTextElement(cursor: PlistXmlCursor, tag: PlistTextTag): string | undefined {
  const openingTag = `<${tag}>`;
  const closingTag = `</${tag}>`;
  if (!consumePlistToken(cursor, openingTag)) return undefined;
  const closingOffset = cursor.contents.indexOf(closingTag, cursor.offset);
  if (closingOffset < 0) return undefined;
  const encoded = cursor.contents.slice(cursor.offset, closingOffset);
  cursor.offset = closingOffset + closingTag.length;
  return xmlUnescapeStrict(encoded);
}

function normalizePlistXml(contents: string): string | undefined {
  for (const character of contents) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isXmlCharacter = codePoint === 0x09
      || codePoint === 0x0a
      || codePoint === 0x0d
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!isXmlCharacter) return undefined;
  }
  return contents.replace(/\r\n?/gu, "\n");
}

function isValidPlistScalarValue(tag: PlistScalarTag, value: string): boolean {
  if (tag === "data") {
    const compact = value.replace(/[\t\n\r ]/gu, "");
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact);
  }
  if (tag === "date") {
    const match = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.exec(value);
    if (match?.[1] === undefined || Number(match[1]) === 0) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      && new Date(timestamp).toISOString() === `${value.slice(0, -1)}.000Z`;
  }
  if (tag === "integer") {
    if (!/^[+-]?(?:0|[1-9][0-9]*)$/u.test(value)) return false;
    const parsed = BigInt(value);
    return parsed >= -(2n ** 63n) && parsed <= (2n ** 63n) - 1n;
  }
  return /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(value)
    && Number.isFinite(Number(value));
}

function skipPlistWhitespace(cursor: PlistXmlCursor): void {
  while (/[\t\n\r ]/u.test(cursor.contents[cursor.offset] ?? "")) cursor.offset += 1;
}

function consumePlistToken(cursor: PlistXmlCursor, token: string): boolean {
  if (!cursor.contents.startsWith(token, cursor.offset)) return false;
  cursor.offset += token.length;
  return true;
}

function plistStringValue(value: ParsedPlistValue | undefined): string | undefined {
  return value?.kind === "string" ? value.value : undefined;
}

function plistStringArray(value: ParsedPlistValue | undefined): string[] | undefined {
  if (value?.kind !== "array") return undefined;
  const strings: string[] = [];
  for (const item of value.value) {
    if (item.kind !== "string") return undefined;
    strings.push(item.value);
  }
  return strings;
}

function plistStringDictionary(value: ParsedPlistValue): Record<string, string> | undefined {
  if (value.kind !== "dictionary") return undefined;
  const entries: [string, string][] = [];
  for (const [key, item] of value.value) {
    if (item.kind !== "string") return undefined;
    entries.push([key, item.value]);
  }
  return Object.fromEntries(entries);
}

function xmlUnescapeStrict(value: string): string | undefined {
  if (/[<>]/u.test(value) || /&(?!(?:apos|quot|gt|lt|amp);)/u.test(value)) return undefined;
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function recordsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length
    && leftEntries.every(([key, value]) => Object.hasOwn(right, key) && right[key] === value);
}

function impossibleMissingDefinition(): never {
  throw new Error("Expected at least one installed native service definition");
}
