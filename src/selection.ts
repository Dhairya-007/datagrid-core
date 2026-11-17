/**
 * Cell, row and range selection.
 *
 * @module
 */

/** What the user is allowed to select. */
export const SelectionMode = {
  none: 'none',
  singleRow: 'singleRow',
  multiRow: 'multiRow',
  singleCell: 'singleCell',
  /** Rectangular cell ranges, as a spreadsheet does. */
  cellRange: 'cellRange',
} as const;
export type SelectionMode =
  (typeof SelectionMode)[keyof typeof SelectionMode];

/**
 * Modifier keys in effect when a selection gesture happened.
 *
 * The adapter translates platform keys into this, so the engine owns the
 * semantics — plain click replaces, ctrl/cmd toggles, shift extends — and
 * every adapter behaves the same way.
 */
export interface SelectionModifiers {
  /** Ctrl on Windows and Linux, cmd on macOS. */
  readonly toggle?: boolean;
  /** Shift. */
  readonly extend?: boolean;
}

/** No modifier held. */
export const noModifiers: SelectionModifiers = Object.freeze({});
/** Ctrl / cmd held. */
export const togglingModifier: SelectionModifiers = Object.freeze({
  toggle: true,
});
/** Shift held. */
export const extendingModifier: SelectionModifiers = Object.freeze({
  extend: true,
});

/**
 * A single cell, addressed by row index and column field.
 *
 * The field rather than a column index means a selection survives the user
 * reordering, hiding or resizing columns.
 */
export class CellAddress {
  readonly row: number;
  readonly field: string;

  constructor(row: number, field: string) {
    this.row = row;
    this.field = field;
    Object.freeze(this);
  }

  /**
   * A string that is equal exactly when two addresses are, for use as a `Map`
   * or `Set` key — which compare by identity and would otherwise treat two
   * addresses of the same cell as different.
   */
  get key(): string {
    return `${this.row}\u0000${this.field}`;
  }

  equals(other: CellAddress | null | undefined): boolean {
    return (
      other !== null &&
      other !== undefined &&
      other.row === this.row &&
      other.field === this.field
    );
  }

  toString(): string {
    return `CellAddress(${this.row}, ${this.field})`;
  }
}

/** Shorthand for `new CellAddress(row, field)`. */
export function cell(row: number, field: string): CellAddress {
  return new CellAddress(row, field);
}

/** Options for a {@link CellRange}. */
export interface CellRangeOptions {
  anchor: CellAddress;
  focus: CellAddress;
  fields: readonly string[];
}

/** A rectangular block of cells between two anchors, inclusive. */
export class CellRange {
  /** Where the drag or shift-selection started. */
  readonly anchor: CellAddress;

  /** Where it currently ends. */
  readonly focus: CellAddress;

  /**
   * Visible fields in display order, used to resolve which columns fall
   * between the two anchors.
   */
  readonly fields: readonly string[];

  constructor(options: CellRangeOptions) {
    this.anchor = options.anchor;
    this.focus = options.focus;
    this.fields = options.fields;
    Object.freeze(this);
  }

  get firstRow(): number {
    return Math.min(this.anchor.row, this.focus.row);
  }

  get lastRow(): number {
    return Math.max(this.anchor.row, this.focus.row);
  }

  private get anchorColumn(): number {
    return this.fields.indexOf(this.anchor.field);
  }

  private get focusColumn(): number {
    return this.fields.indexOf(this.focus.field);
  }

  get firstColumn(): number {
    return Math.min(this.anchorColumn, this.focusColumn);
  }

  get lastColumn(): number {
    return Math.max(this.anchorColumn, this.focusColumn);
  }

  get rowCount(): number {
    return this.lastRow - this.firstRow + 1;
  }

  get columnCount(): number {
    return this.lastColumn - this.firstColumn + 1;
  }

  /** Fields covered by this range, in display order. */
  get coveredFields(): string[] {
    if (this.firstColumn < 0) return [];
    return this.fields.slice(this.firstColumn, this.lastColumn + 1);
  }

  contains(address: CellAddress): boolean {
    if (this.firstColumn < 0) return false;
    if (address.row < this.firstRow || address.row > this.lastRow) return false;
    const column = this.fields.indexOf(address.field);
    // A field that is no longer on screen is in no range. Without the first
    // test, a range whose own anchor column had disappeared reported -1 as
    // its first column and then claimed to contain every missing field,
    // which disagreed with coveredFields — and a copy walked cells the range
    // said it did not cover.
    if (column < 0) return false;
    return column >= this.firstColumn && column <= this.lastColumn;
  }

