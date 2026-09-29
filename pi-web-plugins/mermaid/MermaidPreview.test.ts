// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentRendererInput } from "@jmfederico/pi-web/plugin-api";
import { mermaidFrameDocument } from "./MermaidPreview";

let tag = 0;
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function preview(input: ContentRendererInput, loadEngine?: () => Promise<string>) {
  vi.resetModules();
  const { MermaidPreview } = await import("./MermaidPreview");
  customElements.define(`mermaid-test-${String(++tag)}`, MermaidPreview);
  const element = new MermaidPreview();
  element.input = input;
  if (loadEngine !== undefined) element.loadEngine = loadEngine;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("Mermaid isolation and lifecycle", () => {
  it("requires renderer support rather than silently loading on older API v4 hosts", async () => {
    const { default: plugin } = await import("./pi-web-plugin");
    expect(plugin.requires).toEqual([expect.objectContaining({ pluginId: "pi-web", id: "content-rendering", version: 1 })]);
  });

  it("embeds only trusted engine code under a no-network policy and escapes script terminators", () => {
    const document = mermaidFrameDocument('const value = "</script><script>bad()</script>";');
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("script-src 'unsafe-inline'");
    expect(document).toContain("<\\/script>");
    expect(document.match(/<\/script>/gu)).toHaveLength(1);
  });

  it("accepts messages only from its opaque frame, forwards source, reports failure, and removes the frame on abort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("/* trusted engine */")));
    const controller = new AbortController();
    const fail = vi.fn();
    const element = await preview({ text: "graph TD; A-->B", signal: controller.signal, fail });
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelector("iframe")).not.toBeNull(); });
    const frame = element.shadowRoot?.querySelector("iframe");
    if (frame?.contentWindow === null || frame?.contentWindow === undefined) throw new Error("Missing frame window");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).not.toContain("graph TD");
    const send = vi.spyOn(frame.contentWindow, "postMessage").mockImplementation(() => undefined);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "mermaid-error" } }));
    expect(fail).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "mermaid-ready" } }));
    expect(send).toHaveBeenCalledWith({ type: "mermaid-render", text: "graph TD; A-->B" }, "*");
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "mermaid-rendered", height: 200 } }));
    await element.updateComplete;
    expect(frame.style.height).toBe("224px");
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "mermaid-error" } }));
    expect(fail).toHaveBeenCalledOnce();
    controller.abort();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("iframe")).toBeNull();
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "mermaid-error" } }));
    expect(fail).toHaveBeenCalledOnce();
  });

  it("uses the active package's loader and ignores a previous package's late engine failure", async () => {
    let rejectOld: (error: Error) => void = () => { throw new Error("Not initialized"); };
    const oldEngine = new Promise<string>((_resolve, reject) => { rejectOld = reject; });
    const fail = vi.fn();
    const element = await preview({ text: "same source", signal: new AbortController().signal, fail }, () => oldEngine);
    const activeLoader = vi.fn().mockResolvedValue("/* active package engine */");
    element.loadEngine = activeLoader;
    await element.updateComplete;
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelector("iframe")?.srcdoc).toContain("active package engine"); });
    rejectOld(new Error("old machine unavailable"));
    await Promise.resolve();
    expect(fail).not.toHaveBeenCalled();
    expect(activeLoader).toHaveBeenCalledOnce();
  });

  it("reports a bounded failure if the engine never becomes ready and cancels the timeout on disconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const fail = vi.fn();
    const element = await preview({ text: "source", signal: new AbortController().signal, fail });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fail).toHaveBeenCalledWith(new Error("Mermaid preview timed out"));
    element.remove();
    fail.mockClear();
    const other = await preview({ text: "source", signal: new AbortController().signal, fail });
    other.remove();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fail).not.toHaveBeenCalled();
  });

  it("ignores engine loading results after disconnect and reports fetch failures", async () => {
    let resolveEngine: (response: Response) => void = () => { throw new Error("Not initialized"); };
    const pending = new Promise<Response>((resolve) => { resolveEngine = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    const fail = vi.fn();
    const element = await preview({ text: "old", signal: new AbortController().signal, fail });
    element.remove();
    resolveEngine(new Response("engine"));
    await pending;
    await Promise.resolve();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("iframe")).toBeNull();
    expect(fail).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await preview({ text: "new", signal: new AbortController().signal, fail });
    await vi.waitFor(() => { expect(fail).toHaveBeenCalledOnce(); });
    expect(fail.mock.calls[0]?.[0]).toEqual(new Error("Mermaid engine unavailable (503)"));
  });
});
