/**
 * Multi-column sorting.
 *
 * @module
 */

import { ColumnType, type GridColumn } from './column';
import {
  compareNumbers,
  compareStrings,
  compareValues,
  compareValuesCaseInsensitive,
  compareValuesNatural,
  foldText,
  isNullish,
  naturalSortKey,
  type CellValue,
  type Comparator,
} from './compare';
import { GridFormatError } from './errors';
import type { JsonMap } from './schema';

export const SortDirection = {
  ascending: 'ascending',
  descending: 'descending',
} as const;
export type SortDirection =
  (typeof SortDirection)[keyof typeof SortDirection];

/** Where nulls land relative to real values. */
export const NullsPosition = {
  first: 'first',
  last: 'last',
} as const;
export type NullsPosition =
  (typeof NullsPosition)[keyof typeof NullsPosition];

/** Options for a {@link SortSpec}. */
export interface SortSpecOptions {
  direction?: SortDirection;
  nulls?: NullsPosition;
}

/** One level of an ordering. */
export class SortSpec {
  readonly field: string;
  readonly direction: SortDirection;
  readonly nulls: NullsPosition;

  constructor(field: string, options: SortSpecOptions = {}) {
    this.field = field;
    this.direction = options.direction ?? SortDirection.ascending;
    this.nulls = options.nulls ?? NullsPosition.last;
    Object.freeze(this);
  }

  get isAscending(): boolean {
    return this.direction === SortDirection.ascending;
  }

  /** The same field sorted the other way. */
  get reversed(): SortSpec {
    return new SortSpec(this.field, {
      direction: this.isAscending
        ? SortDirection.descending
        : SortDirection.ascending,
      nulls: this.nulls,
    });
  }

  /**
   * A stable string identifying the ordering this spec asks for, for use as a
   * cache key.
   *
   * Every field that changes the result appears in it. A cache key assembled
   * by its caller is a key that forgets a field the next time one is added; a
   * spec states its own identity instead.
   */
  get fingerprint(): string {
    return `${this.field}:${this.direction}:${this.nulls}`;
  }

  toJSON(): JsonMap {
    const json: JsonMap = { field: this.field, dir: this.direction };
    if (this.nulls !== NullsPosition.last) json['nulls'] = this.nulls;
    return json;
  }

  /**
   * Rebuilds a spec produced by {@link toJSON}.
   *
   * Throws a {@link GridFormatError} — not a `TypeError` — when `field` is
   * missing or is not a string, so that a caller restoring a saved view can
   * report a corrupt document instead of crashing on a null check.
   */
  static fromJSON(json: JsonMap): SortSpec {
    const field = json['field'];
    if (typeof field !== 'string' || field.length === 0) {
      throw new GridFormatError('A sort needs a non-empty "field"');
    }
    return new SortSpec(field, {
      direction:
        json['dir'] === 'descending'
          ? SortDirection.descending
          : SortDirection.ascending,
      nulls:
        json['nulls'] === 'first' ? NullsPosition.first : NullsPosition.last,
    });
  }

  equals(other: unknown): boolean {
    return (
      other instanceof SortSpec &&
      other.field === this.field &&
      other.direction === this.direction &&
      other.nulls === this.nulls
    );
  }

  toString(): string {
    return `${this.field} ${this.isAscending ? 'asc' : 'desc'}`;
  }
}

/** Shorthand for `new SortSpec(field, options)`. */
export function sortBy(field: string, options?: SortSpecOptions): SortSpec {
  return new SortSpec(field, options);
}

/**
 * Builds a comparator for `T` that applies `sorts` in order, using each
 * column's own `GridColumn.comparator` where one is defined.
 *
 * The returned comparator is stable with respect to the input order: rows the
 * sort cannot distinguish keep their relative positions, because
 * {@link sortRows} sorts an index-decorated copy.
 */
export function buildComparator<T>(
  sorts: readonly SortSpec[],
  columns: ReadonlyMap<string, GridColumn<T>>,
): Comparator<T> {
  return (a: T, b: T): number => {
    for (const sort of sorts) {
      const column = columns.get(sort.field);
      if (column === undefined) continue;
      const va = column.sortValue(a);
      const vb = column.sortValue(b);
      if (isNullish(va) || isNullish(vb)) {
        if (isNullish(va) && isNullish(vb)) continue;
        const nullFirst = sort.nulls === NullsPosition.first;
        // Null placement is absolute: it does not flip with the direction.
        return isNullish(va) === nullFirst ? -1 : 1;
      }
      const cmp =
        column.comparator !== null
          ? column.comparator(va, vb)
          : defaultCompareFor(column.type)(va, vb);
      if (cmp !== 0) return sort.isAscending ? cmp : -cmp;
    }
    return 0;
  };
}

/**
 * The comparison a column of `type` orders by when it declares no
 * `GridColumn.comparator` of its own.
 *
 * Text folds case and accents away, with the exact comparison as a tiebreak,
 * because a user sorting a name column does not expect `Cherry` above
 * `apple`: code-unit order puts every capital first and every accent after
 * `z`. Every other type keeps the natural order of its values.
 */
