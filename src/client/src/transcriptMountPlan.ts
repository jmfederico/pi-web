export interface TranscriptMountRow {
  readonly key: string;
  readonly height: number;
}

export interface TranscriptMountViewport {
  readonly top: number;
  readonly height: number;
  readonly overscan: number;
}

export type TranscriptMountSegment =
  | { kind: 'rows'; start: number; end: number }
  | { kind: 'spacer'; key: string; height: number };

/**
 * Partitions retained rows into mounted ranges and omitted-height spacers.
 * Row keys must be unique and heights finite and >= 1. Viewport values must
 * be finite; negative values are clamped to zero before expanding by overscan.
 * Intersections are half-open; an empty expanded viewport selects no rows.
 * Unknown protected keys are ignored. Inputs are never mutated.
 */
export function planTranscriptMounts(
  rows: readonly TranscriptMountRow[],
  viewport: TranscriptMountViewport,
  protectedKeys: ReadonlySet<string> = new Set<string>(),
): TranscriptMountSegment[] {
  if (![viewport.top, viewport.height, viewport.overscan].every(Number.isFinite)) {
    throw new RangeError('Transcript viewport values must be finite');
  }
  const top = Math.max(0, viewport.top);
  const height = Math.max(0, viewport.height);
  const overscan = Math.max(0, viewport.overscan);
  const visibleStart = Math.max(0, top - overscan);
  const visibleEnd = top + height + overscan;
  if (!Number.isFinite(visibleEnd)) {
    throw new RangeError('Expanded transcript viewport must be finite');
  }

  const segments: TranscriptMountSegment[] = [];
  const keys = new Set<string>();
  let offset = 0;
  let runStart = 0;
  let runHeight = 0;
  let runSelected = false;
  let runFirstKey = '';
  let runLastKey = '';

  function appendRun(end: number): void {
    if (runStart === end) return;
    segments.push(runSelected
      ? { kind: 'rows', start: runStart, end }
      : {
        kind: 'spacer',
        // Tuple encoding avoids delimiter collisions. The omitted boundary row
        // IDs keep keys independent of measurements and preceding row indices.
        key: `spacer:${JSON.stringify([runFirstKey, runLastKey])}`,
        height: runHeight,
      });
  }

  for (const [index, row] of rows.entries()) {
    if (!Number.isFinite(row.height) || row.height < 1) {
      throw new RangeError(`Transcript row ${String(index)} height must be finite and >= 1`);
    }
    if (keys.has(row.key)) {
      throw new Error(`Duplicate transcript row key: ${row.key}`);
    }
    keys.add(row.key);
    const bottom = offset + row.height;
    if (!Number.isFinite(bottom)) {
      throw new RangeError('Total transcript height must be finite');
    }
    const selected = protectedKeys.has(row.key)
      || (visibleEnd > visibleStart && bottom > visibleStart && offset < visibleEnd);
    if (selected !== runSelected) {
      appendRun(index);
      runStart = index;
      runHeight = 0;
      runSelected = selected;
    }
    if (index === runStart) runFirstKey = row.key;
    runLastKey = row.key;
    runHeight += row.height;
    offset = bottom;
  }
  appendRun(rows.length);
  return segments;
}
