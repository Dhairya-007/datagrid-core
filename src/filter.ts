/**
 * Declarative, serialisable filter model.
 *
 * @module
 */

import { ColumnType } from './column';
import {
  compareValues,
  compareValuesFolded,
  foldText,
  isNullish,
  type CellValue,
} from './compare';
import { startOfDay, tryParseDate } from './dates';
import { parseDecimal } from './editing';
import { GridFormatError } from './errors';
import type { JsonMap } from './schema';

/** Comparison applied by a {@link FilterCondition}. */
export const FilterOperator = {
  equals: 'equals',
  notEquals: 'notEquals',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  greaterThan: 'greaterThan',
  greaterOrEqual: 'greaterOrEqual',
  lessThan: 'lessThan',
  lessOrEqual: 'lessOrEqual',
  between: 'between',
  isIn: 'isIn',
  isNull: 'isNull',
  isNotNull: 'isNotNull',
  isEmpty: 'isEmpty',
  isNotEmpty: 'isNotEmpty',
} as const;
export type FilterOperator =
  (typeof FilterOperator)[keyof typeof FilterOperator];

const FILTER_OPERATORS = Object.values(FilterOperator);

/** How the children of a {@link FilterGroup} combine. */
export const FilterJoin = {
  and: 'and',
  or: 'or',
} as const;
export type FilterJoin = (typeof FilterJoin)[keyof typeof FilterJoin];

/**
 * Whether the operator takes a value at all.
 *
 * An adapter reads this to decide whether to show an input next to the
 * operator: `is empty` has nothing to type into.
 */
export function operatorNeedsValue(operator: FilterOperator): boolean {
  switch (operator) {
    case FilterOperator.isNull:
    case FilterOperator.isNotNull:
    case FilterOperator.isEmpty:
    case FilterOperator.isNotEmpty:
      return false;
    default:
      return true;
  }
}

/** Whether the operator takes a second value, i.e. it is a range. */
export function operatorNeedsSecondValue(operator: FilterOperator): boolean {
  return operator === FilterOperator.between;
}

/** Whether the operator takes a set of values rather than one. */
export function operatorNeedsValueSet(operator: FilterOperator): boolean {
  return operator === FilterOperator.isIn;
}

/**
 * A short English label, as a starting point for an adapter's menu.
 *
 * Shipped because every adapter needs one and writing the same switch in each
 * of them is how they drift apart. Localised UIs map the operator themselves
 * rather than using this.
 */
export function operatorLabel(operator: FilterOperator): string {
  switch (operator) {
    case FilterOperator.equals:
      return 'equals';
    case FilterOperator.notEquals:
      return 'does not equal';
    case FilterOperator.contains:
      return 'contains';
    case FilterOperator.notContains:
      return 'does not contain';
    case FilterOperator.startsWith:
      return 'starts with';
    case FilterOperator.endsWith:
      return 'ends with';
    case FilterOperator.greaterThan:
      return 'is greater than';
    case FilterOperator.greaterOrEqual:
      return 'is at least';
    case FilterOperator.lessThan:
      return 'is less than';
    case FilterOperator.lessOrEqual:
      return 'is at most';
    case FilterOperator.between:
      return 'is between';
    case FilterOperator.isIn:
      return 'is one of';
    case FilterOperator.isNull:
      return 'is blank';
    case FilterOperator.isNotNull:
      return 'is not blank';
    case FilterOperator.isEmpty:
      return 'is empty';
    case FilterOperator.isNotEmpty:
      return 'is not empty';
  }
}

/**
 * The operators worth offering for a column of `type`, most useful first.
 *
 * `ColumnType` has always claimed to drive this, but the set lived in
 * whichever adapter needed it, as a switch each one wrote again. It belongs
 * here: a date column offering `starts with` is a bug in the engine's model
 * of the column, not in the view that drew the menu.
 *
 * The first entry is the sensible default for a fresh filter row.
 */
