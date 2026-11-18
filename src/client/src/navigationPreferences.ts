export interface NavigationPreferences {
  pinnedIds: string[];
  orderedIds?: string[];
  mobileCollapsed: boolean;
}

const storageKey = "pi-web:navigation-preferences";

function sanitizeIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
}

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
        pinnedIds: sanitizeIds(pins),
        ...("orderedIds" in value ? { orderedIds: sanitizeIds(value.orderedIds) } : {}),
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

/** Remembered destinations lead; newly available destinations retain their default order. */
export function orderedNavigationTabs<T extends { id: string }>(tabs: readonly T[], orderedIds: readonly string[] = []): T[] {
  const remaining = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const tab = remaining.get(id);
    if (tab === undefined) continue;
    ordered.push(tab);
    remaining.delete(id);
  }
  return [...ordered, ...remaining.values()];
}

export function moveNavigationTab(
  id: string,
  neighborId: string,
  position: "before" | "after",
  orderedIds: readonly string[] | undefined,
  availableIds: readonly string[],
): string[] {
  // Materialize all known destinations, not just the current layout/search/pins.
  // Keep unavailable plugin IDs so their positions survive a later return.
  const order = [...new Set([...(orderedIds ?? []), ...availableIds])];
  if (id === neighborId || !order.includes(id) || !order.includes(neighborId)) return order;
  const remaining = order.filter((item) => item !== id);
  const index = remaining.indexOf(neighborId) + (position === "after" ? 1 : 0);
  remaining.splice(index, 0, id);
  return remaining;
}

export function toggleNavigationPin(id: string, pinnedIds: readonly string[], availableIds: readonly string[]): string[] {
  // Materialize the implicit "all" before unpinning. Never prune unavailable plugin IDs.
  const explicitPins = pinnedIds.length === 0 ? availableIds : pinnedIds;
  return explicitPins.includes(id) ? explicitPins.filter((pin) => pin !== id) : [...explicitPins, id];
}
