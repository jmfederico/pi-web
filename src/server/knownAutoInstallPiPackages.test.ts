import { describe, expect, it } from "vitest";
import {
  isKnownAutoInstallablePiPackageId,
} from "./knownAutoInstallPiPackages.js";

describe("isKnownAutoInstallablePiPackageId", () => {
  it.each(["@jmfederico/pi-relay", "@jmfederico/pi-web-workflows", "@jmfederico/pi-session-naming"])("recognizes %s as a known auto-installable package", (id) => {
    expect(isKnownAutoInstallablePiPackageId(id)).toBe(true);
  });

  it("rejects package ids that are not known auto-installable packages", () => {
    expect(isKnownAutoInstallablePiPackageId("@acme/unrelated-package")).toBe(false);
  });
});
