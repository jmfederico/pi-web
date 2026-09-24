// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SafeTunnelOperationResponse,
  SafeTunnelStatusResponse,
} from "../../../../shared/apiTypes";
import { safeTunnelApi, type SafeTunnelApi } from "../../api/safeTunnelClient";
import {
  createSafeTunnelEnableRequest,
  safeTunnelAdvancedPrefill,
  safeTunnelAdvancedValidationMessage,
  safeTunnelPresentation,
  safeTunnelRuntimeSummary,
  SettingsSafeTunnelPanel,
} from "./SettingsSafeTunnelPanel";

const terminalAccountAccessCases = [
  ["payment-required access", "account_access_payment_required", "Payment required"],
  ["suspended access", "account_access_suspended", "Suspended"],
  ["permanently deactivated access", "account_access_deactivated", "Account deactivated"],
] as const;

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

  it("prefills the saved development service before registration", () => {
    const status = safeTunnelStatus({ registered: false });
    status.config.controlApiUrl = "http://127.0.0.1:8787";
    expect(safeTunnelAdvancedPrefill(status)).toEqual({ controlApiUrl: status.config.controlApiUrl });
    expect(safeTunnelAdvancedPrefill(safeTunnelStatus())).toEqual(emptyAdvancedFields());
  });

  it.each(["https://api.tunnels.pi-web.dev", "https://api.tunnels.pi-web.dev/"])("leaves production service %s blank", (controlApiUrl) => {
    const status = safeTunnelStatus();
    status.config.controlApiUrl = controlApiUrl;
    expect(safeTunnelAdvancedPrefill(status)).toEqual(emptyAdvancedFields());
  });

  it.each([
    "ftp://control.example.test",
    "http://control.example.test",
    "http://localhost:8787",
    "https://user:pass@example.test",
    "https://example.test?query=1",
    "https://example.test#fragment",
    "not a URL",
  ])("rejects unsafe service URL %s", (controlApiUrl) => {
    expect(safeTunnelAdvancedValidationMessage({ controlApiUrl })).toBeDefined();
  });

  it("normalizes the single service URL and omits blank input", () => {
    expect(safeTunnelAdvancedValidationMessage({ controlApiUrl: "http://127.0.0.1:8787" })).toBeUndefined();
    expect(createSafeTunnelEnableRequest({ controlApiUrl: " http://127.0.0.1:8787 " }))
      .toEqual({ controlApiUrl: "http://127.0.0.1:8787" });
    expect(createSafeTunnelEnableRequest({ controlApiUrl: "  " })).toEqual({});
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
      accountAccess: {
        status: "account_access_payment_required",
        message: "Account access is not active.",
        dashboardUrl: "https://api.tunnels.pi-web.dev/dashboard",
      },
      desiredState: "enabled",
    }))).toMatchObject({
      action: "enable",
      label: "Payment required",
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
    expect(root.textContent).toContain("Advanced development settings");
    expect(root.querySelectorAll("input")).toHaveLength(1);
    expect(root.querySelector("details.advanced-card")?.hasAttribute("open")).toBe(false);
    expect(root.textContent).not.toContain("Start tunnel");
    expect(root.textContent).not.toContain("Start login");
  });

  it("prefills and preserves the saved development service", async () => {
    const initial = safeTunnelStatus({ desiredState: "disabled", runtimeState: "stopped" });
    const machine = initial.config.machine;
    if (machine === undefined) throw new Error("Expected registered Safe Tunnel fixture");
    initial.config.localPiWebUrl = "http://127.0.0.1:9500";
    initial.config.controlApiUrl = "http://127.0.0.1:8787";
    initial.config.machine = {
      ...machine,
      controlApiBaseUrl: "http://127.0.0.1:8787",
      machineSlug: "saved-dev-box",
    };
    const operation = safeTunnelOperation({ phase: "starting" });
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(initial);
    const enableSpy = vi.spyOn(safeTunnelApi, "enable").mockResolvedValue({
      accepted: true,
      operation,
      status: { ...initial, activeOperation: operation },
    });

    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);

    expect(inputByLabel(root, "Tunnel service API URL").value).toBe("http://127.0.0.1:8787");

    buttonByText(root, "Enable Safe Tunnel").click();
    await vi.waitFor(() => {
      expect(enableSpy).toHaveBeenCalledWith({
        controlApiUrl: "http://127.0.0.1:8787",
      });
    });
  });

  it("does not overwrite an edited advanced draft on refresh", async () => {
    const initial = safeTunnelStatus();
    initial.config.controlApiUrl = "http://127.0.0.1:8787";
    const refreshed = safeTunnelStatus();
    refreshed.config.controlApiUrl = "http://127.0.0.1:8888";
    vi.spyOn(safeTunnelApi, "status")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);

    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);
    setInput(root, "Tunnel service API URL", "http://127.0.0.1:8989");

    await panelPromise(panel, "loadStatus");
    await panel.updateComplete;

    expect(inputByLabel(root, "Tunnel service API URL").value).toBe("http://127.0.0.1:8989");
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

  it("clearing a saved pre-registration service resets to production", async () => {
    const initial = safeTunnelStatus({ registered: false, desiredState: "disabled" });
    initial.config.controlApiUrl = "http://127.0.0.1:8787";
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(initial);
    const enableSpy = vi.spyOn(safeTunnelApi, "enable").mockResolvedValue({
      accepted: true,
      operation: safeTunnelOperation({ phase: "awaiting_approval" }),
      status: initial,
    });
    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);
    expect(inputByLabel(root, "Tunnel service API URL").value).toBe(initial.config.controlApiUrl);
    setInput(root, "Tunnel service API URL", "");
    buttonByText(root, "Refresh").click();
    await vi.waitFor(() => { expect(buttonByText(root, "Enable Safe Tunnel").disabled).toBe(false); });
    await panel.updateComplete;
    expect(inputByLabel(root, "Tunnel service API URL").value).toBe("");
    buttonByText(root, "Enable Safe Tunnel").click();
    await vi.waitFor(() => { expect(enableSpy).toHaveBeenCalledWith({}); });
  });

  it("sends the edited service URL as the only enable option", async () => {
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

    setInput(root, "Tunnel service API URL", "http://127.0.0.1:8787");
    buttonByText(root, "Enable Safe Tunnel").click();

    await vi.waitFor(() => {
      expect(enableSpy).toHaveBeenCalledWith({
        controlApiUrl: "http://127.0.0.1:8787",
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

  it("shows account denial and Disable while owned runtime cleanup is pending", async () => {
    const accountAccess = {
      status: "account_access_payment_required" as const,
      message: "Account access is not active. Open the hosted dashboard.",
      dashboardUrl: "https://api.tunnels.pi-web.dev/dashboard",
    };
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(safeTunnelStatus({
      accountAccess,
      desiredState: "enabled",
      runtimeState: "running",
    }));

    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);

    expect(root.querySelector(".hero-card .status-pill")?.textContent.trim())
      .toBe("Payment required");
    expect(root.textContent).toContain(accountAccess.message);
    expect(root.textContent).toContain("runtime is still running");
    expect(root.textContent).not.toContain("enabled and supervised");
    expect(root.textContent).not.toContain("runtime is unavailable");
    expect(buttonByText(root, "Disable Safe Tunnel")).toBeDefined();
  });

  it.each(terminalAccountAccessCases)(
    "keeps %s primary and offers Disable when the denied runtime is still running",
    async (_description, accountAccessStatus, expectedLabel) => {
      const accountAccess = {
        status: accountAccessStatus,
        message: "Hosted account access currently blocks this Safe Tunnel.",
        dashboardUrl: "https://api.tunnels.pi-web.dev/dashboard",
      };
      vi.spyOn(safeTunnelApi, "status").mockResolvedValue(safeTunnelStatus({
        accountAccess,
        desiredState: "enabled",
        runtimeDiagnosticCode: "runtime_failed",
        runtimeError: "Safe Tunnel runtime is unavailable.",
        runtimeState: "running",
      }));

      const panel = await renderPanel();
      const root = requiredShadowRoot(panel);

      expect(root.querySelector(".hero-card .status-pill")?.textContent.trim()).toBe(
        expectedLabel,
      );
      expect(root.querySelector("#safe-tunnel-state-heading")?.textContent).not.toContain(
        "enabled and supervised",
      );
      expect(root.textContent).toContain(accountAccess.message);
      expect(root.textContent).toContain("Safe Tunnel runtime is unavailable");
      expect(buttonByText(root, "Disable Safe Tunnel")).toBeDefined();
      expect(root.textContent).not.toContain("approval is no longer valid");
    },
  );

  it("renders suspended access guidance and an actionable hosted-dashboard link", async () => {
    const accountAccess = {
      status: "account_access_suspended" as const,
      message: "Account access is suspended pending administrator review.",
      dashboardUrl: "https://api.tunnels.pi-web.dev/dashboard",
    };
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(safeTunnelStatus({
      accountAccess,
      desiredState: "enabled",
      runtimeState: "stopped",
    }));

    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);
    const dashboardLink = [...root.querySelectorAll("a")]
      .find((link) => link.textContent.trim() === "Open hosted dashboard");

    expect(root.textContent).toContain("Account access is suspended");
    expect(root.textContent).toContain(accountAccess.message);
    expect(dashboardLink?.href).toBe(accountAccess.dashboardUrl);
    expect(dashboardLink?.target).toBe("_blank");
    expect(buttonByText(root, "Enable Safe Tunnel")).toBeDefined();
    expect(root.textContent).not.toContain("approval is no longer valid");
  });

  it("renders permanent deactivation without credential re-approval guidance", async () => {
    const accountAccess = {
      status: "account_access_deactivated" as const,
      message: "Account access is permanently deactivated by the hosted service.",
      dashboardUrl: "https://api.tunnels.pi-web.dev/dashboard",
    };
    vi.spyOn(safeTunnelApi, "status").mockResolvedValue(safeTunnelStatus({
      accountAccess,
      desiredState: "enabled",
      runtimeState: "stopped",
    }));

    const panel = await renderPanel();
    const root = requiredShadowRoot(panel);
    const dashboardLink = [...root.querySelectorAll("a")]
      .find((link) => link.textContent.trim() === "Open hosted dashboard");

    expect(root.textContent).toContain("Account is permanently deactivated");
    expect(root.textContent).toContain("This hosted account is permanently deactivated");
    expect(root.textContent).toContain(accountAccess.message);
    expect(dashboardLink?.href).toBe(accountAccess.dashboardUrl);
    expect(buttonByText(root, "Disable Safe Tunnel")).toBeDefined();
    expect([...root.querySelectorAll("button")].some(
      (button) => button.textContent.trim() === "Enable Safe Tunnel",
    )).toBe(false);
    expect(root.textContent).not.toContain("approval is no longer valid");
    expect(root.textContent).not.toContain("approve a replacement registration");
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
  };
}

interface SafeTunnelStatusOptions {
  accountAccess?: NonNullable<SafeTunnelStatusResponse["runtime"]["accountAccess"]>;
  activeOperation?: SafeTunnelOperationResponse;
  desiredState?: SafeTunnelStatusResponse["desiredState"];
  registered?: boolean;
  rejected?: boolean;
  runtimeDiagnosticCode?: SafeTunnelStatusResponse["runtime"]["diagnosticCode"];
  runtimeError?: string;
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
      ...(options.runtimeDiagnosticCode === undefined
        ? {}
        : { diagnosticCode: options.runtimeDiagnosticCode }),
      ...(options.runtimeError === undefined ? {} : { error: options.runtimeError }),
      ...(options.accountAccess === undefined
        ? {}
        : { accountAccess: options.accountAccess }),
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

function inputByLabel(root: ShadowRoot, labelText: string): HTMLInputElement {
  const label = [...root.querySelectorAll("label")]
    .find((candidate) => candidate.textContent.includes(labelText));
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${labelText}`);
  return input;
}

function setInput(root: ShadowRoot, labelText: string, value: string): void {
  const input = inputByLabel(root, labelText);
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