export function operatorsFor(type: ColumnType): FilterOperator[] {
  switch (type) {
    case ColumnType.text:
    case ColumnType.custom:
      return [
        FilterOperator.contains,
        FilterOperator.notContains,
        FilterOperator.equals,
        FilterOperator.notEquals,
        FilterOperator.startsWith,
        FilterOperator.endsWith,
        FilterOperator.isIn,
        FilterOperator.isEmpty,
        FilterOperator.isNotEmpty,
      ];
    case ColumnType.number:
      return [
        FilterOperator.equals,
        FilterOperator.notEquals,
        FilterOperator.greaterThan,
        FilterOperator.greaterOrEqual,
        FilterOperator.lessThan,
        FilterOperator.lessOrEqual,
        FilterOperator.between,
        FilterOperator.isIn,
        FilterOperator.isNull,
        FilterOperator.isNotNull,
      ];
    case ColumnType.date:
      return [
        FilterOperator.equals,
        FilterOperator.notEquals,
        FilterOperator.greaterThan,
        FilterOperator.lessThan,
        FilterOperator.between,
        FilterOperator.isNull,
        FilterOperator.isNotNull,
      ];
    case ColumnType.boolean:
      return [
        FilterOperator.equals,
        FilterOperator.isNull,
        FilterOperator.isNotNull,
      ];
  }
}

/** Reads one field out of a row, for a filter that tests it. */
export type FieldReader = (field: string) => CellValue;

/**
 * Common interface of {@link FilterCondition} and {@link FilterGroup}.
 *
 * Filters form a tree, are value types, and serialise to plain JSON so a
 * saved view can round-trip through storage or an HTTP backend.
 */
export abstract class Filter {
  /** Whether `row` (as a field -> value object) satisfies this filter. */
  matches(row: Record<string, CellValue> | Map<string, CellValue>): boolean {
    const read: FieldReader =
      row instanceof Map
        ? (field) => row.get(field)
        : (field) => row[field];
    return this.matchesRow(read);
  }

  /**
   * Whether a row satisfies this filter, reading values through `read`.
   *
   * The reader form exists so that filtering a wide table does not allocate
   * an object per row: at 50k rows that allocation dominated the filter
   * itself.
   */
  abstract matchesRow(read: FieldReader): boolean;

  /**
   * A stable string identifying this filter, for use as a cache key.
   *
   * Two filters with the same fingerprint select the same rows. It is not a
   * serialisation format — use {@link toJSON} for that — and may change shape
   * between versions.
   */
  abstract get fingerprint(): string;

  /** Fields referenced anywhere in this subtree. */
  abstract get fields(): Set<string>;

  /**
   * Prepares this filter to be run over many rows.
   *
   * Everything that depends only on the filter — folding a needle, building a
   * set out of an `isIn` list, coercing an operand to the column's type —
   * happens once here instead of once per row. {@link matchesRow} stays
   * correct on its own for a one-off test; a pipeline that walks 50k rows
   * compiles first, which is what turns `isIn` over 1,000 values from a scan
   * per row into a hash lookup per row.
   *
   * `types` maps a field to its `ColumnType`, so that a `'50'` typed into a
   * number column's filter compares as 50 rather than as text. A field
   * missing from the map is left uncoerced.
   */
  abstract compile(types?: ReadonlyMap<string, ColumnType>): CompiledFilter;

  abstract toJSON(): JsonMap;

  /**
   * Rebuilds a filter tree produced by {@link toJSON}.
   *
   * `warnings`, when given, collects a line per child that could not be read
   * instead of failing the whole tree; a malformed *leaf* still throws a
   * {@link GridFormatError}, which is what the group above it catches.
   */
  static fromJSON(json: JsonMap, warnings?: string[]): Filter {
    if (!isNullish(json['join'])) {
      return FilterGroup.fromJSON(json, warnings);
    }
    return FilterCondition.fromJSON(json);
  }
}

/** Options for a {@link FilterCondition}. */
export interface FilterConditionOptions {
  field: string;
  operator: FilterOperator;
  value?: CellValue;
  secondValue?: CellValue;
  caseSensitive?: boolean;
  dateOnly?: boolean;
}

/** A single `field operator value` test. */
export class FilterCondition extends Filter {
  readonly field: string;
  readonly operator: FilterOperator;

  /** Right-hand operand. For `isIn` this is an array. */
  readonly value: CellValue;

