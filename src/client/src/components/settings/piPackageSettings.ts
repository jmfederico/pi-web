import type { Machine, MachineKind, PiPackageInfo, PiPackageMutationAction } from "../../api";

export type PiPackageOperationKind = PiPackageMutationAction | "update-all";

export interface PiPackageOperationState {
  kind: PiPackageOperationKind;
  source?: string;
}

export interface PiPackageTargetContext {
  id: string;
  name: string;
  kind: MachineKind;
}

export function piPackageTargetContext(machine: Pick<Machine, "id" | "name" | "kind"> | undefined): PiPackageTargetContext {
  if (machine !== undefined) return { id: machine.id, name: machine.name, kind: machine.kind };
  return { id: "local", name: "local", kind: "local" };
}

export function piPackageTargetLabel(target: PiPackageTargetContext): string {
  return target.kind === "local" ? `${target.name} (local gateway)` : `${target.name} (remote machine)`;
}

export function shouldRefreshGatewayPluginsAfterPiPackageMutation(target: PiPackageTargetContext): boolean {
  return target.kind === "local";
}

export function normalizePiPackageSource(source: string): string {
  return source.trim();
}

export function piPackageSourceValidationMessage(source: string): string | undefined {
  if (normalizePiPackageSource(source) !== "") return undefined;
  return "Enter a Pi package source accepted by Pi, such as npm:@scope/package, a git/URL source, or a local path.";
}

export function piPackageScopeLabel(packageInfo: Pick<PiPackageInfo, "scope">): string {
  return packageInfo.scope === "project" ? "Project scope" : "User scope";
}

export function piPackageFilteredLabel(packageInfo: Pick<PiPackageInfo, "filtered">): string {
  return packageInfo.filtered ? "Filtered by current Pi package settings" : "Available in this PI WEB process";
}

export function piPackageInstalledPathLabel(packageInfo: Pick<PiPackageInfo, "installedPath">): string {
  return packageInfo.installedPath ?? "Installed path not reported by Pi";
}

export function canUpdatePiPackage(packageInfo: Pick<PiPackageInfo, "scope">): boolean {
  return packageInfo.scope === "user";
}

export function piPackageUpdateDisabledReason(packageInfo: Pick<PiPackageInfo, "scope">): string | undefined {
  if (canUpdatePiPackage(packageInfo)) return undefined;
  return "Project-scope Pi packages are listed for visibility, but PI WEB only updates user-scope Pi packages safely from this view.";
}

export function canUpdateAllPiPackages(packages: readonly Pick<PiPackageInfo, "scope">[]): boolean {
  return packages.length > 0 && packages.every(canUpdatePiPackage);
}

export function updateAllPiPackagesDisabledReason(packages: readonly Pick<PiPackageInfo, "scope">[]): string | undefined {
  if (packages.length === 0) return "No Pi packages are configured yet.";
  if (canUpdateAllPiPackages(packages)) return undefined;
  return "Update all is disabled while project-scope Pi packages are listed; update user-scope packages individually.";
}

export function isPiPackageOperationPending(operation: PiPackageOperationState | undefined, kind: PiPackageOperationKind, source?: string): boolean {
  if (operation?.kind !== kind) return false;
  return source === undefined || operation.source === source;
}

export function piPackageMutationFollowUpMessage(action: PiPackageMutationAction, target = piPackageTargetContext(undefined)): string {
  const verb = action === "install" ? "installed" : action === "remove" ? "removed" : "updated";
  const targetSuffix = target.kind === "local" ? "" : ` on ${target.name}`;
  const sessionScope = target.kind === "local" ? "each idle PI WEB session" : `each idle PI WEB session on ${target.name}`;
  const pluginScope = target.kind === "local" ? "PI WEB browser plugin changes" : `PI WEB browser plugin changes served by ${target.name}`;
  return `Pi package ${verb}${targetSuffix}. Type /reload in ${sessionScope} to rediscover Pi runtime resources: extensions, skills, prompt templates, themes, and context/system prompt files. Reload the browser page separately for ${pluginScope}.`;
}

export function friendlyPiPackageErrorMessage(message: string, target: PiPackageTargetContext): string {
  const normalized = message.trim();
  if (target.kind !== "remote") return normalized;
  if (isUnsupportedRemotePiPackageRouteMessage(normalized)) {
    return `Pi package management is not available on ${target.name}. Update and restart Pi-Web on that machine, then try again.`;
  }
  if (normalized === "Remote machine timeout") {
    return `Timed out while contacting ${target.name} for Pi package management. The package operation may still be running remotely; reload the package list before retrying.`;
  }
  if (normalized === "Remote machine unavailable") {
    return `Could not reach ${target.name} for Pi package management. Check the machine connection and try again.`;
  }
  return normalized;
}

function isUnsupportedRemotePiPackageRouteMessage(message: string): boolean {
  return message === "Not Found"
    || /route\s+(GET|POST):?\/api\/pi-packages\b.*not found/iu.test(message)
    || /cannot\s+(GET|POST)\s+.*\/api\/pi-packages\b/iu.test(message);
}
