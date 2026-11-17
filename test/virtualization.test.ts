import { describe, expect, it } from 'vitest';
import { RowMetrics } from '../src/index';

describe('uniform metrics', () => {
  const metrics = RowMetrics.uniform({ rowCount: 1000, rowHeight: 40 });

  it('multiplies rows by height for the total extent', () => {
    expect(metrics.totalExtent).toBe(40000);
    expect(metrics.isUniform).toBe(true);
  });

  it('resolves offsets and heights arithmetically', () => {
    expect(metrics.offsetOf(0)).toBe(0);
    expect(metrics.offsetOf(10)).toBe(400);
    expect(metrics.heightOf(10)).toBe(40);
  });

  it('resolves the row under an offset', () => {
    expect(metrics.indexAt(0)).toBe(0);
    expect(metrics.indexAt(39.9)).toBe(0);
    expect(metrics.indexAt(40)).toBe(1);
    expect(metrics.indexAt(405)).toBe(10);
  });

  it('clamps outside the content', () => {
    expect(metrics.indexAt(-100)).toBe(0);
    expect(metrics.indexAt(1e9)).toBe(999);
  });

  it('covers the viewport plus overscan', () => {
    const window = metrics.windowFor({
      scrollOffset: 400,
      viewportExtent: 200,
      overscan: 2,
    });
    expect(window.firstIndex).toBe(8);
    expect(window.lastIndex).toBe(17);
    expect(window.offset).toBe(320);
    expect(window.totalExtent).toBe(40000);
    expect(window.length).toBe(10);
  });

  it('never runs past the ends', () => {
    const top = metrics.windowFor({ scrollOffset: 0, viewportExtent: 100 });
    expect(top.firstIndex).toBe(0);
    const bottom = metrics.windowFor({
      scrollOffset: 39900,
      viewportExtent: 100,
    });
    expect(bottom.lastIndex).toBe(999);
  });

  it('enumerates exactly the visible rows', () => {
    const window = metrics.windowFor({
      scrollOffset: 0,
      viewportExtent: 80,
      overscan: 0,
    });
    expect(window.indices).toEqual([0, 1, 2]);
  });
});

describe('empty and degenerate metrics', () => {
  it('yields an empty window for no rows', () => {
    const metrics = RowMetrics.uniform({ rowCount: 0, rowHeight: 40 });
    const window = metrics.windowFor({
      scrollOffset: 0,
      viewportExtent: 500,
    });
    expect(window.isEmpty).toBe(true);
    expect(metrics.totalExtent).toBe(0);
  });

  it('yields an empty window for a zero-height viewport', () => {
    const metrics = RowMetrics.uniform({ rowCount: 10, rowHeight: 40 });
    expect(
      metrics.windowFor({ scrollOffset: 0, viewportExtent: 0 }).isEmpty,
    ).toBe(true);
  });

  it('reports zero height outside the range', () => {
    const metrics = RowMetrics.uniform({ rowCount: 3, rowHeight: 40 });
    expect(metrics.heightOf(-1)).toBe(0);
    expect(metrics.heightOf(3)).toBe(0);
  });
});

describe('variable metrics', () => {
  // 0:20, 1:40, 2:60, 3:80, 4:100 -> offsets 0, 20, 60, 120, 200, 300
  const metrics = RowMetrics.variable({
    rowCount: 5,
    heightOf: (i) => 20 * (i + 1),
  });

  it('accumulates per-row heights', () => {
    expect(metrics.isUniform).toBe(false);
    expect(metrics.totalExtent).toBe(300);
    expect(metrics.offsetOf(0)).toBe(0);
    expect(metrics.offsetOf(3)).toBe(120);
    expect(metrics.heightOf(3)).toBe(80);
  });

  it('finds the row at an offset and at the boundaries', () => {
    expect(metrics.indexAt(0)).toBe(0);
    expect(metrics.indexAt(19)).toBe(0);
    expect(metrics.indexAt(20)).toBe(1);
    expect(metrics.indexAt(59)).toBe(1);
    expect(metrics.indexAt(60)).toBe(2);
    expect(metrics.indexAt(299)).toBe(4);
  });

  it('reports the offset of a window first row', () => {
    const window = metrics.windowFor({
      scrollOffset: 130,
      viewportExtent: 50,
      overscan: 0,
    });
    expect(window.firstIndex).toBe(3);
    expect(window.offset).toBe(120);
  });

  it('maps every offset in the content to a row that contains it', () => {
    for (let offset = 0; offset < 300; offset += 7) {
      const index = metrics.indexAt(offset);
      expect(metrics.offsetOf(index)).toBeLessThanOrEqual(offset);
      expect(metrics.offsetOf(index) + metrics.heightOf(index)).toBeGreaterThan(
        offset,
      );
    }
  });
});

describe('scrollOffsetToReveal', () => {
  const metrics = RowMetrics.uniform({ rowCount: 100, rowHeight: 40 });

  it('scrolls up to a row above the viewport', () => {
    expect(
      metrics.scrollOffsetToReveal(2, {
        viewportExtent: 400,
        currentOffset: 800,
      }),
    ).toBe(80);
  });

  it('scrolls down just far enough for a row below the viewport', () => {
    expect(
      metrics.scrollOffsetToReveal(20, {
        viewportExtent: 400,
        currentOffset: 0,
      }),
    ).toBe(440);
  });

  it('does not move when the row is already visible', () => {
    expect(
      metrics.scrollOffsetToReveal(5, {
        viewportExtent: 400,
        currentOffset: 100,
      }),
    ).toBe(100);
  });

  it('never scrolls past the ends', () => {
    expect(
      metrics.scrollOffsetToReveal(0, {
        viewportExtent: 400,
        currentOffset: 10,
        padding: 100,
      }),
    ).toBe(0);
    expect(
      metrics.scrollOffsetToReveal(99, {
        viewportExtent: 400,
        currentOffset: 0,
      }),
    ).toBe(metrics.totalExtent - 400);
  });
});
