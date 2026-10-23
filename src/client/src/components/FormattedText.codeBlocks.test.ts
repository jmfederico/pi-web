// @vitest-environment happy-dom
import { useDeferredContent, settleDeferredContent } from "../formatting/deferredContent.testSupport";
import { afterEach, expect, it, vi } from "vitest";
import { html, render } from "lit";
import { marked } from "marked";
import type { ContentRendererInput, ContentRenderRequest } from "../../../plugin-api";
import { writeClipboardText } from "../clipboard";
import {
  DEFAULT_CODE_BLOCK_POLICY,
  PLAIN_CODE_BLOCK_POLICY,
  type CodeBlockPolicy,
} from "../formatting/codeBlockPolicy";
import { createContentRenderingService, type ChatContentRendering } from "../formatting/contentRendering";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import { ContentRenderingBoundary } from "./ContentRenderingBoundary";
import { ContentRendererHost } from "./ContentRendererHost";
import { FormattedText } from "./FormattedText";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(true) }));

const literalSource = "first\n  second";
const literalMarkdown = `## Heading\n\n**Prose** with \`inline\`.\n\n\`\`\`text\n${literalSource}\n\`\`\``;

useDeferredContent();

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function settle(view: FormattedText | ContentRendererHost): Promise<void> {
  await settleDeferredContent(view);
  await settleDeferredContent(view);
  for (const host of view.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")) {
    await settleDeferredContent(host);
    await settleDeferredContent(host);
  }
}

async function mount(text: string, codeBlocks?: CodeBlockPolicy, contentRendering?: ChatContentRendering): Promise<FormattedText> {
  const view = new FormattedText();
  view.text = text;
  if (codeBlocks !== undefined) view.codeBlocks = codeBlocks;
  view.contentRendering = contentRendering;
  document.body.append(view);
  await settle(view);
  return view;
}

function hostIn(root: ParentNode): ContentRendererHost {
  const host = root.querySelector("pi-web-content-renderer");
  if (!(host instanceof ContentRendererHost)) throw new Error("Expected a content renderer host");
  return host;
}

