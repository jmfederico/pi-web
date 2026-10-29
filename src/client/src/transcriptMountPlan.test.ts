import { describe, expect, it } from 'vitest';
import { planTranscriptMounts, type TranscriptMountRow, type TranscriptMountSegment } from './transcriptMountPlan.js';

const anySpacerKey: unknown = expect.any(String);

const rows: readonly TranscriptMountRow[] = [
  { key: 'a', height: 10 },
  { key: 'b', height: 25 },
  { key: 'c', height: 5 },
  { key: 'd', height: 40 },
  { key: 'e', height: 20 },
  { key: 'f', height: 15 },
  { key: 'g', height: 30 },
];

function spacers(plan: readonly TranscriptMountSegment[]) {
  return plan.filter(segment => segment.kind === 'spacer');
}

// Expand only mounted ranges to observe their positions in the full geometry.
function geometry(source: readonly TranscriptMountRow[], plan: readonly TranscriptMountSegment[]) {
  let height = 0;
  const mounted: { key: string; top: number; bottom: number }[] = [];
  for (const segment of plan) {
    if (segment.kind === 'spacer') {
      expect(segment.height).toBeGreaterThan(0);
      height += segment.height;
    } else {
      expect(segment.end).toBeGreaterThan(segment.start);
      for (const row of source.slice(segment.start, segment.end)) {
        mounted.push({ key: row.key, top: height, bottom: height + row.height });
        height += row.height;
      }
    }
  }
  return { mounted, height };
}

