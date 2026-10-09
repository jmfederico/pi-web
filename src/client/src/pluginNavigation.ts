import type { PluginNavigationPatchDestination, PluginNavigationOptions } from "../../plugin-api";
import { normalizeContributionQueryRecord, patchContributionQueryRecord, type ContributionQueryRecord } from "./namespacedQueryArgs";
import type { QualifiedContributionId } from "./plugins/ids";
import type { ParsedAppRoute } from "./route";

interface PluginNavigationPlan {
  route: ParsedAppRoute;
  contributionQuery: ContributionQueryRecord;
}

/** Resolve plugin intent without touching browser history or the loaded selection. */
export function resolvePluginNavigation(
  destination: PluginNavigationPatchDestination | null,
  options: PluginNavigationOptions | undefined,
  current: ParsedAppRoute,
  currentQuery: Readonly<ContributionQueryRecord>,
  defaultMachineId: string,
  resolveQueryScope?: (tool: string, machineId: string) => {
    contributionId: QualifiedContributionId;
    sourceContributionId?: QualifiedContributionId | undefined;
  } | undefined,
  capturedMachineId?: string,
): PluginNavigationPlan {
  validateOptions(options);
  const patch = options?.mode === "patch";
  validateDestination(destination, patch);

  const machineId = destination.machineId === undefined
    ? capturedMachineId ?? (patch ? current.machineId ?? "local" : defaultMachineId)
    : routeField(destination.machineId) ?? "local";
  const machineChanged = !patch || machineId !== (current.machineId ?? "local");
  const projectId = inheritField(destination.projectId, machineChanged ? undefined : current.projectId);
  const projectChanged = machineChanged || projectId !== current.projectId;
  const workspaceId = inheritField(destination.workspaceId, projectChanged ? undefined : current.workspaceId);
  const workspaceChanged = projectChanged || workspaceId !== current.workspaceId;
  const route: ParsedAppRoute = {
    machineId,
    projectId,
    workspaceId,
    sessionId: inheritField(destination.sessionId, workspaceChanged ? undefined : current.sessionId),
    tool: inheritField(destination.tool, machineChanged ? undefined : current.tool),
    view: inheritField(destination.view, patch ? current.view : undefined),
  };
  let contributionQuery = normalizeContributionQueryRecord(workspaceChanged ? {} : currentQuery);
  if (destination.query !== undefined) {
    if (!isRecord(destination.query)) throw new TypeError("Navigation query must be an object");
    if (route.tool === undefined || route.projectId === undefined || route.workspaceId === undefined) {
      throw new TypeError("Navigation query requires tool, projectId, and workspaceId");
    }
    try {
      // Only host-owned source/runtime identities share query state. Unavailable
      // qualified IDs remain valid namespaces while their plugin loads.
      const scope = patch ? resolveQueryScope?.(route.tool, machineId) : undefined;
      const sourceQueryIds = scope?.sourceContributionId === undefined || scope.sourceContributionId === scope.contributionId
        ? [] : [scope.sourceContributionId];
      contributionQuery = patchContributionQueryRecord(contributionQuery,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        scope?.contributionId ?? route.tool as QualifiedContributionId, sourceQueryIds, destination.query);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }
  return { route, contributionQuery };
}

function inheritField(value: string | null | undefined, inherited: string | undefined): string | undefined {
  return value === undefined ? inherited : routeField(value);
}

function routeField(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

function validateOptions(options: unknown): asserts options is PluginNavigationOptions | undefined {
  if (options === undefined) return;
  if (!isRecord(options)) throw new TypeError("Navigation options must be an object");
  if (options["mode"] !== undefined && options["mode"] !== "replace" && options["mode"] !== "patch") {
    throw new TypeError("Navigation mode must be replace or patch");
  }
  if (options["history"] !== undefined && options["history"] !== "push" && options["history"] !== "replace") {
    throw new TypeError("Navigation history must be push or replace");
  }
}

function validateDestination(destination: unknown, patch: boolean): asserts destination is PluginNavigationPatchDestination {
  if (!isRecord(destination)) throw new TypeError("Navigation destination must be an object");
  for (const key of ["machineId", "projectId", "workspaceId", "sessionId", "tool"] as const) {
    const value = destination[key];
    if (value !== undefined && typeof value !== "string" && !(patch && value === null)) {
      throw new TypeError(`Navigation ${key} must be a string${patch ? " or null" : ""}`);
    }
  }
  const view = destination["view"];
  if (view !== undefined && !(patch && view === null)
    && view !== "navigation" && view !== "chat" && view !== "workspace") {
    throw new TypeError("Navigation view must be navigation, chat, or workspace");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
