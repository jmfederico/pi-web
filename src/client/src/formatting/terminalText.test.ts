import { expect, it } from "vitest";
import { stripTerminalFormatting } from "./terminalText";

it("removes terminal colours, styles and cursor controls without losing output", () => {
  const output = "\x1b[1;31mfailed\x1b[0m\n\x1b[38;5;120mindexed\x1b[39m\t\x1b[38;2;1;2;3mRGB\x1b[0m\x1b[2K\x1b[?25h";
  expect(stripTerminalFormatting(output)).toBe("failed\nindexed\tRGB");
  expect(stripTerminalFormatting("\x9b32mgreen\x9b0m")).toBe("green");
});

it("removes OSC metadata and hyperlink wrappers but keeps the label", () => {
  expect(stripTerminalFormatting("\x1b]0;window title\x07\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  expect(stripTerminalFormatting("\x9d8;;https://example.com\x9clink\x9d8;;\x9c")).toBe("link");
});

it("preserves ordinary text, whitespace, markup and literal escape-code examples", () => {
  const text = '  [31m → café\n\t<img src="x">\\x1b[31m\r\n';
  expect(stripTerminalFormatting(text)).toBe(text);
});
