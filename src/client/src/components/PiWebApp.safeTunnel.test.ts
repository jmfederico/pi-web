// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { api, type Machine, type MachineRuntime } from "../api";
import { initialAppState, type AppState } from "../appState";
import type { AppAction } from "../actions";
import { SessionUnreadController } from "../sessionUnread";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

describe("PiWebApp Safe Tunnel availability gate", () => {
  it("omits the action while local availability is unresolved or disabled", () => {
    const app = new PiWebApp();

    expect(safeTunnelAction(app)).toBeUndefined();

    setAppState(app, {
      machineRuntimes: { local: runtime("local", []) },
    });
    expect(safeTunnelAction(app)).toBeUndefined();
  });

  it("uses only the active gateway-local capability and opens the enabled section", () => {
    const app = new PiWebApp();
    setAppState(app, {
      selectedMachine: remoteMachine,
      machineRuntimes: {
        local: runtime("local", [PI_WEB_CAPABILITIES.safeTunnel]),
        [remoteMachine.id]: runtime(remoteMachine.id, []),
      },
    });

    const action = safeTunnelAction(app);
    expect(action).toMatchObject({
      id: "app.safe-tunnel.manage",
      title: "Manage Safe Tunnel",
      group: "Safe Tunnel",
    });

    void action?.run();

    expect(settingsSection(app)).toBe("safe-tunnel");
    expect(new URL(window.location.href).searchParams.get("settings")).toBe("safe-tunnel");
  });

  it("rechecks availability when an action captured while enabled runs after capability loss", () => {
    const app = new PiWebApp();
    setAppState(app, {
      machineRuntimes: { local: runtime("local", [PI_WEB_CAPABILITIES.safeTunnel]) },
    });
    const action = safeTunnelAction(app);
    if (action === undefined) throw new Error("Expected enabled Safe Tunnel action");

    setAppState(app, { machineRuntimes: { local: runtime("local", []) } });
    void action.run();

    expect(settingsSection(app)).toBe("general");
    expect(new URL(window.location.href).searchParams.get("settings")).toBe("general");
  });

  it("does not trust a selected or remote machine capability when the gateway is inactive", () => {
    const app = new PiWebApp();
    setAppState(app, {
      selectedMachine: remoteMachine,
      machineRuntimes: {
        local: runtime("local", []),
        [remoteMachine.id]: runtime(remoteMachine.id, [PI_WEB_CAPABILITIES.safeTunnel]),
      },
    });

    expect(safeTunnelAction(app)).toBeUndefined();
  });

  it("fails an unresolved deep link closed, then normalizes it when the local runtime resolves disabled", () => {
    window.history.replaceState({}, "", "/?project=p1&settings=safe-tunnel");
    const app = new PiWebApp();

    expect(settingsSection(app)).toBe("safe-tunnel");
    expect(visibleSettingsSection(app)).toBe("general");
    expect(safeTunnelAction(app)).toBeUndefined();

    callSetState(app, { machineRuntimes: { local: runtime("local", []) } });

    expect(settingsSection(app)).toBe("general");
    expect(visibleSettingsSection(app)).toBe("general");
    const url = new URL(window.location.href);
    expect(url.searchParams.get("project")).toBe("p1");
    expect(url.searchParams.get("settings")).toBe("general");
  });

  it("preserves an enabled deep link once the active local capability resolves", () => {
    window.history.replaceState({}, "", "/?settings=safe-tunnel");
    const app = new PiWebApp();

    callSetState(app, {
      machineRuntimes: { local: runtime("local", [PI_WEB_CAPABILITIES.safeTunnel]) },
    });

    expect(settingsSection(app)).toBe("safe-tunnel");
    expect(visibleSettingsSection(app)).toBe("safe-tunnel");
    expect(new URL(window.location.href).searchParams.get("settings")).toBe("safe-tunnel");
  });

  it("discovers activation when the gateway realtime socket reconnects", async () => {
    const app = new PiWebApp();
    setAppState(app, { machineRuntimes: { local: runtime("local", []) } });
    vi.spyOn(api, "runtime").mockResolvedValue(
      runtime("local", [PI_WEB_CAPABILITIES.safeTunnel]),
    );
    const onOpen = captureRealtimeOpen(app);

    onOpen();

    await vi.waitFor(() => { expect(safeTunnelAction(app)).toBeDefined(); });
    expect(api.runtime).toHaveBeenCalledWith("local", true);
  });

  it("fails activation closed while refreshing after gateway reconnect", async () => {
    const app = new PiWebApp();
    setAppState(app, {
      machineRuntimes: { local: runtime("local", [PI_WEB_CAPABILITIES.safeTunnel]) },
    });
    vi.spyOn(api, "runtime").mockResolvedValue(runtime("local", []));
    void safeTunnelAction(app)?.run();
    expect(settingsSection(app)).toBe("safe-tunnel");
    const onOpen = captureRealtimeOpen(app);

    onOpen();

    expect(safeTunnelAction(app)).toBeUndefined();
    expect(settingsSection(app)).toBe("safe-tunnel");
    await vi.waitFor(() => { expect(settingsSection(app)).toBe("general"); });
    expect(api.runtime).toHaveBeenCalledWith("local", true);
    expect(safeTunnelAction(app)).toBeUndefined();
  });
});

