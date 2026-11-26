// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentRendererInput } from "@jmfederico/pi-web/plugin-api";
import { LocalizationService } from "../../src/client/src/localization/service";
import { createPluginLocalization } from "../../src/client/src/plugins/localization";
import { createMermaidContent } from "./mermaidLocalization";
import type { MermaidDrawing, MermaidRenderer } from "./mermaidEngine";
import { MermaidPreview } from "./MermaidPreview";

customElements.define("mermaid-preview-test", MermaidPreview);
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"300\" height=\"120\"><text>A &amp; B</text></svg>";

function deferred() {
  let resolve: (drawing: MermaidDrawing) => void = () => { throw new Error("Not pending"); };
  let reject: (error: unknown) => void = () => { throw new Error("Not pending"); };
  const promise = new Promise<MermaidDrawing>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function preview(input: ContentRendererInput, engine: MermaidRenderer) {
  const element = new MermaidPreview();
  element.content = createMermaidContent(createPluginLocalization(new LocalizationService(), "mermaid", "mermaid", new AbortController().signal));
  element.engine = engine;
  element.input = input;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

const image = (element: MermaidPreview) => element.shadowRoot?.querySelector("img") ?? null;

describe("Mermaid preview", () => {
  it("requires renderer support rather than silently loading on older API v4 hosts", async () => {
    const { default: plugin } = await import("./pi-web-plugin");
    expect(plugin.requires).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: "pi-web", id: "content-rendering", version: 1 }),
      expect.objectContaining({ pluginId: "pi-web", id: "stylesheet-integration", version: 1 }),
    ]));
  });

  it("shows the shared engine's output as a script-free image that reserves its size", async () => {
    const pending = deferred();
    const render = vi.fn<MermaidRenderer["render"]>(() => pending.promise);
    const input = { text: "graph TD; A-->B", signal: new AbortController().signal, fail: vi.fn() };
    const element = await preview(input, { render });
    const drawn = render.mock.calls[0]?.[0];
    expect(drawn).toMatchObject({ text: input.text, signal: input.signal });
    expect(drawn?.width).toBeGreaterThan(0);
    expect(element.shadowRoot?.querySelector('[role="status"]')).not.toBeNull();

    pending.resolve({ svg, width: 300, height: 120 });
    await vi.waitFor(() => { expect(image(element)).not.toBeNull(); });
    const img = image(element);
    expect(img?.getAttribute("width")).toBe("300");
    expect(img?.getAttribute("height")).toBe("120");
    const source = img?.getAttribute("src") ?? "";
    expect(source.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(source.slice(source.indexOf(",") + 1))).toBe(svg);
    expect(element.shadowRoot?.querySelector("iframe")).toBeNull();
    expect(input.fail).not.toHaveBeenCalled();
  });

  it("names the image from the diagram's own accessible title and description, falling back to the generic name", async () => {
    const generic = await preview({ text: "graph TD; A", signal: new AbortController().signal, fail: vi.fn() },
      { render: () => Promise.resolve({ svg, width: 300, height: 120 }) });
    await vi.waitFor(() => { expect(image(generic)).not.toBeNull(); });
    expect(image(generic)?.alt).toBe("Mermaid diagram");
    expect(image(generic)?.hasAttribute("aria-describedby")).toBe(false);

    const authored = await preview({ text: "graph TD; B", signal: new AbortController().signal, fail: vi.fn() },
      { render: () => Promise.resolve({ svg, width: 300, height: 120, title: "Checkout flow", description: "Cart to payment" }) });
    await vi.waitFor(() => { expect(image(authored)).not.toBeNull(); });
    const img = image(authored);
    expect(img?.alt).toBe("Checkout flow");
    const described = authored.shadowRoot?.getElementById(img?.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Cart to payment");
  });

  it("reports engine failures, clears on abort, and ignores results for detached or replaced work", async () => {
    const failing = { render: vi.fn().mockRejectedValue(new Error("Mermaid could not render this source")) };
    const failed = { text: "bad", signal: new AbortController().signal, fail: vi.fn() };
    await preview(failed, failing);
    await vi.waitFor(() => { expect(failed.fail).toHaveBeenCalledWith(new Error("Mermaid could not render this source")); });

    const controller = new AbortController();
    const shown = { text: "good", signal: controller.signal, fail: vi.fn() };
    const element = await preview(shown, { render: () => Promise.resolve({ svg, width: 300, height: 120 }) });
    await vi.waitFor(() => { expect(image(element)).not.toBeNull(); });
    controller.abort();
    await element.updateComplete;
    expect(image(element)).toBeNull();

    const late = deferred();
    const detached = { text: "late", signal: new AbortController().signal, fail: vi.fn() };
    const removed = await preview(detached, { render: () => late.promise });
    removed.remove();
    late.reject(new Error("too late"));
    await Promise.resolve();
    expect(detached.fail).not.toHaveBeenCalled();

    const previous = deferred();
    const replaced = { text: "same", signal: new AbortController().signal, fail: vi.fn() };
    const switched = await preview(replaced, { render: () => previous.promise });
    const active = vi.fn<MermaidRenderer["render"]>().mockResolvedValue({ svg, width: 300, height: 120 });
    switched.engine = { render: active };
    await vi.waitFor(() => { expect(image(switched)).not.toBeNull(); });
    previous.reject(new Error("previous machine unavailable"));
    await Promise.resolve();
    expect(replaced.fail).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledOnce();
  });
});
