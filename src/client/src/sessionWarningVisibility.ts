import type { SessionWarning } from "./api";

export interface SessionWarningVisibilityState {
  selectedSessionKey: string | undefined;
  warningSetSignature: string;
  warningCount: number;
  collapsed: boolean;
  /** Warning-set signatures the user collapsed, keyed by machine/session identity. */
  collapsedWarningSets: ReadonlyMap<string, string>;
}

export function initialSessionWarningVisibilityState(): SessionWarningVisibilityState {
  return {
    selectedSessionKey: undefined,
    warningSetSignature: sessionWarningSetSignature(undefined),
    warningCount: 0,
    collapsed: false,
    collapsedWarningSets: new Map(),
  };
}

/** Stable, order-independent identity for the complete live warning set. */
export function sessionWarningSetSignature(warnings: readonly SessionWarning[] | undefined): string {
  const warningIdentities = (warnings ?? [])
    .map((warning) => JSON.stringify([
      warning.severity,
      warning.message,
      warning.source,
      warning.path,
      warning.dismiss?.id,
    ]))
    .sort();
  return JSON.stringify(warningIdentities);
}

/** Preserve collapse per session while reopening whenever that session's warning set changes. */
export function reconcileSessionWarningVisibility(
  current: SessionWarningVisibilityState,
  sessionKey: string | undefined,
  warnings: readonly SessionWarning[] | undefined,
): SessionWarningVisibilityState {
  const warningSetSignature = sessionWarningSetSignature(warnings);
  const warningCount = warnings?.length ?? 0;
  const warningSetKnown = warnings !== undefined;
  const collapsedWarningSet = sessionKey === undefined ? undefined : current.collapsedWarningSets.get(sessionKey);
  let collapsedWarningSets = current.collapsedWarningSets;
  if (warningSetKnown && sessionKey !== undefined && collapsedWarningSet !== undefined && collapsedWarningSet !== warningSetSignature) {
    const nextCollapsedWarningSets = new Map(current.collapsedWarningSets);
    nextCollapsedWarningSets.delete(sessionKey);
    collapsedWarningSets = nextCollapsedWarningSets;
  }
  const collapsed = warningSetKnown && warningCount > 0 && collapsedWarningSet === warningSetSignature;
  if (
    current.selectedSessionKey === sessionKey
    && current.warningSetSignature === warningSetSignature
    && current.warningCount === warningCount
    && current.collapsed === collapsed
    && current.collapsedWarningSets === collapsedWarningSets
  ) return current;
  return {
    selectedSessionKey: sessionKey,
    warningSetSignature,
    warningCount,
    collapsed,
    collapsedWarningSets,
  };
}

export function collapseSessionWarnings(current: SessionWarningVisibilityState): SessionWarningVisibilityState {
  if (current.collapsed || current.warningCount === 0 || current.selectedSessionKey === undefined) return current;
  const collapsedWarningSets = new Map(current.collapsedWarningSets);
  collapsedWarningSets.set(current.selectedSessionKey, current.warningSetSignature);
  return { ...current, collapsed: true, collapsedWarningSets };
}

export function restoreSessionWarnings(current: SessionWarningVisibilityState): SessionWarningVisibilityState {
  if (!current.collapsed) return current;
  const collapsedWarningSets = new Map(current.collapsedWarningSets);
  if (current.selectedSessionKey !== undefined) collapsedWarningSets.delete(current.selectedSessionKey);
  return { ...current, collapsed: false, collapsedWarningSets };
}
