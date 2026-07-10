// Parses the transient query params that carry an "intent" into the app from
// outside its normal query-param route (route.ts): a home-screen manifest
// shortcut tap, or Android's share-target hand-off. These are one-shot —
// consumed on arrival, not part of the persisted route.

export type AppIntent =
  | { kind: "new-session" }
  | { kind: "continue-last-session" }
  | { kind: "share"; title?: string | undefined; text?: string | undefined; url?: string | undefined };

export function parseAppIntent(params: URLSearchParams): AppIntent | undefined {
  const shortcut = params.get("shortcut");
  if (shortcut === "new") return { kind: "new-session" };
  if (shortcut === "continue-last") return { kind: "continue-last-session" };

  const title = params.get("share_title") ?? undefined;
  const text = params.get("share_text") ?? undefined;
  const url = params.get("share_url") ?? undefined;
  if (title !== undefined || text !== undefined || url !== undefined) return { kind: "share", title, text, url };

  return undefined;
}

export function formatSharedText(intent: Extract<AppIntent, { kind: "share" }>): string {
  return [intent.title, intent.text, intent.url].filter((part): part is string => part !== undefined && part !== "").join("\n");
}

const APP_INTENT_PARAM_NAMES = ["shortcut", "share_title", "share_text", "share_url"] as const;

export function clearAppIntentParams(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of APP_INTENT_PARAM_NAMES) {
    if (!url.searchParams.has(name)) continue;
    url.searchParams.delete(name);
    changed = true;
  }
  if (changed) window.history.replaceState({}, "", url);
}
