import type { LitElement } from "lit";
import type { ImagePresentation } from "./ImagePresentation";

export function imagePresentation(host: LitElement): ImagePresentation {
  const presentation = host.renderRoot.querySelector<ImagePresentation>("pi-web-image-presentation");
  if (presentation === null) throw new Error("Expected image presentation");
  return presentation;
}

export async function settleImage(host: LitElement): Promise<ImagePresentation> {
  await host.updateComplete;
  await host.updateComplete;
  const presentation = imagePresentation(host);
  await presentation.updateComplete;
  return presentation;
}

/** Stub browser decode metadata, not layout: happy-dom does not decode images. */
export function loadIntrinsicDimensions(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
    currentSrc: { configurable: true, value: image.src },
    complete: { configurable: true, value: true },
  });
  image.dispatchEvent(new Event("load"));
}

export function nativeImage(presentation: ImagePresentation): HTMLImageElement {
  const image = presentation.renderRoot.querySelector("img");
  if (image === null) throw new Error("Expected native image");
  return image;
}

export function imageButton(presentation: ImagePresentation, selector = ".image-button"): HTMLButtonElement {
  const button = presentation.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error("Expected image button");
  return button;
}
