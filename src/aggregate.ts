/**
 * Column aggregations used by group rows and the summary footer.
 *
 * @module
 */

import type { ValueFormatter } from './column';
import { compareValues, isNullish, type CellValue } from './compare';
import { parseDecimal } from './editing';
import { GridArgumentError } from './errors';

/** Built-in aggregate functions. */
export const AggregateType = {
  count: 'count',
  countDistinct: 'countDistinct',
  sum: 'sum',
  average: 'average',
  min: 'min',
  max: 'max',
  first: 'first',
  last: 'last',
  custom: 'custom',
} as const;
export type AggregateType = (typeof AggregateType)[keyof typeof AggregateType];

/** A reducer for {@link AggregateType.custom}. */
export type AggregateReducer = (values: CellValue[]) => CellValue;

/** Options for an {@link Aggregation}. */
export interface AggregationOptions {
  type?: AggregateType;
  /**
   * Reducer for `custom`. Receives every value of the field in the group,
   * nulls included.
   */
  compute?: AggregateReducer;
  id?: string;
  /** Text a UI adapter shows beside the result. */
  label?: string;
  /**
   * Formats this aggregate's result for display.
   *
   * An aggregate's result is not in the same units as the column it came
   * from: a count of prices is a number of rows, not an amount of money, so
   * the column's own formatter is the wrong one to use and an adapter that
   * reached for it had to special-case count against sum. Set this to say how
   * the result reads — a currency, a percentage, "3 items".
   */
  format?: ValueFormatter;
}

/** Computes one aggregate over the values of one column. */
export class Aggregation {
  /** Column whose values are aggregated. */
  readonly field: string;

  readonly type: AggregateType;

  readonly compute: AggregateReducer | null;

  readonly label: string | null;

  readonly format: ValueFormatter | null;

  private readonly explicitId: string | null;

  constructor(field: string, options: AggregationOptions = {}) {
    const type = options.type ?? AggregateType.sum;
    if (type === AggregateType.custom && options.compute === undefined) {
      throw new GridArgumentError(
        'AggregateType.custom requires a compute function',
      );
    }
    this.field = field;
    this.type = type;
    this.compute = options.compute ?? null;
    this.explicitId = options.id ?? null;
    this.label = options.label ?? null;
    this.format = options.format ?? null;
    Object.freeze(this);
  }

  static count(field: string, options: AggregationOptions = {}): Aggregation {
    return new Aggregation(field, { ...options, type: AggregateType.count });
  }

  static countDistinct(
    field: string,
    options: AggregationOptions = {},
  ): Aggregation {
    return new Aggregation(field, {
      ...options,
      type: AggregateType.countDistinct,
    });
  }

  static sum(field: string, options: AggregationOptions = {}): Aggregation {
    return new Aggregation(field, { ...options, type: AggregateType.sum });
  }

  static average(field: string, options: AggregationOptions = {}): Aggregation {
    return new Aggregation(field, { ...options, type: AggregateType.average });
  }

  static min(field: string, options: AggregationOptions = {}): Aggregation {
    return new Aggregation(field, { ...options, type: AggregateType.min });
  }

  static max(field: string, options: AggregationOptions = {}): Aggregation {
    return new Aggregation(field, { ...options, type: AggregateType.max });
  }

  /** Key this aggregate is stored under in an {@link AggregateResult}. */
  get id(): string {
    return this.explicitId ?? `${this.field}.${this.type}`;
  }

  /**
   * A stable string identifying what this aggregate computes, for use as a
   * cache key.
   *
   * The reducer is part of it, because two custom aggregations with the same
   * id and different functions do not compute the same thing.
   */
  get fingerprint(): string {
    return `${this.id}:${this.type}:${this.field}:${functionId(this.compute)}`;
  }

  /**
   * This aggregate's result as display text.
   *
   * Without a {@link format}, a whole number prints as itself and a
   * fractional result to two decimal places, because an average of integers
   * is a fraction and `23.333333333333332` in a footer cell is noise rather
   * than precision. A null result — an empty group, or one where every value
   * was null — prints as empty rather than as `0`, matching what {@link apply}
   * returns.
   */
  formatted(value: CellValue): string {
    if (this.format !== null) return this.format(value);
    if (isNullish(value)) return '';
    if (typeof value === 'number') {
      if (Number.isNaN(value) || !Number.isFinite(value)) return String(value);
      const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
      // -0.001 rounds to -0.00, which reads as a negative zero: a loss that
      // looks like a loss of nothing. Round it to plain zero.
      if (text === '-0' || text === '-0.00') return text.slice(1);
      return text;
    }
    return String(value);
  }