  /**
   * This range with both ends pulled inside `rowCount`, or null when it has
   * no rows left.
   */
  clampedTo(rowCount: number): CellRange | null {
    if (rowCount <= 0) return null;
    if (this.lastRow < rowCount) return this;
    const last = rowCount - 1;
    return new CellRange({
      anchor: new CellAddress(
        Math.min(this.anchor.row, last),
        this.anchor.field,
      ),
      focus: new CellAddress(Math.min(this.focus.row, last), this.focus.field),
      fields: this.fields,
    });
  }

  /** Every cell in the range, row-major — the order a clipboard copy needs. */
  *cells(): IterableIterator<CellAddress> {
    const covered = this.coveredFields;
    for (let row = this.firstRow; row <= this.lastRow; row++) {
      for (const field of covered) {
        yield new CellAddress(row, field);
      }
    }
  }

  toString(): string {
    return `CellRange(${this.firstRow}..${this.lastRow} x ${this.coveredFields.join(',')})`;
  }
}

/**
 * How much of the grid is selected, for a select-all control.
 *
 * A checkbox needs three states, not two: "some" is what stops the header
 * checkbox lying about a partial selection.
 */
export const SelectionCoverage = {
  none: 'none',
  some: 'some',
  all: 'all',
} as const;
export type SelectionCoverage =
  (typeof SelectionCoverage)[keyof typeof SelectionCoverage];

/**
 * Holds and mutates the current selection.
 *
 * "Everything is selected" is held as a flag with a set of exceptions rather
 * than as a set of every index. Select-all over a million rows built a
 * million-entry set — to express one bit of information — and then an entry
 * to remap per row on every re-sort. Inverted, select-all, the coverage a
 * header checkbox reads, and every membership test are O(1).
 */
export class SelectionState {
  mode: SelectionMode;

  /** Selected indices, or — when {@link inverted} — the ones left out. */
  private readonly rowSet = new Set<number>();

  /** Whether {@link rowSet} lists what is *not* selected. */
  private inverted = false;

  /** How many rows "everything" covered when it was selected. */
  private invertedCount = 0;

  private activeCellValue: CellAddress | null = null;
  private anchorValue: CellAddress | null = null;
  private rangeValue: CellRange | null = null;

  private sortedCache: number[] | null = null;

  constructor(options: { mode?: SelectionMode } = {}) {
    this.mode = options.mode ?? SelectionMode.multiRow;
  }

  /**
   * Selected row indices, in ascending order.
   *
   * Materialised on demand and cached until the selection changes: it used to
   * sort a fresh copy on every read, which an adapter does once per frame.
   * Reading it over an inverted selection costs one entry per row, so prefer
   * {@link isRowSelected} and {@link rowCount} where they will do.
   */
  get selectedRows(): number[] {
    this.sortedCache ??= this.materialise();
    return this.sortedCache;
  }

  private materialise(): number[] {
    if (!this.inverted) return [...this.rowSet].sort((a, b) => a - b);
    const out: number[] = [];
    for (let i = 0; i < this.invertedCount; i++) {
      if (!this.rowSet.has(i)) out.push(i);
    }
    return out;
  }

  /** Whether everything is selected, held as a flag rather than as a set. */
  get isEverythingSelected(): boolean {
    return this.inverted && this.rowSet.size === 0;
  }

  /**
   * The row indices whose identity has to be followed across a rebuild.
   *
   * The selected rows for an ordinary selection, and the *exceptions* for an
   * inverted one — everything else stays selected whatever moves where, so a
   * select-all over a million rows has nothing to follow.
   */
  get followedRows(): Iterable<number> {
    return this.rowSet;
  }

  /** Drops the cached list of indices. */
  private changed(): void {
    this.sortedCache = null;
  }

  /** The selected rows as a set. O(rows) over an inverted selection. */
  get rows(): ReadonlySet<number> {
    return this.inverted ? new Set(this.materialise()) : new Set(this.rowSet);
  }

  /** The focused cell, which keyboard navigation moves. */
  get activeCell(): CellAddress | null {
    return this.activeCellValue;
  }

  /** The current rectangular range, when `cellRange` mode is active. */
  get range(): CellRange | null {
    return this.rangeValue;
  }

