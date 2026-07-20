import { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { plainTextTheme } from "./plainTextTheme.js";

describe("plainTextTheme", () => {
  it("preserves Pi Theme compatibility without adding formatting", () => {
    const text = "plain extension output";
    const formatters: ((value: string) => string)[] = [
      (value) => plainTextTheme.fg("accent", value),
      (value) => plainTextTheme.bg("selectedBg", value),
      (value) => plainTextTheme.bold(value),
      (value) => plainTextTheme.italic(value),
      (value) => plainTextTheme.underline(value),
      (value) => plainTextTheme.inverse(value),
      (value) => plainTextTheme.strikethrough(value),
      plainTextTheme.getThinkingBorderColor("high"),
      plainTextTheme.getBashModeBorderColor(),
    ];

    expect(plainTextTheme).toBeInstanceOf(Theme);
    for (const format of formatters) expect(format(text)).toBe(text);
  });

  it("returns no terminal ANSI prefixes", () => {
    expect(plainTextTheme.getFgAnsi("accent")).toBe("");
    expect(plainTextTheme.getBgAnsi("selectedBg")).toBe("");
  });
});
