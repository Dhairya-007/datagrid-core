/**
 * Row grouping: tree construction, aggregates and flattening for display.
 *
 * @module
 */

import {
  AggregateResult,
  computeAggregates,
  type Aggregation,
} from './aggregate';
import { ColumnType, type GridColumn } from './column';
import { compareValues, isNullish, type CellValue } from './compare';
import { GridFormatError } from './errors';
import type { JsonMap } from './schema';
import { defaultCompareFor, NullsPosition, SortDirection } from './sort';

/** Buckets a raw value into a group key. */
export type GroupKeyOf = (value: CellValue) => CellValue;

/** Renders a group key as a header label. */
export type GroupLabelOf = (key: CellValue) => string;

/** Options for a {@link GroupSpec}. */
export interface GroupSpecOptions {
  /** Order of the group headers themselves. */
  direction?: SortDirection;

  /**
   * Where the blank group lands relative to the rest.
   *
   * Absolute, as it is for sorting: reversing the header order used to flip
   * the blank group to the top, which reads as "the empty ones matter most"
   * rather than as the same group seen the other way round.
   */
  nulls?: NullsPosition;

  /**
   * Buckets a raw value into a group key, for grouping by something coarser
   * than the stored value (a date's month, a number's decade).
   */
  keyOf?: GroupKeyOf;

  /** Renders a group key as a header label. */
  labelOf?: GroupLabelOf;

  /**
   * Label for the group of rows whose value is null.
   *
   * The engine owns exactly one piece of user-visible text, and this is it.
   * It is a field rather than a lookup because the engine must not grow a
   * dependency on anyone's localisations: an app that needs it translated
   * passes the translated string, from wherever its other strings come from.
   * {@link labelOf}, where given, overrides this as it does everything else.
   */
  blankLabel?: string;
}

/** One level of grouping. */
export class GroupSpec {
  readonly field: string;
  readonly direction: SortDirection;
  readonly nulls: NullsPosition;
  readonly keyOf: GroupKeyOf | null;
  readonly labelOf: GroupLabelOf | null;
  readonly blankLabel: string;

  constructor(field: string, options: GroupSpecOptions = {}) {
    this.field = field;
    this.direction = options.direction ?? SortDirection.ascending;
    this.nulls = options.nulls ?? NullsPosition.last;
    this.keyOf = options.keyOf ?? null;
    this.labelOf = options.labelOf ?? null;
    this.blankLabel = options.blankLabel ?? '(blank)';
    Object.freeze(this);
  }

  keyFor(value: CellValue): CellValue {
    return this.keyOf !== null ? this.keyOf(value) : value;
  }

  labelFor(key: CellValue): string {
    if (this.labelOf !== null) return this.labelOf(key);
    return isNullish(key) ? this.blankLabel : String(key);
  }

  /**
   * A stable string identifying which buckets this spec produces, for use as
   * a cache key.
   *
   * {@link keyOf} and {@link labelOf} are part of it: regrouping the same
   * field with a different bucketing function has to rebuild the groups, and
   * a key of `field:direction` alone silently served the previous buckets.
   *
   * Those two are compared by function identity, which is all JavaScript
   * offers. A closure written inline is a *new* function every time the
   * expression runs, so a spec rebuilt inline on every render misses this
   * cache every time. Hoist the bucketing function to a module-level
   * function, or keep it in a field, and the spec compares equal across
   * rebuilds.
   */
  get fingerprint(): string {
    return (
      `${this.field}:${this.direction}:${this.nulls}` +
      `:${callableId(this.keyOf)}:${callableId(this.labelOf)}:${this.blankLabel}`
    );
  }

  /**
   * JSON for a saved view.
   *
   * {@link keyOf} and {@link labelOf} are functions and cannot be serialised;
   * pass them again through {@link restore} when rebuilding a spec from
   * storage.
   */
  toJSON(): JsonMap {
    const json: JsonMap = { field: this.field, dir: this.direction };
    if (this.nulls !== NullsPosition.last) json['nulls'] = this.nulls;
    return json;
  }

