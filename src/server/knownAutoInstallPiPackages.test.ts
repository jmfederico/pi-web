import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isKnownAutoInstallablePiPackageId,
  KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS,
  resolveShippedPiPackagePath,
  type KnownAutoInstallablePiPackage,
} from "./knownAutoInstallPiPackages.js";

describe("isKnownAutoInstallablePiPackageId", () => {
  it("recognizes the relays package as a known auto-installable package", () => {
    expect(KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS).toContain("@jmfederico/pi-relay");
    expect(isKnownAutoInstallablePiPackageId("@jmfederico/pi-relay")).toBe(true);
  });

  it("rejects package ids that are not known auto-installable packages", () => {
    expect(isKnownAutoInstallablePiPackageId("@acme/unrelated-package")).toBe(false);
  });
});

describe("resolveShippedPiPackagePath", () => {
  it("joins the given package root with the known package's shipped path segments", () => {
    const known: KnownAutoInstallablePiPackage = {
      id: "@acme/known",
      label: "Known",
      description: "A known package.",
      shippedPathSegments: ["dist", "pi-packages", "known"],
    };

    expect(resolveShippedPiPackagePath(known, "/pi-web")).toBe(join("/pi-web", "dist", "pi-packages", "known"));
  });

  it("resolves a real package root by default so callers do not need one for production use", () => {
    const known: KnownAutoInstallablePiPackage = {
      id: "@acme/known",
      label: "Known",
      description: "A known package.",
      shippedPathSegments: ["dist", "pi-packages", "known"],
    };

    expect(resolveShippedPiPackagePath(known)).toMatch(/dist[/\\]pi-packages[/\\]known$/);
  });
});
