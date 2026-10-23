import { validImageDimensions, type ImageDimensions } from "../../../shared/sessionMedia";
import { readMarkdownImageDimensions, rememberMarkdownImageDimensions } from "./markdownImageDimensions";

function externalImageSource(image: HTMLImageElement): string | undefined {
  if ((image.getAttribute("src") ?? "").trim() === "") return undefined;
  const source = image.src;
  return /^https?:\/\//u.test(source) ? source : undefined;
}

function loadedDimensions(image: HTMLImageElement, source: string): ImageDimensions | undefined {
  return image.complete && image.currentSrc === source
    ? validImageDimensions(image.naturalWidth, image.naturalHeight) : undefined;
}

function applyDimensions(image: HTMLImageElement, dimensions: ImageDimensions): void {
  image.setAttribute("width", String(dimensions.width));
  image.setAttribute("height", String(dimensions.height));
}

/** Restore hints on ordinary descendants without entering shadow roots or frames. */
export function restoreExternalMarkdownImageDimensions(root: ParentNode): void {
  root.querySelectorAll("img[src]").forEach((image) => {
    if (!(image instanceof HTMLImageElement)) return;
    const source = externalImageSource(image);
    if (source === undefined) return;
    // Actual bytes win over a stale hint, including when their cache write failed.
    const dimensions = loadedDimensions(image, source) ?? readMarkdownImageDimensions(source);
    if (dimensions !== undefined) applyDimensions(image, dimensions);
  });
}

/** The browser owns loading; only successful metadata for the current source is a hint. */
export function rememberExternalMarkdownImageDimensions(image: HTMLImageElement): void {
  const source = externalImageSource(image);
  if (source === undefined) return;
  const dimensions = loadedDimensions(image, source);
  if (dimensions === undefined) return;
  rememberMarkdownImageDimensions(source, dimensions);
  applyDimensions(image, dimensions);
}
