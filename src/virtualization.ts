/**
 * Row and column windowing maths.
 *
 * @module
 */

import { GridArgumentError } from './errors';
import { clamp } from './util';

/** The slice of rows a viewport can see. */
export class RowWindow {
  /** The window of a grid with nothing to show. */
  static readonly empty: RowWindow = new RowWindow({
    firstIndex: 0,
    lastIndex: -1,
    offset: 0,
    totalExtent: 0,
  });

  /** First visible row, inclusive. */
  readonly firstIndex: number;

  /** Last visible row, inclusive. Less than {@link firstIndex} when empty. */
  readonly lastIndex: number;

  /**
   * Distance from the top of the scrollable content to the top of
   * {@link firstIndex}, so the adapter can place the window without a per-row
   * layout pass.
   */
  readonly offset: number;

  /** Height of every row together, i.e. the scrollable extent. */
  readonly totalExtent: number;

  constructor(options: {
    firstIndex: number;
    lastIndex: number;
    offset: number;
    totalExtent: number;
  }) {
    this.firstIndex = options.firstIndex;
    this.lastIndex = options.lastIndex;
    this.offset = options.offset;
    this.totalExtent = options.totalExtent;
    Object.freeze(this);
  }

  get length(): number {
    return this.lastIndex < this.firstIndex
      ? 0
      : this.lastIndex - this.firstIndex + 1;
  }

  get isEmpty(): boolean {
    return this.length === 0;
  }

  /** The indices in this window, ascending. */
  get indices(): number[] {
    const out = new Array<number>(this.length);
    for (let i = 0; i < out.length; i++) out[i] = this.firstIndex + i;
    return out;
  }

  toString(): string {
    return `RowWindow(${this.firstIndex}..${this.lastIndex}, offset ${this.offset} of ${this.totalExtent})`;
  }
}

/**
 * Maps between scroll offsets and row indices.
 *
 * Uniform rows are pure arithmetic. Variable rows (a measured row, an
 * expanded detail panel, a taller group header) are served from a prefix-sum
 * table built once per change and binary-searched, which keeps scrolling
 * O(log n) instead of O(n).
 */
export class RowMetrics {
  readonly rowCount: number;
  private readonly rowHeight: number;
  private readonly offsets: Float64Array | null;

  private constructor(
    rowCount: number,
    rowHeight: number,
    offsets: Float64Array | null,
  ) {
    this.rowCount = rowCount;
    this.rowHeight = rowHeight;
    this.offsets = offsets;
  }

  /** Metrics for rows that are all the same height. */
  static uniform(options: {
    rowCount: number;
    rowHeight: number;
  }): RowMetrics {
    if (!(options.rowHeight > 0)) {
      throw new GridArgumentError(
        `rowHeight must be positive, got ${options.rowHeight}.`,
      );
    }
    if (options.rowCount < 0) {
      throw new GridArgumentError(
        `rowCount must not be negative, got ${options.rowCount}.`,
      );
    }
    return new RowMetrics(options.rowCount, options.rowHeight, null);
  }

  /** Builds metrics from a per-row height function. */
  static variable(options: {
    rowCount: number;
    heightOf: (index: number) => number;
  }): RowMetrics {
    const { rowCount, heightOf } = options;
    if (rowCount < 0) {
      throw new GridArgumentError(
        `rowCount must not be negative, got ${rowCount}.`,
      );
    }
    const offsets = new Float64Array(rowCount + 1);
    let running = 0;
    for (let i = 0; i < rowCount; i++) {
      const height = heightOf(i);
      if (!(height > 0)) {
        throw new GridArgumentError(
          `Row ${i} has non-positive height ${height}.`,
        );
      }
      running += height;
      offsets[i + 1] = running;
    }
    return new RowMetrics(rowCount, 0, offsets);
  }

  get isUniform(): boolean {
    return this.offsets === null;
  }

  /** Total height of all rows. */
  get totalExtent(): number {
    if (this.offsets === null) return this.rowCount * this.rowHeight;
    return this.offsets[this.rowCount] as number;
  }

  /** Distance from the top of the content to the top of `index`. */
  offsetOf(index: number): number {
    const i = clamp(index, 0, this.rowCount);
    if (this.offsets === null) return i * this.rowHeight;
    return this.offsets[i] as number;
  }

  heightOf(index: number): number {
    if (index < 0 || index >= this.rowCount) return 0;
    if (this.offsets === null) return this.rowHeight;
    return (this.offsets[index + 1] as number) - (this.offsets[index] as number);
  }

  /** The row containing `offset`, clamped to the valid range. */
  indexAt(offset: number): number {
    if (this.rowCount === 0) return 0;
    if (offset <= 0) return 0;
    if (offset >= this.totalExtent) return this.rowCount - 1;
    if (this.offsets === null) {
      return clamp(Math.floor(offset / this.rowHeight), 0, this.rowCount - 1);
    }
    const offsets = this.offsets;
    let low = 0;
    let high = this.rowCount - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((offsets[mid + 1] as number) <= offset) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /**
   * Rows intersecting a viewport of `viewportExtent` at `scrollOffset`.
   *
   * `overscan` renders extra rows on each side so that a fast scroll does not
   * expose blank bands before the next frame.
   */
  windowFor(options: {
    scrollOffset: number;
    viewportExtent: number;
    overscan?: number;
  }): RowWindow {
    const { scrollOffset, viewportExtent, overscan = 2 } = options;
    if (this.rowCount === 0 || viewportExtent <= 0) return RowWindow.empty;
    const first = this.indexAt(scrollOffset);
    const last = this.indexAt(scrollOffset + viewportExtent);
    const from = clamp(first - overscan, 0, this.rowCount - 1);
    const to = clamp(last + overscan, 0, this.rowCount - 1);
    return new RowWindow({
      firstIndex: from,
      lastIndex: to,
      offset: this.offsetOf(from),
      totalExtent: this.totalExtent,
    });
  }

  /**
   * Scroll offset that brings `index` fully into a viewport of
   * `viewportExtent`, moving as little as possible.
   */
  scrollOffsetToReveal(
    index: number,
    options: {
      viewportExtent: number;
      currentOffset: number;
      padding?: number;
    },
  ): number {
    const { viewportExtent, currentOffset, padding = 0 } = options;
    const top = this.offsetOf(index) - padding;
    const bottom = this.offsetOf(index) + this.heightOf(index) + padding;
    if (top < currentOffset) {
      return clamp(top, 0, this.maxScroll(viewportExtent));
    }
    if (bottom > currentOffset + viewportExtent) {
      return clamp(bottom - viewportExtent, 0, this.maxScroll(viewportExtent));
    }
    return currentOffset;
  }

  private maxScroll(viewportExtent: number): number {
    const max = this.totalExtent - viewportExtent;
    return max < 0 ? 0 : max;
  }
}
