// @vitest-environment happy-dom
import { html, svg } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { LocalizationService } from "../../src/client/src/localization/service";
import { createPluginLocalization } from "../../src/client/src/plugins/localization";
import { MermaidPreview } from "./MermaidPreview";
import { createMermaidContent } from "./mermaidLocalization";
import type { MermaidDrawing, MermaidRenderer } from "./mermaidEngine";
import plugin from "./pi-web-plugin";

customElements.define("pi-web-mermaid-preview", MermaidPreview);
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

function owner(service: LocalizationService, id = "mermaid") {
  const lifetime = new AbortController();
  const localization = createPluginLocalization(service, "mermaid", id, lifetime.signal);
  return { localization, lifetime };
}

it("updates pending status and image names without redrawing or modifying diagram source", async () => {
  const service = new LocalizationService({ development: true });
  const { localization, lifetime } = owner(service);
  const element = new MermaidPreview();
  element.content = createMermaidContent(localization);
  let resolve: (drawing: MermaidDrawing) => void = () => { throw new Error("Missing resolver"); };
  const render = vi.fn<MermaidRenderer["render"]>(() => new Promise((done) => { resolve = done; }));
  element.engine = { render };
  const input = { text: "graph TD; A[User text]-->B[مرحبا]", signal: new AbortController().signal, fail: vi.fn() };
  element.input = input;
  document.body.append(element);
  await element.updateComplete;
  expect(element.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe("Rendering diagram…");
  await service.setPreferences({ language: "en-XA", formatLocale: "en" });
  await element.updateComplete;
  expect(element.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain("Rëndërïng");
  resolve({ svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", width: 10, height: 10 });
  await vi.waitFor(() => { expect(element.shadowRoot?.querySelector("img")).not.toBeNull(); });
  const image = element.shadowRoot?.querySelector("img");
  const source = image?.src;
  expect(image?.alt).toContain("Mërmáïd");
  await service.setPreferences({ language: "ar-XB", formatLocale: "en" });
  await element.updateComplete;
  expect(image?.alt).toContain("\u202e");
  expect(element.shadowRoot?.querySelector("img")).toBe(image);
  expect(image?.src).toBe(source);
  expect(render).toHaveBeenCalledOnce();
  expect(render.mock.calls[0]?.[0].text).toBe(input.text);
  expect(input.fail).not.toHaveBeenCalled();
  element.remove();
  lifetime.abort();
  await element.updateComplete;
});

it("releases the previous portable activation and observes only the connected current owner", async () => {
  const firstService = new LocalizationService({ development: true });
  const first = owner(firstService);
  const element = new MermaidPreview();
  element.content = createMermaidContent(first.localization);
  document.body.append(element);
  await element.updateComplete;
  const secondService = new LocalizationService({ development: true });
  const second = owner(secondService, "remote-mermaid");
  element.content = createMermaidContent(second.localization);
  await element.updateComplete;
  first.lifetime.abort();
  const update = vi.spyOn(element, "requestUpdate");
  await firstService.setPreferences({ language: "en-XA", formatLocale: "en" });
  expect(update).not.toHaveBeenCalled();
  await secondService.setPreferences({ language: "en-XA", formatLocale: "en" });
  await element.updateComplete;
  expect(element.shadowRoot?.textContent).toContain("Rëndërïng");
  element.remove();
  await element.updateComplete;
  update.mockClear();
  await secondService.setPreferences({ language: "en", formatLocale: "en" });
  expect(update).not.toHaveBeenCalled();
  document.body.append(element);
  await element.updateComplete;
  expect(element.shadowRoot?.querySelector("p")?.textContent).toBe("Rendering diagram…");
  element.remove();
  second.lifetime.abort();
});

it("exposes a live translated renderer title and passes activation content to the preview", async () => {
  const service = new LocalizationService({ development: true });
  const { localization, lifetime } = owner(service);
  const result = plugin.activate({ apiVersion: 5, pluginId: "mermaid", runtimePluginId: "mermaid", html, svg, localization,
    signal: lifetime.signal, lifetimeSignal: lifetime.signal });
  const renderer = result.contributions.contentRenderers[0];
  expect(renderer?.title).toBe("Diagram");
  const remove = localization.registerCatalog({ id: "fr", namespace: "plugin:mermaid:preview", locale: "fr",
    load: () => Promise.resolve({ diagram: "Schéma", rendering: "Création du schéma…", frameTitle: "Schéma Mermaid" }) });
  await service.setPreferences({ language: "fr", formatLocale: "en" });
  expect(renderer?.title).toBe("Schéma");
  const container = document.createElement("div");
  const { render } = await import("lit");
  render(renderer?.render({ text: "source", signal: new AbortController().signal, fail: vi.fn() }), container);
  const preview = container.querySelector<MermaidPreview>("pi-web-mermaid-preview");
  expect(preview?.content?.messages.t("rendering")).toBe("Création du schéma…");
  expect(preview?.engine).toBeDefined();
  remove();
  result.dispose();
  lifetime.abort();
});
