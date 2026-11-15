// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
import { settleDeferredContent, useDeferredContent } from "../formatting/deferredContent.testSupport";

useDeferredContent();
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

it("strips terminal formatting before rendering legacy tool results without changing history", async () => {
  const view = new ChatView();
  const text = "\x1b[31mfailed\x1b[0m";
  view.messages = [{ role: "tool", parts: [{ type: "toolResult", toolName: "bash", text, isError: true }] }];
  document.body.append(view);
  await view.updateComplete;
  const group = view.renderRoot.querySelector<HTMLDetailsElement>(".event-group");
  if (group !== null) {
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    await view.updateComplete;
  }
  await settleDeferredContent(view);
  const formatted = view.renderRoot.querySelector<FormattedText>(".tool-result formatted-text");
  expect(formatted?.text).toBe("failed");
  expect(formatted?.renderRoot.textContent).toContain("failed");
  expect(view.messages[0]?.parts[0]).toMatchObject({ text });
});
