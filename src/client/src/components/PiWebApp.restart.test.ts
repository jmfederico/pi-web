// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { piWebApi, type Machine, type PiWebStatusResponse } from "../api";
import { createCoreActions } from "../plugins/core/actions";
import type { ApplicationPanelContext, MaintenanceTerminal, PluginRuntimeContext } from "../plugins/types";
import type { RequiredTerminalBrowserComposition } from "../plugins/requiredTerminalFacade";
import { PluginRegistry } from "../plugins/registry";
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";
import { RestartDialog } from "./RestartDialog";

const apps: PiWebApp[] = [];
const gateway: Machine = { id: "local", kind: "local", name: "Gateway", createdAt: "now", updatedAt: "now" };
const remote: Machine = { ...gateway, id: "remote", kind: "remote", name: "Build machine" };
const status: PiWebStatusResponse = {
  packageName: "pi-web", generatedAt: "now", messages: [],
  components: { web: { component: "web", label: "Web", available: true, stale: false }, sessiond: { component: "sessiond", label: "Daemon", available: true, stale: false } },
  release: { packageName: "pi-web", updateAvailable: false },
  commands: { restartWeb: "target-restart-web", restartSessiond: "target-restart-daemon" },
};

function isRuntimeContext(value: unknown): value is PluginRuntimeContext {
  return typeof value === "object" && value !== null && "state" in value && "piWebUnstable" in value;
}

function isPanelContext(value: unknown): value is ApplicationPanelContext {
  return typeof value === "object" && value !== null && "machine" in value && "host" in value;
}

function runtimeContext(app: PiWebApp): PluginRuntimeContext {
  const factory: unknown = Reflect.get(app, "createPluginRuntimeContext");
  if (typeof factory !== "function") throw new Error("Missing runtime context factory");
  // Invoke the real factory without mounting sockets/editors unrelated to restart.
  const context: unknown = Reflect.apply(factory, app, []);
  if (!isRuntimeContext(context)) throw new Error("Invalid runtime context");
  return context;
}

function setup(machine = remote) {
  const app = new PiWebApp();
  apps.push(app);
  Reflect.set(app, "state", { ...initialAppState(), selectedMachine: machine, machines: [gateway, remote] });
  Reflect.set(app, "gatewayPluginLoadPromise", Promise.resolve());
  const loaded: unknown = Reflect.get(app, "loadedMachinePluginIds");
  if (!(loaded instanceof Set)) throw new Error("Missing plugin load registry");
  loaded.add(remote.id);
  const root = app.attachShadow({ mode: "open" });
  Reflect.set(app, "renderRoot", root);
  const load = vi.spyOn(piWebApi, "piWebStatus").mockResolvedValue(status);
  const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>((input) => Promise.resolve({
    run: { id: "run", origin: "core", scope: "maintenance", terminalId: "terminal", title: input.title, command: input.command, status: "running", createdAt: "now", metadata: {} },
    completed: new Promise(() => undefined),
  }));
  const createMaintenanceTerminal = vi.fn(() => ({ open: () => undefined, runCommand }));
  const composition: RequiredTerminalBrowserComposition = {
    binding: { registrationPluginId: "pi-web.terminal", sourcePluginId: "pi-web.terminal", backendRevision: "revision", pairedRequestVersion: 1, pairedChannelVersion: 1 },
    facade: { version: 1, createMaintenanceTerminal, createWorkspaceTerminal: () => { throw new Error("Unexpected workspace terminal"); }, listCommandRuns: () => Promise.resolve([]), parseCommandRun: () => { throw new Error("Unexpected parsing"); } },
  };
  const compositions: unknown = Reflect.get(app, "requiredTerminalByMachine");
  if (!(compositions instanceof Map)) throw new Error("Missing terminal registry");
  compositions.set("local", composition);
  compositions.set("remote", composition);
  return { app, root, load, runCommand, createMaintenanceTerminal, compositions, composition, loaded };
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.disconnectedCallback();
    const registry: unknown = Reflect.get(app, "plugins");
    if (registry instanceof PluginRegistry) await registry.dispose();
  }
  vi.restoreAllMocks();
});

it("opens the core action on the selected remote and launches its confirmed command without awaiting restart completion", async () => {
  const { app, root, load, runCommand, createMaintenanceTerminal } = setup();
  const dialog = new RestartDialog();
  root.append(dialog);
  const show = vi.spyOn(dialog, "show").mockImplementation(async (request) => {
    expect(request.machine).toMatchObject({ id: remote.id, name: remote.name });
    expect(runCommand).not.toHaveBeenCalled();
    await request.run("web", await request.loadCommands());
    return "launched";
  });
  const action = createCoreActions().find((item) => item.id === "app.restart");
  if (action === undefined) throw new Error("Missing restart action");
  await action.run(runtimeContext(app));
  expect(show).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledExactlyOnceWith("remote");
  expect(createMaintenanceTerminal).toHaveBeenCalledWith(expect.objectContaining({ origin: "core", machineId: "remote" }));
  expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: "target-restart-web", open: true }));
});

it("exposes the same direct capability to application panels, without opening a dialog", async () => {
  const { app, root, load, runCommand } = setup();
  const dialog = new RestartDialog();
  root.append(dialog);
  const show = vi.spyOn(dialog, "show");
  const factory: unknown = Reflect.get(app, "createApplicationPanelContext");
  if (typeof factory !== "function") throw new Error("Missing panel context factory");
  const context: unknown = Reflect.apply(factory, app, []);
  if (!isPanelContext(context)) throw new Error("Invalid panel context");
  await expect(context.lifecycle?.requestRestart({ services: "sessiond", confirm: false })).resolves.toBe("launched");
  expect(show).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledExactlyOnceWith("remote");
  expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "target-restart-daemon" }));
});

