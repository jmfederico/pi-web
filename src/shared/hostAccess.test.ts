import { describe, expect, it } from "vitest";
import { developmentAllowedHosts, requireHostAccess } from "./hostAccess.js";

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
