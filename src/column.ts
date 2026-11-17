/**
 * Column definition and supporting value types.
 *
 * @module
 */

import type { CellValue, Comparator } from './compare';
import type { CellRule } from './decoration';
import { GridArgumentError, GridStateError } from './errors';
import { clamp } from './util';

/** Horizontal alignment of a cell's content. */
export const ColumnAlign = {
  start: 'start',
  center: 'center',
  end: 'end',
} as const;
export type ColumnAlign = (typeof ColumnAlign)[keyof typeof ColumnAlign];

/** Which edge of the viewport a column is frozen to, if any. */
export const ColumnPin = {
  none: 'none',
  start: 'start',
  end: 'end',
} as const;
export type ColumnPin = (typeof ColumnPin)[keyof typeof ColumnPin];

/**
 * Logical type of a column's values.
 *
 * Drives default comparators, the default set of filter operators offered to
 * the user, and the editor a UI adapter picks for the column.
 */
export const ColumnType = {
  text: 'text',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  custom: 'custom',
} as const;
export type ColumnType = (typeof ColumnType)[keyof typeof ColumnType];

/** Reads the value of a column out of a row object. */
export type ValueGetter<T> = (row: T) => CellValue;

/**
 * Writes an edited value back into a row object.
 *
 * Returning a value lets immutable models return a modified copy; returning
 * `null` or `undefined` means the row was mutated in place.
 */
export type ValueSetter<T> = (row: T, value: CellValue) => T | null | undefined;

/** Renders a raw value as display text. */
export type ValueFormatter = (value: CellValue) => string;

/**
 * Validates a candidate value, returning an error message or `null` if valid.
 */
export type ValueValidator = (value: CellValue) => string | null;

/** Reads the value a column sorts and groups by. */
export type SortKeyGetter<T> = (row: T) => CellValue;

/** Everything a {@link GridColumn} can be given. */
export interface GridColumnOptions<T> {
  /**
   * Stable identifier for the column, unique within a grid.
   *
   * Also used as the default key when reading from object rows and as the
   * header of exported files.
   */
  field: string;

  /** Header text. Defaults to a humanised {@link field}. */
  title?: string;

  /** Reads this column's value out of a row. */
  value?: ValueGetter<T>;

  /** Logical value type. */
  type?: ColumnType;

  /** Preferred width in logical pixels, before resizing or stretching. */
  width?: number;

  /** Lower bound honoured by interactive resizing. */
  minWidth?: number;

  /** Upper bound honoured by interactive resizing. */
  maxWidth?: number;

  /** Content alignment; defaults to `end` for numbers. */
  align?: ColumnAlign | null;

  /** Edge this column is frozen to. */
  pin?: ColumnPin;

  /** Whether the column takes part in layout at all. */
  visible?: boolean;

  sortable?: boolean;
  filterable?: boolean;
  resizable?: boolean;
  groupable?: boolean;

  /** Formats the raw value for display. Defaults to `String(value)`. */
  format?: ValueFormatter | null;

  /** Overrides the default ordering for this column's values. */
  comparator?: Comparator<CellValue> | null;

  /** Writes an edited value back. A column is editable when this is set. */
  setValue?: ValueSetter<T> | null;

  /** Rejects invalid edits before they are committed. */
  validator?: ValueValidator | null;

  /** Long-form description for a header tooltip. */
  tooltip?: string | null;

  /**
   * Conditional formatting for this column's cells.
   *
   * Evaluated per visible cell against the column's `ColumnStats`, so it
   * costs nothing for rows that are not on screen.
   */
  rule?: CellRule | null;

  /**
   * Reads the value this column *sorts and groups by*, when that differs
   * from the value it shows.
   *
   * Returned once per row per sort rather than on every comparison, which is
   * what makes an expensive ordering affordable: a natural order, a locale
   * collation key or an enum rank costs O(n) here instead of O(n log n)
   * inside {@link comparator}. Return a string, a number or any value
   * `compareValues` understands.
   *
   * Takes precedence over {@link comparator} when both are set, because a
   * key is strictly the cheaper way to say the same thing.
   */
  sortKey?: SortKeyGetter<T> | null;
}