describe('planTranscriptMounts', () => {
  it('uses variable-height intersections and aggregates the complete omitted prefix and suffix', () => {
    const plan = planTranscriptMounts(rows, { top: 36, height: 5, overscan: 0 });
    expect(plan).toEqual([
      { kind: 'spacer', key: anySpacerKey, height: 35 },
      { kind: 'rows', start: 2, end: 4 },
      { kind: 'spacer', key: anySpacerKey, height: 65 },
    ]);
    expect(geometry(rows, plan)).toEqual({
      mounted: [{ key: 'c', top: 35, bottom: 40 }, { key: 'd', top: 40, bottom: 80 }],
      height: 145,
    });
  });

  it('excludes rows merely touching the half-open viewport boundaries', () => {
    expect(planTranscriptMounts(rows, { top: 35, height: 5, overscan: 0 })[1])
      .toEqual({ kind: 'rows', start: 2, end: 3 });
  });

  it('expands by overscan and merges adjacent protected rows into the visible range', () => {
    const plan = planTranscriptMounts(rows, { top: 40, height: 1, overscan: 6 }, new Set(['a', 'e']));
    expect(plan).toEqual([
      { kind: 'rows', start: 0, end: 5 },
      { kind: 'spacer', key: anySpacerKey, height: 45 },
    ]);
    expect(geometry(rows, plan).height).toBe(145);
  });

  it('retains disjoint protected islands without mounting their intervening rows', () => {
    const plan = planTranscriptMounts(rows, { top: 40, height: 40, overscan: 0 }, new Set(['a', 'g', 'missing']));
    expect(plan).toEqual([
      { kind: 'rows', start: 0, end: 1 },
      { kind: 'spacer', key: anySpacerKey, height: 30 },
      { kind: 'rows', start: 3, end: 4 },
      { kind: 'spacer', key: anySpacerKey, height: 35 },
      { kind: 'rows', start: 6, end: 7 },
    ]);
    expect(geometry(rows, plan)).toEqual({
      mounted: [
        { key: 'a', top: 0, bottom: 10 },
        { key: 'd', top: 40, bottom: 80 },
        { key: 'g', top: 115, bottom: 145 },
      ],
      height: 145,
    });
    expect(new Set(spacers(plan).map(segment => segment.key)).size).toBe(2);
  });

  it('handles empty lists and viewports at or beyond the total height', () => {
    expect(planTranscriptMounts([], { top: 100, height: 10, overscan: 0 })).toEqual([]);
    for (const top of [145, 1000]) {
      const plan = planTranscriptMounts(rows, { top, height: 10, overscan: 0 });
      expect(plan).toEqual([{ kind: 'spacer', key: anySpacerKey, height: 145 }]);
      expect(geometry(rows, plan)).toEqual({ mounted: [], height: 145 });
    }
  });

  it('clamps negative viewport values and leaves a zero-length window empty', () => {
    const plan = planTranscriptMounts(rows, { top: -10, height: -5, overscan: -1 });
    expect(geometry(rows, plan)).toEqual({ mounted: [], height: 145 });
    expect(planTranscriptMounts(rows, { top: -10, height: 10, overscan: -1 })[0])
      .toEqual({ kind: 'rows', start: 0, end: 1 });
    expect(planTranscriptMounts(rows, { top: 35, height: 0, overscan: 1 })[1])
      .toEqual({ kind: 'rows', start: 1, end: 3 });
    expect(planTranscriptMounts(rows, { top: 35, height: 0, overscan: 0 }, new Set(['c']))[1])
      .toEqual({ kind: 'rows', start: 2, end: 3 });
  });

  it('emits a single range when every row is selected, including fractional heights', () => {
    const source = [{ key: 'one', height: 1.5 }, { key: 'two', height: 2.25 }];
    const plan = planTranscriptMounts(source, { top: 0, height: 10, overscan: 0 });
    expect(plan).toEqual([{ kind: 'rows', start: 0, end: 2 }]);
    expect(geometry(source, plan).height).toBe(3.75);
  });

  it('keeps spacer identities stable across measurements and preceding insertions', () => {
    const viewport = { top: 0, height: 0, overscan: 0 };
    const protectedKeys = new Set(['d']);
    const original = planTranscriptMounts(rows, viewport, protectedKeys);
    const resized = planTranscriptMounts(rows.map(row => ({ ...row, height: row.height * 2 })), viewport, protectedKeys);
    expect(spacers(resized).map(segment => segment.key)).toEqual(spacers(original).map(segment => segment.key));
    const inserted = planTranscriptMounts([{ key: 'new', height: 1 }, ...rows], viewport, protectedKeys);
    expect(spacers(inserted)[1]?.key).toEqual(expect.any(String));
    expect(spacers(inserted)[1]?.key).toBe(spacers(original)[1]?.key);
  });

  it('does not mutate frozen inputs or retain state between calls', () => {
    const source = Object.freeze(rows.map(row => Object.freeze({ ...row })));
    const viewport = Object.freeze({ top: 0, height: 10, overscan: 0 });
    const protectedKeys = new Set(['g']);
    const before = planTranscriptMounts(source, viewport, protectedKeys);
    planTranscriptMounts(source, { top: 0, height: 1000, overscan: 0 });
    expect(planTranscriptMounts(source, viewport, protectedKeys)).toEqual(before);
    expect([...protectedKeys]).toEqual(['g']);
  });

  it('rejects invalid geometry and duplicate identities explicitly', () => {
    for (const height of [0, -1, 0.5, NaN, Infinity]) {
      expect(() => planTranscriptMounts([{ key: 'bad', height }], { top: 0, height: 1, overscan: 0 }))
        .toThrow(/height/);
    }
    for (const field of ['top', 'height', 'overscan']) {
      expect(() => planTranscriptMounts([], { top: 0, height: 1, overscan: 0, [field]: NaN }))
        .toThrow(/finite/);
    }
    expect(() => planTranscriptMounts([{ key: 'a', height: 10 }, { key: 'a', height: 20 }], { top: 0, height: 1, overscan: 0 }))
      .toThrow(/Duplicate/);
    expect(() => planTranscriptMounts([], { top: Number.MAX_VALUE, height: Number.MAX_VALUE, overscan: 0 }))
      .toThrow(/finite/);
    expect(() => planTranscriptMounts([
      { key: 'a', height: Number.MAX_VALUE }, { key: 'b', height: Number.MAX_VALUE },
    ], { top: 0, height: 1, overscan: 0 })).toThrow(/finite/);
  });
});
