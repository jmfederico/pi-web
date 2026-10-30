import type { PiWebInstallationInfo } from "../shared/apiTypes.js";
import { installationDisplayName } from "../shared/installationName.js";

/**
 * Deployment identity: how a PI WEB instance presents itself in browser chrome
 * and installed PWAs. Dev deployments (Docker dev mode, source checkouts) get a
 * purple recolor of the brand assets and a "(dev)" manifest name so users can
 * tell instances apart where no URL bar is visible.
 */
export type PiWebDeploymentFlavor = "stable" | "dev";

/** Only dev deployments recolor; every stable install keeps the stock assets. */
export function deploymentFlavorFromInstallation(installation: PiWebInstallationInfo | undefined): PiWebDeploymentFlavor {
  if (installation === undefined) return "stable";
  if (installation.kind === "docker") return installation.dockerMode === "dev" ? "dev" : "stable";
  return installation.kind === "local" ? "dev" : "stable";
}

/**
 * Resolve the deployment flavor once per process. Detection failure fails
 * closed to "stable": a wrong label is cosmetic, and the stock assets are the
 * least surprising fallback.
 */
export function createDeploymentFlavorResolver(
  detectInstallation: () => Promise<PiWebInstallationInfo>,
  onError?: (error: unknown) => void,
): () => Promise<PiWebDeploymentFlavor> {
  let memoized: Promise<PiWebDeploymentFlavor> | undefined;
  return () => {
    memoized ??= detectInstallation().then(deploymentFlavorFromInstallation, (error: unknown) => {
      onError?.(error);
      return "stable";
    });
    return memoized;
  };
}

/** Mark the initial document before paint, using the same identity as brand assets. */
export function deploymentHtmlForFlavor(html: string, flavor: PiWebDeploymentFlavor): string {
  return flavor === "dev" ? html.replace(/<html\b/iu, '<html data-pi-web-deployment="dev"') : html;
}

export interface DeploymentIdentityAssetFile {
  fileName: string;
  contentType: string;
}

/** Dev variants are served in place of the stock files, so URLs never change. */
const DEV_IDENTITY_ASSETS: Readonly<Record<string, DeploymentIdentityAssetFile>> = {
  "/favicon.svg": { fileName: "favicon-dev.svg", contentType: "image/svg+xml" },
  "/apple-touch-icon.png": { fileName: "apple-touch-icon-dev.png", contentType: "image/png" },
  "/pwa-icon-192.png": { fileName: "pwa-icon-dev-192.png", contentType: "image/png" },
  "/pwa-icon-512.png": { fileName: "pwa-icon-dev-512.png", contentType: "image/png" },
};

export const DEPLOYMENT_IDENTITY_ASSET_PATHS: readonly string[] = Object.keys(DEV_IDENTITY_ASSETS);

export const DEPLOYMENT_MANIFEST_PATH = "/manifest.webmanifest";
export const DEPLOYMENT_MANIFEST_CONTENT_TYPE = "application/manifest+json";

/** A dark purple tint (the dark theme's purple surface) for the PWA title bar. */
const DEV_MANIFEST_THEME_COLOR = "#21132f";

/**
 * The dev variant of a brand asset for a request path, or undefined when the
 * default static file should be served (stable flavor or unrelated path).
 */
export function deploymentIdentityAssetForPath(pathname: string, flavor: PiWebDeploymentFlavor): DeploymentIdentityAssetFile | undefined {
  if (flavor !== "dev") return undefined;
  return DEV_IDENTITY_ASSETS[pathname];
}

export function isDeploymentIdentityAssetPath(pathname: string): boolean {
  return pathname in DEV_IDENTITY_ASSETS;
}

/**
 * Apply the installation identity and retain the development marker and tint.
 * Icon URLs stay untouched: dev artwork is served in place of stock files.
 */
export function deploymentManifestForFlavor(manifestJson: string, flavor: PiWebDeploymentFlavor, installationName?: string): string {
  const manifest: unknown = JSON.parse(manifestJson);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return manifestJson;
  const name = `${installationDisplayName(installationName)}${flavor === "dev" ? " (dev)" : ""}`;
  return JSON.stringify({
    ...manifest,
    name,
    short_name: name,
    ...(flavor === "dev" ? { theme_color: DEV_MANIFEST_THEME_COLOR } : {}),
  });
}
