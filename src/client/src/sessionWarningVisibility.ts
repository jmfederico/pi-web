import type { SessionWarning } from "./api";

export interface SessionWarningVisibilityState {
  sessionId: string | undefined;
  warningSetSignature: string;
  warningCount: number;
  collapsed: boolean;
}

export function initialSessionWarningVisibilityState(): SessionWarningVisibilityState {
  return {
    sessionId: undefined,
    warningSetSignature: sessionWarningSetSignature(undefined),
    warningCount: 0,
    collapsed: false,
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

/** Preserve collapse only while both the selected session and warning set are unchanged. */
export function reconcileSessionWarningVisibility(
  current: SessionWarningVisibilityState,
  sessionId: string | undefined,
  warnings: readonly SessionWarning[] | undefined,
): SessionWarningVisibilityState {
  const warningSetSignature = sessionWarningSetSignature(warnings);
  if (current.sessionId === sessionId && current.warningSetSignature === warningSetSignature) return current;
  return {
    sessionId,
    warningSetSignature,
    warningCount: warnings?.length ?? 0,
    collapsed: false,
  };
}

export function collapseSessionWarnings(current: SessionWarningVisibilityState): SessionWarningVisibilityState {
  if (current.collapsed || current.warningCount === 0) return current;
  return { ...current, collapsed: true };
}

export function restoreSessionWarnings(current: SessionWarningVisibilityState): SessionWarningVisibilityState {
  if (!current.collapsed) return current;
  return { ...current, collapsed: false };
}
