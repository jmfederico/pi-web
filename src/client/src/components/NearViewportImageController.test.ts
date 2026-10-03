// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownImage } from "./MarkdownImage";
import { TranscriptImage } from "./TranscriptImage";
import { ImageIntersectionObserver, imagePresentation, latestImageObserver, settleImage } from "./imagePresentation.testSupport";

beforeEach(() => {
  ImageIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function automaticImage(kind: "markdown" | "transcript") {
  if (kind === "markdown") {
    const image = new MarkdownImage();
    const first = "https://example.test/first.png";
    const second = "https://example.test/second.png";
    image.previewUrl = first;
    return { image, first, second, replaceSource: () => { image.previewUrl = second; } };
  }
  const image = new TranscriptImage();
  image.imagePart = { type: "image", mimeType: "image/png", data: "QUJD" };
  return {
    image, first: "data:image/png;base64,QUJD", second: "data:image/png;base64,REVG",
    replaceSource: () => { image.imagePart = { type: "image", mimeType: "image/png", data: "REVG" }; },
  };
}

it.each(["markdown", "transcript"] as const)("assigns the automatic %s source on the first host render without a fallback correction", async (kind) => {
  const { image, first } = automaticImage(kind);
  const renderedSources: (string | undefined)[] = [];
  // Record the actual child's binding after each host render, without replacing host logic.
  image.addController({ hostUpdated: () => { renderedSources.push(imagePresentation(image).source); } });
  document.body.append(image);
  const firstCompletion = image.updateComplete;
  expect.soft(await firstCompletion).toBe(true);
  expect.soft(renderedSources).toEqual([first]);
  expect.soft(image.isUpdatePending).toBe(false);
  const presentation = imagePresentation(image);
  expect(presentation.source).toBe(first);
  await presentation.updateComplete;
  expect(presentation.renderRoot.querySelector("img")?.src).toBe(first);
  expect(renderedSources).toEqual([first]);
});

it.each(["markdown", "transcript"] as const)("assigns a replacement %s source on its first host render without a fallback correction", async (kind) => {
  const { image, second, replaceSource } = automaticImage(kind);
  document.body.append(image);
  const presentation = await settleImage(image);
  const previous = presentation.renderRoot.querySelector("img");
  expect(previous).not.toBeNull();
  const renderedSources: (string | undefined)[] = [];
  image.addController({ hostUpdated: () => { renderedSources.push(imagePresentation(image).source); } });
  replaceSource();
  const replacementCompletion = image.updateComplete;
  expect.soft(await replacementCompletion).toBe(true);
  expect.soft(renderedSources).toEqual([second]);
  expect.soft(image.isUpdatePending).toBe(false);
  expect(presentation.source).toBe(second);
  await presentation.updateComplete;
  expect(presentation.renderRoot.querySelector("img")?.src).toBe(second);
  expect(presentation.renderRoot.querySelector("img")).not.toBe(previous);
  expect(renderedSources).toEqual([second]);
});

it.each(["markdown", "transcript"] as const)("keeps automatic %s sources inert until the observer boundary notifies", async (kind) => {
  vi.stubGlobal("IntersectionObserver", ImageIntersectionObserver);
  const { image, first } = automaticImage(kind);
  const renderedSources: (string | undefined)[] = [];
  image.addController({ hostUpdated: () => { renderedSources.push(imagePresentation(image).source); } });
  document.body.append(image);
  expect(await image.updateComplete).toBe(true);
  const presentation = imagePresentation(image);
  await presentation.updateComplete;
  expect(renderedSources).toEqual([undefined]);
  expect(presentation.source).toBeUndefined();
  expect(presentation.renderRoot.querySelector("img")).toBeNull();
  const observer = latestImageObserver();
  observer.notify(false);
  expect(image.isUpdatePending).toBe(false);
  expect(presentation.source).toBeUndefined();
  observer.notify();
  expect(await image.updateComplete).toBe(true);
  await presentation.updateComplete;
  expect(renderedSources).toEqual([undefined, first]);
  expect(presentation.renderRoot.querySelector("img")?.src).toBe(first);
  expect(observer.disconnect).toHaveBeenCalledOnce();
});
