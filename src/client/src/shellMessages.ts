import { textMessage } from "./chatMessages";
import type { ChatLine } from "./chatTypes";
import type { SessionUiEvent } from "./sessionSocket";

export function shellStartMessage(command: string, excludeFromContext?: boolean): ChatLine {
  return textMessage("bash", `${excludeFromContext === true ? "excluded from context\n\n" : ""}$ ${command}`);
}

export function appendShellChunk(messages: ChatLine[], chunk: string): ChatLine[] {
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role !== "bash" || lastPart?.type !== "text") return [...messages, textMessage("bash", chunk)];
  const separator = hasShellOutput(lastPart.text) ? "" : "\n\n";
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: lastPart.text + separator + chunk }] }];
}

export function finalizeShellMessage(messages: ChatLine[], event: Extract<SessionUiEvent, { type: "shell.end" }>): ChatLine[] {
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role !== "bash" || lastPart?.type !== "text") return messages;
  const notes: string[] = [];
  if (!lastPart.text.includes("\n\n") && (event.output === undefined || event.output === "")) notes.push("(no output)");
  if (event.isError === true) notes.push(event.output ?? "Bash command failed");
  if (event.exitCode != null) notes.push(`exit ${String(event.exitCode)}`);
  if (event.cancelled === true) notes.push("cancelled");
  if (event.truncated === true) notes.push("output truncated");
  if (event.fullOutputPath !== undefined && event.fullOutputPath !== "") notes.push(`full output: ${event.fullOutputPath}`);
  if (notes.length === 0) return messages;
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: `${lastPart.text}\n\n${notes.join("\n")}` }] }];
}

function hasShellOutput(text: string): boolean {
  const outputStart = text.lastIndexOf("\n\n");
  const promptStart = text.lastIndexOf("$ ");
  return outputStart > promptStart;
}
