import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { startupUrlLines } from "./startupUrls.js";

const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [
    { address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", cidr: "127.0.0.1/8", mac: "00:00:00:00:00:00" },
    { address: "::1", family: "IPv6", internal: true, netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", cidr: "::1/128", mac: "00:00:00:00:00:00", scopeid: 0 },
  ],
  ens33: [
    { address: "192.168.223.128", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: "192.168.223.128/24", mac: "00:11:22:33:44:55" },
    { address: "2001:db8::2", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", cidr: "2001:db8::2/64", mac: "00:11:22:33:44:55", scopeid: 0 },
    { address: "fe80::2", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", cidr: "fe80::2/64", mac: "00:11:22:33:44:55", scopeid: 2 },
  ],
  docker0: [
    { address: "172.17.0.1", family: "IPv4", internal: false, netmask: "255.255.0.0", cidr: "172.17.0.1/16", mac: "00:11:22:33:44:66" },
  ],
  missing: undefined,
};

function bound(address: string, port = 30177): AddressInfo {
  return { address, port, family: address.includes(":") ? "IPv6" : "IPv4" };
}

describe("startupUrlLines", () => {
  it.each([
    ["127.0.0.1", "  Local: http://127.0.0.1:30177"],
    ["127.0.0.2", "  Local: http://127.0.0.2:30177"],
    ["::1", "  Local: http://[::1]:30177"],
    ["192.168.223.128", "  Open: http://192.168.223.128:30177"],
    ["2001:db8::2", "  Open: http://[2001:db8::2]:30177"],
  ])("shows only the specific bound address %s", (address, expected) => {
    expect(startupUrlLines(bound(address), interfaces)).toEqual([expected]);
  });

  it("lists IPv4 interfaces and loopback for an IPv4 wildcard", () => {
    expect(startupUrlLines(bound("0.0.0.0"), interfaces)).toEqual([
      "  Local: http://127.0.0.1:30177",
      "  ens33: http://192.168.223.128:30177",
      "  docker0: http://172.17.0.1:30177",
    ]);
  });

  it("lists both families for the default dual-stack IPv6 wildcard, excluding scoped addresses", () => {
    expect(startupUrlLines(bound("::"), interfaces)).toEqual([
      "  Local: http://[::1]:30177",
      "  ens33: http://192.168.223.128:30177",
      "  ens33: http://[2001:db8::2]:30177",
      "  docker0: http://172.17.0.1:30177",
    ]);
  });

  it("still shows loopback when no external interfaces exist", () => {
    expect(startupUrlLines(bound("0.0.0.0", 8504), {})).toEqual([
      "  Local: http://127.0.0.1:8504",
    ]);
  });

  it("uses the actual ephemeral port after listen", async () => {
    const app = Fastify({ logger: false });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
      expect(address.port).toBeGreaterThan(0);
      expect(startupUrlLines(address, {})).toEqual([
        `  Local: http://127.0.0.1:${String(address.port)}`,
      ]);
    } finally {
      await app.close();
    }
  });
});
