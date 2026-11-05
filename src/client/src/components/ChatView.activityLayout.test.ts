// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { ChatPart } from "../chatTypes";
import type { FormattedText } from "./FormattedText";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

it("preserves part order and disclosure state when interleaving activity and ordinary content", async () => {
  const view = new ChatView();
  const parts: ChatPart[] = [
    { type: "thinking", text: "Plan" },
    { type: "text", text: "Context" },
    { type: "text", text: "More context" },
    { type: "toolCall", toolName: "read", summary: "file" },
    { type: "toolResult", toolName: "read", text: "Result", isError: false },
    { type: "toolExecution", toolName: "read", summary: "file", status: "success", resultText: "Output" },
    { type: "thinking", text: "hidden", displayText: "" },
    { type: "text", text: "hidden", displayText: "" },
    { type: "thinking", text: "Continue" },
  ];
  view.messages = [{ role: "tool", parts }];
  view.isSendingPrompt = true;
  document.body.append(view);
  await view.updateComplete;
  const message = view.renderRoot.querySelector(".group-msg");
  if (message === null) throw new Error("Activity message was not rendered");
  expect([...message.querySelectorAll<FormattedText>("formatted-text")].map((element) => element.text)).toEqual([
    "Plan", "Context", "More context", "Continue",
  ]);
  expect(message.querySelectorAll(".thinking")).toHaveLength(2);
  const thinking = message.querySelector<HTMLDetailsElement>(".thinking");
  if (thinking === null) throw new Error("Thinking disclosure was not rendered");
  thinking.open = false;
  thinking.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
  expect(message.querySelector(".transcript-section > .thinking:not([open])")).not.toBeNull();
});
