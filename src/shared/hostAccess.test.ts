import { describe, expect, it } from "vitest";
import type { PiWebHostAccess } from "./apiTypes.js";
import { developmentAllowedHosts, hostnameAllowedByPolicy, requireHostAccess } from "./hostAccess.js";

describe("host access policy validation", () => {
  it.each([
    undefined, null, true, false, 0, "any", [], {}, { mode: "unknown" },
    { mode: "restricted" }, { mode: "restricted", hosts: true }, { mode: "restricted", hosts: [""] },
    { mode: "restricted", hosts: ["  "] }, { mode: "restricted", hosts: [1] },
    { mode: "restricted", hosts: [], extra: true }, { mode: "any", hosts: [] }, { mode: "any", extra: true },
  ].map((value) => ({ value })))("rejects malformed explicit policy $value with source context", ({ value }) => {
    expect(() => requireHostAccess(value, "test-source")).toThrow("test-source");
  });

  it("accepts the two complete shapes and copies restricted hosts", () => {
    expect(requireHostAccess({ mode: "any" })).toEqual({ mode: "any" });
    expect(requireHostAccess({ mode: "restricted", hosts: [] })).toEqual({ mode: "restricted", hosts: [] });
    const hosts = [".example.test", "LOCALHOST"];
    const policy = requireHostAccess({ mode: "restricted", hosts });
    hosts.push("later.test");
    expect(policy).toEqual({ mode: "restricted", hosts: [".example.test", "LOCALHOST"] });
  });
});

describe("hostnameAllowedByPolicy", () => {
  const restricted: PiWebHostAccess = { mode: "restricted", hosts: [] };

  it.each([undefined, { mode: "any" as const }])("allows unlisted names with policy %j", (policy) => {
    expect(hostnameAllowedByPolicy("unlisted.test", policy)).toBe(true);
  });

  it.each([
    "localhost", "LOCALHOST.", "Dev.Localhost.",
    "0.0.0.0", "127.0.0.1", "192.168.1.20", "8.8.8.8", "255.255.255.255", "127.0.0.1.",
    "::", "::1", "2001:DB8::1", "0:0:0:0:0:0:0:1", "::ffff:192.0.2.128",
    "[::]", "[::1]", "[2001:DB8::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:192.0.2.128]",
  ])("always allows local names and IP literals: %s", (hostname) => {
    expect(hostnameAllowedByPolicy(hostname, restricted)).toBe(true);
  });

  it.each([
    "unlisted.test", "localhost.evil.test", "evil-localhost", "127.0.0.1.evil.test",
    "127.1", "2130706433", "0x7f000001", "0x7f.0.0.1", "0177.0.0.1", "127.00.0.1",
    "1.2.3.256", "256.0.0.1", "1.2.3.4.5", "1.2.3", "123", "123.456", "123.test",
    "2001:db8:::1", "1:2:3:4:5:6:7", "[::ffff:192.00.2.1]", "[fe80::1%eth0]",
    "[::1", "::1]", "[::1]:80", "[::1]/path", "::1\n", "[::1]@evil.test", "[not-ipv6]",
  ])("does not implicitly allow DNS lookalikes or malformed IP literals: %j", (hostname) => {
    expect(hostnameAllowedByPolicy(hostname, restricted)).toBe(false);
  });

  it("normalizes both sides and respects exact and leading-dot suffix boundaries", () => {
    const policy: PiWebHostAccess = { mode: "restricted", hosts: ["Exact.Test.", ".Trusted.Test."] };
    for (const hostname of ["exact.test", "EXACT.TEST.", "trusted.test", "Child.Trusted.Test.", "deep.child.trusted.test"]) {
      expect(hostnameAllowedByPolicy(hostname, policy)).toBe(true);
    }
    for (const hostname of ["child.exact.test", "untrusted.test", "trusted.test.evil.test", "exact.test.evil.test", "exact.test..", " exact.test"]) {
      expect(hostnameAllowedByPolicy(hostname, policy)).toBe(false);
    }
  });

  it("still permits explicitly listed numeric DNS names without interpreting them as IPs", () => {
    const policy: PiWebHostAccess = { mode: "restricted", hosts: ["127.00.0.1", "2130706433"] };
    expect(hostnameAllowedByPolicy("127.00.0.1", policy)).toBe(true);
    expect(hostnameAllowedByPolicy("2130706433", policy)).toBe(true);
    expect(hostnameAllowedByPolicy("127.01.0.1", policy)).toBe(false);
  });
});

describe("developmentAllowedHosts", () => {
  it.each([undefined, true as const, [], ["Legacy.Test."]].map((allowedHosts) => ({ allowedHosts })))("preserves legacy Vite mapping $allowedHosts while undecided", ({ allowedHosts }) => {
    expect(developmentAllowedHosts(allowedHosts === undefined ? {} : { allowedHosts })).toEqual(allowedHosts);
  });

  it("explicit policy replaces legacy hosts in both directions", () => {
    expect(developmentAllowedHosts({ allowedHosts: ["legacy.test"], hostAccess: { mode: "any" } })).toBe(true);
    expect(developmentAllowedHosts({ allowedHosts: true, hostAccess: { mode: "restricted", hosts: [] } })).toEqual([]);
    expect(developmentAllowedHosts({ allowedHosts: ["legacy.test"], hostAccess: { mode: "restricted", hosts: [".Shared.Test.", "Exact.Test"] } })).toEqual([".shared.test", "exact.test"]);
  });
});
