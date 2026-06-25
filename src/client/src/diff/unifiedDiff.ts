import { diffChars } from "diff";

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

  const changes = diffChars(oldText, newText);
  const similarity = similarityFromChanges(changes, oldText, newText);
  if (Math.max(oldText.length, newText.length) >= 20 && similarity < minInlineSimilarity) return undefined;

  const removed: UnifiedDiffTextSpan[] = [];
  const added: UnifiedDiffTextSpan[] = [];
  for (const change of changes) {
    if (change.value === "") continue;
    if (change.added) added.push({ text: change.value, changed: true });
    else if (change.removed) removed.push({ text: change.value, changed: true });
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
  return similarityFromChanges(diffChars(oldText, newText), oldText, newText);
}

function similarityFromChanges(changes: ReturnType<typeof diffChars>, oldText: string, newText: string): number {
  const maxLength = Math.max(oldText.length, newText.length);
  if (maxLength === 0) return 1;
  const unchangedLength = changes.reduce((total, change) => change.added || change.removed ? total : total + change.value.length, 0);
  return unchangedLength / maxLength;
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
