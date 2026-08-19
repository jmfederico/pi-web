import { describe, expect, it } from "vitest";
import {
  collisionResistantMachineSlug,
  createNodeSafeTunnelEnableDefaultsProvider,
  defaultSafeTunnelControlApiBaseUrl,
  safeTunnelLocalPiWebUrlFromServerAddress,
} from "./safeTunnelEnableDefaults.js";

describe("Safe Tunnel inferred enable defaults", () => {
  it("uses the production Control API, running listener, and OS identity", () => {
    const defaults = createNodeSafeTunnelEnableDefaultsProvider({
      serverAddress: () => ({ address: "0.0.0.0", family: "IPv4", port: 8504 }),
      hostname: () => "Federico's Dev Box",
      uniqueId: () => "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    })();

    expect(defaultSafeTunnelControlApiBaseUrl).toBe("https://api.tunnels.pi-web.dev");
    expect(defaults).toEqual({
      controlApiBaseUrl: defaultSafeTunnelControlApiBaseUrl,
      localPiWebUrl: "http://127.0.0.1:8504",
      machineName: "Federico's Dev Box",
      machineSlug: "federico-s-dev-box-a1b2c3d4",
    });
  });

  it("normalizes wildcard and IPv6 listener addresses into reachable local URLs", () => {
    expect(safeTunnelLocalPiWebUrlFromServerAddress({
      address: "::",
      family: "IPv6",
      port: 9500,
    })).toBe("http://[::1]:9500");
    expect(safeTunnelLocalPiWebUrlFromServerAddress({
      address: "2001:db8::1",
      family: "IPv6",
      port: 9500,
    })).toBe("http://[2001:db8::1]:9500");
    expect(() => safeTunnelLocalPiWebUrlFromServerAddress({
      address: "fe80::1%lo0",
      family: "IPv6",
      port: 9500,
    })).toThrow("scoped IPv6 listener");
  });

  it("fails clearly before listening or for a socket listener", () => {
    expect(() => safeTunnelLocalPiWebUrlFromServerAddress(null)).toThrow("must be listening");
    expect(() => safeTunnelLocalPiWebUrlFromServerAddress("/tmp/pi-web.sock")).toThrow("advanced local target");
  });

  it("uses an advanced local target without consulting unavailable listener inference", () => {
    let serverAddressCalls = 0;
    const defaults = createNodeSafeTunnelEnableDefaultsProvider({
      serverAddress: () => {
        serverAddressCalls += 1;
        return { address: "fe80::1%lo0", family: "IPv6", port: 8504 };
      },
      hostname: () => "Scoped IPv6 machine",
      uniqueId: () => "12345678-abcd",
    })({ localPiWebUrl: "http://[::1]:80" });

    expect(defaults).toEqual({
      controlApiBaseUrl: defaultSafeTunnelControlApiBaseUrl,
      localPiWebUrl: "http://[::1]:80",
      machineName: "Scoped IPv6 machine",
      machineSlug: "scoped-ipv6-machine-12345678",
    });
    expect(serverAddressCalls).toBe(0);
  });

  it("bounds and normalizes inferred machine identity", () => {
    const defaults = createNodeSafeTunnelEnableDefaultsProvider({
      serverAddress: () => ({ address: "127.0.0.1", family: "IPv4", port: 8504 }),
      hostname: () => `  ${"A".repeat(100)}  `,
      uniqueId: () => "12345678-abcd",
    })();
    const fallback = createNodeSafeTunnelEnableDefaultsProvider({
      serverAddress: () => ({ address: "127.0.0.1", family: "IPv4", port: 8504 }),
      hostname: () => "   ",
      uniqueId: () => "abcdef12-abcd",
    })();

    expect(defaults.machineName).toBe("A".repeat(80));
    expect(defaults.machineSlug).toHaveLength(63);
    expect(defaults.machineSlug).toMatch(/^a+-12345678$/u);
    expect(fallback.machineName).toBe("PI WEB");
    expect(fallback.machineSlug).toBe("pi-web-abcdef12");
  });

  it("requires enough unique entropy for collision-resistant slugs", () => {
    expect(collisionResistantMachineSlug("你好", "abcdef12-abcd")).toBe("pi-web-abcdef12");
    expect(() => collisionResistantMachineSlug("dev", "short")).toThrow("collision-resistant");
  });
});
