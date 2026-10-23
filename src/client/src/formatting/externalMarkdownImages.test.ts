// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://pi.example/nested/pi/"}
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageDimensions } from "../../../shared/sessionMedia";
import { rememberExternalMarkdownImageDimensions, restoreExternalMarkdownImageDimensions } from "./externalMarkdownImages";
import { readMarkdownImageDimensions, rememberMarkdownImageDimensions } from "./markdownImageDimensions";

const storageKey = "pi-web:markdown-image-dimensions:v1";
const baseUrl = "https://pi.example/nested/pi/";
const source = "https://images.example/cat.png?v=1";
const hint = { width: 640, height: 480 };
const actual = { width: 1200, height: 800 };

function nativeImage(reference: string | undefined): HTMLImageElement {
  const image = document.createElement("img");
  if (reference !== undefined) image.setAttribute("src", reference);
  return image;
}

/** happy-dom does not decode images; stub only browser load metadata, never layout. */
function setLoadMetadata(image: HTMLImageElement, dimensions: ImageDimensions = actual,
  metadata: { complete?: boolean; currentSrc?: string } = {}): void {
  Object.defineProperties(image, {
    complete: { configurable: true, value: metadata.complete ?? true },
    currentSrc: { configurable: true, value: metadata.currentSrc ?? image.src },
    naturalWidth: { configurable: true, value: dimensions.width },
    naturalHeight: { configurable: true, value: dimensions.height },
  });
}

function expectDimensions(image: Element, dimensions: ImageDimensions): void {
  expect(image.getAttribute("width")).toBe(String(dimensions.width));
  expect(image.getAttribute("height")).toBe(String(dimensions.height));
}

