#!/usr/bin/env node
/**
 * Regenerate the dev-deployment brand icons from the stock artwork.
 *
 * Dev deployments serve purple identity assets (see src/server/deploymentIdentity.ts).
 * The stock PWA icons are flat two-color PNGs, so the dev variants are a pure
 * pixel recolor of the teal brand bar to the purple accent — no rasterizer and
 * no image dependency involved. Run after changing the stock icons:
 *
 *   node scripts/generate-dev-icons.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const PUBLIC_DIR = fileURLToPath(new URL("../src/client/public/", import.meta.url));

/** Teal brand bar in the stock artwork; recolored to the purple accent. */
const SOURCE_BAR = [0x00, 0xf0, 0xd8];
const DEV_BAR = [0xa3, 0x71, 0xf7];

const ICONS = [
  ["pwa-icon-192.png", "pwa-icon-dev-192.png"],
  ["pwa-icon-512.png", "pwa-icon-dev-512.png"],
  ["apple-touch-icon.png", "apple-touch-icon-dev.png"],
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_RGBA = 6;

export function decodePng(data) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG file");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === undefined || height === undefined) throw new Error("PNG is missing IHDR");
  if (bitDepth !== 8 || colorType !== COLOR_TYPE_RGBA) throw new Error(`Unsupported PNG format (bitDepth ${String(bitDepth)}, colorType ${String(colorType)})`);
  if (idat.length === 0) throw new Error("PNG is missing IDAT");

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)];
    const rawRow = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previousRow = y === 0 ? undefined : pixels.subarray((y - 1) * stride, y * stride);
    unfilterRow(filter, rawRow, row, previousRow, bytesPerPixel);
  }
  return { width, height, pixels };
}

function unfilterRow(filter, rawRow, row, previousRow, bytesPerPixel) {
  for (let x = 0; x < rawRow.length; x += 1) {
    const raw = rawRow[x];
    const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
    const up = previousRow?.[x] ?? 0;
    const upLeft = previousRow !== undefined && x >= bytesPerPixel ? previousRow[x - bytesPerPixel] : 0;
    switch (filter) {
      case 0: row[x] = raw; break;
      case 1: row[x] = (raw + left) & 0xff; break;
      case 2: row[x] = (raw + up) & 0xff; break;
      case 3: row[x] = (raw + ((left + up) >> 1)) & 0xff; break;
      case 4: row[x] = (raw + paeth(left, up, upLeft)) & 0xff; break;
      default: throw new Error(`Unsupported PNG filter ${String(filter)}`);
    }
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

export function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const filtered = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    filtered[y * (stride + 1)] = 0;
    pixels.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOR_TYPE_RGBA;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(filtered, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = new Int32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** Recolor the brand bar, tolerating anti-aliasing edges by hue proximity. */
export function recolorBar(pixels, source = SOURCE_BAR, target = DEV_BAR) {
  let recolored = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const [red, green, blue] = source;
    const matches = Math.abs(pixels[offset] - red) + Math.abs(pixels[offset + 1] - green) + Math.abs(pixels[offset + 2] - blue) < 240;
    if (!matches) continue;
    pixels[offset] = target[0];
    pixels[offset + 1] = target[1];
    pixels[offset + 2] = target[2];
    recolored += 1;
  }
  if (recolored === 0) throw new Error("No brand-bar pixels found; the source artwork changed");
}

export function generateDevIcons(publicDir = PUBLIC_DIR) {
  const written = [];
  for (const [sourceName, devName] of ICONS) {
    const image = decodePng(readFileSync(join(publicDir, sourceName)));
    recolorBar(image.pixels);
    writeFileSync(join(publicDir, devName), encodePng(image));
    written.push(devName);
  }
  return written;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const name of generateDevIcons()) console.log(`wrote ${name}`);
}
