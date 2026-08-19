// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SafeTunnelOperationResponse,
  SafeTunnelStatusResponse,
} from "../../../../shared/apiTypes";
import { safeTunnelApi, type SafeTunnelApi } from "../../api/safeTunnelClient";
import {
  createSafeTunnelEnableRequest,
  safeTunnelAdvancedValidationMessage,
  safeTunnelPresentation,
  safeTunnelRuntimeSummary,
  SettingsSafeTunnelPanel,
} from "./SettingsSafeTunnelPanel";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Safe Tunnel enable request helpers", () => {
  it("uses an empty request for the normal inferred production flow", () => {
    const fields = emptyAdvancedFields();

    expect(safeTunnelAdvancedValidationMessage(fields)).toBeUndefined();
    expect(createSafeTunnelEnableRequest(fields)).toEqual({});
  });

  it("validates and normalizes only explicit advanced overrides", () => {
    expect(safeTunnelAdvancedValidationMessage({
      ...emptyAdvancedFields(),
      controlApiUrl: "ftp://control.example.test",
    })).toBe("Advanced Control API URL must use http:// or https://.");
    expect(safeTunnelAdvancedValidationMessage({
      ...emptyAdvancedFields(),
      controlApiUrl: "http://control.example.test",
    })).toBe(
      "Advanced Control API URL must use HTTPS unless it is a literal loopback development endpoint.",
    );
    expect(safeTunnelAdvancedValidationMessage({
      ...emptyAdvancedFields(),
      controlApiUrl: "http://localhost:8787",
    })).toContain("literal loopback");
    expect(safeTunnelAdvancedValidationMessage({
      ...emptyAdvancedFields(),
      machineSlug: "Dev Box",
    })).toContain("lowercase DNS label");
    expect(safeTunnelAdvancedValidationMessage({
      ...emptyAdvancedFields(),
      localPiWebUrl: "http://127.0.0.1",
    })).toContain("explicit port");

    expect(createSafeTunnelEnableRequest({
      controlApiUrl: " http://127.0.0.1:8787 ",
      machineName: " Dev Box ",
      machineSlug: " dev-box ",
      localPiWebUrl: " http://127.0.0.1:8504 ",
      frpcPath: " /opt/frpc ",
    })).toEqual({
      advanced: {
        controlApiUrl: "http://127.0.0.1:8787",
        machineName: "Dev Box",
        machineSlug: "dev-box",
        localPiWebUrl: "http://127.0.0.1:8504",
        frpcPath: "/opt/frpc",
      },
    });
  });

  it.each([
    "http://127.0.0.1:80",
    "http://[::1]:80",
  ])("accepts an explicit default port in advanced local target %s", (localPiWebUrl) => {
    expect(safeTunnelAdvancedValidationMessage({
      ...emptyAdvancedFields(),
      localPiWebUrl,
    })).toBeUndefined();
  });

  it("rejects a relative advanced frpc path before Enable", () => {
    expect(safeTunnelAdvancedValidationMessage({
      ...emptyAdvancedFields(),
      frpcPath: "relative/frpc",
    })).toBe("Advanced frpc path must be absolute.");
  });

  it("presents enabled, stopped, disabled, and revoked states as one action", () => {
    expect(safeTunnelPresentation(safeTunnelStatus({ desiredState: "disabled", runtimeState: "stopped" }))).toMatchObject({
      action: "enable",
      label: "Disabled",
    });
    expect(safeTunnelPresentation(safeTunnelStatus({ desiredState: "enabled", runtimeState: "running" }))).toMatchObject({
      action: "disable",
      label: "Enabled",
    });
    expect(safeTunnelPresentation(safeTunnelStatus({ desiredState: "enabled", runtimeState: "unknown" }))).toMatchObject({
      action: "disable",
      label: "Stopped",
    });
    expect(safeTunnelPresentation(safeTunnelStatus({ rejected: true }))).toMatchObject({
      action: "enable",
      label: "Approval required",
    });
    expect(safeTunnelPresentation(safeTunnelStatus({
      desiredState: "disabled",
      rejected: true,
      runtimeState: "running",
    }))).toMatchObject({ action: "disable", label: "Enabled" });
    expect(safeTunnelRuntimeSummary({ state: "running" })).toBe("Running");
  });
});

