// Tool results are transcript text, not a terminal: discard CSI formatting/control
// sequences and OSC metadata (including hyperlink wrappers), preserving their text.
// eslint-disable-next-line no-control-regex -- ANSI sequences are control characters.
const terminalSequences = /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;

export function stripTerminalFormatting(text: string): string {
  return text.replace(terminalSequences, "");
}
