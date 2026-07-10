import { afterEach, describe, expect, it, vi } from "vitest";
import { safeTunnelApi, type SafeTunnelOperationResponse, type SafeTunnelStatusResponse } from "../../api";
import { createSafeTunnelLoginRequest, machineSlugFromName, safeTunnelLoginValidationMessage, safeTunnelRuntimeSummary, SettingsSafeTunnelPanel } from "./SettingsSafeTunnelPanel";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Safe Tunnel login form helpers", () => {
  it("validates the login fields before calling the bridge", () => {
    expect(safeTunnelLoginValidationMessage({ controlApiUrl: "", machineName: "Dev Box", machineSlug: "dev-box", localPiWebUrl: "", frpcPath: "" })).toBe("Control API URL is required.");
    expect(safeTunnelLoginValidationMessage({ controlApiUrl: "ftp://control.example.test", machineName: "Dev Box", machineSlug: "dev-box", localPiWebUrl: "", frpcPath: "" })).toBe("Control API URL must use http:// or https://.");
    expect(safeTunnelLoginValidationMessage({ controlApiUrl: "https://control.example.test", machineName: "Dev Box", machineSlug: "Dev Box", localPiWebUrl: "", frpcPath: "" })).toBe("Machine slug must be a lowercase DNS label (letters, numbers, hyphens; no leading or trailing hyphen).");
    expect(safeTunnelLoginValidationMessage({ controlApiUrl: "https://control.example.test", machineName: "Dev Box", machineSlug: "dev-box", localPiWebUrl: "http://127.0.0.1:8504", frpcPath: "" })).toBeUndefined();
  });

  it("normalizes login requests and machine slugs", () => {
    expect(machineSlugFromName(" Federico's Dev Box! ")).toBe("federico-s-dev-box");
    expect(createSafeTunnelLoginRequest({
      controlApiUrl: " https://control.example.test ",
      machineName: " Dev Box ",
      machineSlug: " dev-box ",
      localPiWebUrl: " http://127.0.0.1:8504 ",
      frpcPath: " ",
    })).toEqual({
      controlApiUrl: "https://control.example.test",
      machineName: "Dev Box",
      machineSlug: "dev-box",
      localPiWebUrl: "http://127.0.0.1:8504",
    });
  });

  it("formats runtime summaries for the current tunnel card", () => {
    expect(safeTunnelRuntimeSummary({ pidFilePath: "/tmp/connector.pid", state: "running", pid: 1234 })).toBe("Running (PID 1234)");
    expect(safeTunnelRuntimeSummary({ pidFilePath: "/tmp/connector.pid", state: "stopped" })).toBe("Stopped");
  });
});

