// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

it("passes workspace context to queued, text, thinking, skill and tool-result Markdown and updates it on navigation", async () => {
  const view = new ChatView();
  const text = "[file](result.zip)";
  view.sessionId = "session";
  view.workspaceContext = { machineId: "remote", projectId: "p", workspaceId: "w", root: "/work" };
  view.clientQueuedMessages = [{ kind: "followUp", text }];
  view.messages = [{ role: "assistant", parts: [
    { type: "text", text },
    { type: "thinking", text },
    { type: "skillInvocation", name: "skill", location: "/skill", content: text },
    { type: "toolResult", toolName: "read", text, isError: false },
  ] }];
  document.body.append(view);
  await view.updateComplete;
  for (const details of view.renderRoot.querySelectorAll<HTMLDetailsElement>("details")) {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  }
  await view.updateComplete;

  async function hrefs() {
    const formatted = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
    expect(formatted).toHaveLength(5);
    await Promise.all(formatted.map((element) => element.updateComplete));
    return formatted.map((element) => element.renderRoot.querySelector("a")?.getAttribute("href"));
  }

  expect((await hrefs()).every((href) => href?.includes("/machines/remote/projects/p/workspaces/w/file/preview?path=result.zip&download=1") === true)).toBe(true);
  view.workspaceContext = { machineId: "other", projectId: "p2", workspaceId: "w2", root: "/other" };
  await view.updateComplete;
  expect((await hrefs()).every((href) => href?.includes("/machines/other/projects/p2/workspaces/w2/") === true)).toBe(true);
  view.workspaceContext = undefined;
  await view.updateComplete;
  expect(await hrefs()).toEqual([null, null, null, null, null]);
});