  /** Upper bound, used only by `between`. */
  readonly secondValue: CellValue;

  /**
   * Whether text comparisons respect case. Defaults to case-insensitive,
   * which is what users expect of a filter row.
   */
  readonly caseSensitive: boolean;

  /**
   * Whether a `Date` comparison ignores the time of day.
   *
   * `equals` against a date column otherwise needs the exact instant, so
   * "orders on 1 June" matched nothing unless every row happened to be
   * stamped midnight. With this set, both sides are truncated to their
   * calendar day before comparing, which also makes `between` cover both of
   * its end days.
   */
  readonly dateOnly: boolean;

  constructor(options: FilterConditionOptions) {
    super();
    this.field = options.field;
    this.operator = options.operator;
    this.value = options.value ?? null;
    this.secondValue = options.secondValue ?? null;
    this.caseSensitive = options.caseSensitive ?? false;
    this.dateOnly = options.dateOnly ?? false;
    Object.freeze(this);
  }

  override get fields(): Set<string> {
    return new Set([this.field]);
  }

  /**
   * Whether this condition is inert and should be dropped from a query.
   *
   * A filter row the user has not filled in yet must not hide every row.
   */
  get isEmpty(): boolean {
    switch (this.operator) {
      case FilterOperator.isNull:
      case FilterOperator.isNotNull:
      case FilterOperator.isEmpty:
      case FilterOperator.isNotEmpty:
        return false;
      case FilterOperator.between:
        return isNullish(this.value) || isNullish(this.secondValue);
      case FilterOperator.isIn: {
        // A value that is not a list at all is a malformed condition, not a
        // condition that hides every row: restoring a corrupt saved view used
        // to throw from here.
        const values = this.value;
        if (isValueList(values)) return listOf(values).length === 0;
        return true;
      }
      default:
        return (
          isNullish(this.value) ||
          (typeof this.value === 'string' && this.value.length === 0)
        );
    }
  }

  override get fingerprint(): string {
    const value = isValueList(this.value)
      ? listOf(this.value).join('\u0001')
      : String(this.value);
    return (
      `${this.field}|${this.operator}|${value}|` +
      `${String(this.secondValue)}|${String(this.caseSensitive)}|${String(this.dateOnly)}`
    );
  }

  override matchesRow(read: FieldReader): boolean {
    if (this.isEmpty) return true;
    const actual = read(this.field);
    switch (this.operator) {
      case FilterOperator.equals:
        return this.compare(actual, this.value) === 0;
      case FilterOperator.notEquals:
        return this.compare(actual, this.value) !== 0;
      case FilterOperator.contains:
        return this.text(actual).includes(this.text(this.value));
      case FilterOperator.notContains:
        return !this.text(actual).includes(this.text(this.value));
      case FilterOperator.startsWith:
        return this.text(actual).startsWith(this.text(this.value));
      case FilterOperator.endsWith:
        return this.text(actual).endsWith(this.text(this.value));
      case FilterOperator.greaterThan:
        return !isNullish(actual) && this.compare(actual, this.value) > 0;
      case FilterOperator.greaterOrEqual:
        return !isNullish(actual) && this.compare(actual, this.value) >= 0;
      case FilterOperator.lessThan:
        return !isNullish(actual) && this.compare(actual, this.value) < 0;
      case FilterOperator.lessOrEqual:
        return !isNullish(actual) && this.compare(actual, this.value) <= 0;
      case FilterOperator.between: {
        if (isNullish(actual)) return false;
        // A range typed backwards is still a range. Comparing against the
        // bounds in the order they were given matched nothing at all, which
        // reads as "no rows" rather than as "you typed it the other way".
        const ordered = this.compare(this.value, this.secondValue) <= 0;
        const low = ordered ? this.value : this.secondValue;
        const high = ordered ? this.secondValue : this.value;
        return this.compare(actual, low) >= 0 && this.compare(actual, high) <= 0;
      }
      case FilterOperator.isIn: {
        const values = this.value;
        if (!isValueList(values)) return true;
        return listOf(values).some((v) => this.compare(actual, v) === 0);
      }
      case FilterOperator.isNull:
        return isNullish(actual);
      case FilterOperator.isNotNull:
        return !isNullish(actual);
      case FilterOperator.isEmpty:
        return isNullish(actual) || this.text(actual).length === 0;
      case FilterOperator.isNotEmpty:
        return !isNullish(actual) && this.text(actual).length > 0;
    }
  }

