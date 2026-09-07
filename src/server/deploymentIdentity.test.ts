import { describe, expect, it } from "vitest";
import type { PiWebInstallationInfo } from "../shared/apiTypes.js";
import { createDeploymentFlavorResolver, deploymentFlavorFromInstallation, deploymentIdentityAssetForPath, deploymentManifestForFlavor, isDeploymentIdentityAssetPath } from "./deploymentIdentity.js";

describe("deploymentFlavorFromInstallation", () => {
  it("flags Docker dev mode as dev", () => {
    expect(deploymentFlavorFromInstallation({ kind: "docker", dockerMode: "dev" })).toBe("dev");
  });

  it("flags Docker runtime mode, including a missing mode, as stable", () => {
    expect(deploymentFlavorFromInstallation({ kind: "docker", dockerMode: "runtime" })).toBe("stable");
    expect(deploymentFlavorFromInstallation({ kind: "docker" })).toBe("stable");
  });

  it("flags source checkouts as dev and package installs as stable", () => {
    expect(deploymentFlavorFromInstallation({ kind: "local" })).toBe("dev");
    expect(deploymentFlavorFromInstallation({ kind: "npm-global" })).toBe("stable");
    expect(deploymentFlavorFromInstallation({ kind: "pi-package" })).toBe("stable");
    expect(deploymentFlavorFromInstallation({ kind: "unknown" })).toBe("stable");
    expect(deploymentFlavorFromInstallation(undefined)).toBe("stable");
  });
});

describe("createDeploymentFlavorResolver", () => {
  it("detects once and memoizes the result", async () => {
    let detections = 0;
    const installation: PiWebInstallationInfo = { kind: "docker", dockerMode: "dev" };
    const flavor = createDeploymentFlavorResolver(() => { detections += 1; return Promise.resolve(installation); });

    await expect(flavor()).resolves.toBe("dev");
    await expect(flavor()).resolves.toBe("dev");
    expect(detections).toBe(1);
  });

  it("fails closed to stable when detection fails", async () => {
    const errors: unknown[] = [];
    const flavor = createDeploymentFlavorResolver(() => Promise.reject(new Error("no detection")), (error) => { errors.push(error); });

    await expect(flavor()).resolves.toBe("stable");
    expect(errors).toHaveLength(1);
  });
});

describe("deploymentIdentityAssetForPath", () => {
  it("serves dev variants for brand assets on dev deployments", () => {
    expect(deploymentIdentityAssetForPath("/favicon.svg", "dev")).toEqual({ fileName: "favicon-dev.svg", contentType: "image/svg+xml" });
    expect(deploymentIdentityAssetForPath("/pwa-icon-192.png", "dev")).toEqual({ fileName: "pwa-icon-dev-192.png", contentType: "image/png" });
    expect(deploymentIdentityAssetForPath("/pwa-icon-512.png", "dev")).toEqual({ fileName: "pwa-icon-dev-512.png", contentType: "image/png" });
    expect(deploymentIdentityAssetForPath("/apple-touch-icon.png", "dev")).toEqual({ fileName: "apple-touch-icon-dev.png", contentType: "image/png" });
  });

  it("keeps stock assets on stable deployments and for unrelated paths", () => {
    expect(deploymentIdentityAssetForPath("/favicon.svg", "stable")).toBeUndefined();
    expect(deploymentIdentityAssetForPath("/index.html", "dev")).toBeUndefined();
  });

  it("recognizes exactly the identity asset paths", () => {
    expect(isDeploymentIdentityAssetPath("/favicon.svg")).toBe(true);
    expect(isDeploymentIdentityAssetPath("/manifest.webmanifest")).toBe(false);
    expect(isDeploymentIdentityAssetPath("/assets/index.js")).toBe(false);
  });
});

describe("deploymentManifestForFlavor", () => {
  const manifest = JSON.stringify({
    name: "PI WEB",
    short_name: "PI WEB",
    theme_color: "#0d1117",
    background_color: "#0d1117",
    icons: [{ src: "./pwa-icon-192.png", sizes: "192x192", type: "image/png" }],
  });

  it("renames and retints the PWA for dev deployments", () => {
    const mutated: unknown = JSON.parse(deploymentManifestForFlavor(manifest, "dev"));
    // Icon URLs stay: dev artwork is served in place of the stock files.
    expect(mutated).toEqual({
      name: "PI WEB (dev)",
      short_name: "PI WEB (dev)",
      theme_color: "#21132f",
      background_color: "#0d1117",
      icons: [{ src: "./pwa-icon-192.png", sizes: "192x192", type: "image/png" }],
    });
  });

  it("returns the manifest untouched for stable deployments", () => {
    expect(deploymentManifestForFlavor(manifest, "stable")).toBe(manifest);
  });
});
