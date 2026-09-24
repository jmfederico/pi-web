export type SettingsSection = "general" | "sessiond" | "packages" | "plugins" | "safe-tunnel" | "shortcuts";

export function readSettingsSection(): SettingsSection | undefined {
  return parseSettingsSection(new URLSearchParams(window.location.search).get("settings"));
}

export function writeSettingsSection(section: SettingsSection | undefined, options?: { replace?: boolean | undefined }): void {
  const url = new URL(window.location.href);
  if (section === undefined) url.searchParams.delete("settings");
  else url.searchParams.set("settings", section);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (options?.replace === true) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}

export function parseSettingsSection(value: string | null): SettingsSection | undefined {
  if (value === "general") return "general";
  if (value === "sessiond" || value === "sessions") return "sessiond";
  if (value === "packages" || value === "pi-packages") return "packages";
  if (value === "plugins") return "plugins";
  if (value === "safe-tunnel" || value === "safeTunnel" || value === "tunnel") return "safe-tunnel";
  if (value === "shortcuts" || value === "keyboard" || value === "keyboard-shortcuts") return "shortcuts";
  return undefined;
}

/**
 * Resolve a requested section against the gateway's active runtime surface.
 * Safe Tunnel fails closed to ordinary General settings until that local
 * capability is known to be active.
 */
export function normalizeSettingsSection(
  section: SettingsSection | undefined,
  safeTunnelAvailable: boolean,
): SettingsSection | undefined {
  return section === "safe-tunnel" && !safeTunnelAvailable ? "general" : section;
}