  override compile(
    types: ReadonlyMap<string, ColumnType> = new Map(),
  ): CompiledFilter {
    return compileCondition(this, types.get(this.field));
  }

  /**
   * Compares two operands the way this condition's flags ask for.
   *
   * A case-insensitive comparison must *not* break a folded tie with the
   * exact comparison the way a sort does: `equals: 'apple'` against `'Apple'`
   * is a match, and a `>=` that calls two values equal and then excludes one
   * of them is simply wrong.
   */
  private compare(a: CellValue, b: CellValue): number {
    if (this.dateOnly && (a instanceof Date || b instanceof Date)) {
      return compareValues(truncateDay(a), truncateDay(b));
    }
    return this.caseSensitive
      ? compareValues(a, b)
      : compareValuesFolded(a, b);
  }

  private text(value: CellValue): string {
    const text = isNullish(value) ? '' : String(value);
    return this.caseSensitive ? text : foldText(text);
  }

  copyWith(patch: Partial<FilterConditionOptions>): FilterCondition {
    return new FilterCondition({
      field: patch.field ?? this.field,
      operator: patch.operator ?? this.operator,
      value: patch.value === undefined ? this.value : patch.value,
      secondValue:
        patch.secondValue === undefined ? this.secondValue : patch.secondValue,
      caseSensitive: patch.caseSensitive ?? this.caseSensitive,
      dateOnly: patch.dateOnly ?? this.dateOnly,
    });
  }

  /**
   * JSON for a saved view.
   *
   * Operands carry their type: a `Date` is written as `{"$date": "<iso>"}`
   * and a `bigint` as `{"$bigint": "<digits>"}`. Writing a `Date` straight
   * through made it come back as text, so a restored date filter compared
   * instants against ISO strings and matched the wrong rows — and
   * `JSON.stringify` cannot represent a `bigint` at all.
   */
  override toJSON(): JsonMap {
    const json: JsonMap = { field: this.field, op: this.operator };
    if (!isNullish(this.value)) {
      json['value'] = encodeFilterOperand(this.value);
    }
    if (!isNullish(this.secondValue)) {
      json['secondValue'] = encodeFilterOperand(this.secondValue);
    }
    if (this.caseSensitive) json['caseSensitive'] = true;
    if (this.dateOnly) json['dateOnly'] = true;
    return json;
  }

  /**
   * Rebuilds a condition produced by {@link toJSON}.
   *
   * Throws a {@link GridFormatError} for a document this cannot read, rather
   * than a `TypeError` from a null check: a corrupt saved view is a document
   * the caller can report on, not a crash.
   */
  static override fromJSON(json: JsonMap): FilterCondition {
    const field = json['field'];
    if (typeof field !== 'string' || field.length === 0) {
      throw new GridFormatError('A filter needs a non-empty "field"');
    }
    const name = json['op'];
    const operator = FILTER_OPERATORS.find((o) => o === name);
    if (operator === undefined) {
      throw new GridFormatError(`Unknown filter operator: ${String(name)}`);
    }
    let value = decodeFilterOperand(json['value']);
    if (
      operator === FilterOperator.isIn &&
      !isNullish(value) &&
      !Array.isArray(value)
    ) {
      // One value where a list belongs is readable: treat it as a set of one
      // rather than refusing the whole view.
      value = [value];
    }
    return new FilterCondition({
      field,
      operator,
      value,
      secondValue: decodeFilterOperand(json['secondValue']),
      caseSensitive: json['caseSensitive'] === true,
      dateOnly: json['dateOnly'] === true,
    });
  }

  equals(other: unknown): boolean {
    return (
      other instanceof FilterCondition &&
      other.field === this.field &&
      other.operator === this.operator &&
      operandsEqual(other.value, this.value) &&
      operandsEqual(other.secondValue, this.secondValue) &&
      other.caseSensitive === this.caseSensitive &&
      other.dateOnly === this.dateOnly
    );
  }