describe("settings-safe-tunnel-panel operations", () => {
  it("loads status and adopts an active operation", async () => {
    const operation = safeTunnelOperation({ status: "running" });
    const status = safeTunnelStatus({ activeOperation: operation });
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(status);
    const panel = new SettingsSafeTunnelPanel();

    await callPanelPromise(panel, "loadStatus");

    expect(getPanelProperty(panel, "status")).toBe(status);
    expect(getPanelProperty(panel, "operation")).toBe(operation);
    expect(getPanelProperty(panel, "controlApiUrl")).toBe("https://control.example.test");
    expect(getPanelProperty(panel, "machineSlug")).toBe("my-pi-web-machine");
    expect(getPanelProperty(panel, "localPiWebUrl")).toBe("http://127.0.0.1:8504");
    expect(getPanelProperty(panel, "loading")).toBe(false);
  });

  it("renders a separate current tunnel card with connector-owned metadata and actions", () => {
    const panel = new SettingsSafeTunnelPanel();
    setPanelProperty(panel, "status", safeTunnelStatus({ runtimeState: "running", frpcPathConfigured: true }));

    const text = renderedTemplateText(callPanelMethod(panel, "renderCurrentTunnelCard"));

    expect(text).toContain("Current tunnel");
    expect(text).toContain("Slug");
    expect(text).toContain("dev-box");
    expect(text).toContain("Public URL");
    expect(text).toContain("https://dev-box.ns.tunnels.pi-web.dev");
    expect(text).toContain("Machine ID");
    expect(text).toContain("machine_1");
    expect(text).toContain("Config path");
    expect(text).toContain("/home/test/.config/pi-web-tunnel/config.json");
    expect(text).toContain("Local PI WEB URL");
    expect(text).toContain("http://127.0.0.1:8504");
    expect(text).toContain("Running (PID 1234)");
    expect(text).toContain("Open");
    expect(text).toContain("Copy");
  });

  it("renders the registration form as an explicit new or re-register action", () => {
    const panel = new SettingsSafeTunnelPanel();
    setPanelProperty(panel, "status", safeTunnelStatus());

    const text = renderedTemplateText(callPanelMethod(panel, "renderLoginForm"));

    expect(text).toContain("New / re-register tunnel");
    expect(text).toContain("Current tunnel remains separate");
    expect(text).toContain("Current tunnel: slug dev-box");
    expect(text).toContain("intentionally not prefilled from the current tunnel");
    expect(text).toContain("Start new/re-register login");
  });

  it("keeps user-edited registration fields when status defaults are applied", () => {
    const panel = new SettingsSafeTunnelPanel();
    setPanelProperty(panel, "controlApiUrl", "https://edited-control.example.test");
    setPanelProperty(panel, "controlApiUrlEdited", true);
    setPanelProperty(panel, "machineSlug", "edited-slug");
    setPanelProperty(panel, "machineSlugEdited", true);
    setPanelProperty(panel, "localPiWebUrl", "http://127.0.0.1:9999");
    setPanelProperty(panel, "localPiWebUrlEdited", true);

    callPanelMethod(panel, "applyStatusDefaults", safeTunnelStatus());

    expect(getPanelProperty(panel, "controlApiUrl")).toBe("https://edited-control.example.test");
    expect(getPanelProperty(panel, "machineSlug")).toBe("edited-slug");
    expect(getPanelProperty(panel, "localPiWebUrl")).toBe("http://127.0.0.1:9999");
  });

  it("starts login through the Safe Tunnel bridge", async () => {
    const operation = safeTunnelOperation({ status: "running" });
    const status = safeTunnelStatus({ activeOperation: operation });
    const loginSpy = vi.spyOn(safeTunnelApi, "login").mockResolvedValue({ operation, status });
    const panel = new SettingsSafeTunnelPanel();
    setPanelProperty(panel, "controlApiUrl", " https://control.example.test ");
    setPanelProperty(panel, "machineName", " Dev Box ");
    setPanelProperty(panel, "machineSlug", " dev-box ");
    setPanelProperty(panel, "localPiWebUrl", " http://127.0.0.1:8504 ");
    setPanelProperty(panel, "loginFrpcPath", " /opt/frpc ");

    await callPanelPromise(panel, "startLogin");

    expect(loginSpy).toHaveBeenCalledWith({
      controlApiUrl: "https://control.example.test",
      machineName: "Dev Box",
      machineSlug: "dev-box",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPath: "/opt/frpc",
    });
    expect(getPanelProperty(panel, "operation")).toBe(operation);
    expect(getPanelProperty(panel, "status")).toBe(status);
    expect(getPanelProperty(panel, "message")).toBe("Safe Tunnel login started. Approve the connector in the hosted page.");
    expect(getPanelProperty(panel, "mutating")).toBe(false);
  });

  it("treats an installable connector as usable for Safe Tunnel actions", () => {
    const panel = new SettingsSafeTunnelPanel();
    setPanelProperty(panel, "status", safeTunnelStatus({ connectorState: "installable", runtimeState: "stopped", frpcPathConfigured: true }));

    expect(callPanelMethod(panel, "loginDisabledReason", undefined)).toBeUndefined();
    expect(callPanelMethod(panel, "startDisabledReason")).toBeUndefined();

    setPanelProperty(panel, "status", safeTunnelStatus({ connectorState: "installable", runtimeState: "running", frpcPathConfigured: true }));

    expect(callPanelMethod(panel, "stopDisabledReason")).toBeUndefined();
  });

  it("starts and stops the connector through the bridge", async () => {
    const stopped = safeTunnelStatus({ runtimeState: "stopped", frpcPathConfigured: true });
    const operation = safeTunnelOperation({ connectorProcessId: 1234, kind: "start", status: "running" });
    const running = safeTunnelStatus({ activeOperation: operation, runtimeState: "running", frpcPathConfigured: true });
    const startSpy = vi.spyOn(safeTunnelApi, "start").mockResolvedValue({ accepted: true, operation, connectorProcessId: 1234, status: running });
    const stopSpy = vi.spyOn(safeTunnelApi, "stop").mockResolvedValue({ command: { exitCode: 0, stdout: "Stopped\n", stderr: "" }, status: stopped });
    const panel = new SettingsSafeTunnelPanel();
    setPanelProperty(panel, "status", stopped);

    await callPanelPromise(panel, "startConnector");

    expect(startSpy).toHaveBeenCalledWith({});
    expect(getPanelProperty(panel, "operation")).toBe(operation);
    expect(getPanelProperty(panel, "status")).toBe(running);
    expect(getPanelProperty(panel, "message")).toBe("Safe Tunnel connector start operation started (PID 1234).");

    await callPanelPromise(panel, "stopConnector");

    expect(stopSpy).toHaveBeenCalledWith();
    expect(getPanelProperty(panel, "status")).toBe(stopped);
    expect(getPanelProperty(panel, "message")).toBe("Safe Tunnel connector stopped.");
  });

  it("polls an operation and keeps the public URL visible after success", async () => {
    const operation = safeTunnelOperation({ status: "succeeded", publicUrl: "https://dev-box.ns.tunnels.pi-web.dev" });
    const status = safeTunnelStatus({ runtimeState: "stopped" });
    vi.spyOn(safeTunnelApi, "operation").mockResolvedValue(operation);
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(status);
    const panel = new SettingsSafeTunnelPanel();

    await callPanelPromise(panel, "pollOperation", "op_1");

    expect(getPanelProperty(panel, "operation")).toBe(operation);
    expect(getPanelProperty(panel, "status")).toBe(status);
    expect(getPanelProperty(panel, "message")).toBe("Safe Tunnel login completed. Public URL is ready.");
  });
});