function button(host: ContentRendererHost, label: string): HTMLButtonElement {
  const found = [...host.renderRoot.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  if (found === undefined) throw new Error(`Missing ${label} button`);
  return found;
}

function diagramRendering(renderMode: "automatic" | "manual" = "automatic") {
  const draw = vi.fn((input: ContentRendererInput) => html`<b class="diagram-preview">${input.text}</b>`);
  // Renderer identity stays stable when only the surrounding source policy changes.
  const choices = [{ id: "diagram", label: "Diagram", renderer: { id: "diagram", renderMode, render: draw } }];
  const select = vi.fn((request: ContentRenderRequest) => request.language === "diagram" ? choices : []);
  const service = createContentRenderingService(select);
  const inspect = vi.spyOn(service, "renderMarkdown");
  return { draw, select, service, inspect };
}

it("preserves the standalone native, scrolling, copyable default and ignores a codeblocks attribute", async () => {
  expect(DEFAULT_CODE_BLOCK_POLICY).toEqual({ presentation: "code", overflow: "scroll", copy: true, previews: true });
  const view = new FormattedText();
  view.text = literalMarkdown;
  view.setAttribute("codeblocks", JSON.stringify(PLAIN_CODE_BLOCK_POLICY));
  document.body.append(view);
  await settle(view);

  expect(view.codeBlocks).toEqual(DEFAULT_CODE_BLOCK_POLICY);
  expect(view.renderRoot.querySelector(".formatted")?.classList.contains("code-blocks-scroll")).toBe(true);
  expect(view.renderRoot.querySelector("pre > code")?.textContent).toBe(`${literalSource}\n`);
  expect(view.renderRoot.querySelector(".plain-code-block")).toBeNull();
  expect(view.renderRoot.querySelectorAll(".code-block-wrapper")).toHaveLength(1);
  expect(view.renderRoot.querySelectorAll(".code-copy-button")).toHaveLength(1);
});

it.each(["plain", "code"] as const)("preserves unchanged %s source and Copy focus/feedback while trailing prose streams without matching previews", async (presentation) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const service = createContentRenderingService(() => []);
  const view = await mount(`${literalMarkdown}\n\nMore explanation after the code`, { ...DEFAULT_CODE_BLOCK_POLICY, presentation }, service);
  const source = view.renderRoot.querySelector<HTMLElement>("pre, .plain-code-block");
  const copy = view.renderRoot.querySelector<HTMLButtonElement>(".code-copy-button");
  if (source === null || copy === null) throw new Error("Expected source and its Copy button");
  const header = view.renderRoot.querySelector(".code-block-header");
  const label = header?.querySelector(".code-block-label");
  expect(label?.textContent).toBe("text");
  copy.focus();
  copy.click();
  await settle(view);
  expect(copy.getAttribute("aria-label")).toBe("Copied code block");

  for (const chunk of [" grows", " across another streamed update."]) {
    view.text += chunk;
    await settle(view);
    expect(view.renderRoot.querySelector("pre, .plain-code-block")).toBe(source);
    expect(view.renderRoot.querySelector(".code-copy-button")).toBe(copy);
    expect(view.renderRoot.querySelector(".code-block-header")).toBe(header);
    expect(header?.querySelector(".code-block-label")).toBe(label);
    expect(view.renderRoot.querySelector("pi-web-content-renderer, select")).toBeNull();
    expect(view.shadowRoot?.activeElement).toBe(copy);
    expect(copy.getAttribute("aria-label")).toBe("Copied code block");
    expect(source.textContent).toBe(`${literalSource}\n`);
  }
  expect(view.renderRoot.querySelector(".formatted")?.textContent).toContain("More explanation after the code grows across another streamed update.");
  expect(writeClipboardText).toHaveBeenCalledOnce();
  expect(writeClipboardText).toHaveBeenCalledWith(`${literalSource}\n`);
  await vi.advanceTimersByTimeAsync(1200);
  expect(copy.getAttribute("aria-label")).toBe("Copy code block");
});

it("keeps the plain chat baseline literal while bypassing all preview inspection", async () => {
  expect(PLAIN_CODE_BLOCK_POLICY).toEqual({ presentation: "plain", overflow: "wrap", copy: false, previews: false });
  const { draw, select, service, inspect } = diagramRendering();
  const lexer = vi.spyOn(marked, "lexer");
  const view = await mount(literalMarkdown.replace("```text", "```diagram"), PLAIN_CODE_BLOCK_POLICY, service);

  expect(view.renderRoot.querySelector("div.plain-code-block")?.textContent).toBe(`${literalSource}\n`);
  expect(view.renderRoot.querySelector("pre, .code-block-wrapper, .code-copy-button, pi-web-content-renderer")).toBeNull();
  expect(view.renderRoot.querySelector(".formatted")?.classList.contains("code-blocks-scroll")).toBe(false);
  expect(view.renderRoot.querySelector("h2")?.textContent).toBe("Heading");
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Prose");
  expect(view.renderRoot.querySelector("p code")?.textContent).toBe("inline");
  expect(inspect).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(draw).not.toHaveBeenCalled();
  // Ordinary Markdown parsing still runs; a second lexer pass for plugins must not.
  expect(lexer).not.toHaveBeenCalled();
});

const independentPolicies: { label: string; policy: CodeBlockPolicy }[] = [
  { label: "native presentation alone", policy: { ...PLAIN_CODE_BLOCK_POLICY, presentation: "code" } },
  { label: "horizontal overflow alone", policy: { ...PLAIN_CODE_BLOCK_POLICY, overflow: "scroll" } },
  { label: "copy controls on plain source", policy: { ...PLAIN_CODE_BLOCK_POLICY, copy: true } },
  { label: "copy controls on wrapping native source", policy: { ...PLAIN_CODE_BLOCK_POLICY, presentation: "code", copy: true } },
];

