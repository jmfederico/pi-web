// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { Machine } from "../api";
import { createCoreActions } from "../plugins/core/actions";
import type { MaintenanceTerminal, PluginRuntimeContext } from "../plugins/types";
import type { RequiredTerminalBrowserComposition } from "../plugins/requiredTerminalFacade";
import { PluginRegistry } from "../plugins/registry";
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";
import { RestartDialog } from "./RestartDialog";

const apps: PiWebApp[] = [];
const gateway: Machine = { id: "local", kind: "local", name: "Gateway", createdAt: "now", updatedAt: "now" };
const remote: Machine = { ...gateway, id: "remote", kind: "remote" };

function isRuntimeContext(value: unknown): value is PluginRuntimeContext {
  return typeof value === "object" && value !== null && "state" in value && "piWebUnstable" in value;
}

function setup(machine = gateway) {
  const app = new PiWebApp();
  apps.push(app);
  Reflect.set(app, "state", { ...initialAppState(), selectedMachine: machine, machines: [gateway, remote] });
  const root = app.attachShadow({ mode: "open" });
  Reflect.set(app, "renderRoot", root);
  const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>((input) => Promise.resolve({
    run: { id: "run", origin: "core", scope: "maintenance", terminalId: "terminal", title: input.title, command: input.command, status: "running", createdAt: "now", metadata: {} },
    completed: new Promise(() => undefined),
  }));
  const createMaintenanceTerminal = vi.fn(() => ({ open: () => undefined, runCommand }));
  const composition: RequiredTerminalBrowserComposition = {
    binding: { registrationPluginId: "pi-web.terminal", sourcePluginId: "pi-web.terminal", backendRevision: "local-revision", pairedRequestVersion: 1, pairedChannelVersion: 1 },
    facade: { version: 1, createMaintenanceTerminal, createWorkspaceTerminal: () => { throw new Error("Unexpected workspace terminal"); }, listCommandRuns: () => Promise.resolve([]), parseCommandRun: () => { throw new Error("Unexpected parsing"); } },
  };
  const compositions: unknown = Reflect.get(app, "requiredTerminalByMachine");
  if (!(compositions instanceof Map)) throw new Error("Missing terminal registry");
  compositions.set("local", composition);
  // Only extract the shell callback: mounting the entire app starts unrelated
  // sockets/editors. Dialog interactions are covered by mounted component tests.
  const run = templateValueAfterMarker(app.render(), ".onRun=");
  if (typeof run !== "function") throw new Error("Missing restart command callback");
  return { app, root, run: (): Promise<void> => {
    const result: unknown = Reflect.apply(run, undefined, ["restart-web", "Web"]);
    if (!(result instanceof Promise)) throw new Error("Expected asynchronous terminal handoff");
    return result.then(() => undefined);
  }, runCommand, createMaintenanceTerminal };
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.disconnectedCallback();
    const registry: unknown = Reflect.get(app, "plugins");
    if (registry instanceof PluginRegistry) await registry.dispose();
  }
  vi.restoreAllMocks();
});

it("opens confirmation from the core action, then hands off to the existing maintenance terminal without awaiting command completion", async () => {
  const { app, root, run, runCommand, createMaintenanceTerminal } = setup();
  const dialog = new RestartDialog();
  root.append(dialog);
  const show = vi.spyOn(dialog, "show").mockImplementation(() => undefined);
  const factory: unknown = Reflect.get(app, "createPluginRuntimeContext");
  if (typeof factory !== "function") throw new Error("Missing runtime context factory");
  const context: unknown = Reflect.apply(factory, app, []);
  if (!isRuntimeContext(context)) throw new Error("Invalid runtime context");
  const action = createCoreActions().find((item) => item.id === "app.restart");
  if (action === undefined) throw new Error("Missing restart action");
  await action.run(context);
  expect(show).toHaveBeenCalledOnce();
  expect(runCommand).not.toHaveBeenCalled();
  await run();
  expect(createMaintenanceTerminal).toHaveBeenCalledWith(expect.objectContaining({ origin: "core", machineId: "local" }));
  expect(runCommand).toHaveBeenCalledExactlyOnceWith({ command: "restart-web", title: "Web", open: true });
});

it.each([true, false])("selects the gateway before terminal execution and refuses a cancelled navigation (selected: %s)", async (selected) => {
  const { app, run, runCommand } = setup(remote);
  // Fake only the navigation boundary; the maintenance terminal's selection
  // guard remains real, and no remote network/runtime is started by this test.
  const navigate = vi.fn((machine: Machine) => {
    if (selected) Reflect.set(app, "state", { ...initialAppState(), selectedMachine: machine });
    return Promise.resolve(selected);
  });
  Reflect.set(app, "selectMachineWithMemory", navigate);
  if (selected) { await run(); expect(runCommand).toHaveBeenCalledOnce(); }
  else { await expect(run()).rejects.toThrow(); expect(runCommand).not.toHaveBeenCalled(); }
  expect(navigate).toHaveBeenCalledExactlyOnceWith(gateway);
});
