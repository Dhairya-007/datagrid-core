/**
 * Header rows that span several columns.
 *
 * A wide grid usually has columns that belong together — four quarters of a
 * year, a street/city/postcode address, a set of metrics for one service. A
 * stacked header says so once, above them, instead of repeating the grouping
 * in every column title.
 *
 * @module
 */

import { ColumnAlign, type GridColumn } from './column';
import type { ColumnLayout } from './layout';

/** One cell of a stacked header row, spanning the columns it names. */
export class HeaderBand {
  /** Text shown across the span. */
  readonly title: string;

  /**
   * Fields this band covers, by `GridColumn.field`.
   *
   * Order does not matter: the band is drawn over wherever those columns
   * actually are, which is what keeps it correct after a reorder.
   */
  readonly fields: readonly string[];

  readonly align: ColumnAlign;

  readonly tooltip: string | null;

  constructor(options: {
    title: string;
    fields: readonly string[];
    align?: ColumnAlign;
    tooltip?: string | null;
  }) {
    this.title = options.title;
    this.fields = options.fields;
    this.align = options.align ?? ColumnAlign.center;
    this.tooltip = options.tooltip ?? null;
    Object.freeze(this);
  }

  toString(): string {
    return `HeaderBand(${this.title} over ${this.fields.join(', ')})`;
  }
}

/**
 * One row of a stacked header, drawn above the column titles.
 *
 * Rows are listed outermost first, so `[regions, quarters]` draws regions
 * along the top and quarters beneath them.
 */
export class HeaderRow {
  readonly bands: readonly HeaderBand[];

  constructor(bands: readonly HeaderBand[]) {
    this.bands = bands;
    Object.freeze(this);
  }

  /** Every field covered by this row. */
  get fields(): Set<string> {
    const out = new Set<string>();
    for (const band of this.bands) {
      for (const field of band.fields) out.add(field);
    }
    return out;
  }

  toString(): string {
    return `HeaderRow(${this.bands.length} bands)`;
  }
}

/** A band resolved against a laid-out pane: where to draw it, and how wide. */
export class HeaderBandLayout<T> {
  /** The band this segment belongs to, or null for the gap between bands. */
  readonly band: HeaderBand | null;

  /** Left edge within the pane. */
  readonly offset: number;

  readonly width: number;

  /** The columns this segment covers, in display order. */
  readonly columns: readonly ColumnLayout<T>[];

  /**
   * Whether an earlier segment of the same band was already drawn.
   *
   * A band whose columns are split — by a frozen pane boundary, or by the
   * user moving an unrelated column into the middle of it — is drawn as
   * several segments. Only the first repeats the title, so the header does
   * not read as two separate things with the same name.
   */
  readonly isContinuation: boolean;

  constructor(options: {
    band: HeaderBand | null;
    offset: number;
    width: number;
    columns: readonly ColumnLayout<T>[];
    isContinuation: boolean;
  }) {
    this.band = options.band;
    this.offset = options.offset;
    this.width = options.width;
    this.columns = options.columns;
    this.isContinuation = options.isContinuation;
    Object.freeze(this);
  }

  /** Whether this segment is a gap: columns no band covers. */
  get isGap(): boolean {
    return this.band === null;
  }

  get end(): number {
    return this.offset + this.width;
  }

  toString(): string {
    return `HeaderBandLayout(${this.band?.title ?? 'gap'}, ${this.width} @ ${this.offset})`;
  }
}

/**
 * Resolves `row` against one pane's laid-out columns.
 *
 * Walks the pane in display order and starts a new segment whenever the
 * covering band changes, which handles three awkward cases without special
 * casing any of them: a band split across panes, a band interrupted by a
 * column the user moved into it, and columns no band covers.
 *
 * `drawn` carries continuation state **between panes**. A band spanning a
 * frozen column and a scrolling one is laid out twice, once per pane, and
 * only the first segment should carry the title — so pass one set through the
 * panes in display order. Omitting it treats every pane as the first.
 */
export function layoutHeaderRow<T>(
  pane: readonly ColumnLayout<T>[],
  row: HeaderRow,
  options: { drawn?: Set<HeaderBand> } = {},
): HeaderBandLayout<T>[] {
  if (pane.length === 0) return [];

  const owner = new Map<string, HeaderBand>();
  for (const band of row.bands) {
    for (const field of band.fields) {
      // First band wins, so overlapping bands cannot double-cover a column.
      if (!owner.has(field)) owner.set(field, band);
    }
  }

  const segments: HeaderBandLayout<T>[] = [];
  const alreadyDrawn = options.drawn ?? new Set<HeaderBand>();

  let currentBand: HeaderBand | null = null;
  let currentColumns: ColumnLayout<T>[] = [];
  let currentOffset = 0;
  let currentWidth = 0;
  let started = false;

  const flush = (): void => {
    if (!started) return;
    const band = currentBand;
    const isContinuation = band !== null && alreadyDrawn.has(band);
    if (band !== null) alreadyDrawn.add(band);
    segments.push(
      new HeaderBandLayout<T>({
        band,
        offset: currentOffset,
        width: currentWidth,
        columns: currentColumns,
        isContinuation,
      }),
    );
  };

  for (const column of pane) {
    const band = owner.get(column.column.field) ?? null;
    if (!started || band !== currentBand) {
      flush();
      started = true;
      currentBand = band;
      currentColumns = [column];
      currentOffset = column.offset;
      currentWidth = column.width;
    } else {
      currentColumns.push(column);
      currentWidth += column.width;
    }
  }
  flush();

  return segments;
}

/**
 * Validates `rows` against `columns`, returning a message per problem.
 *
 * Reported rather than thrown, because a mistyped field in a header band
 * should be loud in development and harmless in production — the band simply
 * covers fewer columns.
 */
export function describeHeaderProblems<T>(
  rows: readonly HeaderRow[],
  columns: readonly GridColumn<T>[],
): string[] {
  const known = new Set(columns.map((c) => c.field));
  const problems: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const seen = new Map<string, string>();
    for (const band of (rows[i] as HeaderRow).bands) {
      if (band.fields.length === 0) {
        problems.push(
          `Header row ${i}: band "${band.title}" spans no columns.`,
        );
      }
      for (const field of band.fields) {
        if (!known.has(field)) {
          problems.push(
            `Header row ${i}: band "${band.title}" names unknown column "${field}".`,
          );
        }
        const previous = seen.get(field);
        if (previous !== undefined) {
          problems.push(
            `Header row ${i}: column "${field}" is covered by both "${previous}" and "${band.title}".`,
          );
        } else {
          seen.set(field, band.title);
        }
      }
    }
  }
  return problems;
}
