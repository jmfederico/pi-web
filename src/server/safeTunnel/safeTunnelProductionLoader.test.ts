import { describe, expect, it, vi } from "vitest";
import type {
  SafeTunnelDisableResponse,
  SafeTunnelEnableResponse,
  SafeTunnelStatusResponse,
} from "../../shared/apiTypes.js";
import type { SafeTunnelBridgeService } from "./safeTunnelBridgeService.js";
import { loadSafeTunnelBridge } from "./safeTunnelProductionLoader.js";

const status: SafeTunnelStatusResponse = {
  config: { exists: false, state: "missing" },
  desiredState: "disabled",
  runtime: { state: "stopped" },
};

describe("loadSafeTunnelBridge", () => {
  it("does not import or construct the production graph while unavailable", async () => {
    const fixture = fakeBridge();
    const createSafeTunnelProduction = vi.fn(() => fixture.bridge);
    const loadModule = vi.fn(() => Promise.resolve({ createSafeTunnelProduction }));

    const loaded = await loadSafeTunnelBridge(
      false,
      { serverAddress: () => null },
      loadModule,
    );

    expect(loaded).toBeUndefined();
    expect(loadModule).not.toHaveBeenCalled();
    expect(createSafeTunnelProduction).not.toHaveBeenCalled();
    expect(fixture.startup).not.toHaveBeenCalled();
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });

  it("imports and composes exactly one bridge after opt-in", async () => {
    const fixture = fakeBridge();
    const createSafeTunnelProduction = vi.fn(() => fixture.bridge);
    const loadModule = vi.fn(() => Promise.resolve({ createSafeTunnelProduction }));
    const serverAddress = () => null;

    const loaded = await loadSafeTunnelBridge(
      true,
      { serverAddress },
      loadModule,
    );

    expect(loaded).toBe(fixture.bridge);
    expect(loadModule).toHaveBeenCalledOnce();
    expect(createSafeTunnelProduction).toHaveBeenCalledOnce();
    expect(createSafeTunnelProduction).toHaveBeenCalledWith({ serverAddress });
    expect(fixture.startup).not.toHaveBeenCalled();
  });
});

function fakeBridge() {
  const startup = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const shutdown = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const disableResponse: SafeTunnelDisableResponse = { status };
  const enableResponse: SafeTunnelEnableResponse = {
    accepted: true,
    operation: {
      id: "op-1",
      kind: "enable",
      phase: "preparing",
      status: "running",
    },
    status,
  };
  const bridge: SafeTunnelBridgeService = {
    disable: vi.fn(() => Promise.resolve(disableResponse)),
    enable: vi.fn(() => Promise.resolve(enableResponse)),
    operation: vi.fn(() => undefined),
    registeredPublicOrigin: vi.fn(() => Promise.resolve(undefined)),
    shutdown,
    startup,
    status: vi.fn(() => Promise.resolve(status)),
  };
  return { bridge, shutdown, startup };
}