it.each(independentPolicies)("restores $label without preview inspection or stale cached controls", async ({ policy }) => {
  const { draw, select, service, inspect } = diagramRendering();
  const view = await mount(literalMarkdown, PLAIN_CODE_BLOCK_POLICY, service);
  view.codeBlocks = policy;
  await settle(view);

  // Both copy controls and their wrapper must already exist in sanitized HTML,
  // rather than being attached to the mounted DOM by updated().
  const safeHtml = toSafeMarkdownHtml(literalMarkdown, undefined, undefined, true, policy);
  const cached = document.createElement("template");
  cached.innerHTML = safeHtml;
  expect(toSafeMarkdownHtml(literalMarkdown, undefined, undefined, true, { ...policy })).toBe(safeHtml);
  for (const root of [cached.content, view.renderRoot]) {
    expect(root.querySelectorAll("pre")).toHaveLength(policy.presentation === "code" ? 1 : 0);
    expect(root.querySelectorAll("div.plain-code-block")).toHaveLength(policy.presentation === "plain" ? 1 : 0);
    expect(root.querySelector("pre > code, div.plain-code-block")?.textContent).toBe(`${literalSource}\n`);
    expect(root.querySelectorAll(".code-block-wrapper")).toHaveLength(policy.presentation === "code" || policy.copy ? 1 : 0);
    expect(root.querySelectorAll(".code-copy-button")).toHaveLength(policy.copy ? 1 : 0);
  }
  expect(view.renderRoot.querySelector(".formatted")?.classList.contains("code-blocks-scroll")).toBe(policy.overflow === "scroll");

  view.intentKey = "literal-source-new-intent";
  await settle(view);
  expect(view.renderRoot.querySelectorAll(".code-block-wrapper")).toHaveLength(policy.presentation === "code" || policy.copy ? 1 : 0);
  expect(view.renderRoot.querySelectorAll(".code-copy-button")).toHaveLength(policy.copy ? 1 : 0);

  view.codeBlocks = PLAIN_CODE_BLOCK_POLICY;
  await settle(view);
  expect(view.renderRoot.querySelector("div.plain-code-block")?.textContent).toBe(`${literalSource}\n`);
  expect(view.renderRoot.querySelector("pre, .code-block-wrapper, .code-copy-button, pi-web-content-renderer")).toBeNull();
  expect(view.renderRoot.querySelector(".formatted")?.classList.contains("code-blocks-scroll")).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(draw).not.toHaveBeenCalled();
});

it.each([
  { label: "plain, wrapping, copy-free", policy: PLAIN_CODE_BLOCK_POLICY },
  { label: "native, scrolling, copyable", policy: DEFAULT_CODE_BLOCK_POLICY },
])("enables previews for $label blocks and applies source controls only to unmatched blocks", async ({ policy }) => {
  const { draw, select, service, inspect } = diagramRendering();
  const source = "A < B & C";
  const view = await mount(`\`\`\`text\nliteral\n\`\`\`\n\n\`\`\`diagram\n${source}\n\`\`\``, { ...policy, previews: false }, service);
  expect(inspect).not.toHaveBeenCalled();
  expect(view.renderRoot.querySelector("pi-web-content-renderer")).toBeNull();

  view.codeBlocks = { ...policy, previews: true };
  await settle(view);
  const host = hostIn(view.renderRoot);
  expect(draw).toHaveBeenCalledOnce();
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ language: "diagram", text: source }));
  expect(host.codeBlocks).toMatchObject({ presentation: policy.presentation, overflow: policy.overflow, copy: policy.copy });
  expect(host.renderRoot.querySelector(".diagram-preview")?.textContent).toBe(source);
  expect(host.closest(".code-block-wrapper")).toBeNull();
  expect(view.renderRoot.querySelectorAll(".code-block-wrapper")).toHaveLength(policy.copy ? 1 : 0);
  expect(view.renderRoot.querySelectorAll(".code-copy-button")).toHaveLength(policy.copy ? 1 : 0);
  expect(view.renderRoot.querySelector(policy.presentation === "plain" ? "div.plain-code-block" : "pre > code")?.textContent).toBe("literal\n");

  button(host, "Raw").click();
  await settle(host);
  expect(host.renderRoot.querySelector(policy.presentation === "plain" ? "div.plain-code-block" : "pre > code")?.textContent).toBe(source);
  expect(host.renderRoot.querySelector(policy.presentation === "plain" ? "pre" : ".plain-code-block")).toBeNull();
  expect(host.renderRoot.querySelectorAll(".copy")).toHaveLength(policy.copy ? 1 : 0);
  expect(host.renderRoot.querySelector('[aria-label="Raw source"]')?.classList.contains("source-wrap")).toBe(policy.overflow === "wrap");
  expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(true);
});

