import { describe, expect, it } from "vitest";
import {
  createTerminalCopySnapshot,
  type TerminalCopyBufferCellSource,
  type TerminalCopyBufferLineSource,
  type TerminalCopyBufferSource,
} from "./terminalCopySnapshot";

type CellColor = { mode: "default" } | { mode: "palette"; value: number } | { mode: "rgb"; value: number };

interface CellOptions {
  width?: number;
  foreground?: CellColor;
  background?: CellColor;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  inverse?: boolean;
  invisible?: boolean;
  strikethrough?: boolean;
  overline?: boolean;
}

class TestCell implements TerminalCopyBufferCellSource {
  constructor(private readonly chars: string, private readonly options: CellOptions = {}) {}

  getWidth(): number { return this.options.width ?? 1; }
  getChars(): string { return this.chars; }
  getCode(): number { return this.chars.codePointAt(0) ?? 0; }
  getFgColorMode(): number { return 0; }
  getBgColorMode(): number { return 0; }
  getFgColor(): number { return colorValue(this.options.foreground); }
  getBgColor(): number { return colorValue(this.options.background); }
  isBold(): number { return Number(this.options.bold === true); }
  isItalic(): number { return Number(this.options.italic === true); }
  isDim(): number { return Number(this.options.dim === true); }
  isUnderline(): number { return Number(this.options.underline === true); }
  isInverse(): number { return Number(this.options.inverse === true); }
  isInvisible(): number { return Number(this.options.invisible === true); }
  isStrikethrough(): number { return Number(this.options.strikethrough === true); }
  isOverline(): number { return Number(this.options.overline === true); }
  isFgRGB(): boolean { return this.options.foreground?.mode === "rgb"; }
  isBgRGB(): boolean { return this.options.background?.mode === "rgb"; }
  isFgPalette(): boolean { return this.options.foreground?.mode === "palette"; }
  isBgPalette(): boolean { return this.options.background?.mode === "palette"; }
  isFgDefault(): boolean { return this.options.foreground === undefined || this.options.foreground.mode === "default"; }
  isBgDefault(): boolean { return this.options.background === undefined || this.options.background.mode === "default"; }
  isAttributeDefault(): boolean {
    return this.options.foreground === undefined
      && this.options.background === undefined
      && this.options.bold !== true
      && this.options.italic !== true
      && this.options.dim !== true
      && this.options.underline !== true
      && this.options.inverse !== true
      && this.options.invisible !== true
      && this.options.strikethrough !== true
      && this.options.overline !== true;
  }
}

class TestLine implements TerminalCopyBufferLineSource {
  readonly length: number;

  constructor(private readonly cells: (TestCell | undefined)[], readonly isWrapped = false) {
    this.length = cells.length;
  }

  getCell(column: number, cell?: TerminalCopyBufferCellSource): TerminalCopyBufferCellSource | undefined {
    void cell;
    return this.cells[column];
  }
}

class TestBuffer implements TerminalCopyBufferSource {
  readonly length: number;

  constructor(
    private readonly lines: (TestLine | undefined)[],
    readonly baseY = 0,
    readonly cursorY = Math.max(0, lines.length - 1),
    readonly viewportY = baseY,
  ) {
    this.length = lines.length;
  }

  getLine(index: number): TerminalCopyBufferLineSource | undefined {
    return this.lines[index];
  }

  getNullCell(): TerminalCopyBufferCellSource {
    return new TestCell("");
  }
}

