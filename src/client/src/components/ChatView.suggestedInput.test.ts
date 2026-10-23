// @vitest-environment happy-dom

import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

it("does not display suggested input received in session status", async () => {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.status = {
    sessionId: view.sessionId, isStreaming: false, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 0, queuedMessages: [], cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    suggestedInput: "Prepared text from an extension",
  };
  document.body.append(view);
  await view.updateComplete;
  expect(view.shadowRoot?.querySelector(".suggested-input")).toBeNull();
  expect(view.shadowRoot?.textContent).not.toContain("Prepared text from an extension");
  expect(view.shadowRoot?.textContent).not.toContain("Use suggested input");
});
