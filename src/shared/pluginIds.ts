export const piWebPluginIdPattern = /^[a-z][a-z0-9.-]*$/u;

const reservedPiWebPluginIds = new Set(["core", "themes"]);
const machinePluginIdPrefix = "machine.";

export function isPiWebPluginId(value: string): boolean {
  return piWebPluginIdPattern.test(value);
}

export function isReservedPiWebPluginId(value: string): boolean {
  return reservedPiWebPluginIds.has(value) || value.startsWith(machinePluginIdPrefix);
}
