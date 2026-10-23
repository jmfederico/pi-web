// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { ChatPart } from "../chatTypes";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

it("composes full-width activity sections and consecutive inset content without losing part order", async () => {
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
  const runs = [...message.children].filter((element) => element.querySelector(".part") !== null);
  expect(runs.map((element) => element.className)).toEqual([
    "transcript-section", "transcript-content", "transcript-section", "transcript-section", "transcript-section", "transcript-section",
  ]);
  expect(runs.map((element) => element.querySelectorAll(".part").length)).toEqual([1, 2, 1, 1, 1, 1]);
  expect(runs[1]?.querySelectorAll("formatted-text")).toHaveLength(2);
  expect(message.querySelectorAll(".thinking")).toHaveLength(2);
  const thinking = message.querySelector<HTMLDetailsElement>(".thinking");
  if (thinking === null) throw new Error("Thinking disclosure was not rendered");
  thinking.open = false;
  thinking.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
  expect(message.querySelector(".transcript-section > .thinking:not([open])")).not.toBeNull();
});