  override toString(): string {
    return `${this.field} ${this.operator} ${String(this.value)}`;
  }
}

/**
 * Two operands are the same when they are equal, or when both are lists of
 * equal values.
 *
 * An `isIn` condition holds a list, and two arrays with the same contents are
 * never `===` — so two conditions that select exactly the same rows compared
 * unequal, which defeated every cache keyed on a filter and made the filter
 * row rebuild on every keystroke.
 */
function operandsEqual(a: CellValue, b: CellValue): boolean {
  if (isValueList(a) && isValueList(b)) {
    const left = listOf(a);
    const right = listOf(b);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (!scalarsEqual(left[i], right[i])) return false;
    }
    return true;
  }
  return scalarsEqual(a, b);
}

function scalarsEqual(a: CellValue, b: CellValue): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

/** Whether a value is a list of operands rather than a single one. */
function isValueList(value: CellValue): value is readonly CellValue[] | Set<CellValue> {
  return Array.isArray(value) || value instanceof Set;
}

function listOf(value: readonly CellValue[] | Set<CellValue>): CellValue[] {
  return Array.isArray(value) ? [...value] : [...(value as Set<CellValue>)];
}

/** Combines child filters with `and` or `or`. */
export class FilterGroup extends Filter {
  readonly children: readonly Filter[];
  readonly join: FilterJoin;

  constructor(children: readonly Filter[], join: FilterJoin = FilterJoin.and) {
    super();
    this.children = children;
    this.join = join;
    Object.freeze(this);
  }

  /** Every child must match. */
  static and(children: readonly Filter[]): FilterGroup {
    return new FilterGroup(children, FilterJoin.and);
  }

  /** Any child matching is enough. */
  static or(children: readonly Filter[]): FilterGroup {
    return new FilterGroup(children, FilterJoin.or);
  }

  override get fields(): Set<string> {
    const out = new Set<string>();
    for (const child of this.children) {
      for (const field of child.fields) out.add(field);
    }
    return out;
  }

  override get fingerprint(): string {
    const separator = this.join === FilterJoin.and ? '&' : '|';
    return `(${this.children.map((c) => c.fingerprint).join(separator)})`;
  }

  override matchesRow(read: FieldReader): boolean {
    if (this.children.length === 0) return true;
    if (this.join === FilterJoin.and) {
      for (const child of this.children) {
        if (!child.matchesRow(read)) return false;
      }
      return true;
    }
    for (const child of this.children) {
      if (child.matchesRow(read)) return true;
    }
    return false;
  }

  override compile(
    types: ReadonlyMap<string, ColumnType> = new Map(),
  ): CompiledFilter {
    if (this.children.length === 0) return ALWAYS_TRUE;
    const compiled = this.children.map((c) => c.compile(types));
    return this.join === FilterJoin.and
      ? new CompiledAnd(compiled)
      : new CompiledOr(compiled);
  }

  override toJSON(): JsonMap {
    return {
      join: this.join,
      children: this.children.map((c) => c.toJSON()),
    };
  }

  /**
   * Rebuilds a group produced by {@link toJSON}, skipping children it cannot
   * read.
   *
   * A saved view is a user's own work read back by a later build, so one
   * unreadable condition drops out of the tree rather than taking the whole
   * view with it. `warnings`, when given, collects what was skipped.
   */
  static override fromJSON(json: JsonMap, warnings?: string[]): FilterGroup {
    const raw = json['children'];
    const children: Filter[] = [];
    if (Array.isArray(raw)) {
      for (const child of raw) {
        if (typeof child !== 'object' || child === null || Array.isArray(child)) {
          warnings?.push('A filter child that is not an object was skipped.');
          continue;
        }
        try {
          children.push(Filter.fromJSON(child as JsonMap, warnings));
        } catch (error) {
          if (!(error instanceof GridFormatError)) throw error;
          warnings?.push(`A filter was skipped: ${error.message}`);
        }
      }
    }
    return new FilterGroup(
      children,
      json['join'] === 'or' ? FilterJoin.or : FilterJoin.and,
    );
  }