describe("settings-safe-tunnel-panel", () => {
  it("renders one normal Enable Safe Tunnel action without manual fields", async () => {
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(safeTunnelStatus({
      desiredState: "disabled",
      registered: false,
      runtimeState: "stopped",
    }));

    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);

    expect(root.textContent).toContain("Safe Tunnel is off");
    expect(root.textContent).toContain("Protect the public ingress");
    expect(root.textContent).toContain("authentication and access control");
    expect(buttonByText(root, "Enable Safe Tunnel")).toBeDefined();
    expect(root.textContent).toContain("Advanced development and self-hosting overrides");
    expect(root.querySelector("details.advanced-card")?.hasAttribute("open")).toBe(false);
    expect(root.textContent).not.toContain("Start tunnel");
    expect(root.textContent).not.toContain("Start login");
  });

  it("carries approval progress through automatic supervision and public URL", async () => {
    const initial = safeTunnelStatus({
      desiredState: "disabled",
      registered: false,
      runtimeState: "stopped",
    });
    const awaitingApproval = safeTunnelOperation({ phase: "awaiting_approval" });
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(initial);
    const enableSpy = vi.spyOn(safeTunnelApi, "enable").mockResolvedValue({
      accepted: true,
      operation: awaitingApproval,
      status: { ...initial, activeOperation: awaitingApproval },
    });

    const panel = await renderPanel();
    buttonByText(requiredShadowRoot(panel), "Enable Safe Tunnel").click();
    await vi.waitFor(() => { expect(enableSpy).toHaveBeenCalledWith({}); });
    await panel.updateComplete;

    const root = requiredShadowRoot(panel);
    expect(root.textContent).toContain("Waiting for your approval");
    expect(root.textContent).toContain("Approve this PI WEB");
    expect(root.textContent).toContain("ABCD-EFGH");
    expect(root.textContent).toContain("Open approval page");
    expect(root.textContent).toContain("Disable Safe Tunnel");

    const enabled = safeTunnelOperation({
      phase: "enabled",
      status: "succeeded",
      publicUrl: "https://dev-host-a1b2c3d4.ns.tunnels.pi-web.dev",
    });
    vi.spyOn(safeTunnelApi, "operation").mockResolvedValue(enabled);
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(safeTunnelStatus({
      desiredState: "enabled",
      runtimeState: "running",
    }));
    await callPanelPromise(panel, "pollOperation", enabled.id);
    await panel.updateComplete;

    expect(root.textContent).toContain("Safe Tunnel is enabled");
    expect(root.textContent).toContain("https://dev-host-a1b2c3d4.ns.tunnels.pi-web.dev");
  });

  it("sends edited values only through the advanced override envelope", async () => {
    const initial = safeTunnelStatus({ desiredState: "disabled", runtimeState: "stopped" });
    const operation = safeTunnelOperation({ phase: "starting" });
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(initial);
    const enableSpy = vi.spyOn(safeTunnelApi, "enable").mockResolvedValue({
      accepted: true,
      operation,
      status: { ...initial, activeOperation: operation },
    });
    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);

    setInput(root, "Control API URL", "http://127.0.0.1:8787");
    setInput(root, "Machine name", "Dev Box");
    setInput(root, "Machine slug", "dev-box");
    setInput(root, "Local PI WEB URL", "http://127.0.0.1:9500");
    setInput(root, "frpc path", "/opt/frpc");
    buttonByText(root, "Enable Safe Tunnel").click();

    await vi.waitFor(() => {
      expect(enableSpy).toHaveBeenCalledWith({
        advanced: {
          controlApiUrl: "http://127.0.0.1:8787",
          machineName: "Dev Box",
          machineSlug: "dev-box",
          localPiWebUrl: "http://127.0.0.1:9500",
          frpcPath: "/opt/frpc",
        },
      });
    });
  });

  it("shows durable revocation diagnostics and offers re-approval", async () => {
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(safeTunnelStatus({
      desiredState: "enabled",
      rejected: true,
      runtimeState: "stopped",
    }));

    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);

    expect(root.textContent).toContain("Provider access needs your approval again");
    expect(root.textContent).toContain("Safe Tunnel approval is no longer valid");
    expect(root.textContent).toContain("rejected or revoked");
    expect(buttonByText(root, "Enable Safe Tunnel")).toBeDefined();
  });

  it("does not schedule progress polling after capability gating unmounts the panel", async () => {
    const status = deferred<SafeTunnelStatusResponse>();
    const statusRequest = vi.fn(() => status.promise);
    const operation = vi.fn<SafeTunnelApi["operation"]>();
    const panel = new SettingsSafeTunnelPanel();
    panel.api = {
      status: statusRequest,
      enable: vi.fn(),
      disable: vi.fn(),
      operation,
    };
    document.body.append(panel);
    await vi.waitFor(() => { expect(statusRequest).toHaveBeenCalledOnce(); });

    panel.remove();
    status.resolve(safeTunnelStatus({
      activeOperation: safeTunnelOperation({ phase: "awaiting_approval" }),
    }));
    await status.promise;
    await Promise.resolve();

    expect(Reflect.get(panel, "operationPollTimer")).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
  });

  it("polls running operations on schedule and stops after a terminal result", async () => {
    vi.useFakeTimers();
    const running = safeTunnelOperation({ phase: "starting" });
    const completed = safeTunnelOperation({
      phase: "enabled",
      status: "succeeded",
      publicUrl: "https://dev-host-a1b2c3d4.ns.tunnels.pi-web.dev",
    });
    const initial = safeTunnelStatus({
      activeOperation: running,
      desiredState: "enabled",
      runtimeState: "unknown",
    });
    const enabled = safeTunnelStatus({ desiredState: "enabled", runtimeState: "running" });
    const statusRequest = vi.fn<SafeTunnelApi["status"]>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(enabled);
    const operationRequest = vi.fn<SafeTunnelApi["operation"]>()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed);
    const panel = new SettingsSafeTunnelPanel();
    panel.api = {
      status: statusRequest,
      enable: vi.fn(),
      disable: vi.fn(),
      operation: operationRequest,
    };

    document.body.append(panel);
    await settlePanel(panel);
    expect(statusRequest).toHaveBeenCalledOnce();
    expect(Reflect.get(panel, "operationPollTimer")).not.toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000);
    await settlePanel(panel);
    expect(operationRequest).toHaveBeenCalledTimes(1);
    expect(Reflect.get(panel, "operationPollTimer")).not.toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000);
    await settlePanel(panel);
    expect(operationRequest).toHaveBeenCalledTimes(2);
    expect(statusRequest).toHaveBeenCalledTimes(2);
    expect(Reflect.get(panel, "operationPollTimer")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(operationRequest).toHaveBeenCalledTimes(2);
  });

  it("lets disable dominate an older in-flight status response", async () => {
    const initial = safeTunnelStatus({ desiredState: "enabled", runtimeState: "running" });
    const disabled = safeTunnelStatus({ desiredState: "disabled", runtimeState: "stopped" });
    const staleStatus = deferred<SafeTunnelStatusResponse>();
    const statusRequest = vi.spyOn(safeTunnelApi, "status")
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(staleStatus.promise);
    vi.spyOn(safeTunnelApi, "disable").mockResolvedValue({ status: disabled });
    const panel = await renderPanel();

    const refreshing = panelPromise(panel, "loadStatus");
    await vi.waitFor(() => { expect(statusRequest).toHaveBeenCalledTimes(2); });
    await panelPromise(panel, "disableSafeTunnel");
    staleStatus.resolve(safeTunnelStatus({
      activeOperation: safeTunnelOperation({ phase: "starting" }),
      desiredState: "enabled",
      runtimeState: "unknown",
    }));
    await refreshing;
    await panel.updateComplete;

    expect(Reflect.get(panel, "status")).toBe(disabled);
    expect(Reflect.get(panel, "operation")).toBeUndefined();
    expect(Reflect.get(panel, "loading")).toBe(false);
    expect(Reflect.get(panel, "operationPollTimer")).toBeUndefined();
    expect(requiredShadowRoot(panel).textContent).toContain("Safe Tunnel is disabled");
  });

  it("lets disable dominate an older in-flight operation response", async () => {
    const initial = safeTunnelStatus({ desiredState: "enabled", runtimeState: "running" });
    const disabled = safeTunnelStatus({ desiredState: "disabled", runtimeState: "stopped" });
    const staleOperation = deferred<SafeTunnelOperationResponse>();
    const statusRequest = vi.spyOn(safeTunnelApi, "status").mockResolvedValue(initial);
    const operationRequest = vi.spyOn(safeTunnelApi, "operation").mockReturnValue(staleOperation.promise);
    vi.spyOn(safeTunnelApi, "disable").mockResolvedValue({ status: disabled });
    const panel = await renderPanel();

    const polling = panelPromise(panel, "pollOperation", "op_1");
    await vi.waitFor(() => { expect(operationRequest).toHaveBeenCalledOnce(); });
    await panelPromise(panel, "disableSafeTunnel");
    staleOperation.resolve(safeTunnelOperation({ phase: "starting" }));
    await polling;
    await panel.updateComplete;

    expect(statusRequest).toHaveBeenCalledOnce();
    expect(Reflect.get(panel, "status")).toBe(disabled);
    expect(Reflect.get(panel, "operation")).toBeUndefined();
    expect(Reflect.get(panel, "operationPollTimer")).toBeUndefined();
    expect(requiredShadowRoot(panel).textContent).toContain("Safe Tunnel is disabled");
  });

  it("uses Disable Safe Tunnel to cancel or stop the whole flow", async () => {
    const operation = safeTunnelOperation({ phase: "awaiting_approval" });
    const enabling = safeTunnelStatus({
      activeOperation: operation,
      desiredState: "disabled",
      runtimeState: "stopped",
    });
    const disabled = safeTunnelStatus({ desiredState: "disabled", runtimeState: "stopped" });
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(enabling);
    const disableSpy = vi.spyOn(safeTunnelApi, "disable").mockResolvedValue({ status: disabled });

    const panel = await renderPanel();
    buttonByText(requiredShadowRoot(panel), "Disable Safe Tunnel").click();
    await vi.waitFor(() => { expect(disableSpy).toHaveBeenCalledOnce(); });
    await panel.updateComplete;

    expect(requiredShadowRoot(panel).textContent).toContain("Safe Tunnel is disabled");
    expect(buttonByText(requiredShadowRoot(panel), "Enable Safe Tunnel")).toBeDefined();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolvePromise };
}

