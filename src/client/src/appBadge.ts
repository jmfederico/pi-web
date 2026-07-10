// Client-side half of the Badging API. The badge itself is set from sw.js
// (the only place that knows about push arrivals while the app is closed);
// the client's job is just to clear it once the user has actually looked.

interface BadgeNavigator {
  clearAppBadge?: () => Promise<void>;
}

export function clearAppBadge(navigatorObject: BadgeNavigator | undefined = typeof navigator === "undefined" ? undefined : navigator): void {
  if (typeof navigatorObject?.clearAppBadge !== "function") return;
  void navigatorObject.clearAppBadge().catch(() => { /* best-effort */ });
}
