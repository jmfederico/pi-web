// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginStylesheetLoader, resolveStylesheetAssets } from "./styleLoader";

const fileUrl = "https://example.test/plugins/palettes/theme.css";

function sheetFixture() {
  const sheet = new CSSStyleSheet();
  // happy-dom cannot prove CSS rendering. Spy only on the compilation boundary.
  const replaceSync = vi.spyOn(sheet, "replaceSync").mockImplementation(() => undefined);
  return { sheet, replaceSync, createSheet: () => sheet };
}

function cssResponse(text: string, init?: ResponseInit) {
  return new Response(text, { headers: { "content-type": "text/css; charset=utf-8" }, ...init });
}

afterEach(() => { vi.useRealTimers(); });

describe("resolveStylesheetAssets", () => {
  it("resolves CSS resource forms while preserving other strings, comments and nested function arguments", () => {
    const source = `/* url(fake.png) @import 'ignore.css'; */
@font-face { src: url('../fonts/font.woff2') format('woff2'); }
:root { --asset: url(icons/a.svg#mark); --message: "url(fake.png)"; }
x { background: image-set("one.png" 1x, url(two.png) 2x, "three.png" type("image/png"));
mask: URL(#mask); content: "one.png"; other: future-syntax("unchanged"); }`;
    const output = resolveStylesheetAssets(source, fileUrl);
    expect(output).toContain("/* url(fake.png) @import 'ignore.css'; */");
    expect(output).toContain('url("https://example.test/plugins/fonts/font.woff2") format(\'woff2\')');
    expect(output).toContain("url(https://example.test/plugins/palettes/icons/a.svg#mark)");
    expect(output).toContain('image-set("https://example.test/plugins/palettes/one.png" 1x, url(https://example.test/plugins/palettes/two.png) 2x, "https://example.test/plugins/palettes/three.png" type("image/png"))');
    expect(output).toContain(`--message: "url(fake.png)"`);
    expect(output).toContain("url(#mask)");
    expect(output).toContain('content: "one.png"; other: future-syntax("unchanged")');
  });

  it("preserves local SVG references in quoted, unquoted and escaped resource URLs", () => {
    const output = resolveStylesheetAssets(String.raw`x {
filter: url(#shadow);
clip-path: url("#clip");
mask: url('\23 mask');
other: u\72l(\23 marker);
background-image: image-set("#local" 1x, "icons.svg#external" 2x);
}`, fileUrl);
    expect(output).toContain("filter: url(#shadow)");
    expect(output).toContain('clip-path: url("#clip")');
    expect(output).toContain('mask: url("#mask")');
    expect(output).toContain("other: url(#marker)");
    expect(output).toContain('image-set("#local" 1x, "https://example.test/plugins/palettes/icons.svg#external" 2x)');
    expect(output).not.toContain("theme.css#");
  });

  it("handles CSS escapes, image-set prefixes, root paths and absolute/data URLs", () => {
    const output = resolveStylesheetAssets(String.raw`x {
background: u\72l(../a\ b.png);
mask: url("\2e\2e /icons/a.svg");
background-image: -webkit-image-set("/one.png" 1x);
other: url(https://cdn.test/a.png);
inline: url("data:image/svg+xml,<svg/>");
}`, fileUrl);
    expect(output).toContain("url(https://example.test/plugins/a%20b.png)");
    expect(output).toContain('url("https://example.test/plugins/icons/a.svg")');
    expect(output).toContain('-webkit-image-set("https://example.test/one.png" 1x)');
    expect(output).toContain("url(https://cdn.test/a.png)");
    expect(output).toContain('url("data:image/svg+xml,<svg/>")');
  });

  it.each(["@import 'other.css';", "@IMPORT url(other.css);", String.raw`@\69mport 'other.css';`])("rejects imports before browser compilation: %s", (source) => {
    expect(() => resolveStylesheetAssets(source, fileUrl)).toThrow("bundle imports");
  });

  it("rejects malformed URLs rather than silently changing their meaning", () => {
    expect(() => resolveStylesheetAssets("x { background: url(a b.png); }", fileUrl)).toThrow("invalid URL or string");
  });
});

describe("createPluginStylesheetLoader", () => {
  it("fetches once and compiles rewritten URLs using the final redirected file location", async () => {
    const fixture = sheetFixture();
    const response = cssResponse("x { background: url(icon.png) }");
    Object.defineProperty(response, "url", { value: "https://cdn.test/styles/actual.css" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const load = createPluginStylesheetLoader({ fetch, createSheet: fixture.createSheet });
    expect(await load(fileUrl, new AbortController().signal)).toBe(fixture.sheet);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "text/css" });
    expect(fixture.replaceSync).toHaveBeenCalledWith("x { background: url(https://cdn.test/styles/icon.png) }");
  });

  it.each([
    [new Response("missing", { status: 404 }), "HTTP 404"],
    [new Response("<html>login</html>", { headers: { "content-type": "text/html" } }), "Content-Type text/css"],
    [cssResponse("@import 'other.css';"), "bundle imports"],
    [cssResponse("x{}"), "exceeds 2 bytes"],
  ])("reports HTTP, MIME, policy and size failures before compiling", async (response, error) => {
    const fixture = sheetFixture();
    const load = createPluginStylesheetLoader({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
      createSheet: fixture.createSheet,
      maxBytes: error.startsWith("exceeds") ? 2 : 1024,
    });
    await expect(load(fileUrl, new AbortController().signal)).rejects.toThrow(error);
    expect(fixture.replaceSync).not.toHaveBeenCalled();
  });

  it("bounds slow network loads and releases the timer", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => { reject(new Error("fetch aborted")); }, { once: true });
    }));
    const load = createPluginStylesheetLoader({ fetch, timeoutMs: 25 });
    const failure = expect(load(fileUrl, new AbortController().signal)).rejects.toThrow("timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards unload cancellation and never fetches when already aborted", async () => {
    vi.useFakeTimers();
    const fixture = sheetFixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => { reject(new Error("fetch aborted")); }, { once: true });
    }));
    const load = createPluginStylesheetLoader({ fetch, createSheet: fixture.createSheet });
    const controller = new AbortController();
    const failure = expect(load(fileUrl, controller.signal)).rejects.toThrow("plugin unloaded");
    controller.abort(new Error("plugin unloaded"));
    await failure;
    await expect(load(fileUrl, controller.signal)).rejects.toThrow("plugin unloaded");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fixture.replaceSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a response body that stalls after headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-type": "text/css" } });
    const fixture = sheetFixture();
    const load = createPluginStylesheetLoader({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
      createSheet: fixture.createSheet,
      timeoutMs: 25,
    });
    const failure = expect(load(fileUrl, new AbortController().signal)).rejects.toThrow("timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await failure;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.replaceSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts streamed UTF-8 bytes rather than characters and cancels oversized bodies", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("/*☀☀*/")); },
      cancel,
    });
    const fixture = sheetFixture();
    const load = createPluginStylesheetLoader({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { headers: { "content-type": "text/css" } })),
      createSheet: fixture.createSheet,
      maxBytes: 8,
    });
    await expect(load(fileUrl, new AbortController().signal)).rejects.toThrow("exceeds 8 bytes");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.replaceSync).not.toHaveBeenCalled();
  });
});
