import type { PiWebDockerMode, PiWebInstallationInfo, PiWebStatusMessage, PiWebStatusResponse, PluginRuntimeState, RestartServices } from "@jmfederico/pi-web/plugin-api";

export type CommandEntry = {
  label: string;
  command: string;
} & ({ kind: "update" | "updatePi" | "status" } | { kind: "restart"; services: RestartServices });

type CommandLabel = "update" | "updateOptional" | "updatePi" | "restartAll" | "restartWeb" | "restartSessiond" | "status";
const defaultLabel = (key: CommandLabel): string => ({ update: "Update PI WEB", updateOptional: "Update", updatePi: "Update Pi", restartAll: "Restart all", restartWeb: "Restart Web/UI", restartSessiond: "Restart session daemon", status: "Status" })[key];

function commandEntries(status: PiWebStatusResponse, label: (key: CommandLabel) => string): CommandEntry[] {
  const entries: CommandEntry[] = [
    { kind: "update", label: label("updateOptional"), command: status.commands.update ?? "" },
    { kind: "updatePi", label: label("updatePi"), command: status.commands.updatePi ?? "" },
    { kind: "restart", services: "both", label: label("restartAll"), command: status.commands.restart ?? "" },
    { kind: "restart", services: "web", label: label("restartWeb"), command: status.commands.restartWeb ?? "" },
    { kind: "restart", services: "sessiond", label: label("restartSessiond"), command: status.commands.restartSessiond ?? "" },
    { kind: "status", label: label("status"), command: status.commands.status ?? "" },
  ];
  return entries.filter((entry) => entry.command.trim() !== "");
}

export interface UpdatesRuntimeHint {
  dockerMode?: PiWebDockerMode;
}

// Recommendations are advisory. Core reloads status and resolves restart
// commands; Updates never executes the displayed restart command itself.
export function recommendedCommand(status: PiWebStatusResponse, label: (key: CommandLabel) => string = defaultLabel): CommandEntry | undefined {
  const entries = commandEntries(status, label);
  const update = entries.find((entry) => entry.kind === "update");
  if (status.release.updateAvailable && update !== undefined) {
    return { ...update, label: label("update") };
  }
  const { web, sessiond } = status.components;
  // A stale restart may already load a newer Pi, so it comes before updating Pi.
  // The status offers updatePi only while the loaded Pi is too old.
  if (!web.stale && !sessiond.stale) return entries.find((entry) => entry.kind === "updatePi");
  const services: RestartServices = web.stale ? (sessiond.stale ? "both" : "web") : "sessiond";
  // Do not widen a targeted restart just because only a broader command exists.
  return entries.find((entry) => entry.kind === "restart" && entry.services === services);
}

export function additionalCommands(status: PiWebStatusResponse, recommended: CommandEntry | undefined, label: (key: CommandLabel) => string = defaultLabel): CommandEntry[] {
  return commandEntries(status, label).filter((entry) => {
    if (entry.kind !== recommended?.kind) return true;
    return entry.kind === "restart" && recommended.kind === "restart" && entry.services !== recommended.services;
  });
}

export function messagesFor(state: PluginRuntimeState | undefined): PiWebStatusMessage[] {
  return state?.piWebStatus?.messages ?? [];
}

export function statusFor(state: PluginRuntimeState | undefined): PiWebStatusResponse | undefined {
  return state?.piWebStatus;
}

export function messageCount(state: PluginRuntimeState | undefined): number {
  return messagesFor(state).length;
}

export function isSelfManagedInstallation(installation: PiWebInstallationInfo | undefined): boolean {
  return installation === undefined || installation.kind === "local" || installation.kind === "docker" || installation.kind === "unknown";
}

export function shouldShowUpdatesPanel(state: PluginRuntimeState | undefined, hint: UpdatesRuntimeHint = {}): boolean {
  const status = statusFor(state);
  if (hint.dockerMode !== undefined) return true;
  if (messageCount(state) > 0) return true;
  if (status === undefined) return false;
  return isSelfManagedInstallation(status.components.web.installation)
    || isSelfManagedInstallation(status.components.sessiond.installation);
}

export function fallbackDockerStatus(hint: UpdatesRuntimeHint, generatedAt = "federated status unavailable"): PiWebStatusResponse | undefined {
  if (hint.dockerMode === undefined) return undefined;
  const commandPrefix = hint.dockerMode === "dev" ? "pi-web-docker --dev" : "pi-web-docker";
  const installation: PiWebInstallationInfo = { kind: "docker", dockerMode: hint.dockerMode };
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt,
    components: {
      web: { component: "web", label: "Web/UI", stale: false, available: true, installation },
      sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true, installation },
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false, skipped: true },
    commands: {
      // The development image mounts its built checkout at /workspace and does
      // not install a global pi-web executable. Both invoke the same CLI.
      update: hint.dockerMode === "dev" ? "node /workspace/dist/cli.js update" : "pi-web update",
      // Copyable guidance only: lifecycle requests always resolve through core,
      // including on hosts that have not supplied authoritative status yet.
      restart: `${commandPrefix} restart`,
      restartWeb: `${commandPrefix} restart-web`,
      restartSessiond: `${commandPrefix} restart-sessiond`,
      status: `${commandPrefix} status`,
    },
    messages: [{
      id: "docker-status-compatibility",
      severity: "info",
      title: "Docker update commands available",
      body: "This Updates plugin was loaded from a Docker PI WEB runtime, but the gateway has not provided Docker-aware status details yet. The Docker maintenance commands below are still available.",
    }],
  };
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
