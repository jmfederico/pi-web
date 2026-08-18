import { describe, expect, it } from "vitest";
import { loadPiBuiltinExtensions } from "./piBuiltinExtensions.js";

describe("loadPiBuiltinExtensions", () => {
  it("exposes Pi's built-in extension factories, including llama.cpp", async () => {
    const extensions = await loadPiBuiltinExtensions();
    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions.every((extension) =>
      typeof extension === "function" || typeof extension.factory === "function",
    )).toBe(true);
    expect(extensions.map((extension) =>
      typeof extension === "function" ? undefined : extension.name,
    )).toContain("llama.cpp");
  });

  it("returns a stable cached promise result", async () => {
    const first = await loadPiBuiltinExtensions();
    const second = await loadPiBuiltinExtensions();
    expect(second).toEqual(first);
  });
});
