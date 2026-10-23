// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptImage, transcriptImageSource } from "./TranscriptImage";
import { imageButton, nativeImage, settleImage } from "./imagePresentation.testSupport";

const mediaId = "abc012".repeat(10) + "abcd";
const reference = { type: "image" as const, mediaId, mimeType: "image/png", byteSize: 42, width: 1200, height: 800 };
const session = { id: "session /?#%", cwd: "/repo with spaces/?#%" };

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllEnvs();
});

async function mount(parent?: HTMLElement) {
  const root = parent ?? document.createElement("div");
  document.body.append(root);
  const image = new TranscriptImage();
  image.imagePart = reference;
  image.session = session;
  image.machineId = "remote /?#%";
  root.append(image);
  const presentation = await settleImage(image);
  return { image, presentation, root };
}

describe("native transcript images", () => {
  it("immediately assigns the encoded nested selected-machine URL with native lazy loading", async () => {
    vi.stubEnv("BASE_URL", "/nested/pi-web/");
    const { presentation } = await mount();
    const native = nativeImage(presentation);
    const url = new URL(native.src);
    expect(url.pathname).toBe(`/nested/pi-web/api/machines/remote%20%2F%3F%23%25/sessions/session%20%2F%3F%23%25/media/${mediaId}`);
    expect(url.searchParams.get("cwd")).toBe(session.cwd);
    expect(native.alt).toBe("attached image");
    expect(native.getAttribute("width")).toBe("1200");
    expect(native.getAttribute("height")).toBe("800");
    expect(native.getAttribute("loading")).toBe("lazy");
    expect(native.getAttribute("decoding")).toBe("async");
    expect(imageButton(presentation).hidden).toBe(false);
    expect(imageButton(presentation).disabled).toBe(false);
    expect(imageButton(presentation, ".placeholder").hidden).toBe(true);
  });

  it("passes thumbnail presentation and numbered descriptions without replacing or rewriting the source", async () => {
    const { image, presentation } = await mount();
    const native = nativeImage(presentation);
    const originalSource = native.src;
    image.thumbnail = true;
    image.description = "read output image 2 of 3";
    await settleImage(image);
    expect(presentation.thumbnail).toBe(true);
    expect(nativeImage(presentation)).toBe(native);
    expect(native.src).toBe(originalSource);
    expect(native.alt).toBe("read output image 2 of 3");
    expect(imageButton(presentation).getAttribute("aria-label")).toBe("Enlarge read output image 2 of 3");
    expect(native.getAttribute("loading")).toBe("lazy");
  });

  it("immediately assigns legacy inline images without changing the native element", async () => {
    const { image, presentation } = await mount();
    const native = nativeImage(presentation);
    image.imagePart = { type: "image", mimeType: "image/jpeg", data: "QUJD" };
    await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
    expect(native.src).toBe("data:image/jpeg;base64,QUJD");
    expect(native.hasAttribute("width")).toBe(false);
    expect(native.hasAttribute("height")).toBe(false);

    image.imagePart = { ...image.imagePart, width: 400, height: 1600 };
    await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
    expect(native.getAttribute("width")).toBe("400");
    expect(native.getAttribute("height")).toBe("1600");
  });

  it("updates sources and session context in place, including across reconnection", async () => {
    const { image, presentation, root } = await mount();
    const native = nativeImage(presentation);
    image.imagePart = { ...reference, mediaId: "f".repeat(64) };
    image.machineId = "another machine";
    image.session = { id: "another session", cwd: "/another cwd" };
    await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
    const url = new URL(native.src);
    expect(url.pathname).toContain(`/machines/another%20machine/sessions/another%20session/media/${"f".repeat(64)}`);
    expect(url.searchParams.get("cwd")).toBe("/another cwd");

    image.imagePart = { ...image.imagePart };
    await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
    image.remove();
    root.append(image);
    await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);

    image.imagePart = undefined;
    await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
    expect(native.hasAttribute("src")).toBe(false);
    expect(native.hasAttribute("width")).toBe(false);
    expect(native.hasAttribute("height")).toBe(false);
  });

  it("leaves disclosure loading decisions to the browser instead of gating source assignment", async () => {
    const details = document.createElement("details");
    const { image, presentation } = await mount(details);
    const native = nativeImage(presentation);
    expect(details.open).toBe(false);
    expect(native.src).toContain(`/media/${mediaId}?`);
    expect(native.getAttribute("loading")).toBe("lazy");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
  });

  it("can disable native sources from startup and re-enable them in the same DOM", async () => {
    const image = new TranscriptImage();
    image.loadingDisabled = true; image.imagePart = reference; image.session = session;
    document.body.append(image);
    const presentation = await settleImage(image);
    const native = nativeImage(presentation);
    expect(native.hasAttribute("src")).toBe(false);
    expect(imageButton(presentation, ".placeholder").disabled).toBe(true);
    imageButton(presentation, ".placeholder").click(); await settleImage(image);
    expect(native.hasAttribute("src")).toBe(false);
    image.loadingDisabled = false; await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
    expect(native.src).toContain(`/media/${mediaId}?`);
    image.loadingDisabled = true; await settleImage(image);
    expect(native.hasAttribute("src")).toBe(false);
  });

  it("does not assign a media source without valid session/media context", async () => {
    const { image, presentation } = await mount();
    const native = nativeImage(presentation);
    image.session = undefined;
    await settleImage(image);
    expect(native.hasAttribute("src")).toBe(false);
    image.session = session;
    image.imagePart = { ...reference, mediaId: "../../private-file" };
    await settleImage(image);
    expect(nativeImage(presentation)).toBe(native);
    expect(native.hasAttribute("src")).toBe(false);
    expect(imageButton(presentation).hidden).toBe(true);
  });
});

describe("transcript image source safety", () => {
  it.each(["", "../private.png", "a".repeat(63), "g".repeat(64), "A".repeat(64)])("rejects invalid media ID %s", (id) => {
    expect(transcriptImageSource({ ...reference, mediaId: id }, session)).toBeUndefined();
  });

  it("requires a session for references and preserves inline sources for helper consumers", () => {
    expect(transcriptImageSource(reference)).toBeUndefined();
    expect(transcriptImageSource({ type: "image", mimeType: "image/png", data: "QUJD" })).toEqual({
      src: "data:image/png;base64,QUJD", alt: "attached image",
    });
  });
});
