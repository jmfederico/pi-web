import type { ITheme } from "@xterm/xterm";

export interface TerminalCopyBufferSource {
  readonly baseY: number;
  readonly cursorY: number;
  readonly viewportY: number;
  readonly length: number;
  getLine(index: number): TerminalCopyBufferLineSource | undefined;
  getNullCell(): TerminalCopyBufferCellSource;
}

export interface TerminalCopyBufferLineSource {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(column: number, cell?: TerminalCopyBufferCellSource): TerminalCopyBufferCellSource | undefined;
}

export interface TerminalCopyBufferCellSource {
  getWidth(): number;
  getChars(): string;
  getCode(): number;
  getFgColorMode(): number;
  getBgColorMode(): number;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isAttributeDefault(): boolean;
}

export interface TerminalCopyRunStyle {
  foreground: string;
  background: string;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
}

export interface TerminalCopyRun {
  text: string;
  style: TerminalCopyRunStyle;
}

export interface TerminalCopyLine {
  text: string;
  runs: TerminalCopyRun[];
}

export interface TerminalCopySnapshot {
  text: string;
  lines: TerminalCopyLine[];
  physicalLineCount: number;
  viewportLine: number;
}

export interface TerminalCopySnapshotOptions {
  theme?: ITheme | undefined;
  drawBoldTextInBrightColors?: boolean | undefined;
}

interface CapturedPhysicalLine extends TerminalCopyLine {
  wrapped: boolean;
}

const DEFAULT_FOREGROUND = "#ffffff";
const DEFAULT_BACKGROUND = "#000000";
const DEFAULT_ANSI_COLORS = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
] as const;
const ANSI_THEME_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const satisfies readonly (keyof ITheme)[];

// Pin the palette used by both xterm and its copy snapshot so a dependency
// upgrade cannot make the interactive and selectable views drift apart.
export const DEFAULT_TERMINAL_ANSI_THEME: ITheme = {
  black: DEFAULT_ANSI_COLORS[0],
  red: DEFAULT_ANSI_COLORS[1],
  green: DEFAULT_ANSI_COLORS[2],
  yellow: DEFAULT_ANSI_COLORS[3],
  blue: DEFAULT_ANSI_COLORS[4],
  magenta: DEFAULT_ANSI_COLORS[5],
  cyan: DEFAULT_ANSI_COLORS[6],
  white: DEFAULT_ANSI_COLORS[7],
  brightBlack: DEFAULT_ANSI_COLORS[8],
  brightRed: DEFAULT_ANSI_COLORS[9],
  brightGreen: DEFAULT_ANSI_COLORS[10],
  brightYellow: DEFAULT_ANSI_COLORS[11],
  brightBlue: DEFAULT_ANSI_COLORS[12],
  brightMagenta: DEFAULT_ANSI_COLORS[13],
  brightCyan: DEFAULT_ANSI_COLORS[14],
  brightWhite: DEFAULT_ANSI_COLORS[15],
};

export function createTerminalCopySnapshot(
  buffer: TerminalCopyBufferSource,
  columns: number,
  options: TerminalCopySnapshotOptions = {},
): TerminalCopySnapshot {
  const columnCount = Math.max(0, Math.floor(columns));
  if (buffer.length <= 0 || columnCount === 0) return { text: "", lines: [], physicalLineCount: 0, viewportLine: 0 };

  const palette = terminalAnsiPalette(options.theme);
  const foreground = options.theme?.foreground ?? DEFAULT_FOREGROUND;
  const background = options.theme?.background ?? DEFAULT_BACKGROUND;
  const physicalLines: CapturedPhysicalLine[] = [];
  const reusableCell = buffer.getNullCell();
  let lastMeaningfulLine = -1;

  for (let index = 0; index < buffer.length; index += 1) {
    const sourceLine = buffer.getLine(index);
    if (sourceLine === undefined) {
      physicalLines.push({ text: "", runs: [], wrapped: false });
      continue;
    }
    const line = capturePhysicalLine(sourceLine, columnCount, reusableCell, {
      palette,
      foreground,
      background,
      drawBoldTextInBrightColors: options.drawBoldTextInBrightColors !== false,
    });
    physicalLines.push(line);
    if (line.text !== "" || line.runs.some((run) => run.style.background !== background)) lastMeaningfulLine = index;
  }

  const cursorLine = Math.min(buffer.length - 1, Math.max(0, buffer.baseY + buffer.cursorY));
  const endLine = Math.max(lastMeaningfulLine, cursorLine);
  const includedPhysicalLines = physicalLines.slice(0, endLine + 1);
  const lines: TerminalCopyLine[] = [];

  for (const physicalLine of includedPhysicalLines) {
    const currentLine = lines.at(-1);
    if (physicalLine.wrapped && currentLine !== undefined) {
      currentLine.text += physicalLine.text;
      appendRuns(currentLine.runs, physicalLine.runs);
      continue;
    }
    lines.push({ text: physicalLine.text, runs: physicalLine.runs.map((run) => ({ text: run.text, style: run.style })) });
  }

  return {
    text: lines.map((line) => line.text).join("\n"),
    lines,
    physicalLineCount: includedPhysicalLines.length,
    viewportLine: Math.min(endLine, Math.max(0, buffer.viewportY)),
  };
}

interface CaptureColors {
  palette: readonly string[];
  foreground: string;
  background: string;
  drawBoldTextInBrightColors: boolean;
}

