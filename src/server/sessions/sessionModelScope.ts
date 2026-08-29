import { modelsAreEqual } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  resolveModelScopeWithDiagnostics,
  type AgentSessionRuntimeDiagnostic,
  type ExtensionContext,
  type ModelRuntime,
  type ScopedModel,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

type SessionModel = NonNullable<ExtensionContext["model"]>;

interface ResolveSessionModelOptionsInput {
  services: {
    modelRuntime: ModelRuntime;
    settingsManager: Pick<SettingsManager, "getDefaultModel" | "getDefaultProvider" | "getEnabledModels">;
  };
  hasExistingSession: boolean;
  initialModel?: SessionModel;
  initialThinkingLevel?: ThinkingLevel;
}

export interface ResolvedSessionModelOptions {
  scopedModels: ScopedModel[];
  diagnostics: AgentSessionRuntimeDiagnostic[];
  model?: SessionModel;
  thinkingLevel?: ThinkingLevel;
}

/** Resolve pi's cwd-bound cycling scope without overriding explicit or restored session state. */
export async function resolveSessionModelOptions(input: ResolveSessionModelOptionsInput): Promise<ResolvedSessionModelOptions> {
  const patterns = input.services.settingsManager.getEnabledModels();
  const resolved = patterns !== undefined && patterns.length > 0
    ? await resolveModelScopeWithDiagnostics(patterns, input.services.modelRuntime)
    : { scopedModels: [], diagnostics: [] };
  const diagnostics: AgentSessionRuntimeDiagnostic[] = resolved.diagnostics.map((diagnostic) => ({
    type: diagnostic.type,
    message: diagnostic.message,
  }));

  if (input.initialModel !== undefined) {
    return {
      scopedModels: resolved.scopedModels,
      diagnostics,
      model: input.initialModel,
      ...(input.initialThinkingLevel === undefined ? {} : { thinkingLevel: input.initialThinkingLevel }),
    };
  }
  if (input.hasExistingSession || resolved.scopedModels.length === 0) {
    return {
      scopedModels: resolved.scopedModels,
      diagnostics,
      ...(input.initialThinkingLevel === undefined ? {} : { thinkingLevel: input.initialThinkingLevel }),
    };
  }

  const defaultProvider = input.services.settingsManager.getDefaultProvider();
  const defaultModelId = input.services.settingsManager.getDefaultModel();
  const defaultModel = defaultProvider !== undefined && defaultModelId !== undefined
    ? input.services.modelRuntime.getModel(defaultProvider, defaultModelId)
    : undefined;
  const selected = defaultModel === undefined
    ? resolved.scopedModels[0]
    : resolved.scopedModels.find((candidate) => modelsAreEqual(candidate.model, defaultModel)) ?? resolved.scopedModels[0];
  if (selected === undefined) throw new Error("Scoped model resolution returned an empty selection");

  return {
    scopedModels: resolved.scopedModels,
    diagnostics,
    model: selected.model,
    ...(input.initialThinkingLevel !== undefined
      ? { thinkingLevel: input.initialThinkingLevel }
      : selected.thinkingLevel === undefined ? {} : { thinkingLevel: selected.thinkingLevel }),
  };
}

/** Canonical `provider/id` key pi's `enabledModels` entries and scope rows use. */
export function modelScopeId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * The session's effective enabled-model ids, mirroring the precedence of pi's
 * own models selector (`showModelsSelector`): the live cycling scope when the
 * session has one, otherwise the configured `enabledModels` patterns resolved
 * against the runtime catalog — with no-match patterns kept in the list so an
 * edit cannot silently drop a pattern that currently matches nothing —
 * otherwise `null`, pi's "everything enabled" state (no scope).
 */
export async function resolveEnabledModelIds(input: {
  settingsManager: Pick<SettingsManager, "getEnabledModels">;
  modelRuntime: ModelRuntime;
  scopedModels: readonly { model: { provider: string; id: string } }[];
}): Promise<readonly string[] | null> {
  if (input.scopedModels.length > 0) return input.scopedModels.map((scoped) => modelScopeId(scoped.model));
  const patterns = input.settingsManager.getEnabledModels();
  if (patterns === undefined || patterns.length === 0) return null;
  const resolved = await resolveModelScopeWithDiagnostics([...patterns], input.modelRuntime);
  const ids = resolved.scopedModels.map((scoped) => modelScopeId(scoped.model));
  for (const diagnostic of resolved.diagnostics) {
    if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
  }
  return ids;
}