function emptyAdvancedFields() {
  return {
    controlApiUrl: "",
    machineName: "",
    machineSlug: "",
    localPiWebUrl: "",
    frpcPath: "",
  };
}

interface SafeTunnelStatusOptions {
  activeOperation?: SafeTunnelOperationResponse;
  desiredState?: SafeTunnelStatusResponse["desiredState"];
  registered?: boolean;
  rejected?: boolean;
  runtimeState?: SafeTunnelStatusResponse["runtime"]["state"];
}

function safeTunnelStatus(options: SafeTunnelStatusOptions = {}): SafeTunnelStatusResponse {
  const registered = options.registered ?? true;
  const rejected = options.rejected ?? false;
  return {
    config: {
      exists: registered,
      state: rejected ? "rejected" : registered ? "registered" : "missing",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPathConfigured: false,
      ...(registered ? {
        machine: {
          controlApiBaseUrl: "https://api.tunnels.pi-web.dev",
          machineId: "machine_1",
          machineSlug: "dev-host-a1b2c3d4",
          publicUrl: "https://dev-host-a1b2c3d4.ns.tunnels.pi-web.dev",
        },
      } : {}),
    },
    desiredState: options.desiredState ?? (rejected ? "enabled" : "disabled"),
    runtime: {
      state: options.runtimeState ?? "stopped",
      ...(rejected ? {
        diagnosticCode: "credentials_rejected",
        error: "Safe Tunnel access for this PI WEB was rejected or revoked.",
      } : {}),
    },
    ...(options.activeOperation === undefined
      ? {}
      : { activeOperation: options.activeOperation }),
  };
}

