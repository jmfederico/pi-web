// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { hostValidationNotices } from "./hostValidationNotices";
import { configResponse } from "./SettingsDialog.testSupport";
import { generalMessages as messages } from "./settings/settingsGeneralMessages";
import { localization } from "../localization/browser";

afterEach(async () => {
  await localization.setPreferences({ language: "en", formatLocale: "en" });
});

it("does not invent a decision before gateway configuration loads", () => {
  expect(hostValidationNotices(undefined, vi.fn())).toEqual([]);
});

it.each([undefined, "pending", "disabled"] as const)("keeps undecided installs actionable without an off-to-off restart notice (active=%s)", (active) => {
  const open = vi.fn();
  const rows = hostValidationNotices({ ...configResponse({}), ...(active === undefined ? {} : { activeHostValidation: active }) }, open);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row).toMatchObject({ id: "gateway-host-validation", severity: "warning", source: "PI WEB", message: messages.t("hostValidationDecision") });
  expect(row?.dismissId).toBeUndefined();
  row?.action?.run();
  expect(open).toHaveBeenCalledOnce();
});

it.each([
  ["enabled", "pending", true],
  ["enabled", "disabled", true],
  ["enabled", undefined, true],
  ["disabled", "enabled", true],
  ["disabled", "pending", false],
  ["disabled", "disabled", false],
  ["disabled", undefined, false],
  ["enabled", "enabled", false],
] as const)("keeps desired %s separate from active %s (warning=%s)", (desired, active, warned) => {
  const response = { ...configResponse({ hostValidation: desired }), ...(active === undefined ? {} : { activeHostValidation: active }) };
  const rows = hostValidationNotices(response, vi.fn());
  expect(rows).toHaveLength(warned ? 1 : 0);
  if (warned) expect(rows[0]?.message).toBe(messages.t("hostValidationRestart", { desired, active: active ?? "unknown" }));
});

it("localizes a combined pending and restart notice without duplicating its action", async () => {
  for (const language of ["en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "en" });
    const rows = hostValidationNotices({ ...configResponse({ hostValidation: "pending" }), activeHostValidation: "enabled" }, vi.fn());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toContain(messages.t("hostValidationDecision"));
    expect(rows[0]?.message).toContain(messages.t("hostValidationRestart", { desired: "pending", active: "enabled" }));
    expect(rows[0]?.action?.label).toBe(messages.t("hostValidationSettings"));
  }
});
