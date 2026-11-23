// Tool results are transcript text, not a terminal: discard CSI formatting/control
// sequences, OSC metadata (including hyperlink wrappers), and xterm's character-set reset.
// eslint-disable-next-line no-control-regex -- ANSI sequences are control characters.
const terminalSequences = /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b\(B/g;

export function stripTerminalFormatting(text: string): string {
  return text.replace(terminalSequences, "");
}