  /**
   * Where the last shift-extendable gesture started.
   *
   * Row anchors carry an empty field, because a row click has no column.
   */
  get anchor(): CellAddress | null {
    return this.anchorValue;
  }

  get isEmpty(): boolean {
    return this.rowCount === 0 && this.activeCellValue === null;
  }

  get rowCount(): number {
    if (!this.inverted) return this.rowSet.size;
    const count = this.invertedCount - this.rowSet.size;
    return count < 0 ? 0 : count;
  }

  isRowSelected(index: number): boolean {
    if (index < 0) return false;
    if (!this.inverted) return this.rowSet.has(index);
    return index < this.invertedCount && !this.rowSet.has(index);
  }

  /** Marks `index` selected or not, whichever way round the set is held. */
  private setSelected(index: number, selected: boolean): void {
    this.changed();
    if (this.inverted === selected) {
      this.rowSet.delete(index);
    } else {
      this.rowSet.add(index);
    }
  }

  /** Replaces the selection with exactly `indices`. */
  private replaceWith(indices: Iterable<number>): void {
    this.changed();
    this.inverted = false;
    this.invertedCount = 0;
    this.rowSet.clear();
    for (const index of indices) this.rowSet.add(index);
  }

  isCellSelected(address: CellAddress): boolean {
    if (this.rangeValue !== null && this.rangeValue.contains(address)) {
      return true;
    }
    if (address.equals(this.activeCellValue)) return true;
    return (
      this.isRowSelected(address.row) &&
      (this.mode === SelectionMode.singleRow ||
        this.mode === SelectionMode.multiRow)
    );
  }

  /** Applies a row click. */
  selectRow(index: number, modifiers: SelectionModifiers = noModifiers): void {
    switch (this.mode) {
      case SelectionMode.none:
        return;
      case SelectionMode.singleRow:
      case SelectionMode.singleCell:
        this.replaceWith([index]);
        this.anchorValue = new CellAddress(index, '');
        return;
      case SelectionMode.multiRow:
      case SelectionMode.cellRange: {
        const anchor = this.anchorValue;
        if (modifiers.extend === true && anchor !== null) {
          const from = Math.min(anchor.row, index);
          const to = Math.max(anchor.row, index);
          const span: number[] = [];
          for (let i = from; i <= to; i++) span.push(i);
          this.replaceWith(span);
        } else if (modifiers.toggle === true) {
          this.setSelected(index, !this.isRowSelected(index));
          this.anchorValue = new CellAddress(index, '');
        } else {
          this.replaceWith([index]);
          this.anchorValue = new CellAddress(index, '');
        }
        return;
      }
    }
  }

  /** Applies a cell click, updating both the active cell and any range. */
  selectCell(
    address: CellAddress,
    fields: readonly string[],
    modifiers: SelectionModifiers = noModifiers,
  ): void {
    if (this.mode === SelectionMode.none) return;
    this.activeCellValue = address;
    if (this.mode === SelectionMode.cellRange) {
      const anchor = this.anchorValue;
      if (modifiers.extend === true && anchor !== null) {
        this.rangeValue = new CellRange({ anchor, focus: address, fields });
        return;
      }
      this.anchorValue = address;
      this.rangeValue = new CellRange({
        anchor: address,
        focus: address,
        fields,
      });
      return;
    }
    this.anchorValue = address;
    this.rangeValue = null;
    if (
      this.mode === SelectionMode.singleRow ||
      this.mode === SelectionMode.multiRow
    ) {
      this.selectRow(address.row, modifiers);
    }
  }

  /**
   * Extends the range to `address` without moving the anchor — a drag, or a
   * shift-arrow key.
   */
  extendTo(address: CellAddress, fields: readonly string[]): void {
    const anchor = this.anchorValue;
    if (this.mode !== SelectionMode.cellRange || anchor === null) {
      this.selectCell(address, fields);
      return;
    }
    this.activeCellValue = address;
    this.rangeValue = new CellRange({ anchor, focus: address, fields });
  }

