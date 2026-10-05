export function isLargeText(text: string): boolean {
  return text.length >= 1500 || text.split("\n").length >= 10;
}

export function textSizeLabel(text: string): string {
  const lines = text.split("\n").length;
  return `${String(lines)} ${lines === 1 ? "line" : "lines"} · ${String(text.length)} characters`;
}
