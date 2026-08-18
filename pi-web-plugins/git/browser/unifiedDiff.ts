export type UnifiedDiffLineKind = "meta" | "hunk" | "context" | "add" | "remove" | "marker";

export interface UnifiedDiffTextSpan {
  text: string;
  changed: boolean;
}

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind;
  prefix: string;
  text: string;
  spans: UnifiedDiffTextSpan[];
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface InlineDiffResult {
  removed: UnifiedDiffTextSpan[];
  added: UnifiedDiffTextSpan[];
}

interface DiffLinePair {
  removed: UnifiedDiffLine;
  added: UnifiedDiffLine;
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const maxInlineLineLength = 5_000;
const maxInlineBlockLines = 20;
const minInlineSimilarity = 0.20;
const minPairSimilarity = 0.25;
const maxInlineMatrixCells = 250_000;

interface CharacterChange {
  value: string;
  unitCount: number;
  added?: boolean;
  removed?: boolean;
}

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function parseUnifiedDiff(diff: string): UnifiedDiffLine[] {
  const parsedLines = parseUnifiedDiffLines(diff);
  applyInlineDiffs(parsedLines);
  return parsedLines;
}

function parseUnifiedDiffLines(diff: string): UnifiedDiffLine[] {
  const lines = splitDiffLines(diff);
  const parsedLines: UnifiedDiffLine[] = [];
  let oldLineNumber: number | undefined;
  let newLineNumber: number | undefined;

  for (const rawLine of lines) {
    const hunkMatch = hunkHeaderPattern.exec(rawLine);
    if (hunkMatch !== null) {
      oldLineNumber = Number(hunkMatch[1]);
      newLineNumber = Number(hunkMatch[2]);
      parsedLines.push(line("hunk", "", rawLine));
      continue;
    }

    if (oldLineNumber !== undefined && newLineNumber !== undefined) {
      if (rawLine.startsWith("+")) {
        parsedLines.push(line("add", "+", rawLine.slice(1), { newLineNumber }));
        newLineNumber++;
        continue;
      }
      if (rawLine.startsWith("-")) {
        parsedLines.push(line("remove", "-", rawLine.slice(1), { oldLineNumber }));
        oldLineNumber++;
        continue;
      }
      if (rawLine.startsWith(" ")) {
        parsedLines.push(line("context", " ", rawLine.slice(1), { oldLineNumber, newLineNumber }));
        oldLineNumber++;
        newLineNumber++;
        continue;
      }
      if (rawLine.startsWith("\\")) {
        parsedLines.push(line("marker", "", rawLine));
        continue;
      }
    }

    oldLineNumber = undefined;
    newLineNumber = undefined;
    parsedLines.push(line("meta", "", rawLine));
  }

  return parsedLines;
}

function splitDiffLines(diff: string): string[] {
  if (diff === "") return [];
  const lines = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function line(kind: UnifiedDiffLineKind, prefix: string, text: string, numbers: { oldLineNumber?: number; newLineNumber?: number } = {}): UnifiedDiffLine {
  return {
    kind,
    prefix,
    text,
    spans: text === "" ? [] : [{ text, changed: false }],
    ...numbers,
  };
}

function applyInlineDiffs(lines: UnifiedDiffLine[]): void {
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    if (current?.kind !== "remove") {
      index++;
      continue;
    }

    const removedStart = index;
    while (lines[index]?.kind === "remove") index++;
    const addedStart = index;
    while (lines[index]?.kind === "add") index++;

    if (addedStart === index) continue;
    const removedLines = lines.slice(removedStart, addedStart);
    const addedLines = lines.slice(addedStart, index);
    applyInlineDiffBlock(removedLines, addedLines);
  }
}

function applyInlineDiffBlock(removedLines: UnifiedDiffLine[], addedLines: UnifiedDiffLine[]): void {
  if (removedLines.length + addedLines.length > maxInlineBlockLines) return;
  for (const pair of pairChangedLines(removedLines, addedLines)) {
    const inlineDiff = computeInlineDiff(pair.removed.text, pair.added.text);
    if (inlineDiff === undefined) continue;
    pair.removed.spans = inlineDiff.removed;
    pair.added.spans = inlineDiff.added;
  }
}

function pairChangedLines(removedLines: UnifiedDiffLine[], addedLines: UnifiedDiffLine[]): DiffLinePair[] {
  if (removedLines.length === addedLines.length) return removedLines.map((removed, index) => ({ removed, added: addedLines[index] })).filter(isCompletePair);
  if (removedLines.length === 1) return bestPairsForSingleRemovedLine(removedLines[0], addedLines);
  if (addedLines.length === 1) return bestPairsForSingleAddedLine(removedLines, addedLines[0]);

  const pairs: DiffLinePair[] = [];
  const pairCount = Math.min(removedLines.length, addedLines.length);
  for (let index = 0; index < pairCount; index++) {
    const removed = removedLines[index];
    const added = addedLines[index];
    if (removed === undefined || added === undefined) continue;
    if (lineSimilarity(removed.text, added.text) >= minPairSimilarity) pairs.push({ removed, added });
  }
  return pairs;
}

function isCompletePair(pair: { removed: UnifiedDiffLine; added: UnifiedDiffLine | undefined }): pair is DiffLinePair {
  return pair.added !== undefined;
}

function bestPairsForSingleRemovedLine(removed: UnifiedDiffLine | undefined, addedLines: UnifiedDiffLine[]): DiffLinePair[] {
  if (removed === undefined) return [];
  const added = bestMatchingLine(removed.text, addedLines);
  return added === undefined ? [] : [{ removed, added }];
}

function bestPairsForSingleAddedLine(removedLines: UnifiedDiffLine[], added: UnifiedDiffLine | undefined): DiffLinePair[] {
  if (added === undefined) return [];
  const removed = bestMatchingLine(added.text, removedLines);
  return removed === undefined ? [] : [{ removed, added }];
}

function bestMatchingLine(text: string, candidates: UnifiedDiffLine[]): UnifiedDiffLine | undefined {
  let bestCandidate: UnifiedDiffLine | undefined;
  let bestScore = minPairSimilarity;
  for (const candidate of candidates) {
    const score = lineSimilarity(text, candidate.text);
    if (score <= bestScore) continue;
    bestCandidate = candidate;
    bestScore = score;
  }
  return bestCandidate;
}

function computeInlineDiff(oldText: string, newText: string): InlineDiffResult | undefined {
  if (oldText === newText) return undefined;
  if (oldText.length > maxInlineLineLength || newText.length > maxInlineLineLength) return undefined;
  const oldUnits = splitTextUnits(oldText);
  const newUnits = splitTextUnits(newText);
  if (oldUnits.length > maxInlineLineLength || newUnits.length > maxInlineLineLength) return undefined;

  const changes = diffTextUnits(oldUnits, newUnits);
  const similarity = similarityFromChanges(changes, oldUnits.length, newUnits.length);
  if (Math.max(oldUnits.length, newUnits.length) >= 20 && similarity < minInlineSimilarity) return undefined;

  const removed: UnifiedDiffTextSpan[] = [];
  const added: UnifiedDiffTextSpan[] = [];
  for (const change of changes) {
    if (change.value === "") continue;
    if (change.added === true) added.push({ text: change.value, changed: true });
    else if (change.removed === true) removed.push({ text: change.value, changed: true });
    else {
      removed.push({ text: change.value, changed: false });
      added.push({ text: change.value, changed: false });
    }
  }

  if (!removed.some((span) => span.changed) && !added.some((span) => span.changed)) return undefined;
  return { removed: mergeAdjacentSpans(removed), added: mergeAdjacentSpans(added) };
}

function lineSimilarity(oldText: string, newText: string): number {
  if (oldText === newText) return 1;
  if (oldText.length > maxInlineLineLength || newText.length > maxInlineLineLength) return 0;
  const oldUnits = splitTextUnits(oldText);
  const newUnits = splitTextUnits(newText);
  if (oldUnits.length > maxInlineLineLength || newUnits.length > maxInlineLineLength) return 0;
  return similarityFromChanges(diffTextUnits(oldUnits, newUnits), oldUnits.length, newUnits.length);
}

function similarityFromChanges(changes: CharacterChange[], oldLength: number, newLength: number): number {
  const maxLength = Math.max(oldLength, newLength);
  if (maxLength === 0) return 1;
  const unchangedLength = changes.reduce((total, change) => change.added === true || change.removed === true ? total : total + change.unitCount, 0);
  return unchangedLength / maxLength;
}

/**
 * Grapheme-level diff for inline highlights. Browser plugins are served as
 * native modules, so this package keeps the bounded algorithm local instead of
 * depending on an application-bundled bare module. Large, dissimilar middles
 * intentionally fall back to whole-span changes rather than doing unbounded
 * quadratic work. The code-point fallback still never splits surrogate pairs.
 */
function diffTextUnits(oldText: readonly string[], newText: readonly string[]): CharacterChange[] {
  if (sameTextUnits(oldText, newText)) return oldText.length === 0 ? [] : [{ value: oldText.join(""), unitCount: oldText.length }];

  let prefixLength = 0;
  const sharedLength = Math.min(oldText.length, newText.length);
  while (prefixLength < sharedLength && oldText[prefixLength] === newText[prefixLength]) prefixLength += 1;

  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength
    && oldText[oldText.length - suffixLength - 1] === newText[newText.length - suffixLength - 1]
  ) suffixLength += 1;

