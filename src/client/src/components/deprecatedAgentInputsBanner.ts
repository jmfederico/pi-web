import { html, type TemplateResult } from "lit";
import type { Machine, MachineRuntime, PiWebDeprecatedAgentInput } from "../api";

/** One machine's deprecated agent-configuration report, attributed for the banner. */
export interface DeprecatedAgentInputsWarning {
  readonly machineId: string;
  readonly machineName: string;
  readonly inputs: readonly PiWebDeprecatedAgentInput[];
}

/**
 * Deprecated agent-configuration inputs detected on each known machine, in
 * machine-list order so banner attribution is stable. A machine whose runtime
 * check failed or reported nothing contributes no warning, so the banner only
 * ever names machines with a live report of a deprecated input.
 */
export function deprecatedAgentInputsWarnings(machines: readonly Machine[], machineRuntimes: Readonly<Record<string, MachineRuntime>>): DeprecatedAgentInputsWarning[] {
  const warnings: DeprecatedAgentInputsWarning[] = [];
  for (const machine of machines) {
    const inputs = machineRuntimes[machine.id]?.deprecatedAgentInputs;
    if (inputs === undefined || inputs.length === 0) continue;
    warnings.push({ machineId: machine.id, machineName: machine.name, inputs });
  }
  return warnings;
}

/**
 * One banner line per machine: what is set, that it is deprecated, the
 * replacement input (or that there is none and the input must be removed),
 * and that support ends in a future release.
 */
export function deprecatedAgentInputsWarningText(warning: DeprecatedAgentInputsWarning): string {
  const inputs = warning.inputs.map(describeDeprecatedAgentInput).join("; ");
  return `${warning.machineName}: ${inputs}. Support for deprecated agent configuration inputs will be removed in a future release.`;
}

function describeDeprecatedAgentInput(input: PiWebDeprecatedAgentInput): string {
  const label = input.source === "config" ? `config key ${input.name}` : `environment variable ${input.name}`;
  if (input.replacement === undefined) return `${label} is deprecated and ignored; remove it, there is no replacement`;
  return `${label} is deprecated; set ${input.replacement} instead`;
}

/**
 * The non-dismissable deprecation banner: it renders no dismiss control and
 * stays up until every machine's runtime report comes back clean, which only
 * happens once the deprecated input is actually removed.
 */
export function deprecatedAgentInputsBanner(warnings: readonly DeprecatedAgentInputsWarning[]): TemplateResult | null {
  if (warnings.length === 0) return null;
  return html`<div class="deprecation-notice" role="alert">
    ${warnings.map((warning) => html`<p class="deprecation-notice-text">${deprecatedAgentInputsWarningText(warning)}</p>`)}
  </div>`;
}