  /**
   * Rebuilds a spec produced by {@link toJSON}.
   *
   * Throws a {@link GridFormatError} rather than a `TypeError` for a document
   * without a usable field, so one corrupt entry in a saved view can be
   * reported instead of crashing the restore.
   */
  static fromJSON(json: JsonMap): GroupSpec {
    const field = json['field'];
    if (typeof field !== 'string' || field.length === 0) {
      throw new GridFormatError('A group needs a non-empty "field"');
    }
    return new GroupSpec(field, {
      direction:
        json['dir'] === 'descending'
          ? SortDirection.descending
          : SortDirection.ascending,
      nulls:
        json['nulls'] === 'first' ? NullsPosition.first : NullsPosition.last,
    });
  }

  /**
   * This spec with the bucketing functions supplied, for restoring a saved
   * view whose JSON could not carry them.
   */
  restore(options: GroupSpecOptions = {}): GroupSpec {
    return new GroupSpec(this.field, {
      direction: this.direction,
      nulls: this.nulls,
      keyOf: options.keyOf ?? this.keyOf ?? undefined,
      labelOf: options.labelOf ?? this.labelOf ?? undefined,
      blankLabel: options.blankLabel ?? this.blankLabel,
    });
  }

  equals(other: unknown): boolean {
    return (
      other instanceof GroupSpec &&
      other.field === this.field &&
      other.direction === this.direction &&
      other.nulls === this.nulls &&
      other.keyOf === this.keyOf &&
      other.labelOf === this.labelOf &&
      other.blankLabel === this.blankLabel
    );
  }

  toString(): string {
    return `group by ${this.field}`;
  }
}

/** Shorthand for `new GroupSpec(field, options)`. */
export function groupBy(field: string, options?: GroupSpecOptions): GroupSpec {
  return new GroupSpec(field, options);
}

const callableIds = new WeakMap<object, number>();
let nextCallableId = 1;

function callableId(fn: object | null): number {
  if (fn === null) return 0;
  let id = callableIds.get(fn);
  if (id === undefined) {
    id = nextCallableId++;
    callableIds.set(fn, id);
  }
  return id;
}

/**
 * One level of a group's identity: which column, and which value.
 *
 * A group's full key path is what a server needs to answer "give me the rows
 * in this group": the path string identifies a group to the grid, but only
 * the field/value pairs translate into a filter.
 */
export class GroupKey {
  readonly field: string;
  readonly key: CellValue;

  constructor(field: string, key: CellValue) {
    this.field = field;
    this.key = key;
    Object.freeze(this);
  }

  equals(other: unknown): boolean {
    return (
      other instanceof GroupKey &&
      other.field === this.field &&
      sameKey(other.key, this.key)
    );
  }

  toString(): string {
    return `${this.field}=${String(this.key)}`;
  }
}

function sameKey(a: CellValue, b: CellValue): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** Options for a {@link GroupNode}. */
export interface GroupNodeOptions<T> {
  field: string;
  key: CellValue;
  label: string;
  depth: number;
  path: string;
  children?: readonly GroupNode<T>[];
  rows?: readonly T[];
  aggregates?: AggregateResult;
  keys?: readonly GroupKey[];
  declaredCount?: number | null;
  loaded?: boolean;
}

/** A node of the grouped row tree. */
export class GroupNode<T> {
  readonly field: string;
  readonly key: CellValue;
  readonly label: string;

  /** Zero-based nesting level. */
  readonly depth: number;

  /**
   * Stable identity of this group across rebuilds, built from the keys of
   * every ancestor. Used to remember expansion state.
   *
   * The local grouper builds these with {@link groupPathSegment}, which tags
   * the field and the key's type so that two different groups cannot share
   * one path. A source that groups server-side chooses its own paths and only
   * has to keep them stable and distinct; using {@link groupPathSegment}
   * makes them match what a local grid would produce.
   */
  readonly path: string;

  /** Child groups, when more grouping levels remain. */
  readonly children: readonly GroupNode<T>[];

  /** Leaf rows, when this is the innermost level. */
  readonly rows: readonly T[];

  readonly aggregates: AggregateResult;

  /**
   * This group's identity, from the outermost level inwards.
   *
   * What a source is given when the grid asks it for this group's contents.
   */
  readonly keys: readonly GroupKey[];

