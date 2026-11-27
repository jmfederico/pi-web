/// <reference types="vite/client" />
// @vitest-environment happy-dom

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebComponentStatus, PiWebStatusResponse, PluginRuntimeState, MaintenanceTerminalCommandRun, TerminalCommandRunHandle, ApplicationPanelContextV5, MaintenanceTerminal, WorkspacePanelTerminal, MachineLifecycle, RestartServices, RestartResult } from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin.js";
import { fallbackDockerStatus } from "./updatesLogic.js";
import { LocalizationService } from "../../src/client/src/localization/service.js";
import { createPluginLocalization } from "../../src/client/src/plugins/localization.js";

function component(overrides: Partial<PiWebComponentStatus> = {}): PiWebComponentStatus {
  return {
    component: "web",
    label: "Web/UI",
    runtimeVersion: "1.202605.8",
    installedVersion: "1.202605.8",
    stale: false,
    available: true,
    ...overrides,
  };
}

function status(overrides: Partial<PiWebStatusResponse> = {}): PiWebStatusResponse {
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt: "2026-06-14T00:00:00.000Z",
    components: {
      web: component({ component: "web", label: "Web/UI" }),
      sessiond: component({ component: "sessiond", label: "Session daemon" }),
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
    commands: {},
    messages: [],
    ...overrides,
  };
}

function commandRunHandle(input: { title: string; command: string }): TerminalCommandRunHandle<MaintenanceTerminalCommandRun> {
  const run: MaintenanceTerminalCommandRun = {
    id: "run-1",
    origin: "updates",
    scope: "maintenance",
    terminalId: "terminal-1",
    title: input.title,
    command: input.command,
    status: "running",
    createdAt: "2026-06-14T00:00:00.000Z",
    metadata: {},
  };
  return { run, completed: Promise.resolve({ ...run, status: "succeeded" }) };
}

function panelContext(state: PluginRuntimeState, terminal?: MaintenanceTerminal, machine: ApplicationPanelContextV5["machine"] = { id: "local", name: "local", kind: "local" }): ApplicationPanelContextV5 {
  const noop = () => undefined;
  return {
    navigate: () => Promise.resolve(),
    machine,
    catalog: {
      version: 1, machineId: machine.id,
      projects: { list: vi.fn(), get: vi.fn() },
      workspaces: { list: vi.fn(), get: vi.fn() },
      sessions: { list: vi.fn(), get: vi.fn() },
    },
    state,
    host: { requestRender: noop },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    ...(terminal === undefined ? {} : {
      maintenanceTerminal: terminal,
    }),
  };
}

const lifetimes: AbortController[] = [];

function mountPanel(context: ApplicationPanelContextV5, service = new LocalizationService({ preferences: { language: "en", formatLocale: "en-US", timeZone: "UTC" } })) {
  const lifetime = new AbortController();
  lifetimes.push(lifetime);
  const contributions = plugin.activate({
    localization: createPluginLocalization(service, "updates", "updates", lifetime.signal),
    apiVersion: 5,
    pluginId: "updates",
    runtimePluginId: "updates",
    html,
    svg,
    signal: lifetime.signal,
    lifetimeSignal: lifetime.signal,
  }).contributions;
  const panel = contributions.applicationPanels[0];
  if (panel === undefined) throw new Error("Expected Updates application panel");
  const renderContent = panel.render;
  const container = document.createElement("div");
  document.body.append(container);
  let currentContext = context;
  const requestRender = vi.fn(() => { queueMicrotask(() => { if (!lifetime.signal.aborted) draw(); }); });
  function draw() { render(renderContent({ ...currentContext, host: { requestRender } }), container); }
  draw();
  return {
    container, requestRender,
    show(nextContext: ApplicationPanelContextV5) { currentContext = nextContext; draw(); },
    dispose() { lifetime.abort(); },
  };
}

function renderPanel(value: PiWebStatusResponse, terminal?: MaintenanceTerminal, contextOverrides: Partial<ApplicationPanelContextV5> = {}, service?: LocalizationService): HTMLElement {
  return mountPanel({ ...panelContext({ piWebStatus: value }, terminal, contextOverrides.machine), ...contextOverrides }, service).container;
}

