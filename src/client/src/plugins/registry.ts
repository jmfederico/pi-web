import { html, svg } from "lit";
import { requirePluginBackendRevision } from "../../../shared/pluginBackendProtocol";
import type { PiWebPluginRegistration, PluginAction, PluginRuntimeContext, QualifiedContributionId, QualifiedPluginAction, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspaceLabelContribution, QualifiedWorkspacePanelContribution, ThemeContribution, ThemePairContribution, WorkspaceLabelContext, WorkspaceLabelContribution, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelContribution, WorkspacePluginBinding } from "./types";

const idPattern = /^[a-z][a-z0-9.-]*$/u;
const localIdPattern = /^[a-z][a-z0-9.-]*$/u;
const qualifiedContributionIdPattern = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u;
const routeAliasPattern = /^[a-z][a-z0-9.-]*(?::[a-z][a-z0-9.-]*)?$/u;
const pluginRuntimeScopes = new WeakMap<PluginRuntimeContext, (pluginId: string) => PluginRuntimeContext>();
const workspacePanelScopes = new WeakMap<WorkspacePanelContext, (binding: WorkspacePluginBinding) => WorkspacePanelContext>();
const workspaceLabelScopes = new WeakMap<WorkspaceLabelContext, (binding: WorkspacePluginBinding) => WorkspaceLabelContext>();

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
  private readonly registeringPluginIds = new Set<string>();
  private readonly gatewayPluginIds = new Set<string>();
  private readonly gatewayMachineSpecificPluginIds = new Set<string>();
  private readonly remoteMachineSpecificPluginIds = new Map<string, Set<string>>();
  private readonly contributionIds = new Set<QualifiedContributionId>();

  register(registration: PiWebPluginRegistration): void {
    const { plugin } = registration;
    const runtimePluginId = registration.id;
    const sourcePluginId = registration.sourcePluginId ?? runtimePluginId;
    this.validatePluginId(runtimePluginId);
    this.validatePluginId(sourcePluginId);
    const machineSpecific = this.parseMachineSpecific(runtimePluginId, registration.machineSpecific);
    const backendRevision = this.parseBackendRevision(runtimePluginId, registration.backendRevision);
    if (this.pluginIds.has(runtimePluginId) || this.registeringPluginIds.has(runtimePluginId)) throw new Error(`Duplicate plugin id: ${runtimePluginId}`);
    if (this.isRemoteDuplicateHiddenByGateway(registration.sourcePluginId, registration.machineId, machineSpecific)) return;

    this.registeringPluginIds.add(runtimePluginId);
    try {
      const apiVersion: unknown = plugin.apiVersion;
      if (apiVersion !== 2) throw new Error(`Unsupported browser plugin API version for ${sourcePluginId}: ${String(apiVersion)} (expected 2)`);
      const contributions = plugin.activate(Object.freeze({
        apiVersion: 2,
        pluginId: sourcePluginId,
        runtimePluginId,
        html,
        svg,
      })).contributions;
      const contributionIds = new Set<QualifiedContributionId>();
      const actions = (contributions.actions ?? []).map((action) => this.qualifyAction(runtimePluginId, action, registration.machineId, registration.sourcePluginId, contributionIds));
      const workspacePanels = (contributions.workspacePanels ?? []).map((panel) => this.qualifyWorkspacePanel(runtimePluginId, panel, registration.machineId, registration.sourcePluginId, backendRevision, contributionIds));
      const workspaceLabels = (contributions.workspaceLabels ?? []).map((contribution) => this.qualifyWorkspaceLabelContribution(runtimePluginId, contribution, registration.machineId, registration.sourcePluginId, backendRevision, contributionIds));
      const themes = registration.machineId === undefined
        ? (contributions.themes ?? []).map((theme) => this.qualifyTheme(runtimePluginId, theme, contributionIds))
        : [];
      const themePairs = registration.machineId === undefined
        ? (contributions.themePairs ?? []).map((pair) => this.qualifyThemePair(runtimePluginId, pair, contributionIds))
        : [];

      this.pluginIds.add(runtimePluginId);
      for (const contributionId of contributionIds) this.contributionIds.add(contributionId);
      this.actions.push(...actions);
      this.workspacePanels.push(...workspacePanels);
      this.workspaceLabels.push(...workspaceLabels);
      this.themes.push(...themes);
      this.themePairs.push(...themePairs);
      if (registration.machineId === undefined) {
        this.gatewayPluginIds.add(runtimePluginId);
        if (machineSpecific) this.gatewayMachineSpecificPluginIds.add(runtimePluginId);
      } else if (registration.sourcePluginId !== undefined && machineSpecific) {
        addMappedSetValue(this.remoteMachineSpecificPluginIds, registration.sourcePluginId, registration.machineId);
      }
    } finally {
      this.registeringPluginIds.delete(runtimePluginId);
    }
  }

  hasPlugin(pluginId: string): boolean {
    return this.pluginIds.has(pluginId);
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
      if (action.shortcutAliases !== undefined) qualified.shortcutAliases = [...action.shortcutAliases];
      if (action.group !== undefined) qualified.group = action.group;
      if (enabled !== undefined) qualified.enabled = enabled;
      if (disabledReason !== undefined && disabledReason !== "") qualified.disabledReason = disabledReason;
      return qualified;
    });
  }

  getWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    return [...this.workspacePanels].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  resolveWorkspacePanelRouteId(value: string, selectedMachineId: string): QualifiedContributionId | undefined {
    const activePanels = this.workspacePanels.filter((panel) => this.isContributionActive(panel.pluginId, panel.machineId, selectedMachineId, panel.sourcePluginId));
    const exact = activePanels.find((panel) => panel.id === value);
    if (exact !== undefined) return exact.id;
    const aliases = activePanels.filter((panel) => panel.routeAliases?.includes(value) === true);
    if (aliases.length === 1) return aliases[0]?.id;
    if (aliases.length > 1) console.warn(`Ambiguous PI WEB workspace panel route: ${value}`);
    return undefined;
  }

  async invalidateWorkspacePanels(context: WorkspacePanelContext, panelId?: QualifiedContributionId): Promise<void> {
    await Promise.all(this.workspacePanels.map(async (panel) => {
      if (panel.onInvalidate === undefined || (panelId !== undefined && panel.id !== panelId)) return;
      try {
        await panel.onInvalidate(context);
      } catch (error) {
        console.warn(`Failed to invalidate PI WEB plugin panel ${panel.id}`, error);
      }
    }));
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

  private qualifyAction(
    pluginId: string,
    action: PluginAction,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): RegisteredPluginAction {
    const id = this.qualify(pluginId, action.id, contributionIds);
    const sourceId = `${sourcePluginId ?? pluginId}:${action.id}`;
    const shortcutAliases = this.parseShortcutAliases(id, action.shortcutAliases, sourceId);
    return {
      ...action,
      id,
      pluginId,
      localId: action.id,
      ...(shortcutAliases.length === 0 ? {} : { shortcutAliases }),
      ...(machineId === undefined ? {} : { machineId }),
      ...(sourcePluginId === undefined ? {} : { sourcePluginId }),
    };
  }

  private qualifyWorkspacePanel(
    pluginId: string,
    panel: WorkspacePanelContribution,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    backendRevision: string | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): QualifiedWorkspacePanelContribution {
    const id = this.qualify(pluginId, panel.id, contributionIds);
    const badge = panel.badge;
    const visible = panel.visible;
    const onInvalidate = panel.onInvalidate;
    const binding = workspacePluginBinding(pluginId, sourcePluginId, backendRevision);
    const sourceId = `${sourcePluginId ?? pluginId}:${panel.id}`;
    const routeAliases = this.parseRouteAliases(id, panel.routeAliases, sourceId);
    return {
      ...panel,
      id,
      pluginId,
      localId: panel.id,
      ...(routeAliases.length === 0 ? {} : { routeAliases }),
      ...(machineId === undefined ? {} : { machineId }),
      ...(sourcePluginId === undefined ? {} : { sourcePluginId }),
      visible: (context: WorkspacePanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) && (visible?.(workspacePanelContextFor(context, binding)) ?? true),
      ...(badge === undefined ? {} : { badge: (context: WorkspacePanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) ? badge(workspacePanelContextFor(context, binding)) : undefined }),
      ...(onInvalidate === undefined ? {} : { onInvalidate: (context: WorkspacePanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) ? onInvalidate(workspacePanelContextFor(context, binding)) : undefined }),
      render: (context: WorkspacePanelContext) => panel.render(workspacePanelContextFor(context, binding)),
    };
  }

  private qualifyWorkspaceLabelContribution(
    pluginId: string,
    contribution: WorkspaceLabelContribution,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    backendRevision: string | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): QualifiedWorkspaceLabelContribution {
    const id = this.qualify(pluginId, contribution.id, contributionIds);
    const visible = contribution.visible;
    const items = contribution.items;
    const binding = workspacePluginBinding(pluginId, sourcePluginId, backendRevision);
    return {
      ...contribution,
      id,
      pluginId,
      localId: contribution.id,
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) && (visible?.(workspaceLabelContextFor(context, binding)) ?? true),
      items: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) ? items(workspaceLabelContextFor(context, binding)) : [],
    };
  }

  private qualifyTheme(pluginId: string, theme: ThemeContribution, contributionIds: Set<QualifiedContributionId>): QualifiedThemeContribution {
    const id = this.qualify(pluginId, theme.id, contributionIds);
    return { ...theme, id, pluginId, localId: theme.id };
  }

  private qualifyThemePair(pluginId: string, pair: ThemePairContribution, contributionIds: Set<QualifiedContributionId>): QualifiedThemePairContribution {
    const id = this.qualify(pluginId, pair.id, contributionIds);
    return {
      ...pair,
      id,
      pluginId,
      localId: pair.id,
      light: this.qualifyReference(pluginId, pair.light),
      dark: this.qualifyReference(pluginId, pair.dark),
    };
  }

  private qualify(pluginId: string, localId: string, contributionIds: Set<QualifiedContributionId>): QualifiedContributionId {
    this.validateLocalId(localId);
    const qualified: QualifiedContributionId = `${pluginId}:${localId}`;
    if (this.contributionIds.has(qualified) || contributionIds.has(qualified)) throw new Error(`Duplicate contribution id: ${qualified}`);
    contributionIds.add(qualified);
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

  private parseShortcutAliases(id: QualifiedContributionId, aliases: readonly string[] | undefined, sourceId: string): QualifiedContributionId[] {
    const parsed = [...new Set([...(aliases ?? []), sourceId])].filter((alias) => alias !== id);
    const invalid = parsed.find((alias) => !isQualifiedContributionId(alias));
    if (invalid !== undefined) throw new Error(`Invalid shortcut alias for ${id}: ${invalid}`);
    return parsed.filter(isQualifiedContributionId);
  }

  private parseRouteAliases(id: QualifiedContributionId, aliases: readonly string[] | undefined, sourceId: string): string[] {
    const parsed = [...new Set([...(aliases ?? []), sourceId])].filter((alias) => alias !== id);
    for (const alias of parsed) {
      if (!routeAliasPattern.test(alias)) throw new Error(`Invalid workspace panel route alias for ${id}: ${alias}`);
    }
    return parsed;
  }

  private validatePluginId(pluginId: string): void {
    if (!idPattern.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  }

  private validateLocalId(localId: string): void {
    if (!localIdPattern.test(localId)) throw new Error(`Invalid contribution id: ${localId}`);
  }

  private parseBackendRevision(pluginId: string, value: unknown): string | undefined {
    if (value === undefined) return undefined;
    try {
      return requirePluginBackendRevision(value);
    } catch {
      throw new Error(`Invalid plugin backend revision for ${pluginId}`);
    }
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

function workspacePanelContextFor(context: WorkspacePanelContext, binding: WorkspacePluginBinding): WorkspacePanelContext {
  return workspacePanelScopes.get(context)?.(binding) ?? context;
}

function workspaceLabelContextFor(context: WorkspaceLabelContext, binding: WorkspacePluginBinding): WorkspaceLabelContext {
  return workspaceLabelScopes.get(context)?.(binding) ?? context;
}

export function installPluginRuntimeScope(context: PluginRuntimeContext, scope: (pluginId: string) => PluginRuntimeContext): PluginRuntimeContext {
  pluginRuntimeScopes.set(context, scope);
  return context;
}

export function installWorkspacePanelScope(
  context: WorkspacePanelContext,
  scope: (binding: WorkspacePluginBinding) => WorkspacePanelContext,
): WorkspacePanelContext {
  workspacePanelScopes.set(context, scope);
  return context;
}

export function installWorkspaceLabelScope(
  context: WorkspaceLabelContext,
  scope: (binding: WorkspacePluginBinding) => WorkspaceLabelContext,
): WorkspaceLabelContext {
  workspaceLabelScopes.set(context, scope);
  return context;
}

function workspacePluginBinding(
  registrationPluginId: string,
  sourcePluginId: string | undefined,
  backendRevision: string | undefined,
): WorkspacePluginBinding {
  return Object.freeze({
    registrationPluginId,
    sourcePluginId: sourcePluginId ?? registrationPluginId,
    ...(backendRevision === undefined ? {} : { backendRevision }),
  });
}

function addMappedSetValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([value]));
  else existing.add(value);
}

function isQualifiedContributionId(value: string): value is QualifiedContributionId {
  return qualifiedContributionIdPattern.test(value);
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
