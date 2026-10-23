// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { readMarkdownImageDimensions, rememberMarkdownImageDimensions } from "../formatting/markdownImageDimensions";
import { MarkdownImage } from "./MarkdownImage";
import { imageButton, loadIntrinsicDimensions, nativeImage, settleImage } from "./imagePresentation.testSupport";

const previewUrl = "https://example.test/nested/api/preview?path=private&showImage=1";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
});

async function mountOutside(intentKey?: string, source = previewUrl) {
  const image = new MarkdownImage();
  image.outside = true;
  image.intentKey = intentKey;
  image.path = "/private/example.png";
  image.description = "Private screenshot";
  image.previewUrl = source;
  document.body.append(image);
  const presentation = await settleImage(image);
  return { image, presentation, native: nativeImage(presentation) };
}

async function mountWorkspace(source = "https://example.test/nested/api/preview?path=screenshot.png") {
  const image = new MarkdownImage();
  image.previewUrl = source;
  document.body.append(image);
  const presentation = await settleImage(image);
  return { image, presentation, native: nativeImage(presentation) };
}

it("learns dimensions from a first load and reuses them before a new image loads", async () => {
  const first = await mountWorkspace();
  expect(first.native.hasAttribute("width")).toBe(false);
  expect(first.native.hasAttribute("height")).toBe(false);
  loadIntrinsicDimensions(first.native, 640, 480);
  await settleImage(first.image);
  expect(readMarkdownImageDimensions(first.image.previewUrl)).toEqual({ width: 640, height: 480 });
  expect(nativeImage(first.presentation)).toBe(first.native);
  first.image.remove();

  const returned = await mountWorkspace();
  expect(returned.native.getAttribute("width")).toBe("640");
  expect(returned.native.getAttribute("height")).toBe("480");
  expect(returned.native.src).toBe(returned.image.previewUrl);
  const hostUpdate = vi.spyOn(returned.image, "requestUpdate");
  const presentationUpdate = vi.spyOn(returned.presentation, "requestUpdate");
  loadIntrinsicDimensions(returned.native, 640, 480);
  await settleImage(returned.image);
  expect(hostUpdate).not.toHaveBeenCalled();
  expect(presentationUpdate).not.toHaveBeenCalled();
});

it("refreshes stale hints and current sizing when a file's intrinsic dimensions change", async () => {
  rememberMarkdownImageDimensions(previewUrl, { width: 1200, height: 800 });
  const { image, presentation, native } = await mountWorkspace(previewUrl);
  expect(native.getAttribute("width")).toBe("1200");
  expect(native.getAttribute("height")).toBe("800");
  loadIntrinsicDimensions(native, 400, 1600);
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.getAttribute("width")).toBe("400");
  expect(native.getAttribute("height")).toBe("1600");
  expect(readMarkdownImageDimensions(previewUrl)).toEqual({ width: 400, height: 1600 });
});

it("does not learn geometry from errors, invalid metadata, or a stale source/permission", async () => {
  const { image, native } = await mountWorkspace(previewUrl);
  native.dispatchEvent(new Event("error"));
  loadIntrinsicDimensions(native, 0, 480);
  expect(readMarkdownImageDimensions(previewUrl)).toBeUndefined();
  image.previewUrl = "https://example.test/another.png";
  // Parent props may change before the child's next render; ignore the old load.
  loadIntrinsicDimensions(native, 640, 480);
  expect(readMarkdownImageDimensions(previewUrl)).toBeUndefined();
  expect(readMarkdownImageDimensions(image.previewUrl)).toBeUndefined();
  await settleImage(image);
  image.loadingDisabled = true;
  loadIntrinsicDimensions(native, 640, 480);
  expect(readMarkdownImageDimensions(image.previewUrl)).toBeUndefined();
});

it("remembers outside-image geometry without persisting or granting approval", async () => {
  const first = await mountOutside();
  imageButton(first.presentation, ".placeholder").click();
  await settleImage(first.image);
  loadIntrinsicDimensions(first.native, 1200, 800);
  await settleImage(first.image);
  first.image.remove();
  expect(readMarkdownImageDimensions(previewUrl)).toEqual({ width: 1200, height: 800 });

  const returned = await mountOutside();
  expect(returned.native.hasAttribute("src")).toBe(false);
  expect(imageButton(returned.presentation, ".placeholder").hidden).toBe(false);
  imageButton(returned.presentation, ".placeholder").click();
  await settleImage(returned.image);
  expect(returned.native.src).toBe(previewUrl);
  expect(returned.native.getAttribute("width")).toBe("1200");
  expect(returned.native.getAttribute("height")).toBe("800");
});

it("keeps native loading and current sizing usable when persistence is unavailable", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
  const { image, presentation, native } = await mountWorkspace();
  loadIntrinsicDimensions(native, 640, 480);
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.src).toBe(image.previewUrl);
  expect(native.getAttribute("width")).toBe("640");
  expect(native.getAttribute("height")).toBe("480");
});

