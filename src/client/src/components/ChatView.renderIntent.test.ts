// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { html } from "lit";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
import type { ContentRendererHost } from "./ContentRendererHost";
import { createContentRenderingService } from "../formatting/contentRendering";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

it("scopes chat intent by machine, session, message, part and block rather than duplicate text", async () => {
  const view = new ChatView();
  view.sessionId = "intent-session";
  view.contentRendering = createContentRenderingService(() => [{ id: "manual", label: "Manual", renderer: { id: "manual", render: () => html`<b>Diagram</b>` } }]);
  const text = "```diagram\nsame\n```\n\n```diagram\nsame\n```";
  view.messages = ["one", "two"].map((entryId) => ({ entryId, role: "user", parts: [{ type: "text", text }, { type: "text", text }] }));
  document.body.append(view);
  await view.updateComplete;

  async function hosts() {
    await view.updateComplete;
    const formatted = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
    await Promise.all(formatted.map((element) => element.updateComplete));
    const result = formatted.flatMap((element) => [...element.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")]);
    await Promise.all(result.map((element) => element.updateComplete));
    expect(result).toHaveLength(8);
    return result;
  }

  const initial = await hosts();
  const first = initial[0];
  if (first === undefined) throw new Error("Expected first diagram");
  first.renderRoot.querySelector<HTMLButtonElement>("button")?.click();
  await first.updateComplete;
  expect(initial.map((host) => host.renderRoot.querySelector("b") !== null)).toEqual([true, false, false, false, false, false, false, false]);
  view.sessionId = "another-session";
  expect((await hosts()).every((host) => host.renderRoot.querySelector("pre") !== null)).toBe(true);
  view.sessionId = "intent-session";
  expect((await hosts())[0]?.renderRoot.querySelector("b")).not.toBeNull();
  view.machineId = "other-machine";
  expect((await hosts()).every((host) => host.renderRoot.querySelector("pre") !== null)).toBe(true);
  view.machineId = "local";
  expect((await hosts())[0]?.renderRoot.querySelector("b")).not.toBeNull();
  expect(localStorage.length).toBe(0);
});