export function defaultCompareFor(type: ColumnType): Comparator<CellValue> {
  return type === ColumnType.text ? compareValuesCaseInsensitive : compareValues;
}

/**
 * Returns a new array of `rows` ordered by `sorts`, preserving the original
 * order of rows that compare equal.
 */
export function sortRows<T>(
  rows: readonly T[],
  sorts: readonly SortSpec[],
  columns: ReadonlyMap<string, GridColumn<T>>,
): T[] {
  const order = sortOrder(rows, sorts, columns);
  const out = new Array<T>(order.length);
  for (let i = 0; i < order.length; i++) out[i] = rows[order[i] as number] as T;
  return out;
}

const KIND_OTHER = 0;
const KIND_NUM = 1;
const KIND_STRING = 2;

/**
 * The permutation {@link sortRows} applies: positions in `rows`, in sorted
 * order.
 *
 * Exposed because a caller that keeps a sorted list wants to know where each
 * row came from — a data source maintaining an ordered result alongside the
 * source positions it was built from, so that an edit can be patched into it
 * instead of re-sorting everything.
 */
export function sortOrder<T>(
  rows: readonly T[],
  sorts: readonly SortSpec[],
  columns: ReadonlyMap<string, GridColumn<T>>,
): number[] {
  if (sorts.length === 0 || rows.length < 2) {
    return identity(rows.length);
  }

  // Read every sort key once per row rather than on every comparison. A
  // comparison sort makes O(n log n) comparisons, so calling the accessors
  // inside the comparator reads each row's value ~log n times — about 16x
  // over at 50k rows, and more when the accessor computes something.
  const levels = sorts.filter((sort) => columns.has(sort.field));
  if (levels.length === 0) return identity(rows.length);

  const count = rows.length;
  const depth = levels.length;
  const keys = new Array<CellValue>(count * depth);
  const levelColumns = levels.map(
    (level) => columns.get(level.field) as GridColumn<T>,
  );
  for (let level = 0; level < depth; level++) {
    const column = levelColumns[level] as GridColumn<T>;
    const base = level * count;
    for (let i = 0; i < count; i++) {
      keys[base + i] = column.sortValue(rows[i] as T);
    }
  }

  const comparators = levelColumns.map((column) => column.comparator);
  const ascending = levels.map((level) => level.isAscending);
  const nullsFirst = levels.map(
    (level) => level.nulls === NullsPosition.first,
  );

  // Two orderings cost more per comparison than they need to, and both can be
  // answered by a key computed once per row: a case- and accent-folded text
  // order, and a natural one. The raw key stays for the exact tiebreak that
  // keeps the order total.
  const folded = new Array<string[] | null>(depth).fill(null);
  const comparatorForLevel: (Comparator<CellValue> | null)[] = [...comparators];
  // Levels whose key turned out to equal the value itself, so the plain
  // string comparison already gives the order the key would have.
  const plainString = new Array<boolean>(depth).fill(false);
  for (let level = 0; level < depth; level++) {
    const column = levelColumns[level] as GridColumn<T>;
    const comparator = comparators[level] ?? null;
    const natural = comparator === compareValuesNatural;
    if (comparator !== null && !natural) continue;
    if (!natural && column.type !== ColumnType.text) continue;
    const base = level * count;
    if (keyKind(keys, base, count) !== KIND_STRING) continue;
    const keysForLevel = new Array<string>(count).fill('');
    // A column that is already lower case and unaccented folds to itself, and
    // then the folded comparison is pure overhead: two string compares where
    // one would do, on a column where ties are common. Detecting that keeps
    // the folded default as cheap as the code-unit order it replaced.
    let changed = false;
    for (let i = 0; i < count; i++) {
      const value = keys[base + i];
      if (isNullish(value)) continue;
      const raw = value as string;
      const key = natural ? naturalSortKey(raw) : foldText(raw);
      keysForLevel[i] = key;
      if (!changed && key !== raw) changed = true;
    }
    // The key answers what the comparator was for.
    if (natural) comparatorForLevel[level] = null;
    if (changed) {
      folded[level] = keysForLevel;
    } else {
      // Every key came back identical to its value — a column that is already
      // lower case and unaccented, or has no digits to read as numbers — so
      // comparing the values directly is the same order for a fraction of the
      // work. This is what keeps a natural sort over digit-free text, and the
      // folded default over ordinary data, as cheap as the plain comparison.
      plainString[level] = true;
    }
  }

  const order = identity(count);

  // One sort column is the overwhelmingly common case — it is what a header
  // click produces — so it gets a comparison with no type tests and no
  // closure indirection in the inner loop.
  if (depth === 1 && comparatorForLevel[0] === null) {
    const ascendingOnly = ascending[0] as boolean;
    const nullsFirstOnly = nullsFirst[0] as boolean;
    const kind = keyKind(keys, 0, count);

    const nullOrder = (va: CellValue, vb: CellValue): number | null => {
      const aNull = isNullish(va);
      const bNull = isNullish(vb);
      if (aNull && bNull) return 0;
      if (aNull || bNull) return aNull === nullsFirstOnly ? -1 : 1;
      return null;
    };

    const foldedOnly = folded[0];
    if (foldedOnly) {
      order.sort((a, b) => {
        const va = keys[a];
        const vb = keys[b];
        const nulls = nullOrder(va, vb);
        if (nulls !== null) return nulls === 0 ? a - b : nulls;
        let cmp = compareStrings(foldedOnly[a] as string, foldedOnly[b] as string);
        if (cmp === 0) cmp = compareStrings(va as string, vb as string);
        if (cmp !== 0) return ascendingOnly ? cmp : -cmp;
        return a - b;
      });
      return order;
    }
    if (kind === KIND_NUM) {
      order.sort((a, b) => {
        const va = keys[a];
        const vb = keys[b];
        const nulls = nullOrder(va, vb);
        if (nulls !== null) return nulls === 0 ? a - b : nulls;
        const cmp = compareNumbers(va as number, vb as number);
        if (cmp !== 0) return ascendingOnly ? cmp : -cmp;
        return a - b;
      });
      return order;
    }
    if (kind === KIND_STRING) {
      order.sort((a, b) => {
        const va = keys[a];
        const vb = keys[b];
        const nulls = nullOrder(va, vb);
        if (nulls !== null) return nulls === 0 ? a - b : nulls;
        const cmp = compareStrings(va as string, vb as string);
        if (cmp !== 0) return ascendingOnly ? cmp : -cmp;
        return a - b;
      });
      return order;
    }
  }

  // Whether a level needs the folding comparison at comparison time, which is
  // only so when its values are text that folding changes and no key was
  // precomputed for it.
  const foldsAtCompare = levelColumns.map(
    (column, level) =>
      comparatorForLevel[level] === null &&
      !plainString[level] &&
      folded[level] === null &&
      column.type === ColumnType.text,
  );

  order.sort((a, b) => {
    for (let level = 0; level < depth; level++) {
      const base = level * count;
      const va = keys[base + a];
      const vb = keys[base + b];
      const aNull = isNullish(va);
      const bNull = isNullish(vb);
      if (aNull || bNull) {
        if (aNull && bNull) continue;
        // Null placement is absolute: it does not flip with the direction.
        return aNull === nullsFirst[level] ? -1 : 1;
      }
      const foldedLevel = folded[level];
      let cmp = 0;
      // Explicit branches rather than a comparator read out of a list: an
      // indirect call per comparison per level cost half as much again as the
      // direct call over 50k rows and three levels.
      if (foldedLevel) {
        cmp = compareStrings(foldedLevel[a] as string, foldedLevel[b] as string);
        if (cmp === 0) cmp = compareStrings(va as string, vb as string);
      } else {
        const comparator = comparatorForLevel[level];
        if (comparator) {
          cmp = comparator(va, vb);
        } else if (foldsAtCompare[level]) {
          cmp = compareValuesCaseInsensitive(va, vb);
        } else {
          cmp = compareValues(va, vb);
        }
      }
      if (cmp !== 0) return ascending[level] ? cmp : -cmp;
    }
    // Fall back to the input position, which keeps the sort stable.
    return a - b;
  });

  return order;
}