it("rejects retained machine capabilities after selection changes rather than targeting the new selection", async () => {
  const { app, load, runCommand } = setup();
  const lifecycle = runtimeContext(app).lifecycle;
  Reflect.set(app, "state", { ...initialAppState(), selectedMachine: gateway, machines: [gateway, remote] });
  await expect(lifecycle?.requestRestart({ services: "web", confirm: false })).rejects.toThrow();
  expect(load).not.toHaveBeenCalled();
  expect(runCommand).not.toHaveBeenCalled();
});

it.each([true, false])("Settings targets its explicit machine and respects cancelled navigation (selected: %s)", async (selected) => {
  const { app, load, runCommand, createMaintenanceTerminal } = setup();
  Reflect.set(app, "settingsSection", "general");
  const navigate = vi.fn((machine: Machine) => {
    if (selected) Reflect.set(app, "state", { ...initialAppState(), selectedMachine: machine, machines: [gateway, remote] });
    return Promise.resolve(selected);
  });
  Reflect.set(app, "selectMachineWithMemory", navigate);
  // Only extract shell wiring; the real Settings interactions have their own mounted tests.
  const callback = templateValueAfterMarker(app.render(), ".onRestart=");
  if (typeof callback !== "function") throw new Error("Missing settings restart callback");
  const result: unknown = Reflect.apply(callback, undefined, ["local", "web"]);
  if (!(result instanceof Promise)) throw new Error("Expected asynchronous restart request");
  if (selected) {
    await result;
    expect(createMaintenanceTerminal).toHaveBeenCalledWith(expect.objectContaining({ machineId: "local" }));
    expect(runCommand).toHaveBeenCalledOnce();
    expect(Reflect.get(app, "settingsSection")).toBeUndefined();
  } else {
    await expect(result).rejects.toThrow();
    expect(runCommand).not.toHaveBeenCalled();
    expect(Reflect.get(app, "settingsSection")).toBe("general");
  }
  expect(navigate).toHaveBeenCalledExactlyOnceWith(gateway);
  expect(load).toHaveBeenCalledExactlyOnceWith("local");
});

it.each(["ready", "unavailable", "selection-changed", "navigation-retired"] as const)("waits for the Settings target's in-flight plugin activation and fails closed (%s)", async (outcome) => {
  const { app, compositions, composition, loaded, runCommand, createMaintenanceTerminal } = setup(gateway);
  loaded.delete(remote.id);
  compositions.delete(remote.id);
  let finishActivation!: () => void;
  const activation = new Promise<void>((resolve) => { finishActivation = resolve; });
  const loads: unknown = Reflect.get(app, "machinePluginLoadPromises");
  if (!(loads instanceof Map)) throw new Error("Missing in-flight plugin registry");
  loads.set(remote.id, activation);
  const lookup = vi.spyOn(loads, "get");
  Reflect.set(app, "settingsSection", "sessiond");
  // Model route restoration completing while its plugin load is still pending.
  Reflect.set(app, "selectMachineWithMemory", (machine: Machine) => {
    Reflect.set(app, "state", { ...initialAppState(), selectedMachine: machine, machines: [gateway, remote] });
    return Promise.resolve(true);
  });
  const callback = templateValueAfterMarker(app.render(), ".onRestart=");
  if (typeof callback !== "function") throw new Error("Missing settings restart callback");
  const result: unknown = Reflect.apply(callback, undefined, [remote.id, "sessiond"]);
  if (!(result instanceof Promise)) throw new Error("Expected asynchronous restart request");
  const checked = outcome === "ready" ? expect(result).resolves.toBeUndefined() : expect(result).rejects.toThrow();
  // Wait until restart joins the pending load before completing activation.
  await vi.waitFor(() => { expect(lookup).toHaveBeenCalledWith(remote.id); });
  expect(createMaintenanceTerminal).not.toHaveBeenCalled();
  expect(runCommand).not.toHaveBeenCalled();
  if (outcome !== "unavailable") compositions.set(remote.id, composition);
  if (outcome === "selection-changed") {
    Reflect.set(app, "state", { ...initialAppState(), selectedMachine: gateway, machines: [gateway, remote] });
  }
  if (outcome === "navigation-retired") {
    const navigate: unknown = Reflect.get(app, "retireNavigationScope");
    if (typeof navigate !== "function") throw new Error("Missing navigation operation");
    Reflect.apply(navigate, app, [["tool", "view"]]);
  }
  finishActivation();
  await checked;
  if (outcome === "ready") {
    expect(createMaintenanceTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ machineId: remote.id }));
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: "target-restart-daemon" }));
  } else {
    expect(runCommand).not.toHaveBeenCalled();
    expect(Reflect.get(app, "settingsSection")).toBe("sessiond");
  }
});

it("reports missing target Terminal support and never falls back to the gateway", async () => {
  const { app, compositions, runCommand } = setup();
  compositions.delete("remote");
  await expect(runtimeContext(app).lifecycle?.requestRestart({ services: "web", confirm: false })).rejects.toThrow();
  expect(runCommand).not.toHaveBeenCalled();
  const state: unknown = Reflect.get(app, "state");
  expect(state).toMatchObject({ selectedMachine: remote });
  if (typeof state !== "object" || state === null || !("error" in state)) throw new Error("Missing app state");
  expect(state.error).toBeTruthy();
});