function expectNoDimensions(image: Element): void {
  expect(image.hasAttribute("width")).toBe(false);
  expect(image.hasAttribute("height")).toBe(false);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("external Markdown image dimension hints", () => {
  it.each([
    ["https://IMAGES.example:443/album/../cat.png?v=1", source],
    ["http://IMAGES.example:80/cat.png?v=1", "http://images.example/cat.png?v=1"],
    ["//images.example/cat.png?v=1", source],
    ["images/cat.png?v=1", `${baseUrl}images/cat.png?v=1`],
    ["/images/cat.png?v=1", "https://pi.example/images/cat.png?v=1"],
  ])("keys loads and fresh-fragment hints by the browser-resolved URL: %s", (reference, resolved) => {
    const image = nativeImage(reference);
    expect(image.src).toBe(resolved);
    setLoadMetadata(image);
    rememberExternalMarkdownImageDimensions(image);

    expectDimensions(image, actual);
    expect(image.getAttribute("src")).toBe(reference);
    expect(readMarkdownImageDimensions(resolved)).toEqual(actual);
    expect(readMarkdownImageDimensions(reference)).toBeUndefined();
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify([{ source: resolved, ...actual }]));

    const fresh = nativeImage(reference);
    const fragment = document.createDocumentFragment();
    fragment.append(fresh);
    restoreExternalMarkdownImageDimensions(fragment);
    expect(fragment.querySelector("img")).toBe(fresh);
    expect(fresh.getAttribute("src")).toBe(reference);
    expectDimensions(fresh, actual);
  });

  it("restores only ordinary descendants of the supplied root, not shadows, frames or siblings", () => {
    rememberMarkdownImageDimensions(source, hint);
    const root = document.createElement("div");
    const ordinary = nativeImage(source);
    const outside = nativeImage(source);
    const shadowHost = document.createElement("div");
    const shadow = nativeImage(source);
    shadowHost.attachShadow({ mode: "open" }).append(shadow);
    const frame = document.createElement("iframe");
    const custom = document.createElement("pi-web-markdown-image");
    custom.setAttribute("src", source);
    const nonHtmlImage = document.createElementNS("http://www.w3.org/2000/svg", "img");
    nonHtmlImage.setAttribute("src", source);
    root.append(ordinary, shadowHost, frame, custom, nonHtmlImage);
    document.body.append(root, outside);
    const embedded = nativeImage(source);
    if (frame.contentDocument === null) throw new Error("Expected iframe document");
    frame.contentDocument.body.append(embedded);

    restoreExternalMarkdownImageDimensions(root);

    expectDimensions(ordinary, hint);
    for (const excluded of [outside, shadow, embedded, custom, nonHtmlImage]) expectNoDimensions(excluded);
    expect(root.querySelector("img")).toBe(ordinary);
  });

  it("keeps native attributes, elements, links and wrappers while correcting stale hints in place", () => {
    rememberMarkdownImageDimensions(source, hint);
    const root = document.createElement("p");
    const link = document.createElement("a");
    link.setAttribute("href", "https://example.test/original-link");
    const image = nativeImage("//images.example/cat.png?v=1");
    image.setAttribute("alt", "Cat");
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    image.setAttribute("crossorigin", "anonymous");
    image.setAttribute("title", "Original title");
    link.append(image);
    root.append(link);
    document.body.append(root);
    const otherAttributes = () => [...image.attributes]
      .filter(({ name }) => name !== "width" && name !== "height")
      .map(({ name, value }) => [name, value]);
    const before = otherAttributes();
    const srcAssignment = vi.spyOn(image, "src", "set");
    const mutations = vi.spyOn(image, "setAttribute");
    const listen = vi.spyOn(image, "addEventListener");
    const fetch = vi.spyOn(globalThis, "fetch");

    restoreExternalMarkdownImageDimensions(root);
    expectDimensions(image, hint);
    setLoadMetadata(image);
    rememberExternalMarkdownImageDimensions(image);
    expectDimensions(image, actual);

    expect(root.firstElementChild).toBe(link);
    expect(link.firstElementChild).toBe(image);
    expect(link.getAttribute("href")).toBe("https://example.test/original-link");
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(otherAttributes()).toEqual(before);
    expect(image.hasAttribute("style")).toBe(false);
    expect(srcAssignment).not.toHaveBeenCalled();
    expect(mutations.mock.calls.every(([name]) => name === "width" || name === "height")).toBe(true);
    expect(listen).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(readMarkdownImageDimensions(source)).toEqual(actual);
  });

  it("applies newly remembered hints on a fresh mount of unchanged reusable HTML", () => {
    const markup = `<p><img src="${source}" loading="lazy" decoding="async" alt="Cat"></p>`;
    const root = document.createElement("div");
    root.innerHTML = markup;
    document.body.append(root);
    const first = root.querySelector("img");
    if (first === null) throw new Error("Expected native image");
    restoreExternalMarkdownImageDimensions(root);
    expectNoDimensions(first);
    setLoadMetadata(first);
    rememberExternalMarkdownImageDimensions(first);
    root.remove();

    const freshRoot = document.createElement("div");
    freshRoot.innerHTML = markup;
    document.body.append(freshRoot);
    const fresh = freshRoot.querySelector("img");
    if (fresh === null) throw new Error("Expected fresh native image");
    expectNoDimensions(fresh);
    restoreExternalMarkdownImageDimensions(freshRoot);
    expect(fresh).not.toBe(first);
    expect(freshRoot.querySelector("img")).toBe(fresh);
    expectDimensions(fresh, actual);
    expect(fresh.getAttribute("src")).toBe(source);
    expect(fresh.getAttribute("loading")).toBe("lazy");
  });

  it("does not write, promote or otherwise change stored hints during repeated restoration", () => {
    rememberMarkdownImageDimensions(source, hint);
    rememberMarkdownImageDimensions(`${source}&v=2`, actual);
    const snapshot = localStorage.getItem(storageKey);
    const storage = localStorage;
    const write = vi.fn((key: string, value: string) => { storage.setItem(key, value); });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.getItem(key),
      setItem: write,
    });
    const root = document.createElement("div");
    const image = nativeImage(source);
    root.append(image);

    restoreExternalMarkdownImageDimensions(root);
    restoreExternalMarkdownImageDimensions(root);

    expectDimensions(image, hint);
    expect(localStorage.getItem(storageKey)).toBe(snapshot);
    expect(write).not.toHaveBeenCalled();
    image.setAttribute("src", `${source}&v=3`);
    restoreExternalMarkdownImageDimensions(root);
    expectDimensions(image, hint);
    expect(localStorage.getItem(storageKey)).toBe(snapshot);
  });

  it.each([
    { width: 1200, height: 800, complete: false },
    { width: 0, height: 0, complete: true },
    { width: 0, height: 800, complete: true },
    { width: 1200, height: 0, complete: true },
    { width: -1, height: 800, complete: true },
    { width: 1200, height: -1, complete: true },
    { width: 0.5, height: 800, complete: true },
    { width: 1200, height: 0.5, complete: true },
    { width: NaN, height: 800, complete: true },
    { width: 1200, height: Infinity, complete: true },
    { width: Number.MAX_SAFE_INTEGER + 1, height: 800, complete: true },
  ])("ignores incomplete, failed or invalid loads without replacing valid hints: %j", (metadata) => {
    rememberMarkdownImageDimensions(source, hint);
    const snapshot = localStorage.getItem(storageKey);
    const image = nativeImage(source);
    image.setAttribute("width", String(hint.width));
    image.setAttribute("height", String(hint.height));
    setLoadMetadata(image, metadata, { complete: metadata.complete });

    rememberExternalMarkdownImageDimensions(image);

    expectDimensions(image, hint);
    expect(localStorage.getItem(storageKey)).toBe(snapshot);
  });

  it.each(["", "https://images.example/old.png", `${source}&candidate=2`, "//images.example/cat.png?v=1"])(
    "ignores stale loads and srcset candidates unless currentSrc equals resolved src: %s", (currentSrc) => {
      rememberMarkdownImageDimensions(source, hint);
      const snapshot = localStorage.getItem(storageKey);
      const image = nativeImage("//images.example/cat.png?v=1");
      image.setAttribute("srcset", `${source}&candidate=2 2x`);
      setLoadMetadata(image, actual, { currentSrc });

      rememberExternalMarkdownImageDimensions(image);

      expectNoDimensions(image);
      expect(image.getAttribute("srcset")).toBe(`${source}&candidate=2 2x`);
      expect(localStorage.getItem(storageKey)).toBe(snapshot);
    },
  );

  it.each([undefined, "", " \t\n"])("ignores disabled, missing or empty native src attributes: %j", (reference) => {
    rememberMarkdownImageDimensions(source, hint);
    const snapshot = localStorage.getItem(storageKey);
    const image = nativeImage(reference);
    image.setAttribute("data-src", source);
    // Even a resolved URL and leftover successful metadata cannot enable a missing native src.
    Object.defineProperty(image, "src", { configurable: true, value: source });
    setLoadMetadata(image);
    const root = document.createElement("div");
    root.append(image);

    restoreExternalMarkdownImageDimensions(root);
    rememberExternalMarkdownImageDimensions(image);

    expectNoDimensions(image);
    expect(image.getAttribute("src")).toBe(reference ?? null);
    expect(localStorage.getItem(storageKey)).toBe(snapshot);
  });

  it.each(["data:image/png;base64,AA==", "blob:https://images.example/id", "file:///cat.png", "ftp://images.example/cat.png", "about:blank"])(
    "does not use or remember hints for non-HTTP sources: %s", (reference) => {
      const image = nativeImage(reference);
      rememberMarkdownImageDimensions(image.src, hint);
      const snapshot = localStorage.getItem(storageKey);
      setLoadMetadata(image);
      const root = document.createElement("div");
      root.append(image);

      restoreExternalMarkdownImageDimensions(root);
      rememberExternalMarkdownImageDimensions(image);

      expectNoDimensions(image);
      expect(image.getAttribute("src")).toBe(reference);
      expect(localStorage.getItem(storageKey)).toBe(snapshot);
    },
  );

  it.each([
    "{bad json", "{}",
    JSON.stringify([{ source, width: 0, height: 480 }]),
    JSON.stringify([{ source, width: 640 }]),
    JSON.stringify([{ source, width: "640", height: 480 }]),
  ])("treats corrupt snapshots or invalid cached dimensions as unchanged misses: %s", (snapshot) => {
    localStorage.setItem(storageKey, snapshot);
    const root = document.createElement("div");
    const image = nativeImage(source);
    root.append(image);

    restoreExternalMarkdownImageDimensions(root);
    expectNoDimensions(image);
    expect(localStorage.getItem(storageKey)).toBe(snapshot);

    setLoadMetadata(image);
    rememberExternalMarkdownImageDimensions(image);
    expectDimensions(image, actual);
    expect(readMarkdownImageDimensions(source)).toEqual(actual);
  });

  it.each(["missing", "blocked getter"])("still applies successful metadata without hidden memory when storage is %s", (mode) => {
    vi.stubGlobal("localStorage", undefined);
    if (mode === "blocked getter") {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() { throw new Error("storage disabled"); },
      });
    }
    const root = document.createElement("div");
    const image = nativeImage(source);
    root.append(image);
    expect(() => { restoreExternalMarkdownImageDimensions(root); }).not.toThrow();
    expectNoDimensions(image);
    setLoadMetadata(image);
    expect(() => { rememberExternalMarkdownImageDimensions(image); }).not.toThrow();
    expectDimensions(image, actual);

    const fresh = nativeImage(source);
    root.replaceChildren(fresh);
    restoreExternalMarkdownImageDimensions(root);
    expectNoDimensions(fresh);
    vi.unstubAllGlobals();
    expect(readMarkdownImageDimensions(source)).toBeUndefined();
  });

  it("tolerates blocked storage reads and lets a successful load repair the cache", () => {
    const storage = localStorage;
    vi.stubGlobal("localStorage", {
      getItem() { throw new Error("read blocked"); },
      setItem: (key: string, value: string) => { storage.setItem(key, value); },
    });
    const root = document.createElement("div");
    const image = nativeImage(source);
    root.append(image);
    expect(() => { restoreExternalMarkdownImageDimensions(root); }).not.toThrow();
    expectNoDimensions(image);
    setLoadMetadata(image);
    expect(() => { rememberExternalMarkdownImageDimensions(image); }).not.toThrow();
    expectDimensions(image, actual);

    vi.unstubAllGlobals();
    expect(readMarkdownImageDimensions(source)).toEqual(actual);
  });

  it("corrects actual attributes despite blocked writes without retaining an unpersisted hint", () => {
    rememberMarkdownImageDimensions(source, hint);
    const snapshot = localStorage.getItem(storageKey);
    const storage = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.getItem(key),
      setItem() { throw new Error("quota exceeded"); },
    });
    const image = nativeImage(source);
    setLoadMetadata(image);

    expect(() => { rememberExternalMarkdownImageDimensions(image); }).not.toThrow();
    expectDimensions(image, actual);
    expect(localStorage.getItem(storageKey)).toBe(snapshot);
    const root = document.createElement("div");
    const fresh = nativeImage(source);
    root.append(image, fresh);
    // Renders must not replace current decoded geometry with the older persisted hint.
    restoreExternalMarkdownImageDimensions(root);
    expectDimensions(image, actual);
    expectDimensions(fresh, hint);
    expect(localStorage.getItem(storageKey)).toBe(snapshot);
  });

  it("shares storage and the 128-entry budget with filesystem preview URLs", () => {
    const filesystemSource = `${baseUrl}api/machines/local/projects/p/workspaces/w/file/preview?path=cat.png`;
    rememberMarkdownImageDimensions(filesystemSource, hint);
    const image = nativeImage(source);
    setLoadMetadata(image);
    rememberExternalMarkdownImageDimensions(image);
    expect(readMarkdownImageDimensions(filesystemSource)).toEqual(hint);
    expect(readMarkdownImageDimensions(source)).toEqual(actual);
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify([
      { source: filesystemSource, ...hint }, { source, ...actual },
    ]));

    for (let index = 0; index < 126; index++) {
      rememberMarkdownImageDimensions(`${filesystemSource}&v=${String(index)}`, hint);
    }
    const root = document.createElement("div");
    const filesystemNative = nativeImage(filesystemSource);
    root.append(filesystemNative);
    restoreExternalMarkdownImageDimensions(root);
    expectDimensions(filesystemNative, hint);
    const newest = nativeImage(`${source}&new=1`);
    setLoadMetadata(newest);
    rememberExternalMarkdownImageDimensions(newest);

    expect(localStorage.length).toBe(1);
    const records: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    expect(records).toHaveLength(128);
    expect(readMarkdownImageDimensions(filesystemSource)).toBeUndefined();
    expect(readMarkdownImageDimensions(source)).toEqual(actual);
    expect(readMarkdownImageDimensions(newest.src)).toEqual(actual);
  });
});
