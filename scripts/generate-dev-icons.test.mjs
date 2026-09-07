import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng, recolorBar } from "./generate-dev-icons.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("../src/client/public/", import.meta.url));

const ICON_PAIRS = [
  ["pwa-icon-192.png", "pwa-icon-dev-192.png"],
  ["pwa-icon-512.png", "pwa-icon-dev-512.png"],
  ["apple-touch-icon.png", "apple-touch-icon-dev.png"],
];

describe("dev identity icons", () => {
  it.each(ICON_PAIRS)("%s recolors only the brand bar to the dev purple", (sourceName, devName) => {
    const source = decodePng(readFileSync(join(PUBLIC_DIR, sourceName)));
    const dev = decodePng(readFileSync(join(PUBLIC_DIR, devName)));

    expect(dev.width).toBe(source.width);
    expect(dev.height).toBe(source.height);

    const teal = [0x00, 0xf0, 0xd8];
    const purple = [0xa3, 0x71, 0xf7];
    let barPixels = 0;
    let mismatches = 0;
    for (let offset = 0; offset < source.pixels.length; offset += 4) {
      const isBar = source.pixels[offset] === teal[0] && source.pixels[offset + 1] === teal[1] && source.pixels[offset + 2] === teal[2];
      if (isBar) {
        barPixels += 1;
        if (dev.pixels[offset] !== purple[0] || dev.pixels[offset + 1] !== purple[1] || dev.pixels[offset + 2] !== purple[2] || dev.pixels[offset + 3] !== source.pixels[offset + 3]) mismatches += 1;
      } else if (dev.pixels[offset] !== source.pixels[offset] || dev.pixels[offset + 1] !== source.pixels[offset + 1] || dev.pixels[offset + 2] !== source.pixels[offset + 2] || dev.pixels[offset + 3] !== source.pixels[offset + 3]) {
        mismatches += 1;
      }
    }
    expect(mismatches).toBe(0);
    expect(barPixels).toBeGreaterThan(0);
  });
});

describe("PNG codec round trip", () => {
  it("re-encodes losslessly", () => {
    const source = decodePng(readFileSync(join(PUBLIC_DIR, "pwa-icon-192.png")));
    const reencoded = decodePng(encodePng(source));
    expect(Buffer.compare(reencoded.pixels, source.pixels)).toBe(0);
  });

  it("rejects artwork without the brand bar", () => {
    const blank = { width: 1, height: 1, pixels: Buffer.from([13, 17, 23, 255]) };
    expect(() => recolorBar(blank.pixels)).toThrow("No brand-bar pixels");
  });
});
