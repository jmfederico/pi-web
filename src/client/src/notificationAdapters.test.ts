import { afterEach, expect, it, vi } from "vitest";
import { localization } from "./localization/browser";
import { sessionNotificationGroup } from "./notificationAdapters";
import type { SelectedSessionNotificationView } from "./sessionNotifications";

const view: SelectedSessionNotificationView = {
  machineId: "machine", sessionId: "session", cwd: "/repo", daemonInstanceId: "daemon",
  notifications: [
    { id: "host", severity: "warning", message: "Compaction cancelled.", presentation: { kind: "compactionCancelled" }, receivedAt: "2026-08-01T00:00:00Z", truncated: false, order: 2 },
    { id: "extension", severity: "info", message: "Compaction cancelled.", receivedAt: "2026-08-01T00:00:00Z", truncated: true, order: 1 },
  ],
  retainedCount: 2, discardedCount: 3, pendingDismissedIds: new Set(["host"]), dismissAllPending: false,
  dismissThrough: { order: 2, overflowWatermark: 3 }, announcements: [],
};

afterEach(async () => { await localization.setPreferences({ language: "en", formatLocale: "en" }); });

it("localizes host provenance without rewriting raw extension text or changing occurrence identity", async () => {
  const actions = { dismiss: vi.fn(), clear: vi.fn(), scopeLabel: "Session context" };
  const english = sessionNotificationGroup(view, actions);
  await localization.setPreferences({ language: "en-XA", formatLocale: "en" });
  const translated = sessionNotificationGroup(view, actions);
  expect(translated.items[0]?.message).not.toBe(english.items[0]?.message);
  expect(translated.items[1]?.message).toBe(view.notifications[1]?.message);
  expect(translated.items.map((item) => item.id)).toEqual(english.items.map((item) => item.id));
  expect(translated.items[0]?.pending).toBe(true);
  expect(translated.items[1]?.truncated).toBe(true);
  expect(translated.discardedCount).toBe(3);
  await translated.items[1]?.dismiss?.(); await translated.clear?.();
  expect(actions.dismiss).toHaveBeenCalledWith("extension");
  expect(actions.clear).toHaveBeenCalledOnce();
  for (const owner of [{ machineId: "other" }, { sessionId: "other" }, { cwd: "/other" }, { daemonInstanceId: "other" }]) {
    expect(sessionNotificationGroup({ ...view, ...owner }, actions).items[0]?.id).not.toBe(translated.items[0]?.id);
  }
});