/**
 * Apply one checkbox-style membership change to the effective enabled ids.
 * pi-web's picker sets membership explicitly per row, so unlike pi's
 * keyboard-driven single-key toggle (which narrows "all" to just that row),
 * enabling an already-enabled or disabling an already-disabled model is a
 * no-op — signalled by returning `currentIds` unchanged (same reference).
 */
export function applyEnabledModelToggle(
  currentIds: readonly string[] | null,
  availableIds: readonly string[],
  targetId: string,
  enabled: boolean,
): readonly string[] | null {
  if (currentIds === null) {
    return enabled ? null : availableIds.filter((id) => id !== targetId);
  }
  if (enabled) return currentIds.includes(targetId) ? currentIds : [...currentIds, targetId];
  return currentIds.includes(targetId) ? currentIds.filter((id) => id !== targetId) : currentIds;
}

/**
 * pi's persist normalization (`onPersist`): "everything enabled" collapses to
 * `undefined` (no scope). The comparison is exact — a list that covers the
 * whole catalog but also carries stale patterns stays a list, so those
 * patterns survive the edit.
 */
export function persistedEnabledModelPatterns(enabledIds: readonly string[] | null, availableIds: readonly string[]): string[] | undefined {
  if (enabledIds === null) return undefined;
  const allEnabled = enabledIds.length === availableIds.length && enabledIds.every((id) => availableIds.includes(id));
  return allEnabled ? undefined : [...enabledIds];
}

/**
 * pi's live-scope decision (`updateSessionModels`): the ids the session should
 * cycle through, or `null` to clear the scope back to "all available". A list
 * with no currently available model — or one covering the whole catalog —
 * clears the scope instead of pinning it.
 */
export function liveScopedModelIds(enabledIds: readonly string[] | null, availableIds: readonly string[]): readonly string[] | null {
  if (enabledIds === null) return null;
  const hasEnabledAvailableModel = enabledIds.some((id) => availableIds.includes(id));
  const allAvailableModelsEnabled = availableIds.every((id) => enabledIds.includes(id));
  return hasEnabledAvailableModel && !allAvailableModelsEnabled ? enabledIds : null;
}

/**
 * Resolve the canonical enabled ids into the SDK's live cycling scope. A null
 * result means every currently available model is pickable, so the SDK's
 * empty scoped-model array is intentional rather than an empty selection.
 */
export function scopedModelsFromEnabledIds<TModel extends { provider: string; id: string }>(
  available: readonly TModel[],
  enabledIds: readonly string[] | null,
  existingScopedModels: readonly { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }[] = [],
): { model: TModel; thinkingLevel?: ThinkingLevel }[] {
  const scopeIds = liveScopedModelIds(enabledIds, available.map(modelScopeId));
  if (scopeIds === null) return [];
  const modelsById = new Map(available.map((model) => [modelScopeId(model), model]));
  const thinkingLevelsById = new Map(existingScopedModels.map((scoped) => [modelScopeId(scoped.model), scoped.thinkingLevel]));
  return scopeIds.flatMap((id) => {
    const model = modelsById.get(id);
    if (model === undefined) return [];
    const thinkingLevel = thinkingLevelsById.get(id);
    return thinkingLevel === undefined ? [{ model }] : [{ model, thinkingLevel }];
  });
}

export interface EnabledModelCatalogEntry<TModel> {
  model: TModel;
  enabled: boolean;
  /** Position in `available`, retained even though the response is grouped enabled-first. */
  catalogIndex: number;
}

/**
 * The full catalog as the picker lists it in All models mode: enabled models
 * first — the same set and order as the Enabled list — then the remaining
 * models in catalog order (pi's `getSortedIds`). Enabled ids matching nothing
 * currently available (stale patterns) produce no row.
 */
export function catalogWithEnabledFirst<TModel extends { provider: string; id: string }>(
  available: readonly TModel[],
  enabledIds: readonly string[] | null,
): EnabledModelCatalogEntry<TModel>[] {
  if (enabledIds === null) return available.map((model, catalogIndex) => ({ model, enabled: true, catalogIndex }));
  const enabledSet = new Set(enabledIds);
  const modelsById = new Map(available.map((model, catalogIndex) => [modelScopeId(model), { model, catalogIndex }]));
  const entries: EnabledModelCatalogEntry<TModel>[] = [];
  const listed = new Set<string>();
  for (const id of enabledIds) {
    if (listed.has(id)) continue;
    const indexedModel = modelsById.get(id);
    if (indexedModel === undefined) continue;
    listed.add(id);
    entries.push({ ...indexedModel, enabled: true });
  }
  available.forEach((model, catalogIndex) => {
    if (!enabledSet.has(modelScopeId(model))) entries.push({ model, enabled: false, catalogIndex });
  });
  return entries;
}
