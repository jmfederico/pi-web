import { KNOWN_AUTO_INSTALLABLE_PI_PACKAGES, type KnownAutoInstallablePiPackage } from "./knownAutoInstallPiPackages.js";

/** Catalog metadata is shared with auto-install entries, but catalog membership grants no auto-install permission. */
export type KnownPiPackage = KnownAutoInstallablePiPackage;

/** Shipped packages offered by Settings. Optional entries must stay out of the auto-install allowlist. */
export const KNOWN_PI_PACKAGES: readonly KnownPiPackage[] = [
  ...KNOWN_AUTO_INSTALLABLE_PI_PACKAGES,
  {
    id: "@jmfederico/pi-captains-log",
    label: "Captain’s Log",
    description: "Translate the selected session's last reply into pirate, with a visible Pi message trail. Install, then explicitly enable its PI WEB plugin.",
    shippedPathSegments: ["dist", "pi-packages", "captains-log"],
  },
];
