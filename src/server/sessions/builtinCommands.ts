import type { ClientCommand } from "../types.js";

export const BUILTIN_COMMANDS: ClientCommand[] = [
  { name: "settings", description: "Open settings menu", source: "builtin" },
  { name: "model", description: "Select model", source: "builtin" },
  { name: "scoped-models", description: "Enable/disable models for cycling", source: "builtin" },
  { name: "export", description: "Export session", source: "builtin" },
  { name: "import", description: "Import and resume a session from JSONL", source: "builtin" },
  { name: "share", description: "Share session as a secret GitHub gist", source: "builtin" },
  { name: "copy", description: "Copy last agent message", source: "builtin" },
  { name: "name", description: "Set session display name", argumentHint: "<session name>", source: "builtin" },
  { name: "session", description: "Show session info and stats", source: "builtin" },
  { name: "changelog", description: "Show changelog entries", source: "builtin" },
  { name: "hotkeys", description: "Show keyboard shortcuts", source: "builtin" },
  { name: "fork", description: "Create a new fork from a previous user message", source: "builtin" },
  { name: "clone", description: "Duplicate current session at current position", source: "builtin" },
  { name: "tree", description: "Navigate session tree", source: "builtin" },
  { name: "login", description: "Configure provider authentication", source: "builtin" },
  { name: "logout", description: "Remove provider authentication", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "compact", description: "Manually compact session context", argumentHint: "[instructions]", source: "builtin" },
  { name: "resume", description: "Resume a different session", source: "builtin" },
  { name: "reload", description: "Reload Pi runtime resources for this session", source: "builtin" },
  { name: "quit", description: "Quit pi", source: "builtin" },
];

export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.some((command) => command.name === name);
}
