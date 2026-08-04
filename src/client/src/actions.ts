export interface AppAction {
  id: string;
  title: string;
  description?: string;
  shortcut?: string;
  /** Fallback ids for shortcut preferences migrated from an earlier action owner. */
  shortcutAliases?: string[];
  group?: string;
  enabled?: boolean;
  /** When present on a disabled action, keep it visible and explain why it cannot run. */
  disabledReason?: string;
  run: () => void | Promise<void>;
}