function safeTunnelOperation(options: {
  phase: SafeTunnelOperationResponse["phase"];
  publicUrl?: string;
  status?: SafeTunnelOperationResponse["status"];
}): SafeTunnelOperationResponse {
  return {
    id: "op_1",
    kind: "enable",
    phase: options.phase,
    status: options.status ?? "running",
    ...(options.phase === "awaiting_approval" ? {
      userCode: "ABCD-EFGH",
      verificationUriComplete: "https://api.tunnels.pi-web.dev/device?user_code=ABCD-EFGH",
    } : {}),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
  };
}

async function renderPanel(): Promise<SettingsSafeTunnelPanel> {
  const panel = new SettingsSafeTunnelPanel();
  document.body.append(panel);
  await vi.waitFor(() => {
    expect(Reflect.get(panel, "loading")).toBe(false);
  });
  await panel.updateComplete;
  return panel;
}

function requiredShadowRoot(panel: SettingsSafeTunnelPanel): ShadowRoot {
  if (panel.shadowRoot === null) throw new Error("Safe Tunnel panel has no shadow root");
  return panel.shadowRoot;
}

function buttonByText(root: ShadowRoot, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim() === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return button;
}

function setInput(root: ShadowRoot, labelText: string, value: string): void {
  const label = [...root.querySelectorAll("label")]
    .find((candidate) => candidate.textContent.includes(labelText));
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${labelText}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

async function settlePanel(panel: SettingsSafeTunnelPanel): Promise<void> {
  await Promise.resolve();
  await panel.updateComplete;
}

async function callPanelPromise(
  panel: SettingsSafeTunnelPanel,
  methodName: string,
  ...args: readonly unknown[]
): Promise<void> {
  await panelPromise(panel, methodName, ...args);
}

function panelPromise(
  panel: SettingsSafeTunnelPanel,
  methodName: string,
  ...args: readonly unknown[]
): Promise<void> {
  const method: unknown = Reflect.get(panel, methodName);
  if (typeof method !== "function") throw new Error(`Missing panel method: ${methodName}`);
  const result: unknown = Reflect.apply(method, panel, args);
  if (!(result instanceof Promise)) throw new Error(`Panel method is not async: ${methodName}`);
  return result;
}
