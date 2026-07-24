import { html, svg } from "lit";
import type { PiWebPluginRegistration, PluginAction, PluginRuntimeContext, QualifiedContributionId, QualifiedPluginAction, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspaceLabelContribution, QualifiedWorkspacePanelContribution, ThemeContribution, ThemePairContribution, WorkspaceLabelContext, WorkspaceLabelContribution, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelContribution } from "./types";

const idPattern = /^[a-z][a-z0-9.-]*$/u;
const localIdPattern = /^[a-z][a-z0-9.-]*$/u;
const pluginRuntimeScopes = new WeakMap<PluginRuntimeContext, (pluginId: string) => PluginRuntimeContext>();
const workspacePanelScopes = new WeakMap<WorkspacePanelContext, (pluginId: string) => WorkspacePanelContext>();

type RegisteredPluginAction = Omit<PluginAction, "id"> & {
  id: QualifiedContributionId;
  pluginId: string;
  localId: string;
  machineId?: string;
  sourcePluginId?: string;
};

export class PluginRegistry {
  private readonly actions: RegisteredPluginAction[] = [];
  private readonly workspacePanels: QualifiedWorkspacePanelContribution[] = [];
  private readonly workspaceLabels: QualifiedWorkspaceLabelContribution[] = [];
  private readonly themes: QualifiedThemeContribution[] = [];
  private readonly themePairs: QualifiedThemePairContribution[] = [];
  private readonly pluginIds = new Set<string>();
  private readonly gatewayPluginIds = new Set<string>();
  private readonly gatewayMachineSpecificPluginIds = new Set<string>();
  private readonly remoteMachineSpecificPluginIds = new Map<string, Set<string>>();
  private readonly contributionIds = new Set<QualifiedContributionId>();

  register(registration: PiWebPluginRegistration): void {
    const { id, plugin } = registration;
    this.validatePluginId(id);
    const machineSpecific = this.parseMachineSpecific(id, registration.machineSpecific);
    if (this.pluginIds.has(id)) throw new Error(`Duplicate plugin id: ${id}`);
    if (this.isRemoteDuplicateHiddenByGateway(registration.sourcePluginId, registration.machineId, machineSpecific)) return;
    this.pluginIds.add(id);

    const apiVersion: unknown = plugin.apiVersion;
    if (apiVersion !== 1) throw new Error(`Unsupported plugin API version for ${id}: ${String(apiVersion)}`);
    const result = plugin.activate({ apiVersion: 1, pluginId: id, html, svg });
    const contributions = result.contributions;
    for (const action of contributions.actions ?? []) this.actions.push(this.qualifyAction(id, action, registration.machineId, registration.sourcePluginId));
    for (const panel of contributions.workspacePanels ?? []) this.workspacePanels.push(this.qualifyWorkspacePanel(id, panel, registration.machineId, registration.sourcePluginId));
    for (const contribution of contributions.workspaceLabels ?? []) this.workspaceLabels.push(this.qualifyWorkspaceLabelContribution(id, contribution, registration.machineId, registration.sourcePluginId));
    if (registration.machineId === undefined) {
      for (const theme of contributions.themes ?? []) this.themes.push(this.qualifyTheme(id, theme));
      for (const pair of contributions.themePairs ?? []) this.themePairs.push(this.qualifyThemePair(id, pair));
      this.gatewayPluginIds.add(id);
      if (machineSpecific) this.gatewayMachineSpecificPluginIds.add(id);
    } else if (registration.sourcePluginId !== undefined && machineSpecific) {
      addMappedSetValue(this.remoteMachineSpecificPluginIds, registration.sourcePluginId, registration.machineId);
    }
  }

  shouldLoadRemotePlugin(sourcePluginId: string, machineSpecific = false): boolean {
    return !this.gatewayPluginIds.has(sourcePluginId) || this.gatewayMachineSpecificPluginIds.has(sourcePluginId) || machineSpecific;
  }

  getActions(context: PluginRuntimeContext): QualifiedPluginAction[] {
    const selectedMachineId = runtimeContextMachineId(context);
    return this.actions.filter((action) => this.isContributionActive(action.pluginId, action.machineId, selectedMachineId, action.sourcePluginId)).map((action) => {
      const scopedContext = pluginRuntimeContextFor(context, action.pluginId);
      const enabled = action.enabled?.(scopedContext);
      const disabledReason = enabled === false ? action.disabledReason?.(scopedContext) : undefined;
      const qualified: QualifiedPluginAction = {
        id: action.id,
        pluginId: action.pluginId,
        localId: action.localId,
        ...(action.machineId === undefined ? {} : { machineId: action.machineId }),
        title: action.title,
        run: () => action.run(scopedContext),
      };
      if (action.description !== undefined) qualified.description = action.description;
      if (action.shortcut !== undefined) qualified.shortcut = action.shortcut;
      if (action.group !== undefined) qualified.group = action.group;
      if (enabled !== undefined) qualified.enabled = enabled;
      if (disabledReason !== undefined && disabledReason !== "") qualified.disabledReason = disabledReason;
      return qualified;
    });
  }

  getWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    return [...this.workspacePanels].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  getThemes(): QualifiedThemeContribution[] {
    return [...this.themes].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getThemePairs(): QualifiedThemePairContribution[] {
    return [...this.themePairs].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getWorkspaceLabelItems(context: WorkspaceLabelContext): WorkspaceLabelItem[] {
    return [...this.workspaceLabels]
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.id.localeCompare(right.id))
      .flatMap((contribution) => {
        if (contribution.visible?.(context) === false) return [];
        return contribution.items(context);
      });
  }

  private qualifyAction(pluginId: string, action: PluginAction, machineId: string | undefined, sourcePluginId: string | undefined): RegisteredPluginAction {
    const id = this.qualify(pluginId, action.id);
    return { ...action, id, pluginId, localId: action.id, ...(machineId === undefined ? {} : { machineId }), ...(sourcePluginId === undefined ? {} : { sourcePluginId }) };
  }

  private qualifyWorkspacePanel(pluginId: string, panel: WorkspacePanelContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedWorkspacePanelContribution {
    const id = this.qualify(pluginId, panel.id);
    const badge = panel.badge;
    const titleFor = panel.titleFor;
    const visible = panel.visible;
    return {
      ...panel,
      id,
      pluginId,
      localId: panel.id,
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context: WorkspacePanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) && (visible?.(workspacePanelContextFor(context, pluginId)) ?? true),
      ...(titleFor === undefined ? {} : { titleFor: (context: WorkspacePanelContext) => titleFor(workspacePanelContextFor(context, pluginId)) }),
      ...(badge === undefined ? {} : { badge: (context: WorkspacePanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) ? badge(workspacePanelContextFor(context, pluginId)) : undefined }),
      render: (context: WorkspacePanelContext) => panel.render(workspacePanelContextFor(context, pluginId)),
    };
  }

  private qualifyWorkspaceLabelContribution(pluginId: string, contribution: WorkspaceLabelContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedWorkspaceLabelContribution {
    const id = this.qualify(pluginId, contribution.id);
    const visible = contribution.visible;
    const items = contribution.items;
    return {
      ...contribution,
      id,
      pluginId,
      localId: contribution.id,
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) && (visible?.(context) ?? true),
      items: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) ? items(context) : [],
    };
  }

  private qualifyTheme(pluginId: string, theme: ThemeContribution): QualifiedThemeContribution {
    const id = this.qualify(pluginId, theme.id);
    return { ...theme, id, pluginId, localId: theme.id };
  }

  private qualifyThemePair(pluginId: string, pair: ThemePairContribution): QualifiedThemePairContribution {
    const id = this.qualify(pluginId, pair.id);
    return {
      ...pair,
      id,
      pluginId,
      localId: pair.id,
      light: this.qualifyReference(pluginId, pair.light),
      dark: this.qualifyReference(pluginId, pair.dark),
    };
  }

  private qualify(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    const qualified: QualifiedContributionId = `${pluginId}:${localId}`;
    if (this.contributionIds.has(qualified)) throw new Error(`Duplicate contribution id: ${qualified}`);
    this.contributionIds.add(qualified);
    return qualified;
  }

  private qualifyReference(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    return `${pluginId}:${localId}`;
  }

  private isContributionActive(pluginId: string, machineId: string | undefined, selectedMachineId: string, sourcePluginId: string | undefined): boolean {
    if (machineId === undefined) return !this.isGatewayPluginHiddenForMachine(pluginId, selectedMachineId);
    return machineId === selectedMachineId && !this.isRemotePluginHiddenByGateway(sourcePluginId, machineId);
  }

  private isRemoteDuplicateHiddenByGateway(sourcePluginId: string | undefined, machineId: string | undefined, machineSpecific: boolean): boolean {
    return sourcePluginId !== undefined
      && machineId !== undefined
      && this.gatewayPluginIds.has(sourcePluginId)
      && !this.gatewayMachineSpecificPluginIds.has(sourcePluginId)
      && !machineSpecific;
  }

  private isRemotePluginHiddenByGateway(sourcePluginId: string | undefined, machineId: string): boolean {
    if (sourcePluginId === undefined) return false;
    if (this.gatewayMachineSpecificPluginIds.has(sourcePluginId)) return false;
    if (this.remoteMachineSpecificPluginIds.get(sourcePluginId)?.has(machineId) === true) return false;
    return this.gatewayPluginIds.has(sourcePluginId);
  }

  private isGatewayPluginHiddenForMachine(pluginId: string, machineId: string): boolean {
    return machineId !== "local" && (
      this.gatewayMachineSpecificPluginIds.has(pluginId)
      || this.remoteMachineSpecificPluginIds.get(pluginId)?.has(machineId) === true
    );
  }

  private validatePluginId(pluginId: string): void {
    if (!idPattern.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  }

  private validateLocalId(localId: string): void {
    if (!localIdPattern.test(localId)) throw new Error(`Invalid contribution id: ${localId}`);
  }

  private parseMachineSpecific(pluginId: string, value: unknown): boolean {
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw new Error(`Invalid plugin machineSpecific value for ${pluginId}: ${formatUnknownValue(value)}`);
    return value;
  }
}

function pluginRuntimeContextFor(context: PluginRuntimeContext, pluginId: string): PluginRuntimeContext {
  return pluginRuntimeScopes.get(context)?.(pluginId) ?? context;
}

function workspacePanelContextFor(context: WorkspacePanelContext, pluginId: string): WorkspacePanelContext {
  return workspacePanelScopes.get(context)?.(pluginId) ?? context;
}

export function installPluginRuntimeScope(context: PluginRuntimeContext, scope: (pluginId: string) => PluginRuntimeContext): PluginRuntimeContext {
  pluginRuntimeScopes.set(context, scope);
  return context;
}

export function installWorkspacePanelScope(context: WorkspacePanelContext, scope: (pluginId: string) => WorkspacePanelContext): WorkspacePanelContext {
  workspacePanelScopes.set(context, scope);
  return context;
}

function addMappedSetValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([value]));
  else existing.add(value);
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function runtimeContextMachineId(context: PluginRuntimeContext): string {
  return context.state.selectedMachine?.id ?? "local";
}
