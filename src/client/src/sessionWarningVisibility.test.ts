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

  it("reopens for changed warnings and when the same warnings return after clearing", () => {
    const visible = reconcileSessionWarningVisibility(initialSessionWarningVisibilityState(), "session-1", warnings);
    const collapsed = collapseSessionWarnings(visible);
    const changed = reconcileSessionWarningVisibility(collapsed, "session-1", [{ ...subscriptionWarning, message: "changed" }, skillWarning]);
    const cleared = reconcileSessionWarningVisibility(collapsed, "session-1", []);
    const returned = reconcileSessionWarningVisibility(cleared, "session-1", warnings);

    expect(changed.collapsed).toBe(false);
    expect(cleared.collapsed).toBe(false);
    expect(returned.collapsed).toBe(false);
  });

  it("reopens when session selection changes even if the warning set is equal", () => {
    const visible = reconcileSessionWarningVisibility(initialSessionWarningVisibilityState(), "session-1", warnings);
    const collapsed = collapseSessionWarnings(visible);

    expect(reconcileSessionWarningVisibility(collapsed, "session-2", warnings).collapsed).toBe(false);
  });

  it("only collapses a non-empty warning set and restores it explicitly", () => {
    const empty = initialSessionWarningVisibilityState();
    const visible = reconcileSessionWarningVisibility(empty, "session-1", warnings);
    const collapsed = collapseSessionWarnings(visible);

    expect(collapseSessionWarnings(empty)).toBe(empty);
    expect(collapsed.collapsed).toBe(true);
    expect(restoreSessionWarnings(collapsed)).toEqual({ ...collapsed, collapsed: false });
  });
});
