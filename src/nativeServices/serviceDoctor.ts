import { basename, join } from "node:path";
import {
  createDevelopmentNativeServicePlan,
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
    packageJsonPath: join(first.workingDirectory, "package.json"),
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
    ? { kind: target.kind, reason: null }
    : { kind: target.kind, reason: target.reason };
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
      failedPrerequisites: [],
    };
  }

  const configuredOverrides = result.plan.services.filter((service) => service.strategy.kind === "configured-override");
  for (const service of configuredOverrides) {
    lines.push(`! ${service.description} uses a configured command override; doctor does not execute arbitrary configured commands.`);
  }
  if (result.validation.ok) {
    lines.push("✓ All verifiable native-service plan requirements are satisfied in the service-manager context.");
    return { ok: true, failureKind: "none", lines, plan: result.plan, failedPrerequisites: [] };
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

function parseSystemdDefinition(
  definition: InstalledNativeServiceDefinition,
): InstalledNativeServiceInspection<ParsedServiceDefinition> {
  const execStart = /^ExecStart=(?:\/usr\/bin\/env )?(.+?) -lc (.+)$/mu.exec(definition.contents);
  if (execStart?.[1] === undefined || execStart[2] === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has an unrecognized ExecStart.` };
  }
  const shell = installedShell(execStart[1]);
  if (!shell.ok) return shell;
  const shellCommand = parseShellQuotedValue(shell.value.name, execStart[2]);
  if (shellCommand === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has an unrecognized shell command.` };
  }

  const environment: Record<string, string> = {};
  for (const match of definition.contents.matchAll(/^Environment="((?:\\.|[^"])*)"$/gmu)) {
    const assignment = systemdUnescape(match[1] ?? "");
    const separator = assignment.indexOf("=");
    if (separator <= 0) return { ok: false, message: `Installed ${definition.id} systemd unit has a malformed environment entry.` };
    environment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }

  const workingDirectoryMatch = /^WorkingDirectory=(.+)$/mu.exec(definition.contents);
  const workingDirectory = workingDirectoryMatch?.[1] === undefined
    ? null
    : parseSystemdValue(workingDirectoryMatch[1]);
  if (workingDirectoryMatch !== null && workingDirectory === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has a malformed working directory.` };
  }

  return {
    ok: true,
    value: { id: definition.id, shell: shell.value, environment, workingDirectory: workingDirectory ?? null, shellCommand },
  };
}

function parseLaunchdDefinition(
  definition: InstalledNativeServiceDefinition,
): InstalledNativeServiceInspection<ParsedServiceDefinition> {
  const argumentsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(definition.contents)?.[1];
  if (argumentsBlock === undefined) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has no ProgramArguments array.` };
  }
  const arguments_ = [...argumentsBlock.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map((match) => xmlUnescape(match[1] ?? ""));
  if (arguments_.length !== 4 || arguments_[0] !== "/usr/bin/env" || arguments_[2] !== "-lc") {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has unrecognized ProgramArguments.` };
  }
  const shell = installedShell(arguments_[1] ?? "");
  if (!shell.ok) return shell;

  const environment: Record<string, string> = {};
  const environmentBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(definition.contents)?.[1];
  if (environmentBlock !== undefined) {
    for (const match of environmentBlock.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gu)) {
      environment[xmlUnescape(match[1] ?? "")] = xmlUnescape(match[2] ?? "");
    }
  }
  const workingDirectory = launchdString(definition.contents, "WorkingDirectory");

  return {
    ok: true,
    value: {
      id: definition.id,
      shell: shell.value,
      environment,
      workingDirectory,
      shellCommand: arguments_[3] ?? "",
    },
  };
}

function installedShell(executable: string): InstalledNativeServiceInspection<NativeServiceShell> {
  const name = basename(executable).replace(/^-/, "");
  if (name !== "bash" && name !== "zsh" && name !== "fish") {
    return { ok: false, message: `Installed service definition uses unsupported login shell ${executable}.` };
  }
  return {
    ok: true,
    value: { name, executable, source: "detected", detectedExecutable: executable },
  };
}

function parseSystemdValue(value: string): string | undefined {
  if (!value.startsWith('"') && !value.endsWith('"')) return value;
  if (!value.startsWith('"') || !value.endsWith('"')) return undefined;
  return systemdUnescape(value.slice(1, -1));
}

function systemdUnescape(value: string): string {
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

function parseShellQuotedValue(shell: NativeServiceShell["name"], value: string): string | undefined {
  if (!value.startsWith("'") || !value.endsWith("'")) return undefined;
  const inner = value.slice(1, -1);
  if (shell === "fish") return fishSingleQuoteUnescape(inner);
  return inner.replaceAll("'\\''", "'").replaceAll("$$", "$").replaceAll("%%", "%");
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
  return result.replaceAll("$$", "$").replaceAll("%%", "%");
}

function launchdString(contents: string, key: string): string | null {
  const escapedKey = key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = new RegExp(`<key>${escapedKey}<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`, "u").exec(contents)?.[1];
  return value === undefined ? null : xmlUnescape(value);
}

function xmlUnescape(value: string): string {
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
    && leftEntries.every(([key, value]) => right[key] === value);
}

function impossibleMissingDefinition(): never {
  throw new Error("Expected at least one installed native service definition");
}