  equals(other: unknown): boolean {
    if (!(other instanceof FilterGroup)) return false;
    if (
      other.join !== this.join ||
      other.children.length !== this.children.length
    ) {
      return false;
    }
    for (let i = 0; i < this.children.length; i++) {
      if (!filtersEqual(other.children[i], this.children[i])) return false;
    }
    return true;
  }

  override toString(): string {
    return `(${this.children.map(String).join(` ${this.join.toUpperCase()} `)})`;
  }
}

/** Whether two filter trees are the same, either side possibly absent. */
export function filtersEqual(
  a: Filter | null | undefined,
  b: Filter | null | undefined,
): boolean {
  if (a === b) return true;
  if (isNullish(a) || isNullish(b)) return false;
  if (a instanceof FilterCondition) return a.equals(b);
  if (a instanceof FilterGroup) return a.equals(b);
  return a.fingerprint === b.fingerprint;
}

// -- Compiled filters --------------------------------------------------------
//
// A filter is written once by the user and then run over every row, so every
// decision that depends only on the filter belongs here rather than in the
// inner loop: folding the needle, coercing the operand to the column's type,
// and — the one that mattered most — turning an `isIn` list into a hash set.
// A checkbox filter list over a thousand values was O(rows x values).

/**
 * A {@link Filter} prepared to be run over many rows.
 *
 * Obtained from {@link Filter.compile}. Immutable and safe to keep for as
 * long as the filter and the column types stand.
 */
export abstract class CompiledFilter {
  /** Whether a row satisfies the filter, reading values through `read`. */
  abstract test(read: FieldReader): boolean;

  /** Whether this filter lets every row through, so a caller can skip it. */
  get isPassThrough(): boolean {
    return false;
  }
}

class AlwaysTrue extends CompiledFilter {
  override test(): boolean {
    return true;
  }

  override get isPassThrough(): boolean {
    return true;
  }
}

const ALWAYS_TRUE = new AlwaysTrue();

/** A compiled filter that lets every row through. */
export function alwaysTrue(): CompiledFilter {
  return ALWAYS_TRUE;
}

class CompiledAnd extends CompiledFilter {
  constructor(private readonly children: readonly CompiledFilter[]) {
    super();
  }

  override test(read: FieldReader): boolean {
    for (let i = 0; i < this.children.length; i++) {
      if (!(this.children[i] as CompiledFilter).test(read)) return false;
    }
    return true;
  }
}

class CompiledOr extends CompiledFilter {
  constructor(private readonly children: readonly CompiledFilter[]) {
    super();
  }

  override test(read: FieldReader): boolean {
    for (let i = 0; i < this.children.length; i++) {
      if ((this.children[i] as CompiledFilter).test(read)) return true;
    }
    return false;
  }
}

class CompiledPredicate extends CompiledFilter {
  constructor(
    private readonly field: string,
    private readonly predicate: (actual: CellValue) => boolean,
  ) {
    super();
  }

  override test(read: FieldReader): boolean {
    return this.predicate(read(this.field));
  }
}

/**
 * Compiles one condition, coercing its operands to `type` when it is known.
 *
 * Exposed for a data source that compiles conditions itself; most callers
 * want {@link Filter.compile}.
 */
