export type InputMode =
  | { kind: "normal" }
  | { kind: "command" }
  | { kind: "file" }
  | { kind: "shell"; excludeFromContext: boolean };

export function inputModeForDraft(draft: string): InputMode {
  const trimmed = draft.trimStart();
  if (trimmed.startsWith("!")) return { kind: "shell", excludeFromContext: trimmed.startsWith("!!") };
  if (currentToken(draft).startsWith("/")) return { kind: "command" };
  if (isFileCompletionContext(draft)) return { kind: "file" };
  return { kind: "normal" };
}

export function isShellInput(text: string): boolean {
  return inputModeForDraft(text).kind === "shell";
}

function currentToken(draft: string): string {
  const tokenStart = Math.max(draft.lastIndexOf(" "), draft.lastIndexOf("\n")) + 1;
  return draft.slice(tokenStart);
}

function isFileCompletionContext(draft: string): boolean {
  const token = currentToken(draft);
  if (token.startsWith("@")) return true;
  const tokenStart = draft.length - token.length;
  return draft.slice(0, tokenStart).endsWith("@ ");
}
