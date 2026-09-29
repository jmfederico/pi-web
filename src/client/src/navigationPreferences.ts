export interface NavigationPreferences {
  pinnedIds: string[];
  mobileCollapsed: boolean;
}

const storageKey = "pi-web:navigation-preferences";

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadNavigationPreferences(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): NavigationPreferences {
  try {
    const value: unknown = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (typeof value === "object" && value !== null) {
      const pins: unknown = "pinnedIds" in value ? value.pinnedIds : undefined;
      return {
        pinnedIds: Array.isArray(pins) ? [...new Set(pins.filter((id): id is string => typeof id === "string" && id.length > 0))] : [],
        mobileCollapsed: "mobileCollapsed" in value && value.mobileCollapsed === true,
      };
    }
  } catch {
    // Layout preferences are optional when storage is blocked or malformed.
  }
  return { pinnedIds: [], mobileCollapsed: false };
}

export function saveNavigationPreferences(preferences: NavigationPreferences, storage: Pick<Storage, "setItem"> | undefined = browserStorage()): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Ignore quota/privacy errors for this optional browser layout preference.
  }
}

export function isNavigationPinned(id: string, pinnedIds: readonly string[]): boolean {
  return pinnedIds.length === 0 || pinnedIds.includes(id);
}

export function pinnedNavigationTabs<T extends { id: string }>(tabs: readonly T[], pinnedIds: readonly string[]): T[] {
  return tabs.filter((tab) => isNavigationPinned(tab.id, pinnedIds));
}

export function toggleNavigationPin(id: string, pinnedIds: readonly string[], availableIds: readonly string[]): string[] {
  // Materialize the implicit "all" before unpinning. Never prune unavailable plugin IDs.
  const explicitPins = pinnedIds.length === 0 ? availableIds : pinnedIds;
  return explicitPins.includes(id) ? explicitPins.filter((pin) => pin !== id) : [...explicitPins, id];
}