function capturePhysicalLine(sourceLine: TerminalCopyBufferLineSource, columns: number, reusableCell: TerminalCopyBufferCellSource, colors: CaptureColors): CapturedPhysicalLine {
  const cells: { text: string; meaningful: boolean; style: TerminalCopyRunStyle }[] = [];
  const cellCount = Math.min(columns, sourceLine.length);

  for (let column = 0; column < cellCount; column += 1) {
    const cell = sourceLine.getCell(column, reusableCell);
    if (cell === undefined) {
      cells.push({ text: " ", meaningful: false, style: defaultRunStyle(colors) });
      continue;
    }
    const width = cell.getWidth();
    if (width === 0) continue;
    const chars = cell.getChars();
    cells.push({
      text: chars === "" ? " ".repeat(Math.max(1, width)) : chars,
      meaningful: chars !== "" || !cell.isAttributeDefault(),
      style: copyRunStyle(cell, colors),
    });
  }

  let lastMeaningfulCell = cells.length - 1;
  while (lastMeaningfulCell >= 0 && cells[lastMeaningfulCell]?.meaningful !== true) lastMeaningfulCell -= 1;

  const runs: TerminalCopyRun[] = [];
  let text = "";
  for (let index = 0; index <= lastMeaningfulCell; index += 1) {
    const cell = cells[index];
    if (cell === undefined) continue;
    text += cell.text;
    appendRun(runs, { text: cell.text, style: cell.style });
  }

  return { text, runs, wrapped: sourceLine.isWrapped };
}

function copyRunStyle(cell: TerminalCopyBufferCellSource, colors: CaptureColors): TerminalCopyRunStyle {
  const inverse = cell.isInverse() !== 0;
  let foreground = resolveCellColor(cell, "foreground", colors);
  let background = resolveCellColor(cell, "background", colors);
  if (inverse) [foreground, background] = [background, foreground];

  if (cell.isBold() !== 0 && colors.drawBoldTextInBrightColors) {
    const foregroundPaletteIndex = inverse
      ? cell.isBgPalette() ? cell.getBgColor() : undefined
      : cell.isFgPalette() ? cell.getFgColor() : undefined;
    if (foregroundPaletteIndex !== undefined && foregroundPaletteIndex >= 0 && foregroundPaletteIndex < 8) {
      foreground = colors.palette[foregroundPaletteIndex + 8] ?? foreground;
    }
  }

  return {
    foreground,
    background,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    dim: cell.isDim() !== 0,
    underline: cell.isUnderline() !== 0,
    invisible: cell.isInvisible() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
    overline: cell.isOverline() !== 0,
  };
}

function resolveCellColor(cell: TerminalCopyBufferCellSource, target: "foreground" | "background", colors: CaptureColors): string {
  const rgb = target === "foreground" ? cell.isFgRGB() : cell.isBgRGB();
  const palette = target === "foreground" ? cell.isFgPalette() : cell.isBgPalette();
  const value = target === "foreground" ? cell.getFgColor() : cell.getBgColor();
  if (rgb) return rgbColor(value);
  if (palette) return colors.palette[value] ?? (target === "foreground" ? colors.foreground : colors.background);
  return target === "foreground" ? colors.foreground : colors.background;
}

function defaultRunStyle(colors: CaptureColors): TerminalCopyRunStyle {
  return {
    foreground: colors.foreground,
    background: colors.background,
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    invisible: false,
    strikethrough: false,
    overline: false,
  };
}

function appendRuns(target: TerminalCopyRun[], incoming: readonly TerminalCopyRun[]): void {
  for (const run of incoming) appendRun(target, run);
}

function appendRun(runs: TerminalCopyRun[], run: TerminalCopyRun): void {
  if (run.text === "") return;
  const previous = runs.at(-1);
  if (previous !== undefined && sameRunStyle(previous.style, run.style)) {
    previous.text += run.text;
    return;
  }
  runs.push({ text: run.text, style: run.style });
}

function sameRunStyle(left: TerminalCopyRunStyle, right: TerminalCopyRunStyle): boolean {
  return left.foreground === right.foreground
    && left.background === right.background
    && left.bold === right.bold
    && left.italic === right.italic
    && left.dim === right.dim
    && left.underline === right.underline
    && left.invisible === right.invisible
    && left.strikethrough === right.strikethrough
    && left.overline === right.overline;
}

function terminalAnsiPalette(theme: ITheme | undefined): string[] {
  const colors: string[] = [...DEFAULT_ANSI_COLORS];
  for (let index = 0; index < ANSI_THEME_KEYS.length; index += 1) {
    const key = ANSI_THEME_KEYS[index];
    if (key === undefined) continue;
    const themedColor = theme?.[key];
    if (typeof themedColor === "string") colors[index] = themedColor;
  }

  const levels = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  for (let index = 0; index < 216; index += 1) {
    const red = levels[Math.floor(index / 36) % 6] ?? 0;
    const green = levels[Math.floor(index / 6) % 6] ?? 0;
    const blue = levels[index % 6] ?? 0;
    colors.push(rgbChannels(red, green, blue));
  }
  for (let index = 0; index < 24; index += 1) {
    const channel = 8 + index * 10;
    colors.push(rgbChannels(channel, channel, channel));
  }
  for (let index = 0; index < Math.min(theme?.extendedAnsi?.length ?? 0, 240); index += 1) {
    const themedColor = theme?.extendedAnsi?.[index];
    if (themedColor !== undefined) colors[index + 16] = themedColor;
  }
  return colors;
}

function rgbColor(value: number): string {
  return `#${(value & 0xFFFFFF).toString(16).padStart(6, "0")}`;
}

function rgbChannels(red: number, green: number, blue: number): string {
  return `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
}