/**
 * The fields {@link GridColumn.copyWith} accepts.
 *
 * `undefined` (or an absent key) keeps what is there; `null` clears a
 * nullable field. Without the `null` case there was no way to *remove* a
 * callback, so a column with a `setValue` could never be made read-only and a
 * rule could never be taken off a column.
 */
export type GridColumnPatch<T> = Partial<GridColumnOptions<T>>;

/**
 * Describes one column of a grid.
 *
 * A column is pure data: it knows how to read a value out of a row, how to
 * show it, how to compare it and whether the user may sort, filter, resize or
 * edit it. It holds no rendering logic, so the same definition can drive any
 * adapter.
 */
export class GridColumn<T = unknown> {
  readonly field: string;
  readonly title: string;
  readonly value: ValueGetter<T>;
  readonly type: ColumnType;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly align: ColumnAlign | null;
  readonly pin: ColumnPin;
  readonly visible: boolean;
  readonly sortable: boolean;
  readonly filterable: boolean;
  readonly resizable: boolean;
  readonly groupable: boolean;
  readonly format: ValueFormatter | null;
  readonly comparator: Comparator<CellValue> | null;
  readonly setValue: ValueSetter<T> | null;
  readonly validator: ValueValidator | null;
  readonly tooltip: string | null;
  readonly rule: CellRule | null;
  readonly sortKey: SortKeyGetter<T> | null;

  /**
   * Whether {@link value} is the generated property accessor rather than one
   * the caller passed, so {@link copyWith} knows it may regenerate it for a
   * new field.
   */
  private readonly usesDefaultValue: boolean;

  constructor(options: GridColumnOptions<T>) {
    const {
      field,
      title,
      value,
      type = ColumnType.text,
      width = 140,
      minWidth = 48,
      maxWidth = 1200,
      align,
      pin = ColumnPin.none,
      visible = true,
      sortable = true,
      filterable = true,
      resizable = true,
      groupable = true,
      format,
      comparator,
      setValue,
      validator,
      tooltip,
      rule,
      sortKey,
    } = options;

    if (minWidth > maxWidth) {
      throw new GridArgumentError(
        `GridColumn("${field}"): minWidth (${minWidth}) must not exceed maxWidth (${maxWidth}).`,
      );
    }
    if (!(width > 0)) {
      throw new GridArgumentError(
        `GridColumn("${field}"): width must be positive, got ${width}.`,
      );
    }

    this.field = field;
    this.title = title ?? humanize(field);
    this.value = value ?? propertyGetter<T>(field);
    this.usesDefaultValue = value === undefined || value === null;
    this.type = type;
    this.width = width;
    this.minWidth = minWidth;
    this.maxWidth = maxWidth;
    this.align = align ?? null;
    this.pin = pin;
    this.visible = visible;
    this.sortable = sortable;
    this.filterable = filterable;
    this.resizable = resizable;
    this.groupable = groupable;
    this.format = format ?? null;
    this.comparator = comparator ?? null;
    this.setValue = setValue ?? null;
    this.validator = validator ?? null;
    this.tooltip = tooltip ?? null;
    this.rule = rule ?? null;
    this.sortKey = sortKey ?? null;
  }

  /** Whether the user may edit cells in this column. */
  get editable(): boolean {
    return this.setValue !== null;
  }

  /** Effective alignment, resolving the type-based default. */
  get effectiveAlign(): ColumnAlign {
    if (this.align !== null) return this.align;
    return this.type === ColumnType.number
      ? ColumnAlign.end
      : ColumnAlign.start;
  }

  /** Display text for `row` in this column. */
  formattedValue(row: T): string {
    const raw = this.value(row);
    if (this.format !== null) return this.format(raw);
    return raw === null || raw === undefined ? '' : String(raw);
  }

