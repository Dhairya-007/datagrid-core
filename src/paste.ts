/**
 * The outcome of pasting clipboard text into a cell range.
 *
 * @module
 */

import type { CellAddress } from './selection';

/** Why one cell of a paste could not be written. */
export class PasteRejection {
  /** Where it would have gone. */
  readonly cell: CellAddress;

  /** The clipboard text that was rejected, so a message can quote it. */
  readonly text: string;

  /**
   * What was wrong with it, in the words of the column's validator where
   * there was one.
   */
  readonly reason: string;

  constructor(options: { cell: CellAddress; text: string; reason: string }) {
    this.cell = options.cell;
    this.text = options.text;
    this.reason = options.reason;
    Object.freeze(this);
  }

  toString(): string {
    return `PasteRejection(${this.cell.field} row ${this.cell.row}: ${this.reason})`;
  }
}

/** Options for a {@link PasteResult}. */
export interface PasteResultOptions {
  rowsChanged?: number;
  cellsChanged?: number;
  cellsClipped?: number;
  rejections?: readonly PasteRejection[];
  applied?: boolean;
}

/** What a paste did, or would have done. */
export class PasteResult {
  readonly rowsChanged: number;
  readonly cellsChanged: number;

  /**
   * Cells the clipboard carried that fell outside the grid.
   *
   * Pasting a 10-row block into the last 3 rows clips the other 7 rather than
   * creating rows: the grid does not know how to make a row, and a source
   * that does should be given the data itself.
   */
  readonly cellsClipped: number;

  /** Cells that could not be written, each with its reason. */
  readonly rejections: readonly PasteRejection[];

  /** Whether anything was actually written. */
  readonly applied: boolean;

  constructor(options: PasteResultOptions = {}) {
    this.rowsChanged = options.rowsChanged ?? 0;
    this.cellsChanged = options.cellsChanged ?? 0;
    this.cellsClipped = options.cellsClipped ?? 0;
    this.rejections = options.rejections ?? [];
    this.applied = options.applied ?? false;
    Object.freeze(this);
  }

  /** Nothing was pasted, because there was nowhere to paste it. */
  static noTarget(): PasteResult {
    return new PasteResult();
  }

  get hasRejections(): boolean {
    return this.rejections.length > 0;
  }

  get isEmpty(): boolean {
    return this.cellsChanged === 0 && this.rejections.length === 0;
  }

  toString(): string {
    return (
      `PasteResult(${this.cellsChanged} cells in ${this.rowsChanged} rows, ` +
      `${this.rejections.length} rejected, applied: ${String(this.applied)})`
    );
  }
}