  /**
   * Reduces `values` to a single result.
   *
   * Nulls are skipped by the numeric and extremum aggregates, matching SQL,
   * so an empty or all-null group yields `null` rather than `0`.
   */
  apply(values: CellValue[]): CellValue {
    switch (this.type) {
      case AggregateType.count:
        return values.length;
      case AggregateType.countDistinct: {
        // Null is the absence of a value, not a distinct one, which is what
        // SQL's COUNT(DISTINCT col) means too. Counting it made "3 distinct
        // categories" out of two categories and a blank.
        const seen = new Set<unknown>();
        for (const value of values) {
          if (isNullish(value)) continue;
          seen.add(distinctKey(value));
        }
        return seen.size;
      }
      case AggregateType.sum: {
        const nums = numbersOf(values);
        if (nums.length === 0) return null;
        return nums.reduce((a, b) => a + b, 0);
      }
      case AggregateType.average: {
        const nums = numbersOf(values);
        if (nums.length === 0) return null;
        return nums.reduce((a, b) => a + b, 0) / nums.length;
      }
      case AggregateType.min:
        return extremum(values, true);
      case AggregateType.max:
        return extremum(values, false);
      case AggregateType.first:
        return values.length === 0 ? null : (values[0] ?? null);
      case AggregateType.last:
        return values.length === 0 ? null : (values[values.length - 1] ?? null);
      case AggregateType.custom:
        return (this.compute as AggregateReducer)(values);
    }
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Aggregation &&
      other.id === this.id &&
      other.type === this.type
    );
  }

  toString(): string {
    return `${this.type}(${this.field})`;
  }
}

/**
 * A stable number per reducer function, for {@link Aggregation.fingerprint}.
 *
 * JavaScript has no identity hash, and a cache key that cannot tell two
 * reducers apart serves one group's totals for another's.
 */
const functionIds = new WeakMap<object, number>();
let nextFunctionId = 1;

function functionId(fn: AggregateReducer | null): number {
  if (fn === null) return 0;
  let id = functionIds.get(fn);
  if (id === undefined) {
    id = nextFunctionId++;
    functionIds.set(fn, id);
  }
  return id;
}

/**
 * A key under which two values count as the same distinct value.
 *
 * `Set` compares objects by identity, so two equal dates counted twice.
 */
function distinctKey(value: NonNullable<CellValue>): unknown {
  if (value instanceof Date) return `\u0000date:${value.getTime()}`;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object') return String(value);
  return value;
}

/**
 * The numbers among `values`, as sum and average read them.
 *
 * A string is parsed, because a column of numbers typed into a text field is
 * a real shape of data — but only as a finite decimal number. Text reading
 * `NaN`, `Infinity` or `0x10` would otherwise contribute a value nobody
 * typed, and one of the first two in a column makes every sum, average and
 * data bar over it NaN.
 */
function numbersOf(values: readonly CellValue[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) out.push(value);
    } else if (typeof value === 'string') {
      const parsed = parseDecimal(value);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

function extremum(values: readonly CellValue[], min: boolean): CellValue {
  let best: CellValue = null;
  for (const value of values) {
    if (isNullish(value)) continue;
    if (isNullish(best)) {
      best = value;
      continue;
    }
    const cmp = compareValues(value, best);
    if (min ? cmp < 0 : cmp > 0) best = value;
  }
  return best;
}

/**
 * Aggregate results for one group or for the whole grid, keyed by
 * {@link Aggregation.id}.
 */
export class AggregateResult {
  /** The result of aggregating nothing. */
  static readonly empty: AggregateResult = new AggregateResult(new Map());

  private readonly values: ReadonlyMap<string, CellValue>;

  constructor(
    values: ReadonlyMap<string, CellValue> | Record<string, CellValue> = {},
  ) {
    this.values =
      values instanceof Map
        ? values
        : new Map(Object.entries(values as Record<string, CellValue>));
    Object.freeze(this);
  }

  /** The result stored under `id`. */
  get(id: string): CellValue {
    return this.values.get(id) ?? null;
  }

  /** The result of `aggregation`. */
  of(aggregation: Aggregation): CellValue {
    return this.get(aggregation.id);
  }

  get isEmpty(): boolean {
    return this.values.size === 0;
  }

  /** Every result, as a plain object. */
  get asObject(): Record<string, CellValue> {
    return Object.fromEntries(this.values);
  }

  /** Every result, as a map. */
  get asMap(): ReadonlyMap<string, CellValue> {
    return this.values;
  }

  toString(): string {
    return `AggregateResult(${JSON.stringify(this.asObject)})`;
  }
}

/** Runs every aggregation in `aggregations` over `rows`. */
export function computeAggregates<T>(
  rows: readonly T[],
  aggregations: readonly Aggregation[],
  read: (row: T, field: string) => CellValue,
): AggregateResult {
  if (aggregations.length === 0) return AggregateResult.empty;
  const out = new Map<string, CellValue>();
  for (const aggregation of aggregations) {
    const values = rows.map((row) => read(row, aggregation.field));
    out.set(aggregation.id, aggregation.apply(values));
  }
  return new AggregateResult(out);
}