  /**
   * The value this column orders by: {@link sortKey} when one is set, and the
   * displayed value otherwise.
   */
  sortValue(row: T): CellValue {
    return this.sortKey === null ? this.value(row) : this.sortKey(row);
  }

  /** Clamps `candidate` into this column's allowed width range. */
  clampWidth(candidate: number): number {
    return clamp(candidate, this.minWidth, this.maxWidth);
  }

  /**
   * A copy of this column with the given fields replaced.
   *
   * An absent or `undefined` field means "keep what is there"; `null` clears
   * a nullable one, which is the only way to take a callback or a rule off a
   * column.
   *
   * Changing {@link field} also regenerates the default property accessor, so
   * a column declared without a `value` reads the new field rather than
   * quietly keeping the old one.
   */
  copyWith(patch: GridColumnPatch<T>): GridColumn<T> {
    const nextField = patch.field ?? this.field;
    // A column that never had an accessor of its own reads whichever field
    // it now names; one that was given an accessor keeps it.
    const nextValue =
      patch.value ??
      (this.usesDefaultValue && nextField !== this.field
        ? undefined
        : this.value);
    return new GridColumn<T>({
      field: nextField,
      title: patch.title ?? this.title,
      value: nextValue,
      type: patch.type ?? this.type,
      width: patch.width ?? this.width,
      minWidth: patch.minWidth ?? this.minWidth,
      maxWidth: patch.maxWidth ?? this.maxWidth,
      align: pick(patch, 'align', this.align),
      pin: patch.pin ?? this.pin,
      visible: patch.visible ?? this.visible,
      sortable: patch.sortable ?? this.sortable,
      filterable: patch.filterable ?? this.filterable,
      resizable: patch.resizable ?? this.resizable,
      groupable: patch.groupable ?? this.groupable,
      format: pick(patch, 'format', this.format),
      comparator: pick(patch, 'comparator', this.comparator),
      setValue: pick(patch, 'setValue', this.setValue),
      validator: pick(patch, 'validator', this.validator),
      tooltip: pick(patch, 'tooltip', this.tooltip),
      rule: pick(patch, 'rule', this.rule),
      sortKey: pick(patch, 'sortKey', this.sortKey),
    });
  }

  toString(): string {
    return `GridColumn(${this.field})`;
  }
}

/** `undefined` keeps the current value; `null` clears it. */
function pick<T, K extends keyof GridColumnPatch<T>>(
  patch: GridColumnPatch<T>,
  key: K,
  current: GridColumnOptions<T>[K],
): GridColumnOptions<T>[K] {
  const next = patch[key];
  return next === undefined ? current : next;
}

/**
 * Convenience for defining a column without writing `new`, and for letting
 * the row type be inferred from a typed array of rows.
 */
export function column<T = unknown>(
  options: GridColumnOptions<T>,
): GridColumn<T> {
  return new GridColumn<T>(options);
}

function propertyGetter<T>(field: string): ValueGetter<T> {
  return (row: T): CellValue => {
    if (row instanceof Map) return row.get(field) as CellValue;
    if (typeof row === 'object' && row !== null) {
      return (row as Record<string, CellValue>)[field];
    }
    throw new GridStateError(
      `GridColumn("${field}") has no value accessor and rows of type ` +
        `${typeof row} are not objects. Pass \`value\` when defining the column.`,
    );
  };
}

/**
 * `unitPrice` / `unit_price` / `unit-price` -> `Unit Price`, and
 * `HTTPStatus` -> `HTTP Status`.
 *
 * An acronym stays whole: splitting on every case change would have produced
 * `H T T P Status`, and splitting only after a lower-case letter produced
 * `HTTPStatus`. The boundary that matters is the last capital of a run, which
 * begins the next word.
 */
function humanize(field: string): string {
  const spaced = field
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .trim();
  if (spaced.length === 0) return field;
  return spaced
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
