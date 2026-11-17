/**
 * Cell editing: an explicit begin / validate / commit state machine.
 *
 * @module
 */

import { ColumnType, type GridColumn, type ValueValidator } from './column';
import type { CellValue } from './compare';
import { tryParseDate } from './dates';
import { CellAddress } from './selection';

/** Why an edit session ended. */
export const EditOutcome = {
  committed: 'committed',
  cancelled: 'cancelled',
  rejected: 'rejected',
} as const;
export type EditOutcome = (typeof EditOutcome)[keyof typeof EditOutcome];

/** The result of trying to commit an edit. */
export class EditResult<T> {
  readonly outcome: EditOutcome;

  /** The row after the edit; null unless the edit committed. */
  readonly row: T | null;

  /** Validation message; null unless the edit was rejected. */
  readonly error: string | null;

  private constructor(
    outcome: EditOutcome,
    row: T | null = null,
    error: string | null = null,
  ) {
    this.outcome = outcome;
    this.row = row;
    this.error = error;
    Object.freeze(this);
  }

  static committed<T>(row: T): EditResult<T> {
    return new EditResult<T>(EditOutcome.committed, row);
  }

  static cancelled<T>(): EditResult<T> {
    return new EditResult<T>(EditOutcome.cancelled);
  }

  static rejected<T>(error: string): EditResult<T> {
    return new EditResult<T>(EditOutcome.rejected, null, error);
  }

  get isCommitted(): boolean {
    return this.outcome === EditOutcome.committed;
  }

  get isRejected(): boolean {
    return this.outcome === EditOutcome.rejected;
  }
}

/** Options for an {@link EditSession}. */
export interface EditSessionOptions<T> {
  cell: CellAddress;
  column: GridColumn<T>;
  row: T;
  initialValue: CellValue;
}

/**
 * One in-flight cell edit.
 *
 * Editing is a session rather than a callback so that a half-typed value can
 * be validated, shown as an error, and either committed or rolled back
 * without the underlying row ever holding an invalid value.
 */
export class EditSession<T> {
  /**
   * The cell being edited.
   *
   * Not readonly: the row the user is editing can change position under them
   * — a background refresh, or another sort — and the session has to follow
   * it rather than keep pointing at a row index that now holds something
   * else. See {@link relocate}.
   */
  cell: CellAddress;

  readonly column: GridColumn<T>;

  /** The row being edited. */
  readonly row: T;

  /** Value when the session opened, restored by {@link cancel}. */
  readonly originalValue: CellValue;

  private current: CellValue;
  private errorValue: string | null = null;

  constructor(options: EditSessionOptions<T>) {
    this.cell = options.cell;
    this.column = options.column;
    this.row = options.row;
    this.originalValue = options.initialValue;
    this.current = options.initialValue;
  }

  /** The candidate value, as edited so far. */
  get value(): CellValue {
    return this.current;
  }

  /** Current validation message, if any. */
  get error(): string | null {
    return this.errorValue;
  }

  get isValid(): boolean {
    return this.errorValue === null;
  }

  get isDirty(): boolean {
    return !sameValue(this.current, this.originalValue);
  }

  /**
   * Points this session at `rowIndex`, keeping its column and its half-typed
   * value. Called when the edited row moves to a new position.
   */
  relocate(rowIndex: number): void {
    if (rowIndex === this.cell.row) return;
    this.cell = new CellAddress(rowIndex, this.cell.field);
  }

  /**
   * Updates the candidate value and re-runs validation.
   *
   * Validating on change rather than on commit lets the editor show the error
   * while the user is still typing.
   */
  update(value: CellValue): void {
    this.current = value;
    this.errorValue = this.column.validator?.(value) ?? null;
  }

  /** Validates and writes the value back through the column's setter. */
  commit(): EditResult<T> {
    const error = this.column.validator?.(this.current) ?? null;
    if (error !== null) {
      this.errorValue = error;
      return EditResult.rejected<T>(error);
    }
    const setValue = this.column.setValue;
    if (setValue === null) {
      return EditResult.rejected<T>('Column is not editable');
    }
    const updated = setValue(this.row, this.current);
    // A null return means the model mutated in place.
    return EditResult.committed<T>(updated ?? this.row);
  }

  cancel(): EditResult<T> {
    this.current = this.originalValue;
    this.errorValue = null;
    return EditResult.cancelled<T>();
  }
}

/** Whether two cell values are the same, with dates compared by instant. */
function sameValue(a: CellValue, b: CellValue): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

/**
 * Parses editor text back into the column's value type.
 *
 * Editors hand back strings; a number column must not silently store `"42"`
 * where every comparator expects a number.
 *
 * A number must be a finite decimal. `Number(text)` also accepts `0x10`,
 * `Infinity` and an empty string, so pasting any of those into a numeric
 * column stored a value no user typed — 16 for `0x10` — or one that makes
 * every sum, average and sort over the column meaningless.
 */
export function coerceValue(text: string, type: ColumnType): CellValue {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  switch (type) {
    case ColumnType.number:
      return parseDecimal(trimmed);
    case ColumnType.boolean: {
      const lower = trimmed.toLowerCase();
      if (lower === 'true' || lower === 'yes' || lower === '1') return true;
      if (lower === 'false' || lower === 'no' || lower === '0') return false;
      return null;
    }
    case ColumnType.date:
      return tryParseDate(trimmed);
    case ColumnType.text:
    case ColumnType.custom:
      return text;
  }
}

/**
 * Parses `text` as a finite decimal number, or returns null.
 *
 * Decimal only: no hexadecimal, no `NaN`, no `Infinity`. Exposed because an
 * adapter's editor wants the same rule the engine uses, and because a filter
 * operand goes through the same question.
 */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!DECIMAL.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return null;
  return parsed;
}

/** An optionally signed decimal, with an optional fraction and exponent. */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Builds a validator that rejects empty values. */
export function requiredValue(message = 'Required'): ValueValidator {
  return (value: CellValue): string | null => {
    if (value === null || value === undefined) return message;
    if (typeof value === 'string' && value.trim().length === 0) return message;
    return null;
  };
}

/** Builds a validator bounding a numeric column. */
export function numberRange(
  options: { min?: number; max?: number; message?: string } = {},
): ValueValidator {
  const { min, max, message } = options;
  return (value: CellValue): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number') return message ?? 'Must be a number';
    // NaN compares false against every bound, so both range tests passed and
    // the value was declared valid. A NaN in a numeric column poisons every
    // sum, average and sort over it.
    if (!Number.isFinite(value)) return message ?? 'Must be a finite number';
    if (min !== undefined && value < min) {
      return message ?? `Must be at least ${min}`;
    }
    if (max !== undefined && value > max) {
      return message ?? `Must be at most ${max}`;
    }
    return null;
  };
}

/**
 * Composes validators, reporting the first failure.
 *
 * Named `combineValidators` rather than `allOf` so that it does not collide
 * with the matcher libraries' `allOf` in consumer code.
 */
export function combineValidators(
  validators: readonly ValueValidator[],
): ValueValidator {
  return (value: CellValue): string | null => {
    for (const validator of validators) {
      const error = validator(value);
      if (error !== null) return error;
    }
    return null;
  };
}
