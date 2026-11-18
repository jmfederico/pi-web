import { AppMobileMainTabs, type AppMobileMainTab } from "../../src/client/src/components/appShell/AppMobileMainTabs";
import { NavigationDialog } from "../../src/client/src/components/appShell/NavigationDialog";
import { loadNavigationPreferences, orderedNavigationTabs, pinnedNavigationTabs, saveNavigationPreferences } from "../../src/client/src/navigationPreferences";

// Real modal, reorder controller, tab strip and storage; no application services.
const tabs: AppMobileMainTab[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "fixture:tasks", label: "Tasks" },
  { id: "fixture:workspaces", label: "Workspaces with a long destination label that must leave every action reachable" },
  { id: "fixture:notices", label: "Notices" },
  { id: "fixture:terminal", label: "Terminal" },
];
if (new URLSearchParams(location.search).has("long")) {
  tabs.push(...Array.from({ length: 24 }, (_, index): AppMobileMainTab => ({ id: `fixture:extra-${String(index)}`, label: `Additional destination ${String(index + 1)}` })));
}
const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: dark; --pi-bg: #161616; --pi-surface: #252525; --pi-surface-hover: #303030; --pi-text: #eee; --pi-text-bright: #fff; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-danger: #f88; --pi-accent: #aaf; --pi-selection-bg: #303044; --pi-overlay: #0008; --pi-shadow-strong: #0008; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui; }
`;
document.head.append(style);
// Reproduce the full-height, clipped application shadow host. The native modal
// and preview must escape it through their production top-layer composition.
const host = document.createElement("main");
host.style.cssText = "position: fixed; inset: 0; height: 100dvh; overflow: hidden;";
const application = host.attachShadow({ mode: "open" });
document.body.append(host);
const opener = document.createElement("button");
opener.textContent = "Open navigation";
const selected = document.createElement("output");
selected.id = "selected";
const bar = new AppMobileMainTabs();
let preferences = loadNavigationPreferences();
let dialog: NavigationDialog | undefined;
function updateBar(): void {
  bar.tabs = pinnedNavigationTabs(orderedNavigationTabs(tabs, preferences.orderedIds), preferences.pinnedIds);
}
function select(id: AppMobileMainTab["id"]): void {
  selected.textContent = id;
  bar.selectedTab = id;
}
function openNavigation(): void {
  dialog?.remove();
  const next = new NavigationDialog();
  next.tabs = tabs;
  if (bar.selectedTab !== undefined) next.selectedTab = bar.selectedTab;
  next.preferences = preferences;
  next.onSelect = select;
  next.onClose = () => { next.remove(); };
  next.onPreferencesChange = (value, changedField) => {
    preferences = value;
    next.preferences = value;
    next.preferencesSaveFailed = !saveNavigationPreferences(value, undefined, [changedField]);
    updateBar();
  };
  dialog = next;
  application.append(next);
}
bar.onSelect = select;
opener.addEventListener("click", openNavigation);
// Open without moving focus away from a tab, like the app navigation shortcut.
document.addEventListener("keydown", (event) => {
  if (event.altKey && event.key === "n") {
    event.preventDefault();
    openNavigation();
  }
});
updateBar();
application.append(opener, bar, selected);
await bar.updateComplete;
window.addEventListener("pagehide", () => { dialog?.remove(); }, { once: true });
document.body.dataset["ready"] = "true";
