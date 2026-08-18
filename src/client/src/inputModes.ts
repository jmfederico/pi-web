import { detectPromptCompletionTrigger } from "./promptCompletions";

export type InputMode =
  | { kind: "normal" }
  | { kind: "command" }
  | { kind: "file" }
  | { kind: "model" }
  | { kind: "shell"; excludeFromContext: boolean };

export function inputModeForDraft(draft: string): InputMode {
  const trimmed = draft.trimStart();
  if (trimmed.startsWith("!@")) return { kind: "file" };
  if (trimmed.startsWith("!")) return { kind: "shell", excludeFromContext: trimmed.startsWith("!!") };
  if (currentToken(draft).startsWith("/")) return { kind: "command" };
  const trigger = detectPromptCompletionTrigger(draft);
  if (trigger?.kind === "file") return { kind: "file" };
  if (trigger?.kind === "model") return { kind: "model" };
  return { kind: "normal" };
}

export function isShellInput(text: string): boolean {
  return inputModeForDraft(text).kind === "shell";
}

export function inputModesEqual(a: InputMode, b: InputMode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "shell" && b.kind === "shell") return a.excludeFromContext === b.excludeFromContext;
  return true;
}

function currentToken(draft: string): string {
  const tokenStart = Math.max(draft.lastIndexOf(" "), draft.lastIndexOf("\n")) + 1;
  return draft.slice(tokenStart);
}

