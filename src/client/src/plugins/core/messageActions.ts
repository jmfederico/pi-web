import { html } from "lit";
import type { MessageActionAvailabilityContextV5 as MessageActionAvailabilityContext, MessageActionContribution } from "../../../../plugin-api";
import { writeClipboardText } from "../../clipboard";
import { renderCopyIcon, renderGoBackIcon } from "../../components/messageActionIcons";

export function createCoreMessageActions(writeText = writeClipboardText): MessageActionContribution[] {
  const historyAction = {
    visible: ({ message }: MessageActionAvailabilityContext) => message.role === "user" || message.role === "assistant" || (message.role === "tool" && message.isQuestion === true),
    enabled: ({ session }: MessageActionAvailabilityContext) => !session.archived && !session.pending && !session.busy,
  };
  return [{
    ...historyAction,
    id: "message.fork",
    title: "Clone session from this message",
    icon: html`<span class="msg-fork-icon" aria-hidden="true">⑂</span>`,
    run: async ({ history }) => {
      if (window.confirm("Are you sure you want to fork this session?")) await history.fork();
    },
  }, {
    ...historyAction,
    id: "message.back",
    title: "Go back to this message",
    icon: renderGoBackIcon(),
    run: ({ history }) => history.goBack(),
  }, {
    target: "display",
    id: "message.copy",
    title: "Copy message",
    ariaLabel: ({ message }) => `Copy ${message.role} message`,
    icon: renderCopyIcon(),
    visible: ({ message }) => (message.role === "user" || message.role === "assistant") && message.text !== "",
    run: async ({ message }) => {
      if (!await writeText(message.text)) throw new Error("Unable to copy message to the clipboard.");
      return { title: "Copied", ariaLabel: `Copied ${message.role} message`, icon: html`<span aria-hidden="true">✓</span>` };
    },
  }];
}