function deferredRestart() {
  let resolve!: (result: RestartResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RestartResult>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function restartButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent.startsWith("Restart") || button.textContent === "Starting…");
}

function commandTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".updates-command code")].map((code) => code.textContent);
}

afterEach(() => {
  lifetimes.splice(0).forEach((lifetime) => { lifetime.abort(); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Updates restart launch feedback", () => {
  const value = () => status({ commands: { restartWeb: "web", restartSessiond: "daemon", restart: "both", update: "update", status: "status" } });

  it.each(["launched", "cancelled", "rejected"] as const)("disables restart controls only until the request is %s and guards synchronous repeat events", async (outcome) => {
    const deferred = deferredRestart();
    const requestRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => deferred.promise);
    const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mounted = mountPanel({ ...panelContext({ piWebStatus: value() }, { open: () => undefined, runCommand }), lifecycle: { requestRestart } });
    const buttons = restartButtons(mounted.container);
    const web = buttons.find((button) => button.textContent === "Restart Web/UI");
    if (web === undefined) throw new Error("Missing web restart");
    web.click();
    // Both events arrive before the host's queued rerender disables native controls.
    web.click();
    buttons[0]?.click();
    expect(requestRestart).toHaveBeenCalledExactlyOnceWith({ services: "web", confirm: false });
    await Promise.resolve();
    expect(web.textContent).toBe("Starting…");
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons.filter((button) => button.textContent === "Starting…")).toEqual([web]);
    expect([...mounted.container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Copy" || button.textContent === "Run").every((button) => !button.disabled)).toBe(true);

    if (outcome === "rejected") deferred.reject(new Error("Host reported launch failure"));
    else deferred.resolve(outcome);
    await deferred.promise.catch(() => undefined);
    await Promise.resolve();
    expect(web.textContent).toBe("Restart Web/UI");
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("keeps each pending launch bound to its machine across selection changes", async () => {
    const first = deferredRestart();
    const second = deferredRestart();
    const firstRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => first.promise);
    const secondRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => second.promise);
    const firstContext = { ...panelContext({ piWebStatus: value() }, undefined, { id: "first", name: "First", kind: "remote" }), lifecycle: { requestRestart: firstRestart } };
    const secondContext = { ...panelContext({ piWebStatus: value() }, undefined, { id: "second", name: "Second", kind: "remote" }), lifecycle: { requestRestart: secondRestart } };
    const mounted = mountPanel(firstContext);
    restartButtons(mounted.container).find((button) => button.textContent === "Restart Web/UI")?.click();
    mounted.show(secondContext);
    expect(restartButtons(mounted.container).every((button) => !button.disabled)).toBe(true);
    restartButtons(mounted.container).find((button) => button.textContent === "Restart session daemon")?.click();
    mounted.show(firstContext);
    expect(restartButtons(mounted.container).every((button) => button.disabled)).toBe(true);
    first.resolve("launched");
    await first.promise;
    await Promise.resolve();
    expect(restartButtons(mounted.container).every((button) => !button.disabled)).toBe(true);
    mounted.show(secondContext);
    expect(restartButtons(mounted.container).every((button) => button.disabled)).toBe(true);
    second.resolve("launched");
    await second.promise;
    await Promise.resolve();
    expect(restartButtons(mounted.container).every((button) => !button.disabled)).toBe(true);
    expect(firstRestart).toHaveBeenCalledExactlyOnceWith({ services: "web", confirm: false });
    expect(secondRestart).toHaveBeenCalledExactlyOnceWith({ services: "sessiond", confirm: false });
  });

  it("does not rerender or accept retained controls after plugin disposal", async () => {
    const deferred = deferredRestart();
    const requestRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => deferred.promise);
    const mounted = mountPanel({ ...panelContext({ piWebStatus: value() }), lifecycle: { requestRestart } });
    const button = restartButtons(mounted.container)[0];
    button?.click();
    mounted.dispose();
    deferred.resolve("launched");
    await deferred.promise;
    button?.click();
    expect(mounted.requestRender).toHaveBeenCalledOnce();
    expect(requestRestart).toHaveBeenCalledOnce();
  });
});

describe("Updates plugin panel behavior", () => {
  it("pseudo-localizes known gateway notices and controls without translating commands or versions", async () => {
    const service = new LocalizationService({ development: true, preferences: { language: "en-XA", formatLocale: "de-DE", timeZone: "UTC" } });
    await service.ready;
    const value = status({
      commands: { update: "pi-web update --flag" },
      release: { packageName: "@jmfederico/pi-web", updateAvailable: true, latestVersion: "9.8.7" },
      messages: [{ id: "update-available", severity: "info", title: "DO NOT RENDER SERVER TITLE", body: "DO NOT RENDER SERVER BODY" }],
    });
    const container = renderPanel(value, undefined, {}, service);
    expect(container.textContent).not.toContain("DO NOT RENDER");
    expect(container.querySelector(".updates-message-title strong")?.textContent).not.toBe("PI WEB update available");
    expect(container.querySelector(".updates-command button")?.textContent).not.toBe("Copy");
    expect(commandTexts(container)).toEqual(["pi-web update --flag"]);
    expect(container.textContent).toContain("9.8.7");
    expect(container.textContent).toContain("1.202605.8");
    expect(container.textContent).toContain(service.date(Date.parse(value.generatedAt), { dateStyle: "medium", timeStyle: "short" }));
  });

  it("describes a failed version check without declaring the daemon down or recommending a restart", () => {
    const value = status();
    value.components.sessiond = component({ component: "sessiond", available: false });
    value.commands = { restart: "pi-web restart" };
    value.messages = [{ id: "sessiond-unavailable", severity: "info", title: "old title", body: "old body" }];
    const panel = renderPanel(value);

    expect(panel.textContent).toContain("Session daemon version unknown");
    expect(panel.querySelector(".updates-recommended")).toBeNull();
    expect(panel.querySelectorAll(".updates-version-row")[1]?.textContent).toContain("version unknown");
  });

  it("preserves unknown gateway notice details for forward compatibility", () => {
    const container = renderPanel(status({ messages: [{ id: "future", severity: "error", title: "Future gateway notice", body: "Keep this operational guidance" }] }));
    expect(container.textContent).toContain("Future gateway notice");
    expect(container.textContent).toContain("Keep this operational guidance");
  });
  it("folds the update notice into one recommended action without duplicate commands", () => {
    const update = "pi-web update";
    const container = renderPanel(status({
      release: { packageName: "@jmfederico/pi-web", updateAvailable: true, latestVersion: "1.202605.9" },
      commands: {
        update,
        restart: "pi-web restart",
        restartWeb: "pi-web restart-web",
        restartSessiond: "pi-web restart-sessiond",
        status: "pi-web status",
      },
      messages: [{
        id: "update-available",
        severity: "info",
        title: "PI WEB update available",
        body: "PI WEB 1.202605.9 is available; installed version is 1.202605.8. Run the update command to update PI WEB and restart its services.",
      }],
    }));

    const recommended = container.querySelector(".updates-recommended");
    expect(recommended).not.toBeNull();
    // The notice keeps the user informed but offers no competing action of its own.
    expect(recommended?.querySelector(".updates-message button")).toBeNull();
    expect(recommended?.querySelector(".updates-message code")).toBeNull();
    expect([...container.querySelectorAll(".updates-message")].every((notice) => notice.closest(".updates-recommended") !== null)).toBe(true);
    // The update command appears exactly once in the whole panel.
    expect(commandTexts(container).filter((text) => text === update)).toHaveLength(1);
  });

  it("recommends a targeted restart without adding executable commands to notices", () => {
    const restartWeb = "systemctl --user restart pi-web-web";
    const container = renderPanel(status({
      components: {
        web: component({ stale: true, installedVersion: "1.202605.9" }),
        sessiond: component({ component: "sessiond", label: "Session daemon" }),
      },
      commands: { restartWeb, status: "systemctl --user status pi-web-web" },
      messages: [{
        id: "web-stale",
        severity: "warning",
        title: "Web/UI service restart needed",
        body: "The Web/UI service is running 1.202605.8, but 1.202605.9 is installed. Restart the service to use the installed version.",
      }],
    }));

    expect(container.querySelector(".updates-recommended code")?.textContent).toBe(restartWeb);
    const notice = container.querySelector(".updates-message");
    expect(notice).not.toBeNull();
    expect(notice?.querySelector("button")).toBeNull();
    expect(notice?.querySelector("code")).toBeNull();
    // The notice's command shows up exactly once, as the recommended action.
    expect(commandTexts(container).filter((text) => text === restartWeb)).toHaveLength(1);
  });

  it("runs the recommended Pi update in the maintenance terminal and leaves the restart to the user", async () => {
    const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>((input) => Promise.resolve(commandRunHandle(input)));
    const requestRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => Promise.resolve<RestartResult>("launched"));
    const container = renderPanel(status({
      commands: { restart: "pi-web restart", updatePi: "pi update" },
      messages: [{ id: "pi-unsupported", severity: "warning", title: "Pi update recommended", body: "Update Pi, then restart PI WEB." }],
    }), { open: () => undefined, runCommand }, { lifecycle: { requestRestart } });

    const recommended = container.querySelector(".updates-recommended");
    expect(recommended?.querySelector("code")?.textContent).toBe("pi update");
    // Restart stays available as its own action.
    expect(commandTexts(container)).toContain("pi-web restart");
    [...(recommended?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === "Run")?.click();
    await Promise.resolve();

    expect(runCommand.mock.calls.map(([input]) => input.command)).toEqual(["pi update"]);
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("shows the quiet state without a recommended action when everything is current", () => {
    const container = renderPanel(status({ commands: { restart: "pi-web restart" } }));

    expect(container.querySelector(".updates-recommended")).toBeNull();
    expect(container.querySelectorAll(".updates-message")).toHaveLength(0);
    expect(commandTexts(container)).toEqual(["pi-web restart"]);
  });

  it("copies a command unchanged without requiring a selected workspace", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const command = "PI_CODING_AGENT_DIR='/profiles/active' '/usr/bin/node' '/opt/pi-web/dist/cli.js' update";
    const container = renderPanel(status({
      release: { packageName: "@jmfederico/pi-web", updateAvailable: true },
      commands: { update: command },
    }));
    const copy = container.querySelector<HTMLButtonElement>(".updates-recommended button");
    expect(copy?.textContent).toBe("Copy");
    copy?.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(command);
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Run")).toBe(false);
  });

  it.each<RestartServices>(["web", "sessiond", "both"])("delegates a direct %s restart to the panel machine without running the displayed command", (services) => {
    const requestRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => Promise.resolve("launched"));
    const otherMachineRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => Promise.resolve("launched"));
    const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>();
    const workspaceRunCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    // Deliberately opaque text: routing must use metadata, not command parsing.
    const value = status({
      components: {
        web: component({ stale: services !== "sessiond" }),
        sessiond: component({ component: "sessiond", stale: services !== "web" }),
      },
      commands: { restart: "custom-control all", restartWeb: "custom-control browser", restartSessiond: "custom-control agents" },
    });
    const container = renderPanel(value, { open: () => undefined, runCommand }, {
      machine: { id: "remote-a", name: "Production machine", kind: "remote" },
      lifecycle: { requestRestart },
      terminal: { open: () => undefined, runCommand: workspaceRunCommand },
    });
    // Rendering another machine must not replace the first panel's captured capability.
    renderPanel(value, undefined, {
      machine: { id: "remote-b", name: "Other machine", kind: "remote" },
      lifecycle: { requestRestart: otherMachineRestart },
    });
    expect(container.textContent).toContain("Production machine");
    expect(container.textContent).toContain("without confirmation");
    const recommended = container.querySelector(".updates-recommended");
    expect(recommended?.textContent).toContain(services === "web" ? "Active sessions keep running" : "interrupts active sessions and terminals");
    const button = [...(recommended?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent.startsWith("Restart"));
    expect(button).toBeDefined();
    button?.click();

    expect(requestRestart).toHaveBeenCalledExactlyOnceWith({ services, confirm: false });
    expect(otherMachineRestart).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(workspaceRunCommand).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not fall back to terminal execution when core rejects a restart", async () => {
    const error = new Error("Targeted restart unavailable");
    const requestRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => Promise.reject(error));
    const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = renderPanel(status({ commands: { restartWeb: "displayed restart" } }), { open: () => undefined, runCommand }, { lifecycle: { requestRestart } });
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Restart Web/UI");
    expect(button).toBeDefined();
    button?.click();
    await Promise.resolve();
    expect(requestRestart).toHaveBeenCalledExactlyOnceWith({ services: "web", confirm: false });
    expect(runCommand).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Updates plugin restart request failed", error);
  });

  it("delegates Docker fallback restart suggestions even without a maintenance terminal", async () => {
    const requestRestart = vi.fn<MachineLifecycle["requestRestart"]>(() => Promise.resolve("launched"));
    const value = fallbackDockerStatus({ dockerMode: "dev" });
    if (value === undefined) throw new Error("Expected Docker guidance");
    const container = renderPanel(value, undefined, { lifecycle: { requestRestart } });
    const restarts = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent.startsWith("Restart"));
    expect(restarts).toHaveLength(3);
    for (const button of restarts) {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(requestRestart.mock.calls).toEqual([
      [{ services: "both", confirm: false }],
      [{ services: "web", confirm: false }],
      [{ services: "sessiond", confirm: false }],
    ]);
  });

  it("keeps restarts copy-only on hosts without lifecycle, while update and status use maintenance", () => {
    const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>((input) => Promise.resolve(commandRunHandle(input)));
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderPanel(status({ commands: {
      update: "wrapper update", status: "wrapper status",
      restart: "wrapper both", restartWeb: "wrapper web", restartSessiond: "wrapper sessiond",
    } }), { open: () => undefined, runCommand });
    for (const row of container.querySelectorAll(".updates-command")) {
      const command = row.querySelector("code")?.textContent ?? "";
      const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
      if (["wrapper update", "wrapper status"].includes(command)) {
        buttons.find((button) => button.textContent === "Run")?.click();
      } else {
        expect(buttons).toHaveLength(1);
        expect(row.textContent).toContain("newer PI WEB host");
        buttons[0]?.click();
        expect(writeText).toHaveBeenLastCalledWith(command);
      }
    }
    expect(runCommand.mock.calls.map(([input]) => input.command)).toEqual(["wrapper update", "wrapper status"]);
    expect(writeText).toHaveBeenCalledTimes(3);
  });

  it("does not use the selected workspace terminal for maintenance commands", () => {
    const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>((input) => Promise.resolve(commandRunHandle(input)));
    const workspaceRunCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>();
    const container = renderPanel(status({ commands: { update: "pi-web update" } }), { open: () => undefined, runCommand }, {
      workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
      terminal: { open: () => undefined, runCommand: workspaceRunCommand },
    });
    const run = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Run");
    expect(run).toBeDefined();
    run?.click();
    expect(runCommand).toHaveBeenCalledOnce();
    expect(workspaceRunCommand).not.toHaveBeenCalled();
  });

  it.each([
    "pi-web update",
    "PI_CODING_AGENT_DIR='/profiles/active' '/usr/bin/node' '/opt/pi-web/dist/cli.js' update",
  ])("runs the recommended command in the maintenance terminal without a workspace: %s", (update) => {
    const runCommand = vi.fn<MaintenanceTerminal["runCommand"]>((input) => Promise.resolve(commandRunHandle(input)));
    const container = renderPanel(status({
      release: { packageName: "@jmfederico/pi-web", updateAvailable: true, latestVersion: "1.202605.9" },
      commands: { update, restart: "pi-web-docker restart" },
      messages: [{
        id: "update-available",
        severity: "info",
        title: "PI WEB update available",
        body: "PI WEB 1.202605.9 is available. Run the update command to update PI WEB and restart its services.",
      }],
    }), { open: () => undefined, runCommand });

    const runButton = [...container.querySelectorAll<HTMLButtonElement>(".updates-recommended button")].find((button) => button.textContent === "Run");
    if (runButton === undefined) throw new Error("Expected a Run button in the recommended section");
    runButton.click();

    expect(runCommand).toHaveBeenCalledWith({
      title: "Update PI WEB",
      command: update,
      open: true,
      metadata: { "pi.plugin": "updates" },
    });
  });
});
