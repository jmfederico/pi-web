// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, expect, it, vi } from "vitest";
import type { RestartCommands, RestartConfirmation } from "../controllers/restartController";
import { RestartDialog } from "./RestartDialog";
import { dialogSurface, pressKey, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

const commands = { restartWeb: "restart-web", restartSessiond: "restart-daemon", restart: "restart-both" };

async function mount(input: RestartCommands = commands) {
  const dialog = new RestartDialog();
  const run = vi.fn<RestartConfirmation["run"]>().mockResolvedValue(undefined);
  dialog.activityForMachine = () => "active";
  document.body.append(dialog);
  const result = dialog.show({ machine: { id: "remote", name: "Build machine" }, services: "web", loadCommands: vi.fn().mockResolvedValue(input), run });
  await settleRenderedDialog(dialog);
  return { dialog, run, result };
}

function input(dialog: RestartDialog, target: string): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>(`input[value="${target}"]`), target);
}
function button(dialog: RestartDialog, id: string): HTMLButtonElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>(`#${id}`), id);
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it.each(["web", "sessiond", "both"])("hands the selected %s service and displayed commands to the coordinator only after confirmation", async (target) => {
  const { dialog, run, result } = await mount();
  expect(input(dialog, "web").checked).toBe(true);
  input(dialog, target).click();
  await dialog.updateComplete;
  expect(run).not.toHaveBeenCalled();
  button(dialog, "restart-confirm").click();
  button(dialog, "restart-confirm").click();
  await settleRenderedDialog(dialog);
  expect(run).toHaveBeenCalledExactlyOnceWith(target, commands);
  await expect(result).resolves.toBe("launched");
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
  dialog.activityForMachine = () => activity;
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("#restart-activity")).toBeNull();
  input(dialog, "sessiond").click();
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("#restart-activity") !== null).toBe(activity !== "idle");
});

it("cancels through the shared modal without launching a command", async () => {
  const { dialog, run, result } = await mount();
  pressKey(dialogSurface(dialog), "Escape");
  await expect(result).resolves.toBe("cancelled");
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it.each(["cancel", "retry"])("keeps launch errors pending until the user chooses to %s", async (action) => {
  const { dialog, run, result } = await mount();
  const settled = vi.fn();
  void result.then(settled);
  run.mockRejectedValueOnce(new Error("Terminal unavailable"));
  button(dialog, "restart-confirm").click();
  await settleRenderedDialog(dialog);
  expect(dialog.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Terminal unavailable");
  expect(run).toHaveBeenCalledOnce();
  expect(settled).not.toHaveBeenCalled();
  expect(dialog.shadowRoot?.querySelector("modal-surface")).not.toBeNull();
  button(dialog, action === "cancel" ? "restart-close" : "restart-confirm").click();
  await expect(result).resolves.toBe(action === "cancel" ? "cancelled" : "launched");
  expect(run).toHaveBeenCalledTimes(action === "cancel" ? 1 : 2);
});

it("settles replaced or removed confirmation as cancelled before launch", async () => {
  const { dialog, result } = await mount();
  const replacement = dialog.show({ machine: { id: "other", name: "Other machine" }, services: "web", loadCommands: () => Promise.resolve(commands), run: vi.fn() });
  await expect(result).resolves.toBe("cancelled");
  dialog.remove();
  await expect(replacement).resolves.toBe("cancelled");
});

it.each([true, false])("reports the in-flight launch outcome after dialog removal (accepted: %s)", async (accepted) => {
  const { dialog, run, result } = await mount();
  let finish!: () => void;
  let fail!: (error: Error) => void;
  run.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
  const settled = vi.fn();
  // Observe both outcomes immediately so the failure path cannot be unhandled.
  void result.then(settled, settled);
  button(dialog, "restart-confirm").click();
  dialog.remove();
  await dialog.updateComplete;
  expect(settled).not.toHaveBeenCalled();
  if (accepted) {
    finish();
    await expect(result).resolves.toBe("launched");
  } else {
    fail(new Error("Terminal unavailable"));
    await expect(result).rejects.toThrow("Terminal unavailable");
  }
});

it("loads supplied machine commands on demand and settles cancellation before a late response", async () => {
  let finish!: (commands: RestartCommands) => void;
  const load = vi.fn(() => new Promise<RestartCommands>((resolve) => { finish = resolve; }));
  const dialog = new RestartDialog();
  const activity = vi.fn(() => "unknown" as const);
  dialog.activityForMachine = activity;
  document.body.append(dialog);
  await dialog.updateComplete;
  expect(load).not.toHaveBeenCalled();
  const result = dialog.show({ machine: { id: "remote", name: "Build machine" }, services: "sessiond", loadCommands: load, run: vi.fn() });
  await settleRenderedDialog(dialog);
  expect(load).toHaveBeenCalledOnce();
  expect(activity).toHaveBeenCalledWith("remote");
  expect(input(dialog, "sessiond").checked).toBe(true);
  expect(dialog.shadowRoot?.textContent).toContain("Build machine");
  button(dialog, "restart-close").click();
  await expect(result).resolves.toBe("cancelled");
  finish(commands);
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
});