it("disables previews by cancelling active work without disabling native source, copy, or wrapping", async () => {
  const { draw, select, service, inspect } = diagramRendering();
  const policy: CodeBlockPolicy = { ...DEFAULT_CODE_BLOCK_POLICY, overflow: "wrap" };
  const view = await mount("```diagram\nsource\n```", policy, service);
  const originalHost = hostIn(view.renderRoot);
  const signal = draw.mock.calls[0]?.[0].signal;
  expect(signal?.aborted).toBe(false);
  inspect.mockClear();
  select.mockClear();
  const lexer = vi.spyOn(marked, "lexer");

  view.codeBlocks = { ...policy, previews: false };
  await settle(view);
  expect(signal?.aborted).toBe(true);
  expect(originalHost.isConnected).toBe(false);
  expect(view.renderRoot.querySelector("pi-web-content-renderer, .plain-code-block")).toBeNull();
  expect(view.renderRoot.querySelector("pre > code")?.textContent).toBe("source\n");
  expect(view.renderRoot.querySelectorAll(".code-block-wrapper")).toHaveLength(1);
  expect(view.renderRoot.querySelectorAll(".code-copy-button")).toHaveLength(1);
  expect(view.renderRoot.querySelector(".formatted")?.classList.contains("code-blocks-scroll")).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(lexer).not.toHaveBeenCalled();
  expect(draw).toHaveBeenCalledOnce();

  view.codeBlocks = policy;
  await settle(view);
  expect(hostIn(view.renderRoot)).not.toBe(originalHost);
  expect(draw).toHaveBeenCalledTimes(2);
  expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(false);
  expect(view.renderRoot.querySelector(".code-block-wrapper, .code-copy-button")).toBeNull();
});

it("forwards source-control changes without remounting or restarting an active preview", async () => {
  const { draw, service } = diagramRendering();
  const view = await mount("```diagram\nsource\n```", DEFAULT_CODE_BLOCK_POLICY, service);
  const host = hostIn(view.renderRoot);
  const preview = host.renderRoot.querySelector(".diagram-preview");
  expect(preview).not.toBeNull();
  const signal = draw.mock.calls[0]?.[0].signal;
  const policies: CodeBlockPolicy[] = [
    { ...DEFAULT_CODE_BLOCK_POLICY, presentation: "plain" },
    { ...DEFAULT_CODE_BLOCK_POLICY, presentation: "plain", copy: false },
    { ...PLAIN_CODE_BLOCK_POLICY, previews: true },
    { ...PLAIN_CODE_BLOCK_POLICY, presentation: "code", previews: true },
  ];

  for (const policy of policies) {
    view.codeBlocks = policy;
    await settle(view);
    expect(hostIn(view.renderRoot)).toBe(host);
    expect(host.renderRoot.querySelector(".diagram-preview")).toBe(preview);
    expect(host.codeBlocks).toMatchObject({ presentation: policy.presentation, overflow: policy.overflow, copy: policy.copy });
    expect(host.renderRoot.querySelectorAll(".copy")).toHaveLength(policy.copy ? 1 : 0);
    expect(host.renderRoot.querySelector(".source-wrap, .source-scroll")).toBeNull();
    expect(view.renderRoot.querySelector(".formatted")?.classList.contains("code-blocks-scroll")).toBe(policy.overflow === "scroll");
    expect(view.renderRoot.querySelector(".code-block-wrapper, .code-copy-button")).toBeNull();
    expect(draw).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
  }

  button(host, "Raw").click();
  await settle(host);
  expect(host.renderRoot.querySelector("pre > code")?.textContent).toBe("source");
  expect(host.renderRoot.querySelector(".plain-code-block, .copy")).toBeNull();
  expect(host.renderRoot.querySelector('[aria-label="Raw source"]')?.classList.contains("source-wrap")).toBe(true);
  expect(signal?.aborted).toBe(true);
});