  const oldMiddle = oldText.slice(prefixLength, oldText.length - suffixLength);
  const newMiddle = newText.slice(prefixLength, newText.length - suffixLength);
  const changes: CharacterChange[] = [];
  appendCharacterChange(changes, oldText.slice(0, prefixLength));

  if (oldMiddle.length * newMiddle.length > maxInlineMatrixCells) {
    appendCharacterChange(changes, oldMiddle, "removed");
    appendCharacterChange(changes, newMiddle, "added");
  } else {
    for (const change of diffMiddleCharacters(oldMiddle, newMiddle)) appendCharacterChange(changes, splitTextUnits(change.value), change.added === true ? "added" : change.removed === true ? "removed" : undefined);
  }

  appendCharacterChange(changes, oldText.slice(oldText.length - suffixLength));
  return changes;
}

function diffMiddleCharacters(oldText: readonly string[], newText: readonly string[]): CharacterChange[] {
  if (oldText.length === 0) return newText.length === 0 ? [] : [{ value: newText.join(""), unitCount: newText.length, added: true }];
  if (newText.length === 0) return [{ value: oldText.join(""), unitCount: oldText.length, removed: true }];

  const width = newText.length + 1;
  const matrix = new Uint32Array((oldText.length + 1) * width);
  for (let oldIndex = oldText.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newText.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      matrix[offset] = oldText[oldIndex] === newText[newIndex]
        ? (matrix[(oldIndex + 1) * width + newIndex + 1] ?? 0) + 1
        : Math.max(matrix[(oldIndex + 1) * width + newIndex] ?? 0, matrix[oldIndex * width + newIndex + 1] ?? 0);
    }
  }

  const changes: CharacterChange[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldText.length || newIndex < newText.length) {
    if (oldIndex < oldText.length && newIndex < newText.length && oldText[oldIndex] === newText[newIndex]) {
      appendCharacterChange(changes, [oldText[oldIndex] ?? ""]);
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex >= newText.length || (oldIndex < oldText.length && (matrix[(oldIndex + 1) * width + newIndex] ?? 0) >= (matrix[oldIndex * width + newIndex + 1] ?? 0))) {
      appendCharacterChange(changes, [oldText[oldIndex] ?? ""], "removed");
      oldIndex += 1;
    } else {
      appendCharacterChange(changes, [newText[newIndex] ?? ""], "added");
      newIndex += 1;
    }
  }
  return changes;
}

function appendCharacterChange(changes: CharacterChange[], units: readonly string[], kind?: "added" | "removed"): void {
  if (units.length === 0) return;
  const value = units.join("");
  const previous = changes[changes.length - 1];
  const added = kind === "added";
  const removed = kind === "removed";
  if (previous !== undefined && previous.added === (added || undefined) && previous.removed === (removed || undefined)) {
    previous.value += value;
    previous.unitCount += units.length;
    return;
  }
  changes.push({ value, unitCount: units.length, ...(added ? { added: true } : {}), ...(removed ? { removed: true } : {}) });
}

function splitTextUnits(text: string): string[] {
  if (graphemeSegmenter === undefined) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

function sameTextUnits(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((unit, index) => unit === right[index]);
}

function mergeAdjacentSpans(spans: UnifiedDiffTextSpan[]): UnifiedDiffTextSpan[] {
  const merged: UnifiedDiffTextSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous?.changed === span.changed) previous.text += span.text;
    else merged.push({ ...span });
  }
  return merged;
}
