// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { PiWebConfigValues, PiWebConfigResponse } from "../api";
import { hostAccessNotices } from "./hostAccessNotices";
import { configResponse } from "./SettingsDialog.testSupport";
import { generalMessages as messages } from "./settings/settingsGeneralMessages";
import { localization } from "../localization/browser";

afterEach(async () => {
  await localization.setPreferences({ language: "en", formatLocale: "en" });
});

it("does not invent a decision before gateway configuration loads", () => {
  expect(hostAccessNotices(undefined, vi.fn(), vi.fn())).toEqual([]);
});

it.each([{}, { allowedHosts: true }, { allowedHosts: ["legacy.local"] }] satisfies PiWebConfigValues[])("keeps missing policies actionable regardless of legacy settings (%j)", (legacy) => {
  for (const exists of [false, true]) {
    const open = vi.fn();
    const rows = hostAccessNotices({ ...configResponse(legacy), exists, activeHostAccess: null }, open, vi.fn());
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ id: "gateway-host-access", severity: "warning", source: "PI WEB", message: messages.t("hostAccessDecision") });
    expect(row?.dismissId).toBeUndefined();
    row?.action?.run();
    expect(open).toHaveBeenCalledOnce();
  }
});

it("does not count legacy environment configuration as a decision, but accepts explicit environment policy", () => {
  const legacy = { ...configResponse({ allowedHosts: true }), enforcedSettings: { "/allowedHosts": "PI_WEB_ALLOWED_HOSTS" }, activeHostAccess: null };
  expect(hostAccessNotices(legacy, vi.fn(), vi.fn())[0]?.message).toBe(messages.t("hostAccessDecision"));
  const hostAccess = { mode: "restricted" as const, hosts: [] };
  expect(hostAccessNotices({ ...legacy, effectiveConfig: { hostAccess }, activeHostAccess: hostAccess, enforcedSettings: { "/hostAccess": "PI_WEB_HOST_ACCESS" } }, vi.fn(), vi.fn())).toEqual([]);
});

const restricted = { mode: "restricted" as const, hosts: ["gateway.local"] };
const any = { mode: "any" as const };
it.each<{ desired: PiWebConfigValues["hostAccess"]; active: PiWebConfigResponse["activeHostAccess"]; restart: boolean }>([
  { desired: restricted, active: null, restart: true },
  { desired: any, active: null, restart: true },
  { desired: restricted, active: undefined, restart: true },
  { desired: any, active: undefined, restart: true },
  { desired: undefined, active: undefined, restart: false },
  { desired: undefined, active: null, restart: false },
  { desired: undefined, active: any, restart: true },
  { desired: any, active: restricted, restart: true },
  { desired: restricted, active: any, restart: true },
  { desired: any, active: any, restart: false },
  { desired: restricted, active: { ...restricted, hosts: [...restricted.hosts] }, restart: false },
  { desired: restricted, active: { mode: "restricted", hosts: [] }, restart: true },
  { desired: restricted, active: { mode: "restricted", hosts: ["old.local"] }, restart: true },
])("compares the complete saved policy with its startup snapshot: %j", ({ desired, active, restart }) => {
  const response = { ...configResponse(desired === undefined ? {} : { hostAccess: desired }), ...(active === undefined ? {} : { activeHostAccess: active }) };
  const rows = hostAccessNotices(response, vi.fn(), vi.fn());
  expect(rows).toHaveLength(desired === undefined || restart ? 1 : 0);
  const restartMessage = messages.t("hostAccessRestart");
  if (restart) expect(rows[0]?.message).toContain(restartMessage);
  else expect(rows[0]?.message ?? "").not.toContain(restartMessage);
});

it("routes a saved policy restart to confirmation, while an undecided policy keeps settings priority", () => {
  const settings = vi.fn();
  const restart = vi.fn();
  const saved = hostAccessNotices({ ...configResponse({ hostAccess: any }), activeHostAccess: restricted }, settings, restart);
  saved[0]?.action?.run();
  expect(restart).toHaveBeenCalledOnce();
  expect(settings).not.toHaveBeenCalled();
  const undecided = hostAccessNotices({ ...configResponse({}), activeHostAccess: restricted }, settings, restart);
  undecided[0]?.action?.run();
  expect(settings).toHaveBeenCalledOnce();
  expect(restart).toHaveBeenCalledOnce();
});

it("localizes independent decision and restart conditions without duplicating the action", async () => {
  for (const language of ["en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "en" });
    const rows = hostAccessNotices({ ...configResponse({}), activeHostAccess: restricted }, vi.fn(), vi.fn());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toContain(messages.t("hostAccessDecision"));
    expect(rows[0]?.message).toContain(messages.t("hostAccessRestart"));
    expect(rows[0]?.action?.label).toBe(messages.t("hostAccessSettings"));
  }
});