it("assigns workspace sources immediately and lets the browser load them lazily", async () => {
  const image = new MarkdownImage();
  image.path = "screenshots/example.png";
  image.description = "Example screenshot";
  image.previewUrl = "https://example.test/nested/api/preview?path=screenshot.png";
  document.body.append(image);
  const presentation = await settleImage(image);
  const native = nativeImage(presentation);
  expect(native.src).toBe(image.previewUrl);
  expect(native.alt).toBe("Example screenshot");
  expect(native.getAttribute("loading")).toBe("lazy");
  expect(native.getAttribute("decoding")).toBe("async");
  expect(imageButton(presentation, ".placeholder").hidden).toBe(true);
  expect(imageButton(presentation).hidden).toBe(false);
  image.previewUrl = "";
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.hasAttribute("src")).toBe(false);
});

it("keeps outside images src-free until explicit approval, including after source changes", async () => {
  const { image, presentation, native } = await mountOutside();
  const show = imageButton(presentation, ".placeholder");
  expect(native.hasAttribute("src")).toBe(false);
  expect(show.hidden).toBe(false);
  expect(show.textContent).toContain("Show image");
  expect(show.textContent).toContain("/private/example.png");
  expect(imageButton(presentation).hidden).toBe(true);
  show.click();
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.src).toBe(previewUrl);
  expect(show.hidden).toBe(true);
  expect(imageButton(presentation).disabled).toBe(false);

  // Native failures do not revoke approval or replace the image with retry UI.
  native.dispatchEvent(new Event("error"));
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.src).toBe(previewUrl);
  expect(imageButton(presentation).hidden).toBe(false);
  expect(presentation.renderRoot.querySelector('[role="status"]')).toBeNull();

  image.previewUrl = "https://example.test/api/preview?path=different&showImage=1";
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.hasAttribute("src")).toBe(false);
  expect(show.hidden).toBe(false);
  // Without an intent key, even the same URL needs consent on a new visit.
  expect((await mountOutside()).native.hasAttribute("src")).toBe(false);
});

it("preserves the native image and approval on benign props updates but not a new intent", async () => {
  const { image, presentation, native } = await mountOutside("native-benign-props");
  imageButton(presentation, ".placeholder").click();
  await settleImage(image);
  image.path = "/private/renamed-label.png";
  image.description = "Updated description";
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.src).toBe(previewUrl);
  expect(native.alt).toBe("Updated description");
  expect(imageButton(presentation).getAttribute("aria-label")).toBe("Enlarge Updated description");

  image.intentKey = "native-new-intent";
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.hasAttribute("src")).toBe(false);
  expect(imageButton(presentation, ".placeholder").hidden).toBe(false);
});

it("remembers approval only for the chosen intent/source pair, never other images", async () => {
  const first = await mountOutside("native-scoped-choice:first");
  const sibling = await mountOutside("native-scoped-choice:second");
  imageButton(first.presentation, ".placeholder").click();
  await settleImage(first.image);
  expect(first.native.src).toBe(previewUrl);
  expect(sibling.native.hasAttribute("src")).toBe(false);
  first.image.remove();
  const returned = await mountOutside("native-scoped-choice:first");
  expect(returned.native.src).toBe(previewUrl);
  expect(imageButton(returned.presentation, ".placeholder").hidden).toBe(true);
  expect((await mountOutside("native-scoped-choice:other-message")).native.hasAttribute("src")).toBe(false);

  const changed = await mountOutside("native-scoped-choice:first", "https://example.test/different.png");
  expect(changed.native.hasAttribute("src")).toBe(false);
  expect((await mountOutside("native-scoped-choice:first")).native.hasAttribute("src")).toBe(false);
  expect(localStorage.length).toBe(0);
});

it("expires remembered consent after 15 minutes without extending it on revisit", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const first = await mountOutside("native-expiring-choice");
  imageButton(first.presentation, ".placeholder").click();
  await settleImage(first.image);
  vi.setSystemTime(14 * 60_000);
  expect((await mountOutside("native-expiring-choice")).native.src).toBe(previewUrl);
  vi.setSystemTime(15 * 60_000);
  const expired = await mountOutside("native-expiring-choice");
  expect(expired.native.hasAttribute("src")).toBe(false);
  expect(imageButton(expired.presentation, ".placeholder").hidden).toBe(false);
});

it("disables sources without granting outside approval through the inactive request button", async () => {
  const { image, presentation, native } = await mountOutside("disabled-approval-test");
  image.loadingDisabled = true; await settleImage(image);
  const show = imageButton(presentation, ".placeholder");
  expect(show.disabled).toBe(true);
  show.click(); await settleImage(image);
  image.loadingDisabled = false; await settleImage(image);
  expect(show.disabled).toBe(false);
  expect(native.hasAttribute("src")).toBe(false);
  show.click(); await settleImage(image);
  expect(native.src).toBe(previewUrl);
  image.loadingDisabled = true; await settleImage(image);
  expect(native.hasAttribute("src")).toBe(false);
  image.loadingDisabled = false; await settleImage(image);
  expect(native.src).toBe(previewUrl);
});

it("does not carry automatic workspace loading into an outside-file approval", async () => {
  const { image, presentation, native } = await mountOutside("native-boundary-choice");
  image.outside = false;
  await settleImage(image);
  expect(native.src).toBe(previewUrl);
  image.outside = true;
  await settleImage(image);
  expect(nativeImage(presentation)).toBe(native);
  expect(native.hasAttribute("src")).toBe(false);
  expect(imageButton(presentation, ".placeholder").hidden).toBe(false);
});
