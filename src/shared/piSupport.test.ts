import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOlderThanSupportedPi, loadedPiVersion, supportedPiMinimumVersion, versionRangeFloor } from "./piSupport.js";

describe("supported Pi minimum", () => {
  it("is declared by the shipped package.json as a parseable development dependency floor", () => {
    const packageJson: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(supportedPiMinimumVersion(packageJson)).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("reads the floor of the Pi development dependency, not the optional peer range", () => {
    expect(supportedPiMinimumVersion({
      peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
      devDependencies: { "@earendil-works/pi-coding-agent": "^1.6.3" },
    })).toBe("1.6.3");
    expect(supportedPiMinimumVersion({ peerDependencies: { "@earendil-works/pi-coding-agent": "*" } })).toBeUndefined();
  });

  it("takes the floor of single-comparator ranges only", () => {
    expect(versionRangeFloor("^1.6.0")).toBe("1.6.0");
    expect(versionRangeFloor("~1.6.3")).toBe("1.6.3");
    expect(versionRangeFloor(">=1.6.0")).toBe("1.6.0");
    expect(versionRangeFloor("1.6.0")).toBe("1.6.0");
    expect(versionRangeFloor("^2.0.0-rc.1")).toBe("2.0.0-rc.1");
    for (const range of ["*", "1.x", "^1.6", ">=1.6.0 <2.0.0", "^1.6.0 || ^2.0.0", "latest"]) {
      expect(versionRangeFloor(range)).toBeUndefined();
    }
  });
});

describe("isOlderThanSupportedPi", () => {
  it("warns only for parseable versions older than the minimum", () => {
    expect(isOlderThanSupportedPi("1.6.0", "1.6.0")).toBe(false);
    expect(isOlderThanSupportedPi("1.6.2", "1.6.3")).toBe(true);
    expect(isOlderThanSupportedPi("1.5.9", "1.6.0")).toBe(true);
    expect(isOlderThanSupportedPi("1.6.4", "1.6.3")).toBe(false);
    expect(isOlderThanSupportedPi("1.7.0", "1.6.0")).toBe(false);
    expect(isOlderThanSupportedPi("2.0.0", "1.6.0")).toBe(false);
    expect(isOlderThanSupportedPi("1.6.0-rc.1", "1.6.0")).toBe(true);
    expect(isOlderThanSupportedPi("1.7.0-rc.1", "1.6.0")).toBe(false);
    expect(isOlderThanSupportedPi("unknown", "1.6.0")).toBe(false);
    expect(isOlderThanSupportedPi("1.5.0", "not-a-version")).toBe(false);
  });
});

describe("loadedPiVersion", () => {
  it("prefers the session daemon's Pi and falls back to the web process's", () => {
    const web = { available: true, piVersion: "1.6.1" };
    expect(loadedPiVersion({ web, sessiond: { available: true, piVersion: "1.5.0" } })).toEqual({ source: "sessiond", version: "1.5.0" });
    expect(loadedPiVersion({ web, sessiond: { available: false } })).toEqual({ source: "web", version: "1.6.1" });
    expect(loadedPiVersion({ sessiond: { available: false } })).toBeUndefined();
  });
});
