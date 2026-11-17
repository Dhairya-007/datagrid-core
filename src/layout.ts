/**
 * Column layout: widths, frozen panes and horizontal windowing.
 *
 * @module
 */

import { ColumnPin, type GridColumn } from './column';
import { clamp } from './util';

/** How leftover horizontal space is distributed. */
export const ColumnFit = {
  /** Keep the declared widths and scroll horizontally. */
  none: 'none',

  /** Grow every column proportionally to fill the viewport. */
  stretch: 'stretch',

  /** Grow only the last column. */
  lastColumn: 'lastColumn',
} as const;
export type ColumnFit = (typeof ColumnFit)[keyof typeof ColumnFit];

/** One laid-out column: its resolved width and its x position in its pane. */
export class ColumnLayout<T> {
  readonly column: GridColumn<T>;
  readonly width: number;

  /** Left edge, measured from the start of the pane this column belongs to. */
  readonly offset: number;

  /** Index among the visible columns of the whole grid. */
  readonly index: number;

  constructor(options: {
    column: GridColumn<T>;
    width: number;
    offset: number;
    index: number;
  }) {
    this.column = options.column;
    this.width = options.width;
    this.offset = options.offset;
    this.index = options.index;
    Object.freeze(this);
  }

  get end(): number {
    return this.offset + this.width;
  }

  toString(): string {
    return `ColumnLayout(${this.column.field}, ${this.width} @ ${this.offset})`;
  }
}

/**
 * The three horizontal panes of a grid: the columns frozen to the leading
 * edge, the scrolling middle, and the columns frozen to the trailing edge.
 *
 * Splitting panes here — rather than inside the view — is what lets frozen
 * columns work identically in every adapter, and keeps the scrolling pane a
 * plain list that can be windowed.
 */
export class GridLayout<T> {
  readonly leading: readonly ColumnLayout<T>[];
  readonly scrolling: readonly ColumnLayout<T>[];
  readonly trailing: readonly ColumnLayout<T>[];

  readonly viewportWidth: number;

  constructor(options: {
    leading: readonly ColumnLayout<T>[];
    scrolling: readonly ColumnLayout<T>[];
    trailing: readonly ColumnLayout<T>[];
    viewportWidth: number;
  }) {
    this.leading = options.leading;
    this.scrolling = options.scrolling;
    this.trailing = options.trailing;
    this.viewportWidth = options.viewportWidth;
  }

  get leadingWidth(): number {
    return extentOf(this.leading);
  }

  get trailingWidth(): number {
    return extentOf(this.trailing);
  }

  get scrollingWidth(): number {
    return extentOf(this.scrolling);
  }

  /** Width available to the scrolling pane. */
  get scrollViewportWidth(): number {
    const rest = this.viewportWidth - this.leadingWidth - this.trailingWidth;
    return rest < 0 ? 0 : rest;
  }

  /** Total width of every column. */
  get totalWidth(): number {
    return this.leadingWidth + this.scrollingWidth + this.trailingWidth;
  }

  get allColumns(): ColumnLayout<T>[] {
    return [...this.leading, ...this.scrolling, ...this.trailing];
  }

  get columnCount(): number {
    return this.leading.length + this.scrolling.length + this.trailing.length;
  }

  /**
   * Columns of the scrolling pane that intersect the horizontal viewport.
   *
   * Wide grids — a hundred columns of a financial blotter — only build the
   * cells actually on screen.
   */
  visibleScrollingColumns(options: {
    scrollOffset: number;
    viewportWidth?: number;
    overscan?: number;
  }): ColumnLayout<T>[] {
    const { scrollOffset, overscan = 1 } = options;
    const width = options.viewportWidth ?? this.scrollViewportWidth;
    if (this.scrolling.length === 0 || width <= 0) return [];
    let first = this.scrolling.length - 1;
    let last = 0;
    for (let i = 0; i < this.scrolling.length; i++) {
      const c = this.scrolling[i] as ColumnLayout<T>;
      if (c.end > scrollOffset && c.offset < scrollOffset + width) {
        if (i < first) first = i;
        if (i > last) last = i;
      }
    }
    if (first > last) return [];
    const from = clamp(first - overscan, 0, this.scrolling.length - 1);
    const to = clamp(last + overscan, 0, this.scrolling.length - 1);
    return this.scrolling.slice(from, to + 1);
  }
}

function extentOf<T>(columns: readonly ColumnLayout<T>[]): number {
  return columns.length === 0
    ? 0
    : (columns[columns.length - 1] as ColumnLayout<T>).end;
}