describe("createTerminalCopySnapshot", () => {
  it("joins wrapped physical rows into selectable logical lines", () => {
    const buffer = new TestBuffer([
      line("abc"),
      line("def", true),
      line("next"),
    ]);

    const snapshot = createTerminalCopySnapshot(buffer, 20);

    expect(snapshot.lines.map((item) => item.text)).toEqual(["abcdef", "next"]);
    expect(snapshot.text).toBe("abcdef\nnext");
    expect(snapshot.physicalLineCount).toBe(3);
  });

  it("preserves palette, RGB, inverse, and text-decoration styles", () => {
    const styled = new TestLine([
      new TestCell("A", { foreground: { mode: "palette", value: 1 }, bold: true }),
      new TestCell("B", { foreground: { mode: "palette", value: 1 }, bold: true }),
      new TestCell("C", {
        foreground: { mode: "rgb", value: 0x123456 },
        background: { mode: "palette", value: 4 },
        italic: true,
        underline: true,
        strikethrough: true,
        overline: true,
      }),
      new TestCell("D", {
        foreground: { mode: "palette", value: 2 },
        background: { mode: "rgb", value: 0x010203 },
        inverse: true,
      }),
    ]);

    const snapshot = createTerminalCopySnapshot(new TestBuffer([styled]), 20);

    expect(snapshot.lines[0]?.runs).toHaveLength(3);
    expect(snapshot.lines[0]?.runs[0]).toMatchObject({
      text: "AB",
      style: { foreground: "#ef2929", background: "#000000", bold: true },
    });
    expect(snapshot.lines[0]?.runs[1]).toMatchObject({
      text: "C",
      style: {
        foreground: "#123456",
        background: "#3465a4",
        italic: true,
        underline: true,
        strikethrough: true,
        overline: true,
      },
    });
    expect(snapshot.lines[0]?.runs[2]).toMatchObject({
      text: "D",
      style: { foreground: "#010203", background: "#4e9a06" },
    });
  });

  it("uses terminal theme colors and extended ANSI overrides", () => {
    const source = new TestLine([
      new TestCell("A"),
      new TestCell("B", { foreground: { mode: "palette", value: 1 } }),
      new TestCell("C", { foreground: { mode: "palette", value: 16 } }),
    ]);

    const snapshot = createTerminalCopySnapshot(new TestBuffer([source]), 20, {
      theme: {
        foreground: "#eeeeee",
        background: "#111111",
        red: "#aa0000",
        extendedAnsi: ["#abcdef"],
      },
    });

    expect(snapshot.lines[0]?.runs.map((run) => [run.text, run.style.foreground, run.style.background])).toEqual([
      ["A", "#eeeeee", "#111111"],
      ["B", "#aa0000", "#111111"],
      ["C", "#abcdef", "#111111"],
    ]);
  });

  it("keeps interior blanks while trimming unused cells on the right", () => {
    const source = new TestLine([
      new TestCell("A"),
      new TestCell(""),
      new TestCell("B"),
      new TestCell(""),
      new TestCell(""),
    ]);

    const snapshot = createTerminalCopySnapshot(new TestBuffer([source]), 5);

    expect(snapshot.text).toBe("A B");
  });

  it("includes the cursor line but omits unused rows below it", () => {
    const buffer = new TestBuffer([
      line("output"),
      new TestLine([new TestCell("")]),
      new TestLine([new TestCell("")]),
    ], 0, 1, 1);

    const snapshot = createTerminalCopySnapshot(buffer, 20);

    expect(snapshot.lines.map((item) => item.text)).toEqual(["output", ""]);
    expect(snapshot.text).toBe("output\n");
    expect(snapshot.physicalLineCount).toBe(2);
    expect(snapshot.viewportLine).toBe(1);
  });

  it("preserves wide and combined cells while skipping continuation cells", () => {
    const source = new TestLine([
      new TestCell("👩‍💻", { width: 2 }),
      new TestCell("", { width: 0 }),
      new TestCell("é"),
      new TestCell("!"),
    ]);

    const snapshot = createTerminalCopySnapshot(new TestBuffer([source]), 10);

    expect(snapshot.text).toBe("👩‍💻é!");
  });

  it("respects disabled bold-to-bright color promotion and terminal column bounds", () => {
    const source = new TestLine([
      new TestCell("A", { foreground: { mode: "palette", value: 1 }, bold: true }),
      new TestCell("B"),
      new TestCell("C"),
    ]);

    const snapshot = createTerminalCopySnapshot(new TestBuffer([source]), 2, { drawBoldTextInBrightColors: false });

    expect(snapshot.text).toBe("AB");
    expect(snapshot.lines[0]?.runs[0]?.style.foreground).toBe("#cc0000");
  });

  it("returns an empty snapshot when there are no usable columns", () => {
    expect(createTerminalCopySnapshot(new TestBuffer([line("output")]), 0)).toEqual({
      text: "",
      lines: [],
      physicalLineCount: 0,
      viewportLine: 0,
    });
  });
});

function line(text: string, isWrapped = false): TestLine {
  return new TestLine(Array.from(text, (character) => new TestCell(character)), isWrapped);
}

function colorValue(color: CellColor | undefined): number {
  return color?.mode === "default" || color === undefined ? 0 : color.value;
}
