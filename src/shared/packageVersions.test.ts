import { describe, expect, it } from "vitest";
import { comparePackageVersions } from "./packageVersions.js";

describe("comparePackageVersions", () => {
  it("compares semver-shaped CalVer versions", () => {
    expect(comparePackageVersions("1.202605.9", "1.202605.8")).toBeGreaterThan(0);
    expect(comparePackageVersions("1.202605.8", "1.202605.8")).toBe(0);
    expect(comparePackageVersions("1.202605.7", "1.202605.8")).toBeLessThan(0);
  });

  it.each([
    ["2.0.0-rc.10", "2.0.0-rc.2"],
    ["2.0.0-rc.1", "2.0.0-beta.11"],
    ["2.0.0-alpha.beta", "2.0.0-alpha.1"],
    ["2.0.0-alpha.1", "2.0.0-alpha"],
    ["2.0.0", "2.0.0-rc.10"],
  ])("orders prerelease %s after %s by SemVer precedence", (newer, older) => {
    expect(comparePackageVersions(newer, older)).toBeGreaterThan(0);
    expect(comparePackageVersions(older, newer)).toBeLessThan(0);
  });
});