  /**
   * How many rows this group holds, when the grid cannot count them.
   *
   * A source that groups server-side returns a header and a count without the
   * rows, so the count has to be stated rather than derived. Null means
   * "count what is here".
   */
  readonly declaredCount: number | null;

  /**
   * Whether this group's contents are in hand.
   *
   * False for a header a source returned without its rows; the grid asks for
   * them when the group is opened. See `GridDataSource.fetchGroupChildren`.
   */
  readonly loaded: boolean;

  constructor(options: GroupNodeOptions<T>) {
    this.field = options.field;
    this.key = options.key;
    this.label = options.label;
    this.depth = options.depth;
    this.path = options.path;
    this.children = options.children ?? [];
    this.rows = options.rows ?? [];
    this.aggregates = options.aggregates ?? AggregateResult.empty;
    this.keys = options.keys ?? [];
    this.declaredCount = options.declaredCount ?? null;
    this.loaded = options.loaded ?? true;
  }

  get isLeafGroup(): boolean {
    return this.children.length === 0;
  }

  /** Number of data rows anywhere beneath this node. */
  get rowCount(): number {
    if (this.declaredCount !== null) return this.declaredCount;
    if (this.isLeafGroup) return this.rows.length;
    let sum = 0;
    for (const child of this.children) sum += child.rowCount;
    return sum;
  }

  /** This node with its contents filled in, as a lazy load provides them. */
  withContents(
    options: {
      children?: readonly GroupNode<T>[];
      rows?: readonly T[];
      aggregates?: AggregateResult;
    } = {},
  ): GroupNode<T> {
    return new GroupNode<T>({
      field: this.field,
      key: this.key,
      label: this.label,
      depth: this.depth,
      path: this.path,
      children: options.children ?? [],
      rows: options.rows ?? [],
      aggregates: options.aggregates ?? this.aggregates,
      keys: this.keys,
      declaredCount: this.declaredCount,
    });
  }

  /** This node with its children replaced, keeping everything else. */
  withChildren(children: readonly GroupNode<T>[]): GroupNode<T> {
    return new GroupNode<T>({
      field: this.field,
      key: this.key,
      label: this.label,
      depth: this.depth,
      path: this.path,
      children,
      rows: this.rows,
      aggregates: this.aggregates,
      keys: this.keys,
      declaredCount: this.declaredCount,
      loaded: this.loaded,
    });
  }

  /** Every data row beneath this node, in display order. */
  get allRows(): T[] {
    if (this.isLeafGroup) return [...this.rows];
    const out: T[] = [];
    for (const child of this.children) out.push(...child.allRows);
    return out;
  }

  /**
   * This node with `transform` applied to every row beneath it.
   *
   * Used to show an optimistic edit inside a grouped view: the pending value
   * has to be substituted before the tree is flattened, or the rows the user
   * sees are the ones the source last sent.
   */
  mapRows(transform: (row: T) => T): GroupNode<T> {
    return new GroupNode<T>({
      field: this.field,
      key: this.key,
      label: this.label,
      depth: this.depth,
      path: this.path,
      children: this.children.map((child) => child.mapRows(transform)),
      rows: this.rows.map(transform),
      aggregates: this.aggregates,
      keys: this.keys,
      declaredCount: this.declaredCount,
      loaded: this.loaded,
    });
  }
}

/** Options for {@link buildGroups}. */
export interface BuildGroupsOptions<T> {
  aggregations?: readonly Aggregation[];
  depth?: number;
  parentPath?: string;
  parentKeys?: readonly GroupKey[];
}

/**
 * Groups `rows` by `groups`, computing `aggregations` at every level.
 *
 * Rows arrive already sorted and filtered; grouping preserves their relative
 * order inside each bucket.
 */
