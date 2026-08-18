// Implementation details of the bundled Info plugin.
//
// This file is NOT part of the plugin skeleton. If you copied the Info plugin
// as a starting point for your own plugin, replace everything here with your
// own content — the plugin contract (metadata and contribution definitions)
// lives in pi-web-plugin.ts.

import type { TemplateResult } from "lit";
import type { HtmlTemplateTag, MachineKind, PiWebComponentStatus, PiWebInstallationInfo, PiWebReleaseStatus, PiWebStatusResponse, PluginMachine, PluginRuntimeContext, Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

export type ComponentHealth = "current" | "restart needed" | "unavailable";

export function componentHealth(component: PiWebComponentStatus): ComponentHealth {
  if (!component.available) return "unavailable";
  if (component.stale) return "restart needed";
  return "current";
}

export function formatVersion(version: string | undefined): string {
  return version === undefined || version === "" ? "unknown" : version;
}

export function installationLabel(installation: PiWebInstallationInfo | undefined): string {
  if (installation === undefined) return "installation unknown";
  if (installation.kind === "pi-package") {
    const scope = installation.scope === undefined ? "" : ` · ${installation.scope}`;
    const source = installation.source ?? "Pi package";
    return `${source}${scope}`;
  }
  if (installation.kind === "npm-global") return "global npm package";
  if (installation.kind === "local") return "local checkout";
  if (installation.kind === "docker") return installation.dockerMode === "dev" ? "Docker development runtime" : "Docker runtime";
  return "installation unknown";
}

export function machineKindLabel(kind: MachineKind): string {
  return kind === "local" ? "local machine" : "remote machine";
}

export function releaseSummary(release: PiWebReleaseStatus): string {
  if (release.updateAvailable) {
    return release.latestVersion === undefined || release.latestVersion === ""
      ? "Update available"
      : `Update available: ${release.latestVersion}`;
  }
  if (release.error !== undefined && release.error !== "") return `Update check failed: ${release.error}`;
  if (release.skipped === true) return "Update check skipped";
  return "Up to date";
}

/** One-line component summary used by the panel rows and the clipboard diagnostics. */
export function componentDetails(component: PiWebComponentStatus): string {
  const parts = [
    `running ${formatVersion(component.runtimeVersion)}`,
    `installed ${formatVersion(component.installedVersion)}`,
    `pi ${formatVersion(component.piVersion)}`,
    componentHealth(component),
    installationLabel(component.installation),
  ];
  if (component.installation?.path !== undefined && component.installation.path !== "") parts.push(component.installation.path);
  if (component.error !== undefined && component.error !== "") parts.push(`error: ${component.error}`);
  return parts.join(" · ");
}

/** Note shown when the session daemon runs a different Pi version than the web process. */
export function piVersionDriftNote(web: PiWebComponentStatus, sessiond: PiWebComponentStatus): string | undefined {
  if (!sessiond.available) return undefined;
  if (web.piVersion === undefined || sessiond.piVersion === undefined) return undefined;
  return web.piVersion === sessiond.piVersion ? undefined : `session daemon running ${formatVersion(sessiond.piVersion)}`;
}

export function workspaceFlags(workspace: Workspace): string[] {
  return [
    workspace.provider === undefined ? "folder workspace" : `provider: ${workspace.provider.pluginId}`,
    workspace.isMain ? "main workspace" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
}

export interface DiagnosticsInput {
  status: PiWebStatusResponse | undefined;
  machine?: PluginMachine | undefined;
  workspace?: Workspace | undefined;
}

/** Plain-text status block suitable for pasting into a bug report. */
export function diagnosticsSummary({ status, machine, workspace }: DiagnosticsInput): string {
  const lines: string[] = ["PI WEB diagnostics"];
  if (status === undefined) {
    lines.push("Status: unavailable");
  } else {
    lines.push(`Package: ${status.packageName}`);
    lines.push(`${status.components.web.label}: ${componentDetails(status.components.web)}`);
    lines.push(`${status.components.sessiond.label}: ${componentDetails(status.components.sessiond)}`);
    const checked = status.release.checkedAt === undefined || status.release.skipped === true ? "" : ` (checked ${status.release.checkedAt})`;
    lines.push(`Release: ${releaseSummary(status.release)}${checked}`);
    lines.push(`Status generated: ${status.generatedAt}`);
  }
  if (machine !== undefined) lines.push(`Machine: ${machine.name} (${machineKindLabel(machine.kind)})`);
  if (workspace === undefined) {
    lines.push("Workspace: none selected");
  } else {
    lines.push(`Workspace: ${workspace.label} — ${workspace.path} (${workspaceFlags(workspace).join(", ")})`);
  }
  return lines.join("\n");
}

/** Action body: copy the diagnostics summary for the current runtime context. */
export async function copyDiagnostics(context: PluginRuntimeContext): Promise<void> {
  const summary = diagnosticsSummary({
    status: context.state.piWebStatus,
    machine: context.state.selectedMachine,
    workspace: context.state.selectedWorkspace,
  });
  await navigator.clipboard.writeText(summary);
}

function renderComponent(html: HtmlTemplateTag, component: PiWebComponentStatus): TemplateResult {
  const health = componentHealth(component);
  return html`
    <div class="info-component">
      <strong>${component.label}</strong>
      <span class=${health === "current" ? "info-health-ok" : "info-health-attention"}>${health}</span>
      <small>${componentDetails(component)}</small>
    </div>
  `;
}

function renderStatusSection(html: HtmlTemplateTag, status: PiWebStatusResponse | undefined): TemplateResult {
  if (status === undefined) {
    return html`
      <section>
        <strong>PI WEB</strong>
        <p class="muted">PI WEB status is not available yet. It refreshes automatically in the background.</p>
      </section>
    `;
  }
  const web = status.components.web;
  const driftNote = piVersionDriftNote(web, status.components.sessiond);
  const messageCount = status.messages.length;
  return html`
    <section>
      <strong>PI WEB</strong>
      <div class="info-row">
        <span>Version</span>
        <span>${formatVersion(web.runtimeVersion)}</span>
        ${web.installedVersion === undefined || web.installedVersion === web.runtimeVersion ? null : html`<small>installed ${formatVersion(web.installedVersion)}</small>`}
      </div>
      <div class="info-row">
        <span>Pi</span>
        <span>${formatVersion(web.piVersion)}</span>
        ${driftNote === undefined ? null : html`<small>${driftNote}</small>`}
      </div>
      <div class="info-row">
        <span>Package</span>
        <span>${status.packageName}</span>
      </div>
      <div class="info-row">
        <span>Installation</span>
        <span>${installationLabel(web.installation)}</span>
        ${web.installation?.path === undefined || web.installation.path === "" ? null : html`<small>${web.installation.path}</small>`}
      </div>
      <div class="info-row">
        <span>Release</span>
        <span>${releaseSummary(status.release)}</span>
        ${status.release.checkedAt === undefined || status.release.skipped === true ? null : html`<small>checked ${status.release.checkedAt}</small>`}
      </div>
      ${messageCount === 0 ? null : html`<p class="muted">${String(messageCount)} status ${messageCount === 1 ? "message" : "messages"} — open the Updates tab for details.</p>`}
      <p class="muted">Status generated ${status.generatedAt}</p>
    </section>
    <section>
      <strong>Services</strong>
      ${renderComponent(html, status.components.web)}
      ${renderComponent(html, status.components.sessiond)}
    </section>
  `;
}

function renderMachineSection(html: HtmlTemplateTag, machine: PluginMachine): TemplateResult {
  return html`
    <section>
      <strong>Machine</strong>
      <div class="info-row">
        <span>Name</span>
        <span>${machine.name}</span>
      </div>
      <div class="info-row">
        <span>Type</span>
        <span>${machineKindLabel(machine.kind)}</span>
      </div>
    </section>
  `;
}

function renderWorkspaceSection(html: HtmlTemplateTag, workspace: Workspace): TemplateResult {
  return html`
    <section>
      <strong>Workspace</strong>
      <div class="info-row">
        <span>Name</span>
        <span>${workspace.label}</span>
      </div>
      <div class="info-row">
        <span>Path</span>
        <span class="info-path">${workspace.path}</span>
        ${workspaceFlags(workspace).length === 0 ? null : html`<small>${workspaceFlags(workspace).join(" · ")}</small>`}
      </div>
    </section>
  `;
}

/** Panel body: render the Info tab for the current workspace panel context. */
export function renderInfoPanel(html: HtmlTemplateTag, context: WorkspacePanelContext): TemplateResult {
  return html`
    <style>
      .viewer.info-status { flex: 1 1 auto; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; padding: 12px; overflow-y: auto; overflow-x: hidden; }
      .viewer.info-status section { flex: 0 0 auto; min-width: 0; display: grid; gap: 8px; align-content: start; }
      .viewer.info-status p { margin: 0; }
      .info-row { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: 3px 10px; border-bottom: 1px solid var(--pi-border-muted); padding: 6px 0; overflow-wrap: anywhere; }
      .info-row small { grid-column: 1 / -1; color: var(--pi-muted); }
      .info-component { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 10px; border-bottom: 1px solid var(--pi-border-muted); padding: 6px 0; }
      .info-component small { grid-column: 1 / -1; color: var(--pi-muted); overflow-wrap: anywhere; }
      .info-health-ok { color: var(--pi-success); }
      .info-health-attention { color: var(--pi-warning); }
    </style>
    <section class="toolbar"><strong>Info</strong></section>
    <section class="viewer info-status">
      ${renderStatusSection(html, context.state?.piWebStatus)}
      ${renderMachineSection(html, context.machine)}
      ${renderWorkspaceSection(html, context.workspace)}
    </section>
  `;
}
