// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { FormattedText } from "./FormattedText";
import { writeClipboardText } from "../clipboard";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(true) }));
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.clearAllMocks(); });

it("boxes unmatched tool output literally, keeps errors open and copies full contents", async () => {
  const view = new ChatView();
  const text = '# Not a heading\n<a href="https://example.com">not a link</a>\n' + "payload\n".repeat(20);
  view.messages = [{ role: "tool", parts: [{ type: "toolResult", toolName: "codemode", text, isError: true }] }];
  document.body.append(view);
  await view.updateComplete;
  const group = view.renderRoot.querySelector<HTMLDetailsElement>("details[data-index]");
  if (group != null) {
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    await view.updateComplete;
  }
  expect(view.renderRoot.querySelector<HTMLDetailsElement>("details.part")?.open).toBe(true);
  const formatted = view.renderRoot.querySelector<FormattedText>("formatted-text");
  if (formatted == null) throw new Error("Missing formatted output");
  await formatted.updateComplete;
  expect(formatted.renderRoot.querySelector("pre code")?.textContent).toBe(text);
  expect(formatted.renderRoot.querySelector("h1, a")).toBeNull();
  formatted.renderRoot.querySelector<HTMLButtonElement>(".code-copy-button")?.click();
  expect(writeClipboardText).toHaveBeenCalledWith(text);
});

it("collapses large user and queued text without losing content or changing short prose", async () => {
  const view = new ChatView();
  const text = "First line\n" + "pasted data\n".repeat(12);
  view.messages = [{ role: "user", parts: [{ type: "text", text }] }, { role: "assistant", parts: [{ type: "text", text: "**Short prose**" }] }];
  view.clientQueuedMessages = [{ kind: "followUp", text }];
  document.body.append(view);
  await view.updateComplete;
  const disclosures = [...view.renderRoot.querySelectorAll<HTMLDetailsElement>(".large-text")];
  expect(disclosures).toHaveLength(2);
  for (const details of disclosures) {
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("14 lines");
    details.open = true;
    const formatted = details.querySelector<FormattedText>("formatted-text");
    await formatted?.updateComplete;
    expect(formatted?.renderRoot.querySelector("pre code")?.textContent).toBe(text);
  }
  const prose = view.renderRoot.querySelector<FormattedText>("formatted-text.part");
  await prose?.updateComplete;
  expect(prose?.renderRoot.querySelector("strong")?.textContent).toBe("Short prose");
  view.renderRoot.querySelector<HTMLButtonElement>('[aria-label="Copy user message"]')?.click();
  expect(writeClipboardText).toHaveBeenCalledWith(text.trim());
  view.requestUpdate();
  await view.updateComplete;
  expect(disclosures[0]?.open).toBe(true);
});

it("updates literal code without interpreting Markdown or losing its copy button", async () => {
  const view = new FormattedText();
  view.codeBlock = true;
  view.text = "**code**";
  document.body.append(view);
  await view.updateComplete;
  view.text = "# next\n<script>danger()</script>";
  await view.updateComplete;
  expect(view.renderRoot.querySelector("pre code")?.textContent).toBe(view.text);
  expect(view.renderRoot.querySelector("script, h1, strong")).toBeNull();
  expect(view.renderRoot.querySelectorAll(".code-copy-button")).toHaveLength(1);
  const copyIcon = view.renderRoot.querySelector(".code-copy-button path")?.getAttribute("d");
  expect(copyIcon).toBeTruthy();
  view.renderRoot.querySelector<HTMLButtonElement>(".code-copy-button")?.click();
  expect(writeClipboardText).toHaveBeenCalledWith(view.text);
  await vi.waitFor(() => {
    const copied = view.renderRoot.querySelector('[aria-label="Copied code block"] path')?.getAttribute("d");
    expect(copied).toBeTruthy();
    expect(copied).not.toBe(copyIcon);
  });
});
