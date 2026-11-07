// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, expect, it, vi } from "vitest";
import type { PiWebStatusResponse } from "../api";
import { piWebApi } from "../api";
import { RestartDialog } from "./RestartDialog";
import { dialogSurface, pressKey, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

const commands = { restartWeb: "restart-web", restartSessiond: "restart-daemon", restart: "restart-both" };

async function mount(input: PiWebStatusResponse["commands"] = commands) {
  const dialog = new RestartDialog();
  dialog.loadCommands = vi.fn().mockResolvedValue(input);
  const run = vi.fn<(command: string, title: string) => Promise<void>>().mockResolvedValue(undefined);
  dialog.onRun = run;
  dialog.activity = "active";
  document.body.append(dialog);
  dialog.show();
  await settleRenderedDialog(dialog);
  return { dialog, run };
}

function input(dialog: RestartDialog, target: string): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>(`input[value="${target}"]`), target);
}
function button(dialog: RestartDialog, id: string): HTMLButtonElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>(`#${id}`), id);
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it.each([ ["web", commands.restartWeb], ["sessiond", commands.restartSessiond], ["both", commands.restart] ])("hands the exact %s command to the terminal only after confirmation", async (target, command) => {
  const { dialog, run } = await mount();
  expect(input(dialog, "web").checked).toBe(true);
  input(dialog, target).click();
  await dialog.updateComplete;
  expect(run).not.toHaveBeenCalled();
  button(dialog, "restart-confirm").click();
  button(dialog, "restart-confirm").click();
  await settleRenderedDialog(dialog);
  expect(run).toHaveBeenCalledExactlyOnceWith(command, expect.any(String));
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
});

it("does not broaden a missing per-service command to both services", async () => {
  const { dialog, run } = await mount({ restart: commands.restart });
  expect(input(dialog, "web").disabled).toBe(true);
  expect(input(dialog, "sessiond").disabled).toBe(true);
  expect(button(dialog, "restart-confirm").disabled).toBe(true);
  expect(run).not.toHaveBeenCalled();
  input(dialog, "both").click();
  await dialog.updateComplete;
  expect(button(dialog, "restart-confirm").disabled).toBe(false);
});

it.each(["active", "idle", "unknown"] as const)("shows a simple activity hint for %s only when the daemon is selected", async (activity) => {
  const { dialog } = await mount();
  dialog.activity = activity;
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("#restart-activity")).toBeNull();
  input(dialog, "sessiond").click();
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("#restart-activity") !== null).toBe(activity !== "idle");
});

it("cancels through the shared modal without launching a command", async () => {
  const { dialog, run } = await mount();
  pressKey(dialogSurface(dialog), "Escape");
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it("shows terminal-launch errors without tracking or retrying the restart", async () => {
  const { dialog, run } = await mount();
  run.mockRejectedValue(new Error("Terminal unavailable"));
  button(dialog, "restart-confirm").click();
  await settleRenderedDialog(dialog);
  expect(dialog.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Terminal unavailable");
  expect(run).toHaveBeenCalledOnce();
  expect(dialog.shadowRoot?.querySelector("modal-surface")).not.toBeNull();
});

it("loads only gateway commands on demand and ignores results after cancellation", async () => {
  let finish!: (status: PiWebStatusResponse) => void;
  const load = vi.spyOn(piWebApi, "piWebStatus").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const dialog = new RestartDialog();
  dialog.onRun = vi.fn();
  document.body.append(dialog);
  await dialog.updateComplete;
  expect(load).not.toHaveBeenCalled();
  dialog.show();
  await settleRenderedDialog(dialog);
  expect(load).toHaveBeenCalledExactlyOnceWith("local");
  button(dialog, "restart-close").click();
  finish({ packageName: "pi-web", generatedAt: "now", components: { web: { component: "web", label: "Web", available: true, stale: false }, sessiond: { component: "sessiond", label: "Daemon", available: true, stale: false } }, release: { packageName: "pi-web", updateAvailable: false }, commands, messages: [] });
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
});