/**
 * Orders `columns` the way they appear on screen: the columns pinned to the
 * leading edge, then the scrolling ones, then the columns pinned to the
 * trailing edge, each group keeping its relative order.
 *
 * Declaration order is not screen order once anything is pinned, and the
 * difference is user-visible: arrow keys that follow declaration order skip
 * columns, a range selection covers cells that are not next to each other,
 * and an export's header does not match the header on screen. Anything that
 * means "left to right" reads this rather than the column list.
 *
 * Invisible columns are dropped, because they occupy no screen position.
 */
export function orderColumnsForDisplay<T>(
  columns: readonly GridColumn<T>[],
): GridColumn<T>[] {
  const leading: GridColumn<T>[] = [];
  const scrolling: GridColumn<T>[] = [];
  const trailing: GridColumn<T>[] = [];
  for (const column of columns) {
    if (!column.visible) continue;
    switch (column.pin) {
      case ColumnPin.start:
        leading.push(column);
        break;
      case ColumnPin.none:
        scrolling.push(column);
        break;
      case ColumnPin.end:
        trailing.push(column);
        break;
    }
  }
  return [...leading, ...scrolling, ...trailing];
}

/** Options for {@link computeLayout}. */
export interface ComputeLayoutOptions {
  viewportWidth: number;
  /**
   * Interactive resizes, keyed by field, so a user's drag survives a rebuild
   * without mutating the column definitions.
   */
  widthOverrides?: ReadonlyMap<string, number>;
  fit?: ColumnFit;
}

/**
 * Resolves `columns` into a {@link GridLayout} for a viewport of
 * `viewportWidth`.
 */
export function computeLayout<T>(
  columns: readonly GridColumn<T>[],
  options: ComputeLayoutOptions,
): GridLayout<T> {
  const {
    viewportWidth,
    widthOverrides = new Map<string, number>(),
    fit = ColumnFit.none,
  } = options;

  // Screen order, not list order: this is the only place either is derived,
  // so the panes, the exported header, keyboard navigation and range
  // selection cannot disagree about which column is next to which. Growing
  // "the last column" also means the last one on screen, which is what the
  // user is looking at.
  const visible = orderColumnsForDisplay<T>(columns);

  const widths = new Map<string, number>();
  for (const column of visible) {
    const override = widthOverrides.get(column.field);
    widths.set(column.field, column.clampWidth(override ?? column.width));
  }

  let natural = 0;
  for (const width of widths.values()) natural += width;
  if (fit !== ColumnFit.none && viewportWidth > natural && visible.length > 0) {
    const slack = viewportWidth - natural;
    if (fit === ColumnFit.stretch) {
      // Water-filling: grow in proportion, and whatever a column could not
      // take because it hit its maxWidth is offered to the columns that can
      // still grow, round after round. Handing the whole remainder to the
      // last growable column made one column absorb everything two clamped
      // columns refused — [110, 200, 290] where [110, 245, 245] is what
      // "stretch" means.
      let remaining = slack;
      let candidates = visible.filter(
        (c) => (widths.get(c.field) as number) < c.maxWidth,
      );
      // Bounded by the number of columns: each round clamps at least one, or
      // distributes everything and stops.
      while (remaining > 0.01 && candidates.length > 0) {
        let extent = 0;
        for (const c of candidates) extent += widths.get(c.field) as number;
        if (extent <= 0) break;
        let distributed = 0;
        for (const c of candidates) {
          const current = widths.get(c.field) as number;
          const share = remaining * (current / extent);
          const grown = c.clampWidth(current + share);
          distributed += grown - current;
          widths.set(c.field, grown);
        }
        if (distributed <= 0.01) break;
        remaining -= distributed;
        candidates = candidates.filter(
          (c) => (widths.get(c.field) as number) < c.maxWidth,
        );
      }
    } else {
      const last = visible[visible.length - 1] as GridColumn<T>;
      widths.set(
        last.field,
        last.clampWidth((widths.get(last.field) as number) + slack),
      );
    }
  }

  const leading: ColumnLayout<T>[] = [];
  const scrolling: ColumnLayout<T>[] = [];
  const trailing: ColumnLayout<T>[] = [];
  const offsets = new Map<ColumnPin, number>([
    [ColumnPin.start, 0],
    [ColumnPin.none, 0],
    [ColumnPin.end, 0],
  ]);

  for (let i = 0; i < visible.length; i++) {
    const column = visible[i] as GridColumn<T>;
    const width = widths.get(column.field) as number;
    const offset = offsets.get(column.pin) as number;
    const laid = new ColumnLayout<T>({ column, width, offset, index: i });
    offsets.set(column.pin, offset + width);
    switch (column.pin) {
      case ColumnPin.start:
        leading.push(laid);
        break;
      case ColumnPin.none:
        scrolling.push(laid);
        break;
      case ColumnPin.end:
        trailing.push(laid);
        break;
    }
  }

  return new GridLayout<T>({ leading, scrolling, trailing, viewportWidth });
}