interface SafeTunnelStatusOptions {
  activeOperation?: SafeTunnelOperationResponse;
  connectorState?: SafeTunnelStatusResponse["connector"]["state"];
  frpcPathConfigured?: boolean;
  runtimeState?: SafeTunnelStatusResponse["runtime"]["state"];
}

function safeTunnelStatus(options: SafeTunnelStatusOptions = {}): SafeTunnelStatusResponse {
  const connectorState = options.connectorState ?? "available";
  return {
    connector: {
      command: connectorState === "installable" ? "/home/test/.local/share/pi-web/safe-tunnel-connector/node_modules/.bin/pi-web-tunnel" : "pi-web-tunnel",
      state: connectorState,
      ...(connectorState === "installable" ? { install: {
        binName: "pi-web-tunnel",
        command: "/home/test/.local/share/pi-web/safe-tunnel-connector/node_modules/.bin/pi-web-tunnel",
        enabled: true,
        installDirectory: "/home/test/.local/share/pi-web/safe-tunnel-connector",
        installerCommand: "npm",
        packageSpec: "@jmfederico/pi-web-tunnel",
      } } : {}),
    },
    config: {
      path: "/home/test/.config/pi-web-tunnel/config.json",
      exists: true,
      state: "registered",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPathConfigured: options.frpcPathConfigured ?? true,
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        machineId: "machine_1",
        machineSlug: "dev-box",
        publicUrl: "https://dev-box.ns.tunnels.pi-web.dev",
      },
    },
    runtime: {
      pidFilePath: "/home/test/.config/pi-web-tunnel/connector.pid",
      state: options.runtimeState ?? "running",
      ...(options.runtimeState === "running" || options.runtimeState === undefined ? { pid: 1234 } : {}),
    },
    ...(options.activeOperation === undefined ? {} : { activeOperation: options.activeOperation }),
  };
}

function safeTunnelOperation(options: { connectorProcessId?: number; kind?: SafeTunnelOperationResponse["kind"]; publicUrl?: string; status: SafeTunnelOperationResponse["status"] }): SafeTunnelOperationResponse {
  const kind = options.kind ?? "login";
  return {
    id: "op_1",
    kind,
    status: options.status,
    startedAt: "2026-07-03T00:00:00.000Z",
    stdout: kind === "login" ? "Open this URL to authorize the connector:\nhttps://control.example.test/device?userCode=ABCD-EFGH\nUser code: ABCD-EFGH\n" : "Starting PI WEB Safe Tunnel connector.\n",
    stderr: "",
    ...(options.connectorProcessId === undefined ? {} : { connectorProcessId: options.connectorProcessId }),
    ...(kind === "login" ? { userCode: "ABCD-EFGH", verificationUriComplete: "https://control.example.test/device?userCode=ABCD-EFGH" } : {}),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
  };
}

function renderedTemplateText(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => renderedTemplateText(item)).join("");
  if (isTemplateResultRecord(value)) {
    return value.strings.reduce((text, stringPart, index) => `${text}${stringPart}${renderedTemplateText(value.values[index])}`, "");
  }
  return "";
}

function isTemplateResultRecord(value: unknown): value is { strings: readonly string[]; values: readonly unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

async function callPanelPromise(panel: SettingsSafeTunnelPanel, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callPanelMethod(panel, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SettingsSafeTunnelPanel.${methodName} did not return a promise`);
  await result;
}

function callPanelMethod(panel: SettingsSafeTunnelPanel, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(panel, methodName);
  if (!isPanelMethod(method)) throw new Error(`SettingsSafeTunnelPanel.${methodName} is not callable`);
  return method.call(panel, ...args);
}

function isPanelMethod(value: unknown): value is (this: SettingsSafeTunnelPanel, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}

function setPanelProperty(panel: SettingsSafeTunnelPanel, property: string, value: unknown): void {
  Reflect.set(panel, property, value);
}

function getPanelProperty(panel: SettingsSafeTunnelPanel, property: string): unknown {
  return Reflect.get(panel, property);
}