export function compileCondition(
  condition: FilterCondition,
  type: ColumnType | undefined,
): CompiledFilter {
  if (condition.isEmpty) return ALWAYS_TRUE;
  const field = condition.field;
  const folded = !condition.caseSensitive;
  const dateOnly = condition.dateOnly;

  const coerce = (operand: CellValue): CellValue =>
    coerceFilterOperand(operand, type, dateOnly);

  const compare = (a: CellValue, b: CellValue): number => {
    if (dateOnly && (a instanceof Date || b instanceof Date)) {
      return compareValues(truncateDay(a), truncateDay(b));
    }
    return folded ? compareValuesFolded(a, b) : compareValues(a, b);
  };

  const normalise = (value: CellValue): CellValue =>
    dateOnly && value instanceof Date ? startOfDay(value) : value;

  const operand = coerce(condition.value);
  const second = coerce(condition.secondValue);

  switch (condition.operator) {
    case FilterOperator.equals:
      return new CompiledPredicate(field, (a) => compare(a, operand) === 0);
    case FilterOperator.notEquals:
      return new CompiledPredicate(field, (a) => compare(a, operand) !== 0);
    case FilterOperator.contains: {
      const needle = textOf(operand, folded);
      return new CompiledPredicate(field, (a) =>
        textOf(a, folded).includes(needle),
      );
    }
    case FilterOperator.notContains: {
      const needle = textOf(operand, folded);
      return new CompiledPredicate(
        field,
        (a) => !textOf(a, folded).includes(needle),
      );
    }
    case FilterOperator.startsWith: {
      const needle = textOf(operand, folded);
      return new CompiledPredicate(field, (a) =>
        textOf(a, folded).startsWith(needle),
      );
    }
    case FilterOperator.endsWith: {
      const needle = textOf(operand, folded);
      return new CompiledPredicate(field, (a) =>
        textOf(a, folded).endsWith(needle),
      );
    }
    case FilterOperator.greaterThan:
      return new CompiledPredicate(
        field,
        (a) => !isNullish(a) && compare(a, operand) > 0,
      );
    case FilterOperator.greaterOrEqual:
      return new CompiledPredicate(
        field,
        (a) => !isNullish(a) && compare(a, operand) >= 0,
      );
    case FilterOperator.lessThan:
      return new CompiledPredicate(
        field,
        (a) => !isNullish(a) && compare(a, operand) < 0,
      );
    case FilterOperator.lessOrEqual:
      return new CompiledPredicate(
        field,
        (a) => !isNullish(a) && compare(a, operand) <= 0,
      );
    case FilterOperator.between: {
      // Bounds typed backwards still describe the same range.
      const ordered = compare(operand, second) <= 0;
      const low = ordered ? operand : second;
      const high = ordered ? second : operand;
      return new CompiledPredicate(
        field,
        (a) => !isNullish(a) && compare(a, low) >= 0 && compare(a, high) <= 0,
      );
    }
    case FilterOperator.isIn: {
      const raw = condition.value;
      if (!isValueList(raw)) return ALWAYS_TRUE;
      // The whole point of compiling: one hash lookup per row instead of a
      // walk over every selected value.
      const keys = new Set<unknown>();
      for (const value of listOf(raw)) {
        keys.add(setKey(normalise(coerce(value)), folded));
      }
      return new CompiledPredicate(field, (a) =>
        keys.has(setKey(normalise(a), folded)),
      );
    }
    case FilterOperator.isNull:
      return new CompiledPredicate(field, (a) => isNullish(a));
    case FilterOperator.isNotNull:
      return new CompiledPredicate(field, (a) => !isNullish(a));
    case FilterOperator.isEmpty:
      return new CompiledPredicate(
        field,
        (a) => isNullish(a) || textOf(a, false).length === 0,
      );
    case FilterOperator.isNotEmpty:
      return new CompiledPredicate(
        field,
        (a) => !isNullish(a) && textOf(a, false).length > 0,
      );
  }
}

function truncateDay(value: CellValue): CellValue {
  return value instanceof Date ? startOfDay(value) : value;
}

function textOf(value: CellValue, folded: boolean): string {
  const text = isNullish(value) ? '' : String(value);
  return folded ? foldText(text) : text;
}

/**
 * A hash key under which two values that a filter calls equal are the same.
 *
 * `5` and `5.0` are one value, `'Apple'` and `'apple'` are one value when the
 * filter folds case, and a `Date` keys on its instant.
 */
function setKey(value: CellValue, folded: boolean): unknown {
  if (isNullish(value)) return null;
  if (typeof value === 'string') return folded ? foldText(value) : value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'boolean') return value;
  return String(value);
}

/**
 * Coerces a filter operand to the type of the column it tests.
 *
 * A filter row hands back whatever the user typed, so a number column's
 * filter arrived holding `'50'` and compared as text — `'100' < '50'`. A date
 * restored from a saved view written by an older build arrives as an ISO
 * string for the same reason. Anything that cannot be read as `type` is
 * returned unchanged, so a text column is never second-guessed.
 */