export function buildGroups<T>(
  rows: readonly T[],
  groups: readonly GroupSpec[],
  columns: ReadonlyMap<string, GridColumn<T>>,
  options: BuildGroupsOptions<T> = {},
): GroupNode<T>[] {
  const {
    aggregations = [],
    depth = 0,
    parentPath = '',
    parentKeys = [],
  } = options;
  if (groups.length === 0 || rows.length === 0) return [];
  const spec = groups[0] as GroupSpec;
  const column = columns.get(spec.field);

  // Buckets are keyed by a tagged string rather than by the key itself: a
  // JavaScript Map compares object keys by identity, so grouping by a date
  // column put every row in a bucket of its own.
  const buckets = new Map<string, { key: CellValue; label: string; rows: T[] }>();
  for (const row of rows) {
    const raw = column === undefined ? null : column.value(row);
    const key = spec.keyFor(raw);
    const id = pathKeySegment(key);
    let bucket = buckets.get(id);
    if (bucket === undefined) {
      bucket = { key, label: spec.labelFor(key), rows: [] };
      buckets.set(id, bucket);
    }
    bucket.rows.push(row);
  }

  // Header order follows the column's own comparator, so that groups sort the
  // way the column sorts: a priority column ordering High/Medium/Low by
  // comparator used to produce headers in alphabetical order. A keyOf
  // bucketing function makes the keys something the column's comparator has
  // never seen, so that case keeps the generic order.
  const compare =
    spec.keyOf === null
      ? (column?.comparator ??
        defaultCompareFor(column?.type ?? ColumnType.text))
      : compareValues;
  const nullsFirst = spec.nulls === NullsPosition.first;
  const ordered = [...buckets.values()].sort((a, b) => {
    // Nulls are placed before the direction is applied, so the blank group
    // does not jump to the top when the headers are reversed.
    const aNull = isNullish(a.key);
    const bNull = isNullish(b.key);
    if (aNull || bNull) {
      if (aNull && bNull) return 0;
      return aNull === nullsFirst ? -1 : 1;
    }
    const cmp = compare(a.key, b.key);
    return spec.direction === SortDirection.ascending ? cmp : -cmp;
  });

  const rest = groups.slice(1);
  return ordered.map((bucket) => {
    const segment = groupPathSegment(spec.field, bucket.key);
    const path = parentPath.length === 0 ? segment : `${parentPath}\u001f${segment}`;
    const keys = [...parentKeys, new GroupKey(spec.field, bucket.key)];
    const children = buildGroups<T>(bucket.rows, rest, columns, {
      aggregations,
      depth: depth + 1,
      parentPath: path,
      parentKeys: keys,
    });
    return new GroupNode<T>({
      field: spec.field,
      key: bucket.key,
      label: bucket.label,
      depth,
      path,
      keys,
      children,
      rows: children.length === 0 ? bucket.rows : [],
      aggregates: computeAggregates<T>(bucket.rows, aggregations, (row, field) =>
        columns.get(field)?.value(row),
      ),
    });
  });
}

/**
 * One segment of a {@link GroupNode.path}.
 *
 * The field and the key's type are both part of it. A path of bare keys
 * collided in two ways that a user could reach from the UI: a `null` group
 * and a group whose value is the string `"null"` produced the same path, as
 * did `1` and `"1"`, so two different groups shared one expansion state and
 * one lazy-load cache entry; and regrouping by another field reused the
 * previous field's collapsed paths, so a freshly grouped column could open
 * with arbitrary groups already closed.
 */
export function groupPathSegment(field: string, key: CellValue): string {
  return `${escapePathPart(field)}=${pathKeySegment(key)}`;
}

/**
 * One key, encoded with its type so that two keys of different types cannot
 * produce the same path.
 *
 * Shared with tree paths, which have the same collision to avoid.
 */
export function pathKeySegment(key: CellValue): string {
  return `${tagOf(key)}:${escapePathPart(keyText(key))}`;
}

function tagOf(key: CellValue): string {
  if (isNullish(key)) return 'n';
  if (typeof key === 'string') return 's';
  if (typeof key === 'number') return Number.isInteger(key) ? 'i' : 'f';
  if (typeof key === 'boolean') return 'b';
  if (key instanceof Date) return 't';
  if (typeof key === 'bigint') return 'g';
  return 'o';
}

function keyText(key: CellValue): string {
  if (isNullish(key)) return '';
  if (key instanceof Date) return key.toISOString();
  return String(key);
}

/**
 * Escapes the separators a path is built from, so that a key containing one
 * cannot forge a segment boundary.
 */
function escapePathPart(text: string): string {
  return text
    .replace(/\u001e/g, '\u001e\u001e')
    .replace(/\u001f/g, '\u001e1')
    .replace(/=/g, '\u001e2');
}