it.each(["text", "markdown"] as const)("keeps public plugin %s hosts on undefined, legacy source policy", async (surface) => {
  const { draw, service } = diagramRendering("manual");
  const source = "<source> & raw";
  const root = document.createElement("div");
  document.body.append(root);
  render(surface === "text"
    ? service.capability.renderText({ machineId: "local", language: "diagram", text: source })
    : service.capability.renderMarkdown({
      machineId: "local", text: `\`\`\`diagram\n${source}\n\`\`\``,
      toSafeHtml: (text) => toSafeMarkdownHtml(text, undefined, undefined, true, PLAIN_CODE_BLOCK_POLICY),
    }), root);
  if (surface === "markdown") {
    const boundary = root.querySelector("pi-web-content-rendering-boundary");
    if (!(boundary instanceof ContentRenderingBoundary)) throw new Error("Expected a public Markdown boundary");
    await settleDeferredContent(boundary);
    await settleDeferredContent(boundary);
  }
  const host = hostIn(root);
  await settle(host);

  expect(host.codeBlocks).toBeUndefined();
  expect(draw).not.toHaveBeenCalled();
  expect(host.renderRoot.querySelector("pre > code")?.textContent).toBe(source);
  expect(host.renderRoot.querySelector(".plain-code-block")).toBeNull();
  expect(host.renderRoot.querySelector('[aria-label="Raw source"]')?.classList.contains("source-scroll")).toBe(true);
  expect(host.renderRoot.querySelectorAll(".copy")).toHaveLength(1);
  button(host, "Copy source").click();
  await settle(host);
  expect(writeClipboardText).toHaveBeenCalledWith(source);
});

it.each(["plain", "code"] as const)("copies escaped %s source through the rendered copy button", async (presentation) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const source = '<script>alert("unsafe")</script>\n  <img src="x" onerror="bad()"> & <b>literal</b>';
  const view = await mount(`\`\`\`html\n${source}\n\`\`\``, { ...PLAIN_CODE_BLOCK_POLICY, presentation, copy: true });
  expect(view.renderRoot.querySelector("script, img, b")).toBeNull();
  expect(view.renderRoot.querySelector("pre > code, div.plain-code-block")?.textContent).toBe(`${source}\n`);
  const copy = view.renderRoot.querySelector<HTMLButtonElement>(".code-copy-button");
  if (copy === null) throw new Error("Expected a copy button");
  const icon = copy.querySelector("span");
  if (icon === null) throw new Error("Expected a copy button icon");

  icon.click();
  await settle(view);
  expect(writeClipboardText).toHaveBeenCalledOnce();
  expect(writeClipboardText).toHaveBeenCalledWith(`${source}\n`);
  expect(copy.getAttribute("aria-label")).toBe("Copied code block");
  await vi.runAllTimersAsync();
  await settle(view);
  expect(copy.getAttribute("aria-label")).toBe("Copy code block");
});
