import { describe, expect, it } from 'vitest';
import { planGalleryBands, type GalleryMountImage } from './galleryMountBands.js';

const images: readonly GalleryMountImage[] = [
  { key: 'a' },
  { key: 'b', anchor: 'message-b' },
  { key: 'c', anchor: '' },
  { key: 'd', anchor: 'message-d' },
  { key: 'e' },
];

describe('planGalleryBands', () => {
  it.each([
    { width: 127, ranges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]] },
    { width: 255.9, ranges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]] },
    { width: 256, ranges: [[0, 2], [2, 4], [4, 5]] },
    { width: 384, ranges: [[0, 3], [3, 5]] },
    { width: 1024, ranges: [[0, 5]] },
  ])('uses thumbnail capacity and preserves partial rows at width $width', ({ width, ranges }) => {
    const bands = planGalleryBands(images, width);
    expect(bands.map(band => [band.start, band.end])).toEqual(ranges);
    expect(bands.flatMap(band => band.members)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const band of bands) {
      expect(band.members).toEqual(images.slice(band.start, band.end).map(image => image.key));
    }
  });

  it('collects every defined anchor, including nonfirst images and empty anchors', () => {
    expect(planGalleryBands(images, 384).map(band => band.anchors))
      .toEqual([['message-b', ''], ['message-d']]);
  });

  it('keeps member IDs and first-image band keys stable when width changes', () => {
    const narrow = planGalleryBands(images, 128);
    const wide = planGalleryBands(images, 256);
    expect(wide.map(band => band.key)).toEqual([narrow[0]?.key, narrow[2]?.key, narrow[4]?.key]);
    expect(wide.flatMap(band => band.members)).toEqual(narrow.flatMap(band => band.members));
    const prefixed = planGalleryBands([{ key: 'new' }, ...images], 128);
    expect(prefixed.slice(1).map(band => band.key)).toEqual(narrow.map(band => band.key));
  });

  it('tuple-encodes opaque image IDs without delimiter collisions', () => {
    const keys = ['a:b', 'a', 'b:c', 'a,b', '["a","b"]', '"', ''];
    const bands = planGalleryBands(keys.map(key => ({ key })), 128);
    expect(bands.map(band => band.key)).toEqual(keys.map(key => `gallery-band:${JSON.stringify([key])}`));
    expect(new Set(bands.map(band => band.key)).size).toBe(keys.length);
    expect(bands.flatMap(band => band.members)).toEqual(keys);
  });

  it('uses one column for unknown or nonpositive widths and handles empty inputs', () => {
    for (const width of [0, -128, NaN, Infinity, -Infinity]) {
      expect(planGalleryBands(images, width)).toEqual(planGalleryBands(images, 128));
      expect(planGalleryBands([], width)).toEqual([]);
    }
    expect(planGalleryBands([], 384)).toEqual([]);
  });

  it('does not mutate inputs or retain state between calls', () => {
    const frozen = Object.freeze(images.map(image => Object.freeze({ ...image })));
    const before = planGalleryBands(frozen, 256);
    planGalleryBands(frozen, 384);
    expect(planGalleryBands(frozen, 256)).toEqual(before);
    expect(frozen).toEqual(images);
  });
});