function identity(count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = i;
  return out;
}

/**
 * Whether every non-null key in a level is a number, or every one a string.
 *
 * Settling the type once lets {@link sortOrder} use a direct comparison for
 * the single-column case instead of `compareValues`, which re-tests the
 * operand types on every one of the O(n log n) comparisons.
 */
function keyKind(keys: readonly CellValue[], base: number, count: number): number {
  let allNum = true;
  let allString = true;
  for (let i = 0; i < count; i++) {
    const value = keys[base + i];
    if (isNullish(value)) continue;
    if (typeof value !== 'number') allNum = false;
    if (typeof value !== 'string') allString = false;
    if (!allNum && !allString) return KIND_OTHER;
  }
  if (allNum) return KIND_NUM;
  if (allString) return KIND_STRING;
  return KIND_OTHER;
}

/**
 * Applies the three-state header-click cycle
 * (unsorted -> ascending -> descending -> unsorted) to `sorts`.
 *
 * With `additive` false the clicked column replaces the whole ordering, which
 * is the plain-click behaviour; with it true the column is appended, which is
 * the ctrl/cmd-click behaviour for building a multi-level sort.
 */
export function cycleSort(
  sorts: readonly SortSpec[],
  field: string,
  options: { additive?: boolean } = {},
): SortSpec[] {
  const additive = options.additive ?? false;
  const existing = sorts.find((s) => s.field === field);
  if (!additive) {
    if (existing === undefined) return [new SortSpec(field)];
    return existing.isAscending ? [existing.reversed] : [];
  }
  const next = [...sorts];
  if (existing === undefined) {
    next.push(new SortSpec(field));
    return next;
  }
  const index = next.findIndex((s) => s.field === field);
  if (existing.isAscending) {
    next[index] = existing.reversed;
  } else {
    next.splice(index, 1);
  }
  return next;
}