const remoteMachine: Machine = {
  id: "remote-a",
  name: "Remote A",
  kind: "remote",
  baseUrl: "https://remote.example.test",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

function runtime(machineId: string, capabilities: NonNullable<MachineRuntime["capabilities"]>): MachineRuntime {
  return {
    machineId,
    ok: true,
    checkedAt: "2026-07-03T00:00:00.000Z",
    capabilities,
  };
}

function captureRealtimeOpen(app: PiWebApp): () => void {
  const sessionUnread: unknown = Reflect.get(app, "sessionUnread");
  if (!(sessionUnread instanceof SessionUnreadController)) {
    throw new Error("PiWebApp session unread controller was unavailable");
  }
  vi.spyOn(sessionUnread, "refresh").mockResolvedValue();

  let onOpen: (() => void) | undefined;
  const realtime = {
    connect: (_onEvent: unknown, nextOnOpen?: () => void): void => {
      onOpen = nextOnOpen;
    },
  };
  if (!Reflect.set(app, "realtime", realtime)) throw new Error("Could not replace PiWebApp realtime socket");
  callAppMethod(app, "connectRealtime");
  if (onOpen === undefined) throw new Error("PiWebApp realtime open callback was unavailable");
  return onOpen;
}

function safeTunnelAction(app: PiWebApp): AppAction | undefined {
  const actions = callAppMethod(app, "getDefaultActions");
  if (!Array.isArray(actions)) throw new Error("PiWebApp default actions were unavailable");
  return actions.find((value): value is AppAction => isAppAction(value) && value.id === "app.safe-tunnel.manage");
}

function visibleSettingsSection(app: PiWebApp): unknown {
  return callAppMethod(app, "visibleSettingsSection");
}

function settingsSection(app: PiWebApp): unknown {
  return Reflect.get(app, "settingsSection");
}

function setAppState(app: PiWebApp, patch: Partial<AppState>): void {
  if (!Reflect.set(app, "state", { ...initialAppState(), ...patch })) throw new Error("Could not set PiWebApp state");
}

function callSetState(app: PiWebApp, patch: Partial<AppState>): void {
  callAppMethod(app, "setState", patch);
}

function callAppMethod(app: PiWebApp, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`PiWebApp.${name} is not callable`);
  return Reflect.apply(method, app, args);
}

function isAppAction(value: unknown): value is AppAction {
  return typeof value === "object" && value !== null
    && "id" in value && typeof value.id === "string"
    && "run" in value && typeof value.run === "function";
}
