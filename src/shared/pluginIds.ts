export const piWebPluginIdPattern = /^[a-z][a-z0-9.-]*$/u;

const reservedPiWebPluginIds = new Set(["core", "themes"]);
const machinePluginIdPrefix = "machine.";
const bundledPiWebPluginId = "pi-web";
const bundledPiWebPluginIdPrefix = `${bundledPiWebPluginId}.`;

export function isPiWebPluginId(value: string): boolean {
  return piWebPluginIdPattern.test(value);
}

export function isPiWebBundledPluginId(value: string): boolean {
  return value === bundledPiWebPluginId || value.startsWith(bundledPiWebPluginIdPrefix);
}

export function isReservedPiWebPluginId(value: string): boolean {
  return reservedPiWebPluginIds.has(value)
    || value.startsWith(machinePluginIdPrefix)
    || isPiWebBundledPluginId(value);
}
