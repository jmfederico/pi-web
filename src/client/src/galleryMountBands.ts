import { THUMBNAIL_WIDTH } from "./thumbnailGeometry";

export interface GalleryMountImage {
  readonly key: string;
  readonly anchor?: string;
}

export interface GalleryMountBand {
  readonly key: string;
  readonly start: number;
  readonly end: number;
  readonly members: readonly string[];
  readonly anchors: readonly string[];
}

/**
 * Groups images in input order into thumbnail rows with half-open index ranges.
 * Image keys must be unique and stable. Nonpositive or nonfinite widths use one
 * column until a measured width is available. The parent supplies the 96px row
 * height estimate from ImagePresentation's fixed 128×96 thumbnail contract.
 */
export function planGalleryBands(
  images: readonly GalleryMountImage[],
  width: number,
): GalleryMountBand[] {
  const columns = Number.isFinite(width) && width > 0
    ? Math.max(1, Math.floor(width / THUMBNAIL_WIDTH))
    : 1;
  const bands: GalleryMountBand[] = [];
  for (const [start, image] of images.entries()) {
    if (start % columns !== 0) continue;
    const end = Math.min(start + columns, images.length);
    const row = images.slice(start, end);
    bands.push({
      key: `gallery-band:${JSON.stringify([image.key])}`,
      start,
      end,
      members: row.map(member => member.key),
      anchors: row.flatMap(member => member.anchor === undefined ? [] : [member.anchor]),
    });
  }
  return bands;
}
