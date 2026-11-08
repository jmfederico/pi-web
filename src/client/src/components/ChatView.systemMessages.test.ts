// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { html } from "lit";
import type { TranscriptMessageRendererInput } from "../../../plugin-api";
import { normalizeMessages } from "../chatMessages";
import { messageActionMessage } from "../plugins/messageActions";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
import type { TranscriptRendererHost } from "./TranscriptRendererHost";

const body = "  **Warning:** the child completed its task.\n\nMessage from session quoted-sender:\n\nKeep this quoted text intact.  \n";
const content = `Message from session text-only-sender:\n\n${body}`;

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelector("base")?.remove();
  localStorage.clear();
  vi.unstubAllEnvs();
});

async function mount(messages: unknown[]) {
  const view = new ChatView();
  view.machineId = "remote /?&#";
  view.sessionId = "recipient";
  view.workspaceContext = { machineId: view.machineId, projectId: "receiving-project", workspaceId: "receiving-workspace", root: "/repo" };
  view.messages = normalizeMessages(messages);
  document.body.append(view);
  await view.updateComplete;
  return view;
}

it("links only the metadata sender on the message's machine without borrowing the recipient workspace", async () => {
  vi.stubEnv("BASE_URL", "./");
  const base = document.createElement("base");
  base.href = "https://pi.example.test/nested/pi-web/?project=old&workspace=old";
  document.head.append(base);
  const sender = "sender /?&#<name>";
  const view = await mount([{ role: "custom", customType: "session.message", display: true, content, details: { sendingSessionId: sender, body } }]);
  const link = view.renderRoot.querySelector<HTMLAnchorElement>("a");
  expect(link?.textContent).toBe(sender);
  expect(link?.href).toBe(`https://pi.example.test/nested/pi-web/?${new URLSearchParams({ machine: view.machineId, session: sender, view: "chat" })}`);
  expect(view.renderRoot.querySelector<FormattedText>("formatted-text")?.text).toBe(body);

  view.machineId = "local";
  await view.updateComplete;
  expect(new URL(view.renderRoot.querySelector<HTMLAnchorElement>("a")?.href ?? "").searchParams.get("machine")).toBe("local");
});

it("keeps legacy, unknown and malformed messages unchanged without inferring presentation from text", async () => {
  const view = await mount([
    { role: "system", content },
    { role: "custom", customType: "extension.notice", content, details: { sendingSessionId: "not-a-session-message", body } },
    ...[undefined, null, "sender", {}, { sendingSessionId: "legacy-sender" },
      { sendingSessionId: 42, body }, { sendingSessionId: "   ", body }, { sendingSessionId: "sender", body: 42 },
    ].map((details) => ({ role: "custom", customType: "session.message", content, details })),
  ]);
  expect(view.renderRoot.querySelector("a")).toBeNull();
  const bodies = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
  expect(bodies.map((element) => element.text)).toEqual(Array<string>(10).fill(content));
});

it("renders mixed old and new history without changing the original record or action content", async () => {
  const legacy = { role: "custom", customType: "session.message", entryId: "old", content, details: { sendingSessionId: "text-only-sender" } };
  const current = { ...legacy, entryId: "new", details: { ...legacy.details, body } };
  const snapshot = structuredClone([legacy, current]);
  const view = await mount([legacy, current]);
  expect([...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")].map((element) => element.text)).toEqual([content, body]);
  expect(view.renderRoot.querySelectorAll("a")).toHaveLength(1);
  expect(view.messages.map((message) => messageActionMessage(message)?.text)).toEqual([content, content]);
  expect([legacy, current]).toEqual(snapshot);
});

it("retains custom-renderer selection and restores the unchanged session-message body on removal", async () => {
  const details = { sendingSessionId: "sender", body };
  const view = await mount([{ role: "custom", customType: "session.message", content, details }]);
  const render = vi.fn((input: TranscriptMessageRendererInput) => html`<p>${String(input.entry.content)}</p>`);
  view.transcriptRenderers = [{ id: "test:session", pluginId: "test", localId: "session", target: "custom-message", customType: "session.message", render }];
  await view.updateComplete;
  const host = view.renderRoot.querySelector<TranscriptRendererHost>("pi-web-transcript-renderer");
  await host?.updateComplete;
  expect(render.mock.calls[0]?.[0].entry).toMatchObject({ content, details });
  view.transcriptRenderers = [];
  await view.updateComplete;
  expect(view.renderRoot.querySelector("pi-web-transcript-renderer")).toBeNull();
  expect(view.renderRoot.querySelector<FormattedText>("formatted-text")?.text).toBe(body);
  expect(view.renderRoot.querySelector("a")?.textContent).toBe("sender");
});
