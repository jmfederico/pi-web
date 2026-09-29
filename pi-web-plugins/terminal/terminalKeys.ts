export type TerminalSoftKeyId =
  | "escape"
  | "tab"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-z"
  | "ctrl-l"
  | "ctrl-r"
  | "ctrl-u"
  | "ctrl-w"
  | "arrow-left"
  | "arrow-up"
  | "arrow-down"
  | "arrow-right"
  | "home"
  | "end"
  | "page-up"
  | "page-down"
  | "delete"
  | "backspace"
  | "meta-backward-word"
  | "meta-forward-word";

export interface TerminalModesSnapshot {
  applicationCursorKeysMode: boolean;
}

export interface TerminalSoftKeyDefinition {
  id: TerminalSoftKeyId;
  label: string;
  ariaLabel: string;
  title: string;
}

export const TERMINAL_SOFT_KEYS: readonly TerminalSoftKeyDefinition[] = [
  { id: "escape", label: "Esc", ariaLabel: "Escape", title: "Send Escape" },
  { id: "tab", label: "Tab", ariaLabel: "Tab", title: "Send Tab" },
  { id: "ctrl-c", label: "Ctrl+C", ariaLabel: "Control C", title: "Interrupt the foreground process" },
  { id: "ctrl-d", label: "Ctrl+D", ariaLabel: "Control D", title: "Send EOF / close input" },
  { id: "ctrl-z", label: "Ctrl+Z", ariaLabel: "Control Z", title: "Suspend the foreground process" },
  { id: "ctrl-l", label: "Ctrl+L", ariaLabel: "Control L", title: "Clear / redraw the terminal" },
  { id: "ctrl-r", label: "Ctrl+R", ariaLabel: "Control R", title: "Reverse search history" },
  { id: "ctrl-u", label: "Ctrl+U", ariaLabel: "Control U", title: "Delete to the start of the line" },
  { id: "ctrl-w", label: "Ctrl+W", ariaLabel: "Control W", title: "Delete the previous word" },
  { id: "arrow-left", label: "←", ariaLabel: "Left arrow", title: "Move left" },
  { id: "arrow-up", label: "↑", ariaLabel: "Up arrow", title: "Move up / previous command" },
  { id: "arrow-down", label: "↓", ariaLabel: "Down arrow", title: "Move down / next command" },
  { id: "arrow-right", label: "→", ariaLabel: "Right arrow", title: "Move right" },
  { id: "home", label: "Home", ariaLabel: "Home", title: "Move to the start" },
  { id: "end", label: "End", ariaLabel: "End", title: "Move to the end" },
  { id: "page-up", label: "PgUp", ariaLabel: "Page up", title: "Page up" },
  { id: "page-down", label: "PgDn", ariaLabel: "Page down", title: "Page down" },
  { id: "delete", label: "Del", ariaLabel: "Delete", title: "Delete forward" },
  { id: "backspace", label: "⌫", ariaLabel: "Backspace", title: "Backspace" },
  { id: "meta-backward-word", label: "M-B", ariaLabel: "Meta B", title: "Move backward one word" },
  { id: "meta-forward-word", label: "M-F", ariaLabel: "Meta F", title: "Move forward one word" },
];

const ESC = "\x1b";
const DEL = "\x7f";

export function terminalSoftKeySequence(key: TerminalSoftKeyId, modes?: TerminalModesSnapshot): string {
  switch (key) {
    case "escape": return ESC;
    case "tab": return "\t";
    case "ctrl-c": return controlSequence("c");
    case "ctrl-d": return controlSequence("d");
    case "ctrl-z": return controlSequence("z");
    case "ctrl-l": return controlSequence("l");
    case "ctrl-r": return controlSequence("r");
    case "ctrl-u": return controlSequence("u");
    case "ctrl-w": return controlSequence("w");
    case "arrow-left": return cursorSequence("D", modes);
    case "arrow-up": return cursorSequence("A", modes);
    case "arrow-down": return cursorSequence("B", modes);
    case "arrow-right": return cursorSequence("C", modes);
    case "home": return cursorEndpointSequence("H", modes);
    case "end": return cursorEndpointSequence("F", modes);
    case "page-up": return `${ESC}[5~`;
    case "page-down": return `${ESC}[6~`;
    case "delete": return `${ESC}[3~`;
    case "backspace": return DEL;
    case "meta-backward-word": return `${ESC}b`;
    case "meta-forward-word": return `${ESC}f`;
  }
}

function controlSequence(letter: string): string {
  return String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);
}

function cursorSequence(code: "A" | "B" | "C" | "D", modes: TerminalModesSnapshot | undefined): string {
  return modes?.applicationCursorKeysMode === true ? `${ESC}O${code}` : `${ESC}[${code}`;
}

function cursorEndpointSequence(code: "F" | "H", modes: TerminalModesSnapshot | undefined): string {
  return modes?.applicationCursorKeysMode === true ? `${ESC}O${code}` : `${ESC}[${code}`;
}
