// @vitest-environment happy-dom

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebComponentStatus, PiWebStatusResponse, PluginRuntimeState, TerminalCommandRun, TerminalCommandRunHandle, WorkspacePanelContext, WorkspacePanelTerminal } from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin.js";

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

function commandRunHandle(input: { title: string; command: string }): TerminalCommandRunHandle {
  const run: TerminalCommandRun = {
    id: "run-1",
    origin: "updates",
    projectId: "project-1",
    workspaceId: "workspace-1",
    terminalId: "terminal-1",
    title: input.title,
    command: input.command,
    status: "running",
    createdAt: "2026-06-14T00:00:00.000Z",
    metadata: {},
  };
  return { run, completed: Promise.resolve({ ...run, status: "succeeded" }) };
}

function panelContext(state: PluginRuntimeState, terminal?: WorkspacePanelTerminal): WorkspacePanelContext {
  const noop = () => undefined;
  return {
    machine: { id: "local", name: "local", kind: "local" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    state,
    files: {
      readFile: () => Promise.reject(new Error("not implemented")),
      listFiles: () => Promise.reject(new Error("not implemented")),
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    host: { requestRender: noop },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: terminal ?? { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
}

function renderPanel(value: PiWebStatusResponse, terminal?: WorkspacePanelTerminal): HTMLElement {
  const contributions = plugin.activate({ apiVersion: 2, pluginId: "updates", runtimePluginId: "updates", html, svg }).contributions;
  const panel = contributions.workspacePanels?.[0];
  if (panel === undefined) throw new Error("Expected Updates workspace panel");
  const container = document.createElement("div");
  document.body.append(container);
  render(panel.render(panelContext({ piWebStatus: value }, terminal)), container);
  return container;
}

function sectionOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".viewer.updates-status > section")].map((section) => {
    if (section.classList.contains("updates-recommended")) return "recommended";
    if (section.classList.contains("updates-meta")) return "meta";
    const heading = section.querySelector(":scope > strong")?.textContent.trim();
    return heading === undefined || heading === "" ? "notices" : heading;
  });
}

function commandTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".updates-command code")].map((code) => code.textContent);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Updates plugin panel layout", () => {
  it("folds the update notice into one recommended action above the services and optional commands", () => {
    const update = "npm install -g @jmfederico/pi-web --allow-scripts=node-pty && pi-web restart";
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
        command: update,
      }],
    }));

    const recommended = container.querySelector(".updates-recommended");
    expect(recommended).not.toBeNull();
    expect(recommended?.textContent).toContain("PI WEB update available");
    // The notice keeps the user informed but offers no competing action of its own.
    expect(recommended?.querySelector(".updates-message button")).toBeNull();
    expect(recommended?.querySelector(".updates-message code")).toBeNull();
    expect([...container.querySelectorAll(".updates-message")].every((notice) => notice.closest(".updates-recommended") !== null)).toBe(true);
    // The update command appears exactly once in the whole panel.
    expect(commandTexts(container).filter((text) => text === update)).toHaveLength(1);
    expect(sectionOrder(container)).toEqual(["recommended", "Installed services", "Additional commands (optional)", "meta"]);
  });

  it("keeps notices action-free and defers their commands to the suggested list when nothing is recommended", () => {
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
        command: restartWeb,
      }],
    }));

    expect(container.querySelector(".updates-recommended")).toBeNull();
    const notice = container.querySelector(".updates-message");
    expect(notice?.textContent).toContain("Web/UI service restart needed");
    expect(notice?.querySelector("button")).toBeNull();
    expect(notice?.querySelector("code")).toBeNull();
    // The notice's command still shows up exactly once, in the suggested list.
    expect(commandTexts(container).filter((text) => text === restartWeb)).toHaveLength(1);
    expect(sectionOrder(container)).toEqual(["notices", "Installed services", "Suggested commands", "meta"]);
  });

  it("shows the quiet state without a recommended action when everything is current", () => {
    const container = renderPanel(status({ commands: { restart: "pi-web restart" } }));

    expect(container.querySelector(".updates-recommended")).toBeNull();
    expect(container.textContent).toContain("No PI WEB update or restart messages.");
    expect(sectionOrder(container)).toEqual(["notices", "Installed services", "Suggested commands", "meta"]);
  });

  it("runs the recommended command in a terminal from the recommended action", () => {
    const update = "pi-web-docker update";
    const runCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>((input) => Promise.resolve(commandRunHandle(input)));
    const container = renderPanel(status({
      release: { packageName: "@jmfederico/pi-web", updateAvailable: true, latestVersion: "1.202605.9" },
      commands: { update, restart: "pi-web-docker restart" },
      messages: [{
        id: "update-available",
        severity: "info",
        title: "PI WEB update available",
        body: "PI WEB 1.202605.9 is available. Run the update command to update PI WEB and restart its services.",
        command: update,
      }],
    }), { open: () => undefined, runCommand });

    const runButton = [...container.querySelectorAll<HTMLButtonElement>(".updates-recommended button")].find((button) => button.textContent === "Run");
    if (runButton === undefined) throw new Error("Expected a Run button in the recommended section");
    runButton.click();

    expect(runCommand).toHaveBeenCalledWith({
      title: "Update & restart everything",
      command: update,
      open: true,
      metadata: { "pi.plugin": "updates" },
    });
  });
});
