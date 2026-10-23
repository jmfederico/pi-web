// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { render } from "lit";
import { useDeferredContent, settleDeferredContent } from "./deferredContent.testSupport";
import { PluginRegistry } from "../plugins/registry";
import { adaptPublicPlugin } from "../plugins/publicContext";
import type { ContentRendererHost } from "../components/ContentRendererHost";
import type { TokenHighlightedCode } from "../../../../pi-web-plugins/code-highlight/TokenHighlightedCode";
import codeHighlight from "../../../../pi-web-plugins/code-highlight/pi-web-plugin";
import type { MermaidPreview } from "../../../../pi-web-plugins/mermaid/MermaidPreview";
import mermaid from "../../../../pi-web-plugins/mermaid/pi-web-plugin";

const registries: PluginRegistry[] = [];
useDeferredContent();
afterEach(async () => {
  document.body.replaceChildren();
  for (const registry of registries.splice(0)) await registry.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function registryWithMermaid(options: ConstructorParameters<typeof PluginRegistry>[0] = {}) {
  const registry = new PluginRegistry(options);
  registries.push(registry);
  await registry.register({ id: "code-highlight", plugin: adaptPublicPlugin(codeHighlight) });
  await registry.register({ id: "mermaid", plugin: adaptPublicPlugin(mermaid) });
  return registry;
}

function viewButton(host: ContentRendererHost, label: string): HTMLButtonElement {
  const button = [...host.renderRoot.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  if (button === undefined) throw new Error(`Missing ${label} button`);
  return button;
}

it("offers Highlighted, Diagram, and Raw for the same Mermaid source without loading the diagram engine for highlighting", async () => {
  const fetchEngine = vi.fn(() => Promise.resolve(new Response("/* trusted test engine */")));
  vi.stubGlobal("fetch", fetchEngine);
  const registry = await registryWithMermaid();
  const text = 'flowchart LR\n  A[Raw] --> B["<img src=x onerror=alert(1)>"]';
  const request = { machineId: "local", text, language: "mermaid" };
  expect(registry.contentRendering.listRenderers(request)).toEqual([
    { id: "code-highlight:highlighted", label: "Highlighted", title: "Highlighted", renderMode: "automatic" },
    { id: "mermaid:diagram", label: "Diagram", title: "Diagram", renderMode: "manual" },
  ]);
  render(registry.contentRendering.renderText(request), document.body);
  const host = document.body.querySelector<ContentRendererHost>("pi-web-content-renderer");
  if (host === null) throw new Error("Expected source view host");
  await settleDeferredContent(host);
  const highlighted = host.renderRoot.querySelector<TokenHighlightedCode>("pi-web-token-highlighted-code");
  if (highlighted === null) throw new Error("Expected the bundled highlighting renderer");
  await vi.waitFor(() => { expect(highlighted.renderRoot.querySelector(".hljs-keyword")?.textContent).toBe("flowchart"); });
  expect(highlighted.renderRoot.querySelector("code")?.textContent).toBe(text);
  expect(highlighted.renderRoot.querySelector("img, script")).toBeNull();
  expect(fetchEngine).not.toHaveBeenCalled();

  viewButton(host, "Raw").click();
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector("pre code")?.textContent).toBe(text);
  expect(host.renderRoot.querySelector("select")).toBeNull();
  expect(fetchEngine).not.toHaveBeenCalled();
  viewButton(host, "Diagram").click();
  await settleDeferredContent(host);
  const diagram = host.renderRoot.querySelector<MermaidPreview>("pi-web-mermaid-preview");
  if (diagram === null) throw new Error("Expected diagram renderer");
  await vi.waitFor(() => { expect(diagram.renderRoot.querySelector("iframe")).not.toBeNull(); });
  expect(diagram.input?.text).toBe(text);
  expect(diagram.renderRoot.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(fetchEngine).toHaveBeenCalledOnce();

  viewButton(host, "Highlighted").click();
  await settleDeferredContent(host);
  expect(diagram.input?.signal.aborted).toBe(true);
  expect(host.renderRoot.querySelector("pi-web-mermaid-preview")).toBeNull();
  expect(host.renderRoot.querySelector("pi-web-token-highlighted-code")).not.toBeNull();
});

it("adds filename-based grammar support without creating extra renderer choices and removes it when Mermaid is disabled", async () => {
  let enabled = true;
  const registry = await registryWithMermaid({ isContributionEnabled: (id) => id !== "mermaid" || enabled });
  for (const filePath of ["chart.mmd", "chart.MERMAID"]) {
    const request = { machineId: "local", text: "graph TD; A-->B", filePath };
    expect(registry.contentRendering.listRenderers(request).map(({ label }) => label)).toEqual(["Highlighted", "Diagram"]);
    expect(await registry.syntaxHighlighting.highlight({ ...request, signal: new AbortController().signal })).toEqual(expect.arrayContaining([
      { from: 0, to: 5, kind: "keyword" },
    ]));
  }
  enabled = false;
  const request = { machineId: "local", text: "graph TD; A-->B", language: "mermaid" };
  expect(registry.contentRendering.listRenderers(request)).toEqual([]);
  expect(await registry.syntaxHighlighting.highlight({ ...request, signal: new AbortController().signal })).toBeUndefined();
});