  /** How much of `rowCount` rows is selected. */
  coverageOf(rowCount: number): SelectionCoverage {
    if (rowCount === 0) return SelectionCoverage.none;
    if (this.inverted) {
      // Exceptions outside the current row count are not holes in it.
      let holes = 0;
      for (const index of this.rowSet) {
        if (index >= 0 && index < rowCount) holes++;
      }
      if (holes === 0) return SelectionCoverage.all;
      return holes >= rowCount
        ? SelectionCoverage.none
        : SelectionCoverage.some;
    }
    if (this.rowSet.size === 0) return SelectionCoverage.none;
    // Count only rows that still exist: a stale index must not make a partial
    // selection look complete.
    let inRange = 0;
    for (const index of this.rowSet) {
      if (index >= 0 && index < rowCount) inRange++;
    }
    if (inRange === 0) return SelectionCoverage.none;
    return inRange >= rowCount ? SelectionCoverage.all : SelectionCoverage.some;
  }

  /** Selects every one of `rowCount` rows, in constant time. */
  selectAll(rowCount: number): void {
    if (
      this.mode !== SelectionMode.multiRow &&
      this.mode !== SelectionMode.cellRange
    ) {
      return;
    }
    this.changed();
    this.inverted = true;
    this.invertedCount = rowCount < 0 ? 0 : rowCount;
    this.rowSet.clear();
  }

  clear(): void {
    this.changed();
    this.inverted = false;
    this.invertedCount = 0;
    this.rowSet.clear();
    this.activeCellValue = null;
    this.anchorValue = null;
    this.rangeValue = null;
  }

  /**
   * Rewrites every row index through `moved`, dropping the ones it maps to
   * null or outside `rowCount`.
   *
   * A selection is stored as indices because that is what an adapter renders,
   * which means it otherwise follows the screen position rather than the row:
   * select a row, sort, and the selection is on whatever now sits there.
   * Given a way to recognise a row — see `GridController.rowKey` — the
   * controller calls this after every rebuild so the selection follows the
   * rows instead.
   *
   * A range is remapped by its two ends. After a reorder the cells between
   * them are not the cells that were between them before; following the
   * anchor and the focus is the only rule that keeps a rectangle a rectangle.
   */
  remapRows(
    moved: (index: number) => number | null,
    rowCount: number,
  ): void {
    this.changed();
    const next = new Set<number>();
    for (const index of this.rowSet) {
      const movedTo = moved(index);
      if (movedTo !== null && movedTo >= 0 && movedTo < rowCount) {
        next.add(movedTo);
      }
    }
    this.rowSet.clear();
    for (const index of next) this.rowSet.add(index);
    if (this.inverted) {
      // Everything stays selected whatever moved where; only the holes have
      // to follow their rows. This is the point of holding it inverted: a
      // select-all over a million rows remaps nothing at all.
      this.invertedCount = rowCount;
    }

    const remap = (address: CellAddress | null): CellAddress | null => {
      if (address === null) return null;
      const movedTo = moved(address.row);
      if (movedTo === null || movedTo < 0 || movedTo >= rowCount) return null;
      return movedTo === address.row
        ? address
        : new CellAddress(movedTo, address.field);
    };

    this.activeCellValue = remap(this.activeCellValue);
    this.anchorValue = remap(this.anchorValue);
    const range = this.rangeValue;
    if (range !== null) {
      const anchor = remap(range.anchor);
      const focus = remap(range.focus);
      this.rangeValue =
        anchor === null || focus === null
          ? null
          : new CellRange({ anchor, focus, fields: range.fields });
    }
  }

  /**
   * Keeps the selection meaningful after the row count changes, dropping
   * indices that no longer exist.
   *
   * Every part of the selection is clamped, not only the active cell: a range
   * over rows 0..5 of a grid that now has two rows went on reporting
   * `lastRow` 5, and a copy of it emitted rows that are not there.
   */
  clampTo(rowCount: number): void {
    this.changed();
    for (const index of [...this.rowSet]) {
      if (index >= rowCount) this.rowSet.delete(index);
    }
    if (this.inverted && rowCount < this.invertedCount) {
      this.invertedCount = rowCount;
    }
    if (rowCount <= 0) {
      this.activeCellValue = null;
      this.anchorValue = null;
      this.rangeValue = null;
      return;
    }
    const last = rowCount - 1;
    const active = this.activeCellValue;
    if (active !== null && active.row > last) {
      this.activeCellValue = new CellAddress(last, active.field);
    }
    const anchor = this.anchorValue;
    if (anchor !== null && anchor.row > last) {
      this.anchorValue = new CellAddress(last, anchor.field);
    }
    this.rangeValue = this.rangeValue?.clampedTo(rowCount) ?? null;
  }
}
