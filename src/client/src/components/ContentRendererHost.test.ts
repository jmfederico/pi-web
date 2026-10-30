// @vitest-environment happy-dom
import { useDeferredContent, settleDeferredContent } from "../formatting/deferredContent.testSupport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { html } from "lit";
import type { ContentRendererContributionV5 as ContentRendererContribution } from "../../../plugin-api";
import type { ContentRendererChoice } from "../plugins/contentRenderers";
import { ContentRendererHost } from "./ContentRendererHost";
import { writeClipboardText } from "../clipboard";
import { localization } from "../localization/browser";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(true) }));

useDeferredContent();

afterEach(async () => {
  document.body.replaceChildren();
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function hostWith(choices: readonly ContentRendererChoice[]): ContentRendererHost {
  const host = new ContentRendererHost();
  host.text = "source";
  host.choices = choices;
  return host;
}

function automaticHost(draw: ContentRendererContribution["render"]): ContentRendererHost {
  return hostWith([{ id: "automatic", label: "Automatic", renderer: { id: "automatic", renderMode: "automatic", render: draw } }]);
}

function setDetailsOpen(details: HTMLDetailsElement, open: boolean): void {
  details.open = open;
}

function button(host: ContentRendererHost, label: string): HTMLButtonElement {
  const found = [...host.renderRoot.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  if (found === undefined) throw new Error(`Missing ${label} button`);
  return found;
}

it("shows every named view and Raw, and explicitly activates manual views while cancelling previous work", async () => {
  const automatic = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Automatic</b>`);
  const manual = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Manual</b>`);
  const host = hostWith([
    { id: "automatic", label: "Automatic fallback", renderer: { id: "automatic", title: "Highlighted", renderMode: "automatic", render: automatic } },
    { id: "manual", label: "Diagram", renderer: { id: "manual", render: manual } },
  ]);
  document.body.append(host);
  await settleDeferredContent(host);
  const views = [...host.renderRoot.querySelectorAll<HTMLButtonElement>(".views button")];
  expect(views.map((view) => view.textContent.trim())).toEqual(["Highlighted", "Diagram", "Raw"]);
  expect(views.map((view) => view.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
  expect(host.renderRoot.querySelector("select")).toBeNull();
  const diagram = button(host, "Diagram");
  diagram.focus();
  diagram.click();
  await settleDeferredContent(host);
  expect(manual).toHaveBeenCalledOnce();
  expect(automatic.mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(views.map((view) => view.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  expect(host.shadowRoot?.activeElement).toBe(diagram);

  host.choices = [...host.choices].reverse();
  await settleDeferredContent(host);
  expect(button(host, "Diagram")).toBe(diagram);
  expect(manual).toHaveBeenCalledOnce();
  button(host, "Raw").click();
  await settleDeferredContent(host);
  expect(manual.mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(views.map((view) => view.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
  diagram.click();
  await settleDeferredContent(host);
  expect(manual).toHaveBeenCalledTimes(2);
  expect(diagram.getAttribute("aria-pressed")).toBe("true");
});

it("scopes choice hooks to named views and Raw, keeping selection aligned with aria-pressed", async () => {
  const host = hostWith([
    { id: "first", label: "First", renderer: { id: "first", render: () => html`<b>First</b>` } },
    { id: "second", label: "Second", renderer: { id: "second", render: () => html`<b>Second</b>` } },
  ]);
  document.body.append(host);
  await settleDeferredContent(host);
  const scope = host.renderRoot.querySelector('[data-ui-context="content-views"]');
  const choices = [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  expect(choices).toEqual([button(host, "First"), button(host, "Second"), button(host, "Raw")]);
  expect(choices.every((choice) => choice.matches(".ui-choice.ui-button"))).toBe(true);
  const copy = button(host, "Copy source");
  expect(scope?.contains(copy)).toBe(false);
  expect(copy.matches(".ui-choice, [data-selected]")).toBe(false);

  const expectSelection = (expected: string[]) => {
    expect(choices.map((choice) => choice.getAttribute("data-selected"))).toEqual(expected);
    expect(choices.map((choice) => choice.getAttribute("aria-pressed"))).toEqual(expected);
  };
  expectSelection(["false", "false", "true"]);
  button(host, "First").click();
  await settleDeferredContent(host);
  expectSelection(["true", "false", "false"]);
  button(host, "Raw").click();
  await settleDeferredContent(host);
  expectSelection(["false", "false", "true"]);
});

it("updates the automatic default until a view is explicitly selected", async () => {
  const first = { id: "first", label: "First", renderer: { id: "first", renderMode: "automatic" as const, render: () => html`<b>First</b>` } };
  const last = { id: "last", label: "Last", renderer: { id: "last", renderMode: "automatic" as const, render: () => html`<b>Last</b>` } };
  const host = hostWith([first]);
  document.body.append(host);
  await settleDeferredContent(host);
  host.choices = [first, last];
  await settleDeferredContent(host);
  expect(button(host, "Last").getAttribute("aria-pressed")).toBe("true");
  button(host, "First").click();
  await settleDeferredContent(host);
  host.choices = [last];
  await settleDeferredContent(host);
  expect(button(host, "Last").getAttribute("aria-pressed")).toBe("true");
  expect(host.renderRoot.querySelector("b")?.textContent).toBe("Last");
});

it("uses last automatic defaults, ignores manual-last, and preserves explicit renderer and Raw choices", async () => {
  const first = { id: "first", label: "First", renderer: { id: "first", renderMode: "automatic" as const, render: () => html`<b>First</b>` } };
  const last = { id: "last", label: "Last", renderer: { id: "last", renderMode: "automatic" as const, render: () => html`<b>Last</b>` } };
  const manual = vi.fn(() => html`manual`);
  const host = hostWith([first, last, { id: "manual", label: "Manual", renderer: { id: "manual", render: manual } }]);
  document.body.append(host);
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector("b")?.textContent).toBe("Last");
  expect(manual).not.toHaveBeenCalled();
  button(host, "First").click();
  await settleDeferredContent(host);
  host.choices = [last, first, { ...last, id: "new" }];
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector("b")?.textContent).toBe("First");
  button(host, "Raw").click();
  await settleDeferredContent(host);
  host.choices = [first, last];
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector("pre")?.textContent).toBe("source");
  expect(button(host, "Raw").getAttribute("aria-pressed")).toBe("true");
  expect(button(host, "First").getAttribute("aria-pressed")).toBe("false");
});

it("refreshes failed manual previews on dependency changes without losing activation or Raw intent", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Preview</b>`);
  const host = hostWith([{ id: "manual", label: "Manual", renderer: { id: "manual", render: draw } }]);
  document.body.append(host);
  await settleDeferredContent(host);
  host.renderingRevision = {};
  await settleDeferredContent(host);
  expect(draw).not.toHaveBeenCalled();

  button(host, "Manual").click();
  await settleDeferredContent(host);
  draw.mock.calls[0]?.[0].fail(new Error("grammar unavailable"));
  await settleDeferredContent(host);
  expect(host.renderRoot.textContent).toContain("Preview failed");
  host.renderingRevision = {};
  await settleDeferredContent(host);
  expect(draw).toHaveBeenCalledTimes(2);
  expect(host.renderRoot.querySelector("b")?.textContent).toBe("Preview");
  expect(host.renderRoot.textContent).not.toContain("Preview failed");
  draw.mock.calls[0]?.[0].fail(new Error("stale failure"));
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector("b")?.textContent).toBe("Preview");

  host.renderingRevision = {};
  await settleDeferredContent(host);
  expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(true);
  expect(draw).toHaveBeenCalledTimes(3);
  button(host, "Raw").click();
  await settleDeferredContent(host);
  host.renderingRevision = {};
  await settleDeferredContent(host);
  expect(draw).toHaveBeenCalledTimes(3);
  expect(host.renderRoot.querySelector("pre")?.textContent).toBe("source");
  expect(button(host, "Raw").getAttribute("aria-pressed")).toBe("true");
});

it("propagates metadata and cancels obsolete rendering for each metadata change", async () => {
  const inputs: import("../../../plugin-api").ContentRendererInputV5[] = [];
  const host = automaticHost((input) => { inputs.push(input); return html`preview`; });
  host.machineId = "local";
  host.language = "test";
  host.filePath = "a.test";
  document.body.append(host);
  await settleDeferredContent(host);
  expect(inputs[0]).toMatchObject({ text: "source", machineId: "local", language: "test", filePath: "a.test" });
  for (const key of ["machineId", "language", "filePath"] as const) {
    const previous = inputs.at(-1);
    host[key] = "changed";
    await settleDeferredContent(host);
    expect(previous?.signal.aborted).toBe(true);
    expect(inputs.at(-1)?.[key]).toBe("changed");
  }
  expect(inputs).toHaveLength(4);
});

it("shows the renderer label and an accessible Copy icon without activating a manual preview", async () => {
  const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Preview</b>`);
  const host = hostWith([{ id: "manual", label: "Mermaid / diagram", renderer: { id: "manual", render: draw } }]);
  document.body.append(host);
  await settleDeferredContent(host);
  const view = button(host, "Mermaid / diagram");
  expect(view.closest(".code-block-header")).not.toBeNull();
  expect(draw).not.toHaveBeenCalled();
  const copy = button(host, "Copy source");
  expect(copy.textContent).toBe("⧉");
  expect(copy.getAttribute("title")).toBe("Copy source");
  expect(copy.querySelector('span[aria-hidden="true"]')).not.toBeNull();
  expect(copy.closest(".code-block-header")?.nextElementSibling?.id).toBe("content");
  view.click();
  await settleDeferredContent(host);
  expect(button(host, "Mermaid / diagram")).toBe(view);
  expect(host.renderRoot.querySelector("b")?.textContent).toBe("Preview");
  expect(host.renderRoot.querySelector(".copy")).toBe(copy);
});

it("copies source from a visible preview and retains accessible success/failure feedback on the icon", async () => {
  const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Rendered diagram</b>`);
  const host = automaticHost(draw);
  document.body.append(host);
  await settleDeferredContent(host);
  const copy = button(host, "Copy source");
  copy.click();
  await settleDeferredContent(host);
  await settleDeferredContent(host);
  expect(writeClipboardText).toHaveBeenCalledWith("source");
  expect(copy.textContent).toBe("✓");
  expect(copy.getAttribute("aria-label")).toBe("Copied source");
  expect(copy.getAttribute("title")).toBe("Copied source");
  expect(host.renderRoot.querySelector('[role="status"]')?.textContent).toBe("Copied source");

  vi.mocked(writeClipboardText).mockResolvedValueOnce(false);
  copy.click();
  await settleDeferredContent(host);
  await settleDeferredContent(host);
  expect(copy.textContent).toBe("⧉");
  expect(copy.getAttribute("aria-label")).toBe("Failed to copy source");
  expect(copy.getAttribute("title")).toBe("Failed to copy source");
  expect(host.renderRoot.querySelector('[role="status"]')?.textContent).toBe("Failed to copy source");
  expect(host.renderRoot.querySelector("b")?.textContent).toBe("Rendered diagram");
  expect(draw).toHaveBeenCalledOnce();
});

it("keeps consumer-owned external controls outside the standard embedded frame", async () => {
  const host = automaticHost(() => html`<b>Preview</b>`);
  host.externalControls = true;
  document.body.append(host);
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector(".code-block-frame, .code-block-header, .code-block-copy")).toBeNull();
  expect(host.renderRoot.querySelector("b")?.textContent).toBe("Preview");
});

it("attaches source-policy modifiers only to raw source, never to preview content or its ancestors", async () => {
  const draw = vi.fn<ContentRendererContribution["render"]>(() => html`
    <pre class="renderer-owned-code">Preview code</pre>
    <div class="plain-code-block">Preview text</div>
  `);
  const host = automaticHost(draw);
  host.codeBlocks = { presentation: "code", overflow: "wrap", copy: true };
  document.body.append(host);
  await settleDeferredContent(host);
  const preview = host.renderRoot.querySelector(".preview");
  expect(preview).not.toBeNull();
  const previewCode = preview?.querySelector("pre");
  const previewText = preview?.querySelector(".plain-code-block");

  for (const overflow of ["wrap", "scroll"] as const) {
    host.codeBlocks = { presentation: "code", overflow, copy: true };
    await settleDeferredContent(host);
    expect(host.renderRoot.querySelector(".source-wrap, .source-scroll")).toBeNull();
    expect(host.renderRoot.querySelector(".preview")).toBe(preview);
    expect(preview?.querySelector("pre")).toBe(previewCode);
    expect(preview?.querySelector(".plain-code-block")).toBe(previewText);
    expect(draw).toHaveBeenCalledOnce();
    expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(false);
  }

  button(host, "Raw").click();
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector("#content > pre.source-scroll")?.textContent).toBe("source");
  expect(host.renderRoot.querySelector(".preview")).toBeNull();
  expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(true);

  host.codeBlocks = { presentation: "plain", overflow: "wrap", copy: true };
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector("#content > .plain-code-block.source-wrap")?.textContent).toBe("source");
  expect(host.renderRoot.querySelector("#content")?.className).toBe("");
});

it("translates controls and cached feedback live without restarting previews or changing source", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const remove = localization.registerCatalog({ id: "test:content-renderer-fr", namespace: "core.content-renderer", locale: "fr", load: () => Promise.resolve({
    controls: "Commandes du bloc", raw: "Brut", rawSource: "Source brute", renderedContent: "Contenu rendu",
    previewFailed: "Échec de l’aperçu. La source brute est affichée ci-dessous.", copySource: "Copier la source",
    copiedSource: "Source copiée", copyFailed: "Échec de la copie",
  }) });
  try {
    const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>User diagram</b>`);
    const host = automaticHost(draw);
    host.text = 'const value = "مرحبا <b>user text</b>";';
    document.body.append(host);
    await settleDeferredContent(host);
    button(host, "Copy source").click();
    await settleDeferredContent(host);
    expect(button(host, "Copied source")).toBeDefined();
    const preview = host.renderRoot.querySelector(".preview");
    await localization.setPreferences({ language: "fr", formatLocale: "de" });
    await settleDeferredContent(host);
    expect(host.renderRoot.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Commandes du bloc");
    expect(button(host, "Brut")).toBeDefined();
    expect(button(host, "Source copiée").textContent).toBe("✓");
    expect(host.renderRoot.querySelector('[role="status"]')?.textContent).toBe("Source copiée");
    expect(host.renderRoot.querySelector(".preview")).toBe(preview);
    expect(preview?.getAttribute("aria-label")).toBe("Contenu rendu");
    expect(draw).toHaveBeenCalledOnce();
    expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(false);
    vi.mocked(writeClipboardText).mockResolvedValueOnce(false);
    button(host, "Source copiée").click();
    await settleDeferredContent(host);
    expect(button(host, "Échec de la copie")).toBeDefined();
    draw.mock.calls[0]?.[0].fail(new Error("Private raw diagnostic"));
    await settleDeferredContent(host);
    expect(host.renderRoot.textContent).toContain("Échec de l’aperçu");
    expect(host.renderRoot.textContent).not.toContain("Private raw diagnostic");
    expect(host.renderRoot.querySelector("pre")?.textContent).toBe(host.text);
    expect(host.renderRoot.querySelector("pre")?.getAttribute("dir")).toBe("ltr");
    await localization.setPreferences({ language: "ar-XB", formatLocale: "en" });
    await settleDeferredContent(host);
    expect(host.renderRoot.textContent).not.toContain("Échec de l’aperçu");
    expect(host.renderRoot.querySelector("pre")?.textContent).toBe(host.text);
    expect(writeClipboardText).toHaveBeenCalledWith(host.text);
    expect(draw).toHaveBeenCalledOnce();
  } finally { remove(); await localization.ready; }
});

it("keeps plain raw source LTR under pseudo RTL and refreshes labels after reconnect", async () => {
  const host = hostWith([]);
  host.text = "user source مرحبا";
  host.codeBlocks = { presentation: "plain", overflow: "wrap", copy: true };
  document.body.append(host);
  await settleDeferredContent(host);
  host.remove();
  await localization.setPreferences({ language: "ar-XB", formatLocale: "en" });
  document.body.append(host);
  await settleDeferredContent(host);
  const source = host.renderRoot.querySelector(".plain-code-block");
  expect(source?.textContent).toBe(host.text);
  expect(source?.getAttribute("dir")).toBe("ltr");
  expect(source?.getAttribute("aria-label")).not.toBe("Raw source");
  expect(host.renderRoot.querySelector(".copy")?.getAttribute("aria-label")).not.toBe("Copy source");
});

describe("content renderer disclosure lifecycle", () => {
  it("retains a closed group's body without starting automatic work, and aborts/restarts only its renderer on toggles", async () => {
    const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Preview</b>`);
    const host = automaticHost(draw);
    const group = document.createElement("details");
    const body = document.createElement("div");
    body.append(host);
    group.append(document.createElement("summary"), body);
    document.body.append(group);
    await settleDeferredContent(host);

    expect(draw).not.toHaveBeenCalled();
    expect(host.isConnected).toBe(true);
    expect(host.renderRoot.querySelector("pre")?.textContent).toBe("source");

    setDetailsOpen(group, true);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();
    const first = draw.mock.calls[0]?.[0];
    expect(first?.signal.aborted).toBe(false);
    expect(host.renderRoot.querySelector("b")?.textContent).toBe("Preview");

    setDetailsOpen(group, false);
    await settleDeferredContent(host);
    expect(first?.signal.aborted).toBe(true);
    expect(group.lastElementChild).toBe(body);
    expect(body.firstElementChild).toBe(host);
    expect(host.isConnected).toBe(true);
    expect(draw).toHaveBeenCalledOnce();

    setDetailsOpen(group, true);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(body.firstElementChild).toBe(host);
    expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(false);
    expect(draw.mock.calls[1]?.[0].signal).not.toBe(first?.signal);
    first?.fail(new Error("obsolete closed preview"));
    await settleDeferredContent(host);
    expect(host.renderRoot.querySelector("b")?.textContent).toBe("Preview");
    expect(host.renderRoot.textContent).not.toContain("Preview failed");
  });

  it("preserves view buttons and manual activation across temporary closure without intent memory", async () => {
    const first = vi.fn<ContentRendererContribution["render"]>(() => html`<b>First</b>`);
    const second = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Second</b>`);
    const host = hostWith([
      { id: "first", label: "First", renderer: { id: "first", renderMode: "manual", render: first } },
      { id: "second", label: "Second", renderer: { id: "second", renderMode: "manual", render: second } },
    ]);
    const group = document.createElement("details");
    group.open = true;
    group.append(document.createElement("summary"), host);
    document.body.append(group);
    await settleDeferredContent(host);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    const view = button(host, "Second");
    expect(view.closest(".code-block-header")).not.toBeNull();
    view.click();
    await settleDeferredContent(host);
    expect(second).toHaveBeenCalledOnce();

    setDetailsOpen(group, false);
    await settleDeferredContent(host);
    expect(second.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(view.getAttribute("aria-pressed")).toBe("false");
    expect(button(host, "Raw").getAttribute("aria-pressed")).toBe("true");

    setDetailsOpen(group, true);
    await settleDeferredContent(host);
    expect(group.querySelector("pi-web-content-renderer")).toBe(host);
    expect(button(host, "Second")).toBe(view);
    expect(view.getAttribute("aria-pressed")).toBe("true");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
    expect(host.renderRoot.querySelector("b")?.textContent).toBe("Second");

    button(host, "Raw").click();
    await settleDeferredContent(host);
    setDetailsOpen(group, false);
    await settleDeferredContent(host);
    setDetailsOpen(group, true);
    await settleDeferredContent(host);
    expect(second).toHaveBeenCalledTimes(2);
    expect(host.renderRoot.querySelector("pre")?.textContent).toBe("source");
    expect(view.getAttribute("aria-pressed")).toBe("false");
  });

  it("requires every nested details ancestor to be open, including outside a shadow host", async () => {
    const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Preview</b>`);
    const host = automaticHost(draw);
    const outer = document.createElement("details");
    const bridge = document.createElement("div");
    const shadow = bridge.attachShadow({ mode: "open" });
    const inner = document.createElement("details");
    inner.open = true;
    inner.append(document.createElement("summary"), host);
    shadow.append(inner);
    outer.append(document.createElement("summary"), bridge);
    document.body.append(outer);
    await settleDeferredContent(host);
    expect(draw).not.toHaveBeenCalled();

    setDetailsOpen(inner, false);
    await settleDeferredContent(host);
    setDetailsOpen(outer, true);
    await settleDeferredContent(host);
    expect(draw).not.toHaveBeenCalled();
    setDetailsOpen(inner, true);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();

    setDetailsOpen(outer, false);
    await settleDeferredContent(host);
    expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(true);
    setDetailsOpen(inner, false);
    await settleDeferredContent(host);
    setDetailsOpen(inner, true);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();
    setDetailsOpen(outer, true);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledTimes(2);
    setDetailsOpen(inner, false);
    await settleDeferredContent(host);
    expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(true);
  });

  it("cancels on detach, removes old listeners, and collects new ancestors on reconnect", async () => {
    const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Preview</b>`);
    const host = automaticHost(draw);
    const oldGroup = document.createElement("details");
    oldGroup.open = true;
    oldGroup.append(document.createElement("summary"), host);
    document.body.append(oldGroup);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();

    host.remove();
    expect(draw.mock.calls[0]?.[0].signal.aborted).toBe(true);
    const requestUpdate = vi.spyOn(host, "requestUpdate");
    setDetailsOpen(oldGroup, false);
    expect(requestUpdate).not.toHaveBeenCalled();

    const newGroup = document.createElement("details");
    newGroup.append(document.createElement("summary"), host);
    document.body.append(newGroup);
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledOnce();
    requestUpdate.mockClear();
    setDetailsOpen(oldGroup, true);
    expect(requestUpdate).not.toHaveBeenCalled();
    setDetailsOpen(newGroup, true);
    expect(requestUpdate).toHaveBeenCalledOnce();
    await settleDeferredContent(host);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw.mock.calls[1]?.[0].signal.aborted).toBe(false);
  });
});