export function coerceFilterOperand(
  operand: CellValue,
  type: ColumnType | undefined,
  dateOnly = false,
): CellValue {
  if (isNullish(operand) || type === undefined) return operand;
  switch (type) {
    case ColumnType.number:
      if (typeof operand === 'number' || typeof operand === 'bigint') {
        return operand;
      }
      if (typeof operand === 'string') return parseDecimal(operand) ?? operand;
      return operand;
    case ColumnType.date: {
      if (operand instanceof Date) {
        return dateOnly ? startOfDay(operand) : operand;
      }
      if (typeof operand === 'string') {
        const parsed = tryParseDate(operand.trim());
        if (parsed === null) return operand;
        return dateOnly ? startOfDay(parsed) : parsed;
      }
      return operand;
    }
    case ColumnType.boolean: {
      if (typeof operand === 'boolean') return operand;
      if (typeof operand === 'string') {
        const lower = operand.trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
      }
      return operand;
    }
    case ColumnType.text:
    case ColumnType.custom:
      return operand;
  }
}

/** Key a date operand is written under in JSON. */
export const FILTER_DATE_KEY = '$date';

/** Key a `bigint` operand is written under in JSON. */
export const FILTER_BIGINT_KEY = '$bigint';

/**
 * Encodes a filter operand as something `JSON.stringify` accepts.
 *
 * A `bigint` made `JSON.stringify` throw outright, which meant a saved view
 * holding one could not be stored at all, and a `Date` came back as a string
 * that no longer compared as a date.
 */
export function encodeFilterOperand(operand: CellValue): unknown {
  if (operand instanceof Date) {
    return { [FILTER_DATE_KEY]: operand.toISOString() };
  }
  if (typeof operand === 'bigint') {
    return { [FILTER_BIGINT_KEY]: operand.toString() };
  }
  if (isValueList(operand)) {
    return listOf(operand).map((value) => encodeFilterOperand(value));
  }
  return operand;
}

/**
 * Decodes what {@link encodeFilterOperand} wrote.
 *
 * A bare ISO string is left as a string: it may be a text column's operand,
 * and a date column's operand is coerced by {@link coerceFilterOperand}
 * against the column type, which knows which it is.
 */
export function decodeFilterOperand(operand: unknown): CellValue {
  if (Array.isArray(operand)) {
    return operand.map((value) => decodeFilterOperand(value));
  }
  if (typeof operand === 'object' && operand !== null) {
    const map = operand as Record<string, unknown>;
    const date = map[FILTER_DATE_KEY];
    if (typeof date === 'string') return tryParseDate(date) ?? date;
    const big = map[FILTER_BIGINT_KEY];
    if (typeof big === 'string') return tryParseBigInt(big) ?? big;
    return operand;
  }
  return operand;
}

function tryParseBigInt(text: string): bigint | null {
  if (!/^[+-]?\d+$/.test(text.trim())) return null;
  try {
    return BigInt(text.trim());
  } catch {
    return null;
  }
}

/**
 * Drops the conditions in `filter` whose field `isKnown` rejects.
 *
 * A filter on a column that has been removed tests a field no row has a value
 * for, which hides every row — and with the header gone there is no menu left
 * to clear it from. The grid prunes the filter it sends rather than
 * forgetting what the user set, so putting the column back brings its filter
 * back with it.
 *
 * Returns null when nothing is left to test.
 */
export function pruneFilter(
  filter: Filter | null | undefined,
  isKnown: (field: string) => boolean,
): Filter | null {
  if (isNullish(filter)) return null;
  if (filter instanceof FilterCondition) {
    return isKnown(filter.field) ? filter : null;
  }
  if (filter instanceof FilterGroup) {
    const kept: Filter[] = [];
    for (const child of filter.children) {
      const pruned = pruneFilter(child, isKnown);
      if (pruned !== null) kept.push(pruned);
    }
    if (kept.length === 0) return null;
    if (kept.length === 1 && filter.join === FilterJoin.and) {
      return kept[0] as Filter;
    }
    return new FilterGroup(kept, filter.join);
  }
  return filter;
}

/** Shorthand for a single condition. */
export function where(options: FilterConditionOptions): FilterCondition {
  return new FilterCondition(options);
}
