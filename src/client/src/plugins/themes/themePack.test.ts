import { describe, expect, it } from "vitest";
import { PluginRegistry } from "../registry";
import { themePackPlugin } from "./index";

describe("Apple Dark legibility", () => {
  it("keeps normal text readable on every primary row and selection surface", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "themes", plugin: themePackPlugin });
    const theme = registry.getThemes().find((candidate) => candidate.id === "themes:apple-dark");
    if (theme === undefined) throw new Error("Apple Dark theme is missing");
    for (const background of ["--pi-bg", "--pi-surface", "--pi-surface-hover", "--pi-selection-bg"] as const) {
      for (const foreground of ["--pi-text", "--pi-text-secondary", "--pi-muted", "--pi-dim", "--pi-accent", "--pi-success", "--pi-warning", "--pi-danger", "--pi-purple"] as const) {
        expect(contrast(theme.tokens[foreground], theme.tokens[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme.tokens["--pi-accent-border"], theme.tokens[background]), `focus on ${background}`).toBeGreaterThanOrEqual(3);
    }
  });
});

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

function contrast(left: string | undefined, right: string | undefined): number {
  if (left === undefined || right === undefined) throw new Error("Missing palette token");
  const a = luminance(left); const b = luminance(right);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
