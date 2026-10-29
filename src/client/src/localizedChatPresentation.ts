import { localizedCommandResult } from "./commandResultMessages";
import { chatTranscriptMessages as messages } from "./chatTranscriptMessages";
import { summarizeArgs, type ArgumentSummaryPresentation, type ChatTextPresentation } from "./chatPresentation";

export function localizedArgumentSummary(presentation: ArgumentSummaryPresentation): string {
  return summarizeArgs(presentation.args, {
    replacement: () => messages.t("argsReplacement"),
    edits: (count) => messages.t("argsEdits", { count }),
    items: (count) => messages.t("argsItems", { count }),
    object: () => messages.t("argsObject"),
  });
}

export function localizedChatText(presentation: ChatTextPresentation): string {
  switch (presentation.kind) {
    case "commandResult": return localizedCommandResult(presentation);
    case "modelAuthRemoved": return messages.t("modelAuthRemoved", { provider: presentation.provider, model: presentation.model });
    case "sessionNamingFailed": return messages.t("sessionNamingFailed", { detail: presentation.detail });
    case "arguments": return localizedArgumentSummary(presentation);
    case "backgroundTask": return `${messages.t("backgroundTaskStatus", { status: presentation.status })} · ${presentation.name} (${presentation.id})`;
    case "imagePlaceholder": return messages.t("imagePlaceholder");
    case "modelError": return messages.t("modelFailure", { detail: presentation.detail, detailed: presentation.detail === "" ? "no" : "yes" });
    case "liveShell": {
      const lines = presentation.excluded ? [messages.t("shellExcluded"), "", `$ ${presentation.command}`] : [`$ ${presentation.command}`];
      if (presentation.output !== undefined) lines.push("", presentation.output);
      const completion = presentation.completion;
      if (completion !== undefined) {
        const notes: string[] = [];
        if (completion.noOutput) notes.push(messages.t("shellNoOutput"));
        if (completion.failed) notes.push(completion.failureOutput ?? messages.t("shellFailed"));
        if (completion.exitCode !== undefined) notes.push(messages.t("shellExit", { code: completion.exitCode }));
        if (completion.cancelled) notes.push(messages.t("shellCancelled"));
        if (completion.truncated) notes.push(messages.t("shellTruncated"));
        if (completion.fullOutputPath !== undefined) notes.push(messages.t("shellFullOutput", { path: completion.fullOutputPath }));
        if (notes.length > 0) lines.push("", notes.join("\n"));
      }
      return lines.join("\n");
    }
    case "bash": {
      const lines = presentation.excluded ? [messages.t("shellExcluded"), "", `$ ${presentation.command}`] : [`$ ${presentation.command}`];
      if (presentation.output !== undefined) lines.push("", presentation.output);
      if (presentation.exitCode !== undefined) lines.push("", messages.t("shellExit", { code: presentation.exitCode }));
      if (presentation.cancelled) lines.push("", messages.t("shellCancelled"));
      if (presentation.truncated) lines.push("", messages.t("shellTruncated"));
      if (presentation.fullOutputPath !== undefined) lines.push("", messages.t("shellFullOutput", { path: presentation.fullOutputPath }));
      return lines.join("\n");
    }
  }
}
