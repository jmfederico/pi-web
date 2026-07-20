import { describe, expect, it } from "vitest";
import type { SessionWarning } from "./api";
import {
  collapseSessionWarnings,
  initialSessionWarningVisibilityState,
  reconcileSessionWarningVisibility,
  restoreSessionWarnings,
  sessionWarningSetSignature,
} from "./sessionWarningVisibility";

const subscriptionWarning: SessionWarning = { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } };
const skillWarning: SessionWarning = { severity: "error", message: "skill failed to load", source: "skill", path: "/skills/a.md" };
const warnings: SessionWarning[] = [subscriptionWarning, skillWarning];

describe("sessionWarningSetSignature", () => {
  it("identifies an equivalent warning set across object replacement and ordering", () => {
    const replacement = [
      { ...skillWarning },
      { ...subscriptionWarning, dismiss: { id: "anthropicExtraUsage" } },
    ] satisfies SessionWarning[];

    expect(sessionWarningSetSignature(replacement)).toBe(sessionWarningSetSignature(warnings));
  });

  it("changes when warning presentation or dismissal identity changes", () => {
    const original = sessionWarningSetSignature(warnings);
    const changes: SessionWarning[][] = [
      [{ ...subscriptionWarning, severity: "error" }, skillWarning],
      [{ ...subscriptionWarning, message: "subscription auth changed" }, skillWarning],
      [{ ...subscriptionWarning, source: "runtime" }, skillWarning],
      [subscriptionWarning, { ...skillWarning, path: "/skills/b.md" }],
      [{ ...subscriptionWarning, dismiss: { id: "different" } }, skillWarning],
      [...warnings, { severity: "info", message: "heads up" }],
    ];

    for (const changed of changes) expect(sessionWarningSetSignature(changed)).not.toBe(original);
  });
});

describe("session warning visibility transitions", () => {
  it("keeps an equivalent warning set collapsed across routine status replacement", () => {
    const visible = reconcileSessionWarningVisibility(initialSessionWarningVisibilityState(), "session-1", warnings);
    const collapsed = collapseSessionWarnings(visible);
    const replacement = warnings.map((warning) => ({ ...warning }));

    expect(reconcileSessionWarningVisibility(collapsed, "session-1", replacement)).toBe(collapsed);
  });

  it("retains collapse while status is unavailable but reopens after a known warning change", () => {
    const visible = reconcileSessionWarningVisibility(initialSessionWarningVisibilityState(), "session-1", warnings);
    const collapsed = collapseSessionWarnings(visible);
    const unavailable = reconcileSessionWarningVisibility(collapsed, "session-1", undefined);
    const refreshed = reconcileSessionWarningVisibility(unavailable, "session-1", warnings);
    const changed = reconcileSessionWarningVisibility(collapsed, "session-1", [{ ...subscriptionWarning, message: "changed" }, skillWarning]);
    const cleared = reconcileSessionWarningVisibility(collapsed, "session-1", []);
    const returned = reconcileSessionWarningVisibility(cleared, "session-1", warnings);

    expect(unavailable.collapsed).toBe(false);
    expect(refreshed.collapsed).toBe(true);
    expect(changed.collapsed).toBe(false);
    expect(cleared.collapsed).toBe(false);
    expect(returned.collapsed).toBe(false);
  });

  it("remembers collapse per session while navigating between unchanged warning sets", () => {
    const firstVisible = reconcileSessionWarningVisibility(initialSessionWarningVisibilityState(), "session-1", warnings);
    const firstCollapsed = collapseSessionWarnings(firstVisible);
    const secondVisible = reconcileSessionWarningVisibility(firstCollapsed, "session-2", warnings);
    const secondCollapsed = collapseSessionWarnings(secondVisible);
    const returnedToFirst = reconcileSessionWarningVisibility(secondCollapsed, "session-1", warnings.map((warning) => ({ ...warning })));

    expect(secondVisible.collapsed).toBe(false);
    expect(returnedToFirst.collapsed).toBe(true);
    expect(reconcileSessionWarningVisibility(returnedToFirst, "session-2", warnings).collapsed).toBe(true);
  });

  it("keeps an explicitly restored warning set visible after navigating away and back", () => {
    const visible = reconcileSessionWarningVisibility(initialSessionWarningVisibilityState(), "session-1", warnings);
    const restored = restoreSessionWarnings(collapseSessionWarnings(visible));
    const away = reconcileSessionWarningVisibility(restored, "session-2", warnings);

    expect(reconcileSessionWarningVisibility(away, "session-1", warnings).collapsed).toBe(false);
  });

  it("only collapses a selected, non-empty warning set and restores it explicitly", () => {
    const empty = initialSessionWarningVisibilityState();
    const selectedEmpty = reconcileSessionWarningVisibility(empty, "session-1", []);
    const visible = reconcileSessionWarningVisibility(empty, "session-1", warnings);
    const collapsed = collapseSessionWarnings(visible);
    const restored = restoreSessionWarnings(collapsed);

    expect(collapseSessionWarnings(empty)).toBe(empty);
    expect(collapseSessionWarnings(selectedEmpty)).toBe(selectedEmpty);
    expect(collapsed.collapsed).toBe(true);
    expect(restored.collapsed).toBe(false);
    expect(restored.collapsedWarningSets.size).toBe(0);
  });
});
