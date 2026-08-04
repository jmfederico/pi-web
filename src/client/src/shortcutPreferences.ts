import type { AppAction } from "./actions";
import type { PiWebShortcutConfig } from "./api";
import { resolveShortcutBindings, shortcutPreferenceForAction } from "./keyboardShortcuts";

export function applyShortcutPreferences(actions: AppAction[], shortcuts: PiWebShortcutConfig | undefined): AppAction[] {
  if (shortcuts === undefined) return actions;
  return actions.map((action) => applyShortcutPreference(action, shortcuts));
}

export function applyActiveShortcutPreferences(actions: AppAction[], shortcuts: PiWebShortcutConfig | undefined): AppAction[] {
  const activeShortcutActionIds = new Set(resolveShortcutBindings(actions, shortcuts, { enabledOnly: true })
    .filter((binding) => binding.active)
    .map((binding) => binding.action.id));
  return applyShortcutPreferences(actions, shortcuts).map((action) => action.shortcut !== undefined && !activeShortcutActionIds.has(action.id) ? withoutShortcut(action) : action);
}

export function applyShortcutPreference(action: AppAction, shortcuts: PiWebShortcutConfig): AppAction {
  const shortcut = shortcutPreferenceForAction(action, shortcuts);
  if (shortcut === undefined) return action;
  if (shortcut === null) return withoutShortcut(action);
  return { ...action, shortcut };
}

function withoutShortcut(action: AppAction): AppAction {
  const copy = { ...action };
  delete copy.shortcut;
  return copy;
}
