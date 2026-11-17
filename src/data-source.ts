/**
 * Data sources: the seam between the grid and wherever rows come from.
 *
 * @module
 */

import {
  AggregateResult,
  computeAggregates,
  type Aggregation,
} from './aggregate';
import { ColumnType, type GridColumn } from './column';
import { compareValues, foldText, type CellValue } from './compare';
import { ColumnStats, computeColumnStats } from './decoration';
import { GridStateError } from './errors';
import {
  Filter,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  pruneFilter,
  type CompiledFilter,
} from './filter';
import { buildGroups, type GroupNode } from './group';
import { GridChangeNotifier } from './notifier';
import { GridQuery, GridResult } from './query';
import { buildComparator, sortOrder } from './sort';
import type { Comparator } from './compare';

/**
 * What a data source can do, as the source itself declares it.
 *
 * The grid used to ask `source instanceof InMemoryDataSource` and treat
 * everything else as a remote source that could do nothing: no editing, no
 * statistics, no distinct values, no cancellation. That made "local or
 * remote" a branch in the engine rather than a property of the source, and
 * every feature worked fully only on an array in memory.
 *
 * A source answers for itself instead, and an adapter can read this to stop
 * offering what the source cannot honour — a checkbox filter list for a
 * source with no distinct values, an editor for one that cannot write.
 */
export class SourceCapabilities {
  /**
   * Rows are resolved locally, so the grid need not re-query to sort, filter
   * or page.
   */
  readonly isLocal: boolean;

  /** The source can answer inside the frame, through `fetchSync`. */
  readonly isSynchronous: boolean;

  /** Edits can be written back. */
  readonly canWrite: boolean;

  /**
   * Column ranges are available, so conditional formatting has something to
   * draw against.
   */
  readonly providesStats: boolean;

  /** A column's distinct values are available, for a checkbox filter list. */
  readonly providesDistinctValues: boolean;

  /** Group headers and counts can be fetched without their rows. */
  readonly supportsLazyGroups: boolean;

  /** An in-flight fetch is actually abandoned when the grid cancels it. */
  readonly supportsCancellation: boolean;

  /** The source can be asked for another slice, for infinite scrolling. */
  readonly supportsLoadMore: boolean;

  constructor(options: {
    isLocal: boolean;
    isSynchronous: boolean;
    canWrite: boolean;
    providesStats: boolean;
    providesDistinctValues: boolean;
    supportsLazyGroups: boolean;
    supportsCancellation: boolean;
    supportsLoadMore?: boolean;
  }) {
    this.isLocal = options.isLocal;
    this.isSynchronous = options.isSynchronous;
    this.canWrite = options.canWrite;
    this.providesStats = options.providesStats;
    this.providesDistinctValues = options.providesDistinctValues;
    this.supportsLazyGroups = options.supportsLazyGroups;
    this.supportsCancellation = options.supportsCancellation;
    this.supportsLoadMore = options.supportsLoadMore ?? true;
    Object.freeze(this);
  }

  toString(): string {
    const parts = [
      this.isLocal ? 'local' : null,
      this.isSynchronous ? 'synchronous' : null,
      this.canWrite ? 'write' : null,
      this.providesStats ? 'stats' : null,
      this.providesDistinctValues ? 'distinct' : null,
      this.supportsLazyGroups ? 'lazyGroups' : null,
      this.supportsCancellation ? 'cancellation' : null,
      this.supportsLoadMore ? 'loadMore' : null,
    ].filter((part): part is string => part !== null);
    return `SourceCapabilities(${parts.join(', ')})`;
  }
}

/** What one group holds, fetched when the user opened it. */
export class GroupChildren<T> {
  /** Leaf rows, when this was the innermost grouping level. */
  readonly rows: readonly T[];

  /**
   * Child groups, when another level remains. They may themselves be
   * unloaded headers, so a deep grouping stays lazy all the way down.
   */
  readonly groups: readonly GroupNode<T>[];

  /**
   * Aggregates for the group, if the source computed them now rather than
   * with the header. Null leaves whatever the header carried.
   */
  readonly aggregates: AggregateResult | null;

  constructor(
    options: {
      rows?: readonly T[];
      groups?: readonly GroupNode<T>[];
      aggregates?: AggregateResult | null;
    } = {},
  ) {
    this.rows = options.rows ?? [];
    this.groups = options.groups ?? [];
    this.aggregates = options.aggregates ?? null;
  }

  get isEmpty(): boolean {
    return this.rows.length === 0 && this.groups.length === 0;
  }
}

/** One row to be written, as it was and as it should become. */
export class RowUpdate<T> {
  /** The row as the source currently holds it, so it can be found again. */
  readonly original: T;

  /** The row to store in its place. */
  readonly updated: T;

  constructor(original: T, updated: T) {
    this.original = original;
    this.updated = updated;
    Object.freeze(this);
  }

  toString(): string {
    return `RowUpdate(${String(this.original)} -> ${String(this.updated)})`;
  }
}

/**
 * The distinct values of one column, and whether there are more.
 *
 * A plain array could not say: the list was read one value over the limit so
 * that a caller could tell, and then cut back to the limit before it was
 * returned, which threw away the only evidence. A checkbox filter list that
 * cannot tell a complete list from a truncated one shows the user a set of
 * values and lets them believe it is all of them.
 */
export class DistinctValues {
  /** Nothing to offer, from a source that cannot answer. */
  static readonly none: DistinctValues = new DistinctValues([]);

  /** The values, ascending. A truncated list holds the smallest ones. */
  readonly values: readonly CellValue[];

  /** Whether the column holds more values than the limit allowed. */
  readonly truncated: boolean;

  constructor(values: readonly CellValue[], truncated = false) {
    this.values = values;
    this.truncated = truncated;
    Object.freeze(this);
  }

  get isEmpty(): boolean {
    return this.values.length === 0;
  }

  get isNotEmpty(): boolean {
    return this.values.length > 0;
  }

  get length(): number {
    return this.values.length;
  }

  toString(): string {
    return `DistinctValues(${this.values.length}${this.truncated ? '+' : ''})`;
  }
}

/**
 * Supplies rows for a {@link GridQuery}.
 *
 * Extend this to put a grid in front of anything: an array in memory, a
 * SQLite table, a REST endpoint, a stream. The grid only ever asks for the
 * page it is about to show, so a remote source never has to materialise the
 * whole table.
 */
export abstract class GridDataSource<T> extends GridChangeNotifier {
  private columnMap: ReadonlyMap<string, GridColumn<T>> = new Map();
  private revisionValue = 0;
  private columnTypesCache: ReadonlyMap<string, ColumnType> | null = null;

  /**
   * Columns, so the source can read and compare values.
   *
   * Set by the controller before the first fetch. Assigning bumps
   * {@link revision}, because a new formatter or accessor invalidates
   * anything derived from the old ones.
   */
  get columns(): ReadonlyMap<string, GridColumn<T>> {
    return this.columnMap;
  }

  set columns(value: ReadonlyMap<string, GridColumn<T>>) {
    this.columnMap = value;
    this.columnTypesCache = null;
    this.revisionValue++;
  }

  /**
   * Each column's declared type, for compiling a filter against it.
   *
   * Built once per set of columns rather than per filter pass: it is what
   * tells `Filter.compile` that `'50'` typed into this column means the
   * number 50.
   */
  get columnTypes(): ReadonlyMap<string, ColumnType> {
    if (this.columnTypesCache === null) {
      const types = new Map<string, ColumnType>();
      for (const column of this.columnMap.values()) {
        types.set(column.field, column.type);
      }
      this.columnTypesCache = types;
    }
    return this.columnTypesCache;
  }

  /**
   * Increments whenever the rows or columns change.
   *
   * Anything derived from the data — a filtered list, a search index — is
   * only valid for one revision.
   */
  get revision(): number {
    return this.revisionValue;
  }

  /** Marks derived state stale. Call from any mutator. */
  bumpRevision(): void {
    this.revisionValue++;
  }

  /**
   * Whether rows are resolved locally. Remote sources return false, which
   * tells the grid to re-query on every sort, filter or page change.
   */
  get isLocal(): boolean {
    return false;
  }

  /**
   * Whether this source can answer inside the current frame, through
   * {@link fetchSync}.
   *
   * The grid takes that path when it can, which is what spares a local grid a
   * frame of emptiness on its very first render. It used to ask
   * `source instanceof InMemoryDataSource`, which meant that any other
   * synchronous source — a decorator, a test double, a SQLite table read on
   * the same thread — was treated as remote however fast it was. A source
   * says what it can do; the grid does not guess from its type.
   */
  get isSynchronous(): boolean {
    return false;
  }

  /**
   * Resolves `query` now, without awaiting.
   *
   * Only called when {@link isSynchronous} is true, and throws otherwise: a
   * source that cannot answer immediately has nothing to return here, and
   * returning an empty result would be a lie the grid would render.
   */
  fetchSync(_query: GridQuery): GridResult<T> {
    throw new GridStateError(
      `${this.constructor.name} cannot answer synchronously. Override fetchSync ` +
        'and isSynchronous, or leave isSynchronous false and implement fetch.',
    );
  }

  /** Resolves `query`. */
  abstract fetch(query: GridQuery): Promise<GridResult<T>>;

  /**
   * Whether this source can write an edited row back.
   *
   * False by default, because a source that only answers {@link fetch} has
   * nowhere to put a write. The grid asks before it opens an editor, so a
   * read-only source does not offer editing it cannot honour.
   */
  get canCommit(): boolean {
    return false;
  }

  /**
   * Writes `updated` back in place of `original`.
   *
   * Returns the row as the source now holds it, which need not be `updated`:
   * a server may normalise a value or fill in a timestamp, and the grid shows
   * what comes back. Rejecting the promise rejects the edit, and the grid
   * rolls its optimistic update back and reports the error.
   *
   * Only called when {@link canCommit} is true.
   */
  commit(_original: T, _updated: T): Promise<T> {
    throw new GridStateError(
      `${this.constructor.name} cannot write rows back. Override commit and ` +
        'canCommit to support editing.',
    );
  }

  /**
   * Writes several rows as one change, returning them in the order given.
   *
   * A paste into a range is one user action, so it should be one write: a
   * source that can send a batch in a single request or a single transaction
   * overrides this, and the default walks {@link commit} for a source that
   * cannot. Either way the grid refreshes once.
   */
  async commitAll(writes: readonly RowUpdate<T>[]): Promise<T[]> {
    const out: T[] = [];
    for (const write of writes) {
      out.push(await this.commit(write.original, write.updated));
    }
    return out;
  }

  /**
   * Whether {@link statsFor} answers with real ranges rather than
   * `ColumnStats.empty`.
   *
   * A conditional formatting rule has nothing to draw against without them,
   * so an adapter reads this to tell "no rule applies" from "this source
   * cannot measure the column".
   */
  get providesStats(): boolean {
    return false;
  }

  /** Whether {@link distinctValuesFor} answers with real values. */
  get providesDistinctValues(): boolean {
    return false;
  }

  /**
   * Whether rows exist beyond the last result, for a grid that loads more as
   * the user scrolls rather than paging.
   *
   * A source that cannot know — a REST endpoint that reports no total —
   * should return true until a fetch comes back short, which is what the
   * grid's own book-keeping does for {@link InMemoryDataSource}.
   */
  get hasMore(): boolean {
    return false;
  }

  /**
   * Whether this source honours `GridQuery.signal` by abandoning the work.
   *
   * False by default, because ignoring the signal is a valid implementation
   * and claiming otherwise would have an adapter promise the user something
   * that does not happen.
   */
  get supportsCancellation(): boolean {
    return false;
  }

  /**
   * Whether this source can extend itself a slice at a time.
   *
   * Distinct from {@link hasMore}, which is about whether there is anything
   * left: this is about whether asking is meaningful at all. A source answers
   * a load-more request through {@link fetch} with an offset, so the default
   * is to support it as soon as rows are paged.
   */
  get supportsLoadMore(): boolean {
    return true;
  }

  /** Everything this source can do, in one value. */
  get capabilities(): SourceCapabilities {
    return new SourceCapabilities({
      isLocal: this.isLocal,
      isSynchronous: this.isSynchronous,
      canWrite: this.canCommit,
      providesStats: this.providesStats,
      providesDistinctValues: this.providesDistinctValues,
      supportsLazyGroups: this.supportsLazyGroups,
      supportsCancellation: this.supportsCancellation,
      supportsLoadMore: this.supportsLoadMore,
    });
  }

  /**
   * Range of the values currently shown in `field`, for conditional
   * formatting. Sources that cannot answer cheaply return `ColumnStats.empty`,
   * which leaves rules inert rather than wrong.
   */
  statsFor(_field: string): ColumnStats {
    return ColumnStats.empty;
  }

  /**
   * Whether this source can answer a `GridQuery.lazyGroups` query, returning
   * group headers with counts and the rows of a group only when asked.
   *
   * This is what makes grouping usable over a large backend: without it,
   * grouping has to pull every matching row so the grid can count the groups
   * itself.
   */
  get supportsLazyGroups(): boolean {
    return false;
  }

  /**
   * Resolves the contents of one group.
   *
   * `node` carries the group's `GroupNode.keys`, which is what translates
   * into a filter, and `query` is the query the headers came from, so the
   * source can apply the same filters, search and ordering within the group.
   *
   * Return child groups when another grouping level remains, or rows when
   * this is the innermost one. Only called when {@link supportsLazyGroups} is
   * true.
   */
  fetchGroupChildren(
    _query: GridQuery,
    _node: GroupNode<T>,
  ): Promise<GroupChildren<T>> {
    throw new GridStateError(
      `${this.constructor.name} cannot resolve a group lazily. Override ` +
        'fetchGroupChildren and supportsLazyGroups to support it.',
    );
  }

  /**
   * The distinct values of `field` for a checkbox filter list.
   *
   * Returns `DistinctValues.none` when the source cannot answer cheaply,
   * which an adapter reads as "offer a text filter instead" rather than as
   * "this column is empty". `limit` caps the list: a value picker over a
   * high-cardinality column is unusable anyway, and a source should not
   * materialise a million strings to be told so — `DistinctValues.truncated`
   * says whether it had to stop.
   *
   * The values are computed over the rows that match every *other* filter,
   * not over the rows that match this column's own: a list narrowed by the
   * column's own filter offers only the values already picked, so a user who
   * chooses "Input" can never add "Display" to the selection.
   */
  distinctValuesFor(_field: string, _limit = 500): DistinctValues {
    return DistinctValues.none;
  }

  /**
   * Every row this source holds, or null when it cannot say.
   *
   * A source that holds its rows locally returns them; one that pages a
   * backend returns null, because it has no list to return. The grid uses
   * this to find a row it has to write to but is not showing — an undo over a
   * row on another page, inside a closed group, or filtered out of view —
   * which it previously looked for among the visible rows alone and therefore
   * silently skipped.
   */
  get localRows(): readonly T[] | null {
    return null;
  }

  /** Tells the grid to re-run its current query, e.g. after a write. */
  invalidate(): void {
    this.notifyListeners();
  }
}

/**
 * Serves rows from an array already in memory.
 *
 * Runs the whole pipeline locally — filter, search, sort, group, aggregate,
 * page — and is the source used by the vast majority of grids.
 *
 * Up to around 20k rows every operation stays inside a 16.7 ms frame on a
 * desktop machine. Between there and 100k, sorting and a whole-table search
 * cross it. Past 100k, prefer a source that pushes the work into a database.
 */
export class InMemoryDataSource<T> extends GridDataSource<T> {
  private data: T[];

  constructor(rows: readonly T[] = []) {
    super();
    this.data = [...rows];
  }

  /** The current, unprocessed rows. */
  get rows(): readonly T[] {
    return this.data;
  }

  override get localRows(): readonly T[] {
    return this.data;
  }

  get length(): number {
    return this.data.length;
  }

  override get isLocal(): boolean {
    return true;
  }

  override get isSynchronous(): boolean {
    return true;
  }

  override get providesStats(): boolean {
    return true;
  }

  override get providesDistinctValues(): boolean {
    return true;
  }

  /** Replaces every row and refreshes the grid. */
  setRows(rows: Iterable<T>): void {
    this.data = [...rows];
    this.bumpRevision();
    this.notifyListeners();
  }

  add(row: T): void {
    this.data.push(row);
    this.bumpRevision();
    this.notifyListeners();
  }

  addAll(rows: Iterable<T>): void {
    this.data.push(...rows);
    this.bumpRevision();
    this.notifyListeners();
  }

  insert(index: number, row: T): void {
    this.data.splice(index, 0, row);
    this.bumpRevision();
    this.notifyListeners();
  }

  remove(row: T): boolean {
    const index = this.data.indexOf(row);
    if (index < 0) return false;
    this.data.splice(index, 1);
    this.bumpRevision();
    this.notifyListeners();
    return true;
  }

  removeAt(index: number): void {
    if (index < 0 || index >= this.data.length) {
      throw new RangeError(
        `Row index ${index} is outside 0..${this.data.length - 1}.`,
      );
    }
    this.data.splice(index, 1);
    this.bumpRevision();
    this.notifyListeners();
  }

  removeWhere(test: (row: T) => boolean): void {
    const before = this.data.length;
    this.data = this.data.filter((row) => !test(row));
    if (this.data.length !== before) {
      this.bumpRevision();
      this.notifyListeners();
    }
  }

  clear(): void {
    if (this.data.length === 0) return;
    this.data = [];
    this.bumpRevision();
    this.notifyListeners();
  }

  /**
   * Replaces the row at `index`, as an edit commit does.
   *
   * The pipeline is patched rather than thrown away where that is possible:
   * see {@link patchRow}. One edited cell used to re-index, re-filter and
   * re-sort the whole table — tens of milliseconds at 50k rows with a search
   * and a sort active, for a change to one value.
   */
  replaceAt(index: number, row: T): void {
    const previous = this.data[index] as T;
    this.data[index] = row;
    this.bumpRevision();
    this.patchRow(index, previous, row);
    this.notifyListeners();
  }

  override get canCommit(): boolean {
    return true;
  }

  override async commit(original: T, updated: T): Promise<T> {
    const index = this.indexOfRow(original);
    if (index < 0) {
      throw new GridStateError('The edited row is no longer in the source.');
    }
    // Writes through the array, which notifies and re-runs the query, so an
    // edit that changes the sort key moves its row immediately.
    this.replaceAt(index, updated);
    return updated;
  }

  /** The position of `row`. */
  indexOfRow(row: T): number {
    return this.data.indexOf(row);
  }

  /**
   * Replaces every row in `writes`, notifying once.
   *
   * A paste of 200 cells across 20 rows would otherwise re-run the query 20
   * times, and each of those re-runs re-sorts.
   */
  override async commitAll(writes: readonly RowUpdate<T>[]): Promise<T[]> {
    if (writes.length === 0) return [];
    // One index for the whole batch: locating each row with a scan made a
    // paste of n rows O(n x rows).
    const positions = new Map<T, number>();
    for (let i = this.data.length - 1; i >= 0; i--) {
      positions.set(this.data[i] as T, i);
    }
    const indices: number[] = [];
    const taken = new Set<number>();
    for (const write of writes) {
      let index = positions.get(write.original) ?? -1;
      if (index < 0 || taken.has(index)) {
        // Take the first matching row no other write in this batch has
        // claimed, so two equal rows edited together still land in two
        // places.
        index = -1;
        for (let i = 0; i < this.data.length; i++) {
          if (!taken.has(i) && this.data[i] === write.original) {
            index = i;
            break;
          }
        }
      }
      if (index < 0) {
        throw new GridStateError('An edited row is no longer in the source.');
      }
      taken.add(index);
      indices.push(index);
    }
    for (let i = 0; i < writes.length; i++) {
      const at = indices[i] as number;
      const write = writes[i] as RowUpdate<T>;
      const previous = this.data[at] as T;
      this.data[at] = write.updated;
      // Patched row by row, as a single edit is: a paste of twenty rows into
      // a 50k-row grid costs twenty splices rather than a re-index, a
      // re-filter and a re-sort. One notification for the batch either way.
      this.bumpRevision();
      this.patchRow(at, previous, write.updated);
    }
    this.notifyListeners();
    return writes.map((write) => write.updated);
  }

  override async fetch(query: GridQuery): Promise<GridResult<T>> {
    return this.fetchSync(query);
  }

  /**
   * Synchronous {@link fetch}, for adapters that can render in the same
   * frame.
   *
   * The pipeline is memoised in three stages — matched, then ordered, then
   * grouped — each keyed by the part of the query it depends on and by
   * `revision`. That is what makes the common interactions cheap: turning a
   * page only re-slices, and reversing a sort does not re-filter.
   */
  override fetchSync(query: GridQuery): GridResult<T> {
    this.lastQuery = query;
    const total = this.data.length;
    const matched = this.matchedFor(query);
    const ordered = this.orderedFor(query, matched);
    const aggregates = this.aggregatesFor(query, ordered);
    const sourceIndexOf = (row: T): number => this.sourceIndexOf(row);

    if (query.isGrouped) {
      // Grouping needs the full matched set: a group header must count every
      // row in its group, not just the ones on the current page.
      return new GridResult<T>({
        rows: [],
        groups: this.groupsFor(query, ordered),
        totalCount: total,
        filteredCount: matched.length,
        aggregates,
        sourceIndexOf,
      });
    }

    if (query.offset > 0 || query.limit !== null) {
      const start = Math.min(Math.max(query.offset, 0), ordered.length);
      const end =
        query.limit === null
          ? ordered.length
          : Math.min(Math.max(start + query.limit, start), ordered.length);
      return new GridResult<T>({
        rows: ordered.slice(start, end),
        totalCount: total,
        filteredCount: matched.length,
        aggregates,
        sourceIndexOf,
      });
    }

    return new GridResult<T>({
      rows: [...ordered],
      totalCount: total,
      filteredCount: matched.length,
      aggregates,
      sourceIndexOf,
    });
  }

  // -- Source positions ----------------------------------------------------

  private positionGeneration = -1;
  private positions: Map<T, number> | null = null;

  /**
   * Where `row` sits in the unordered, unfiltered array.
   *
   * The grid used to report a row's position in the *sorted* result as its
   * source index, which is a different number as soon as anything is sorted,
   * and -1 for every grouped or tree row even though the rows were right
   * here. The lookup is built on the first call per matched set, so a grid
   * that never asks pays nothing.
   */
  sourceIndexOf(row: T): number {
    let positions = this.positions;
    if (positions === null || this.positionGeneration !== this.matchedGeneration) {
      positions = new Map<T, number>();
      for (let i = 0; i < this.matchedIndices.length; i++) {
        positions.set(
          this.matchedRows[i] as T,
          this.matchedIndices[i] as number,
        );
      }
      this.positions = positions;
      this.positionGeneration = this.matchedGeneration;
    }
    return positions.get(row) ?? -1;
  }

  // -- Stage 1: rows that match the filter and the search ------------------

  private matchedRevision = -1;
  private matchedKey = '';

  /**
   * Bumped whenever the matched set is recomputed.
   *
   * The stats and distinct-value caches key on this instead of on a string
   * built from the revision and the match key: building that string per call
   * cost real time on the conditional-formatting path, which asks for a
   * column's stats once per visible cell.
   */
  private matchedGeneration = 0;
  private matchedFilterKey = '';
  private matchedNeedle = '';
  private matchedIndices: number[] = [];
  private matchedRows: T[] = [];

  private searchFieldsFor(query: GridQuery): readonly string[] {
    if (query.searchFields.length > 0) return query.searchFields;
    const out: string[] = [];
    for (const column of this.columns.values()) {
      if (column.visible) out.push(column.field);
    }
    return out;
  }

  private matchedFor(query: GridQuery): T[] {
    const fields = this.searchFieldsFor(query);
    const needle = query.needle;
    // The query states its own identity; see GridQuery's cache identity
    // section. Falling back to the resolved search fields matters because
    // this source substitutes every visible column when the query named
    // none, and that substitution changes what matches.
    const filterKey =
      fields === query.searchFields
        ? query.filterFingerprint
        : `${query.filter?.fingerprint ?? ''}\u0000${fields.join(',')}`;
    const key = `${filterKey}\u0000${needle}`;
    if (this.matchedRevision === this.revision && this.matchedKey === key) {
      return this.matchedRows;
    }

    // Typing another character can only shrink the result, so the new needle
    // is searched within the previous match rather than over every row. The
    // first keystroke narrows the filter-only result for the same reason.
    // This is why indices are cached alongside the rows.
    const canNarrow =
      this.matchedRevision === this.revision &&
      this.matchedFilterKey === filterKey &&
      needle.length > 0 &&
      needle.startsWith(this.matchedNeedle);

    const filter = query.filter;
    const index = needle.length === 0 ? null : this.searchIndexFor(fields);
    // Narrowing has already applied the filter to these rows.
    const applyFilter = filter !== null && !canNarrow;
    // Compiled once per pass, not once per row: this is where an `isIn` over
    // a thousand checkbox values stops being O(rows x values), and where a
    // '50' typed into a number column's filter becomes the number 50.
    const compiled = applyFilter
      ? (filter as Filter).compile(this.columnTypes)
      : null;
    const candidates = canNarrow
      ? this.matchedIndices
      : rangeOf(this.data.length);

    const indices: number[] = [];
    const out: T[] = [];
    const columns = this.columns;
    for (const i of candidates) {
      // Search first: a contains over the prebuilt index is cheaper than
      // walking a filter tree.
      if (index !== null && !(index[i] as string).includes(needle)) continue;
      const row = this.data[i] as T;
      if (compiled !== null && !compiled.test((f) => columns.get(f)?.value(row))) {
        continue;
      }
      indices.push(i);
      out.push(row);
    }

    this.matchedRevision = this.revision;
    this.matchedKey = key;
    this.matchedGeneration++;
    this.matchedFilterKey = filterKey;
    this.matchedNeedle = needle;
    this.matchedIndices = indices;
    this.matchedRows = out;
    return out;
  }

  // -- Column statistics ---------------------------------------------------

  private statsGeneration = -1;
  private readonly statsCache = new Map<string, ColumnStats>();

  /**
   * Range of `field` across the rows that currently match.
   *
   * Computed over the matched set rather than every row, so a data bar is
   * drawn against what the user can actually see. Cached per revision and per
   * matched set, because a bar must not cost a column scan per frame.
   */
  override statsFor(field: string): ColumnStats {
    if (this.statsGeneration !== this.matchedGeneration) {
      this.statsCache.clear();
      this.statsGeneration = this.matchedGeneration;
    }
    const cached = this.statsCache.get(field);
    if (cached !== undefined) return cached;
    const column = this.columns.get(field);
    const rows =
      this.matchedRows.length === 0 && this.matchedKey.length === 0
        ? this.data
        : this.matchedRows;
    const stats =
      column === undefined
        ? ColumnStats.empty
        : computeColumnStats(rows.map((row) => column.value(row)));
    this.statsCache.set(field, stats);
    return stats;
  }

  private distinctGeneration = -1;
  private distinctLimit = -1;
  private distinctScope = '';
  private readonly distinctCache = new Map<string, DistinctValues>();

  /**
   * The last query this source resolved, so a distinct-value list knows which
   * filters to leave out.
   */
  private lastQuery: GridQuery | null = null;

  /**
   * The distinct values of `field` among the rows that match every filter
   * except this column's own.
   *
   * Cached exactly as {@link statsFor} is, and for the same reason: a
   * checkbox filter list is rebuilt every time the menu opens, and scanning a
   * column per frame is not affordable.
   *
   * Three things used to be wrong with it. The list was cut back to `limit`
   * after being read one over, so a truncated list was indistinguishable from
   * a complete one. The values kept were the first ones *seen* rather than
   * the smallest, so a truncated list was an arbitrary sample shown in sorted
   * order. And the rows scanned were the ones matching every filter including
   * this column's, so picking a value left that value as the only one on
   * offer.
   */
  override distinctValuesFor(field: string, limit = 500): DistinctValues {
    const scope = this.distinctScopeKey;
    if (
      this.distinctGeneration !== this.matchedGeneration ||
      this.distinctLimit !== limit ||
      this.distinctScope !== scope
    ) {
      this.distinctCache.clear();
      this.distinctGeneration = this.matchedGeneration;
      this.distinctLimit = limit;
      this.distinctScope = scope;
    }
    const cached = this.distinctCache.get(field);
    if (cached !== undefined) return cached;

    const column = this.columns.get(field);
    if (column === undefined) return DistinctValues.none;

    // A sorted array bounded at `limit`: the largest value is dropped as soon
    // as one too many arrives, so what survives is the smallest `limit`
    // values and the list is a prefix of the real one. Stopping the scan
    // early instead bounded the time and gave back an arbitrary sample shown
    // in sorted order, which reads exactly like a complete list. The limit
    // bounds what is held, not what is read.
    const seen: CellValue[] = [];
    let truncated = false;
    for (const row of this.rowsForDistinct(field)) {
      const value = column.value(row);
      const at = sortedPosition(seen, value);
      if (at.found) continue;
      seen.splice(at.index, 0, value);
      if (seen.length > limit) {
        seen.pop();
        truncated = true;
      }
    }
    const out = new DistinctValues(seen, truncated);
    this.distinctCache.set(field, out);
    return out;
  }

  /**
   * The rows a distinct-value list for `field` is computed over: those that
   * match the rest of the query, with any condition on `field` itself left
   * out.
   */
  private rowsForDistinct(field: string): readonly T[] {
    const query = this.lastQuery;
    if (query === null) return this.data;
    const filter = pruneFilter(query.filter, (f) => f !== field);
    const needle = query.needle;
    if (filter === null && needle.length === 0) return this.data;
    const compiled: CompiledFilter | null =
      filter === null ? null : filter.compile(this.columnTypes);
    const index =
      needle.length === 0
        ? null
        : this.searchIndexFor(this.searchFieldsFor(query));
    const columns = this.columns;
    const out: T[] = [];
    for (let i = 0; i < this.data.length; i++) {
      if (index !== null && !(index[i] as string).includes(needle)) continue;
      const row = this.data[i] as T;
      if (compiled !== null && !compiled.test((f) => columns.get(f)?.value(row))) {
        continue;
      }
      out.push(row);
    }
    return out;
  }

  /** Identity of the scope a distinct-value list is computed over. */
  private get distinctScopeKey(): string {
    const query = this.lastQuery;
    if (query === null) return '';
    return `${query.filter?.fingerprint ?? ''}\u0000${query.needle}`;
  }

  // -- The search index ----------------------------------------------------

  private indexRevision = -1;
  private indexKey = '';
  private searchIndex: string[] = [];

  /**
   * One folded, searchable string per row, covering `fields`.
   *
   * Quick search is the most repeated operation a grid does — once per
   * keystroke — and formatting every cell of every row each time dominated
   * it. Formatting happens once per revision instead.
   *
   * Columns are joined with a character a user cannot type, so a search can
   * never match text that spans two columns.
   */
  private searchIndexFor(fields: readonly string[]): string[] {
    const key = fields.join(',');
    if (this.indexRevision === this.revision && this.indexKey === key) {
      return this.searchIndex;
    }

    const resolved: GridColumn<T>[] = [];
    for (const field of fields) {
      const column = this.columns.get(field);
      if (column !== undefined) resolved.push(column);
    }
    const index = new Array<string>(this.data.length).fill('');
    for (let i = 0; i < this.data.length; i++) {
      const row = this.data[i] as T;
      let text = '';
      for (let c = 0; c < resolved.length; c++) {
        if (c > 0) text += '\u0001';
        text += (resolved[c] as GridColumn<T>).formattedValue(row);
      }
      index[i] = foldText(text);
    }

    this.indexRevision = this.revision;
    this.indexKey = key;
    this.searchIndex = index;
    return index;
  }

  // -- Stage 2: ordering ---------------------------------------------------

  private orderedRevision = -1;
  private orderedKey = '';
  private orderedRows: T[] = [];

  /**
   * Source position of each row in {@link orderedRows}.
   *
   * Kept because it is what makes the order reproducible: a sort breaks ties
   * by the input position, so a row inserted into an existing order has to be
   * placed among its equals by source position to land where a full re-sort
   * would have put it.
   */
  private orderedIndices: number[] = [];

  private orderedKeyFor(query: GridQuery): string {
    const sorts = query.sorts.map((s) => s.fingerprint).join(',');
    return `${this.matchedKey}\u0000${sorts}`;
  }

  private orderedFor(query: GridQuery, matched: T[]): T[] {
    if (query.sorts.length === 0) {
      this.orderedRows = matched;
      this.orderedIndices = this.matchedIndices;
      this.orderedRevision = this.revision;
      this.orderedKey = this.orderedKeyFor(query);
      return matched;
    }
    const key = this.orderedKeyFor(query);
    if (this.orderedRevision === this.revision && this.orderedKey === key) {
      return this.orderedRows;
    }
    const order = sortOrder<T>(matched, query.sorts, this.columns);
    this.orderedRows = order.map((i) => matched[i] as T);
    this.orderedIndices = order.map((i) =>
      i < this.matchedIndices.length ? (this.matchedIndices[i] as number) : -1,
    );
    this.orderedRevision = this.revision;
    this.orderedKey = key;
    return this.orderedRows;
  }

  // -- Stage 3: aggregates and groups --------------------------------------

  private aggregateRevision = -1;
  private aggregateKey = '';
  private aggregateResult: AggregateResult = AggregateResult.empty;

  private aggregatesFor(query: GridQuery, ordered: T[]): AggregateResult {
    if (query.aggregations.length === 0) return AggregateResult.empty;
    const key =
      `${this.orderedKey}\u0000${this.matchedKey}\u0000` +
      query.aggregations.map((a) => a.fingerprint).join(',');
    if (this.aggregateRevision === this.revision && this.aggregateKey === key) {
      return this.aggregateResult;
    }
    const columns = this.columns;
    const result = computeAggregates<T>(ordered, query.aggregations, (row, field) =>
      columns.get(field)?.value(row),
    );
    this.aggregateRevision = this.revision;
    this.aggregateKey = key;
    this.aggregateResult = result;
    return result;
  }

  private groupRevision = -1;
  private groupKey = '';
  private groupNodes: GroupNode<T>[] = [];

  private groupsFor(query: GridQuery, ordered: T[]): GroupNode<T>[] {
    const key =
      `${this.orderedKey}\u0000${this.matchedKey}\u0000` +
      // The bucketing functions are part of the key: see
      // GroupSpec.fingerprint.
      query.groups.map((g) => g.fingerprint).join(',') +
      '\u0000' +
      query.aggregations.map((a) => a.fingerprint).join(',');
    if (this.groupRevision === this.revision && this.groupKey === key) {
      return this.groupNodes;
    }
    const nodes = buildGroups<T>(ordered, query.groups, this.columns, {
      aggregations: query.aggregations,
    });
    this.groupRevision = this.revision;
    this.groupKey = key;
    this.groupNodes = nodes;
    return nodes;
  }

  // -- Incremental patching -------------------------------------------------

  /**
   * Keeps the memoised stages valid across a single replaced row, or leaves
   * them stale for a full recompute.
   *
   * Returns whether the patch was applied, which is only for the tests: a
   * caller cannot tell the difference, and that is the point. Where anything
   * about the current state is not understood here, the stages are left stale
   * and the next fetch rebuilds them — a slow answer is always allowed; a
   * wrong one is not.
   */
  private patchRow(index: number, _previous: T, updated: T): boolean {
    const query = this.lastQuery;
    if (query === null) return false;
    // The caches have to have been valid for the revision before this one.
    const before = this.revision - 1;
    if (this.matchedRevision !== before) return false;
    if (this.matchedKey.length === 0 && this.matchedRows.length === 0) {
      return false;
    }
    if (query.isGrouped) {
      // The group tree is rebuilt from the ordered rows either way, and the
      // lazy-group path has its own book-keeping.
      return false;
    }

    const fields = this.searchFieldsFor(query);
    const needle = query.needle;
    if (needle.length > 0) {
      // The search index has to be in hand and cover the same fields.
      if (
        this.indexRevision !== before ||
        this.indexKey !== fields.join(',')
      ) {
        return false;
      }
      if (this.searchIndex.length !== this.data.length) return false;
    }

    const sorted = query.sorts.length > 0;
    if (sorted) {
      if (
        this.orderedRevision !== before ||
        this.orderedKey !== this.orderedKeyFor(query) ||
        this.orderedRows.length !== this.orderedIndices.length
      ) {
        return false;
      }
    }

    // 1. The row's searchable text.
    if (
      this.indexRevision === before &&
      this.searchIndex.length === this.data.length
    ) {
      const resolved: GridColumn<T>[] = [];
      for (const field of this.indexKey.split(',')) {
        const column = this.columns.get(field);
        if (column !== undefined) resolved.push(column);
      }
      let text = '';
      for (let c = 0; c < resolved.length; c++) {
        if (c > 0) text += '\u0001';
        text += (resolved[c] as GridColumn<T>).formattedValue(updated);
      }
      this.searchIndex[index] = foldText(text);
      this.indexRevision = this.revision;
    }

    // 2. Does the row still match?
    const filter = query.filter;
    const compiled = filter === null ? null : filter.compile(this.columnTypes);
    const columns = this.columns;
    const matchesSearch =
      needle.length === 0 ||
      (this.searchIndex[index] as string).includes(needle);
    const matchesFilter =
      compiled === null || compiled.test((f) => columns.get(f)?.value(updated));
    const matches = matchesSearch && matchesFilter;

    const at = this.positionInMatched(index);
    const wasMatched = at >= 0;
    if (wasMatched && matches) {
      this.matchedRows = [...this.matchedRows];
      this.matchedRows[at] = updated;
    } else if (wasMatched && !matches) {
      this.matchedRows = [...this.matchedRows];
      this.matchedRows.splice(at, 1);
      this.matchedIndices = [...this.matchedIndices];
      this.matchedIndices.splice(at, 1);
    } else if (!wasMatched && matches) {
      const insertAt = this.insertionInMatched(index);
      this.matchedRows = [...this.matchedRows];
      this.matchedRows.splice(insertAt, 0, updated);
      this.matchedIndices = [...this.matchedIndices];
      this.matchedIndices.splice(insertAt, 0, index);
    }
    this.matchedRevision = this.revision;
    // Everything derived from the matched set — stats, distinct values, the
    // source-position lookup — is keyed on this.
    this.matchedGeneration++;

    // 3. Where does it belong in the order?
    if (!sorted) {
      this.orderedRows = this.matchedRows;
      this.orderedIndices = this.matchedIndices;
      this.orderedRevision = this.revision;
      return true;
    }

    const rows = [...this.orderedRows];
    const indices = [...this.orderedIndices];
    const wasAt = indices.indexOf(index);
    if (wasAt >= 0) {
      rows.splice(wasAt, 1);
      indices.splice(wasAt, 1);
    }
    if (matches) {
      const comparator = buildComparator<T>(query.sorts, this.columns);
      const insertAt = insertionInOrder(rows, indices, updated, index, comparator);
      rows.splice(insertAt, 0, updated);
      indices.splice(insertAt, 0, index);
    }
    this.orderedRows = rows;
    this.orderedIndices = indices;
    this.orderedRevision = this.revision;
    return true;
  }

  /**
   * Position of source index `index` in the matched indices, or -1.
   *
   * The indices are ascending, so this is a binary search.
   */
  private positionInMatched(index: number): number {
    let low = 0;
    let high = this.matchedIndices.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const value = this.matchedIndices[mid] as number;
      if (value === index) return mid;
      if (value < index) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  /** Where source index `index` belongs in the matched indices. */
  private insertionInMatched(index: number): number {
    let low = 0;
    let high = this.matchedIndices.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.matchedIndices[mid] as number) < index) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}

/**
 * Where `row` belongs in an already ordered list.
 *
 * Ties are broken by source position, which is what `sortOrder` does with the
 * input order, so the row lands exactly where a full re-sort would have put
 * it.
 */
function insertionInOrder<T>(
  rows: readonly T[],
  indices: readonly number[],
  row: T,
  index: number,
  comparator: Comparator<T>,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    let cmp = comparator(rows[mid] as T, row);
    if (cmp === 0) cmp = (indices[mid] as number) - index;
    if (cmp < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Binary search over a list kept in `compareValues` order. */
function sortedPosition(
  sorted: readonly CellValue[],
  value: CellValue,
): { index: number; found: boolean } {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const cmp = compareValues(sorted[mid], value);
    if (cmp === 0) return { index: mid, found: true };
    if (cmp < 0) low = mid + 1;
    else high = mid;
  }
  return { index: low, found: false };
}

function rangeOf(count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = i;
  return out;
}

/**
 * Wraps an async callback as a data source.
 *
 * The quickest way to point a grid at an HTTP endpoint: translate the
 * {@link GridQuery} into request parameters and return the page the server
 * sent.
 */
export class AsyncDataSource<T> extends GridDataSource<T> {
  private readonly fetcher: (query: GridQuery) => Promise<GridResult<T>>;
  private readonly committer:
    | ((original: T, updated: T) => Promise<T>)
    | null;

  constructor(
    fetcher: (query: GridQuery) => Promise<GridResult<T>>,
    options: { onCommit?: (original: T, updated: T) => Promise<T> } = {},
  ) {
    super();
    this.fetcher = fetcher;
    this.committer = options.onCommit ?? null;
  }

  override fetch(query: GridQuery): Promise<GridResult<T>> {
    return this.fetcher(query);
  }

  /**
   * Editable only when an `onCommit` was supplied: there is otherwise no
   * endpoint to send the write to.
   */
  override get canCommit(): boolean {
    return this.committer !== null;
  }

  override commit(original: T, updated: T): Promise<T> {
    if (this.committer === null) {
      throw new GridStateError('This source has no onCommit to write through.');
    }
    return this.committer(original, updated);
  }
}

/**
 * Convenience filter for a quick-search box, matching `needle` against any of
 * `fields` with `contains`.
 */
export function searchFilter(
  needle: string,
  fields: readonly string[],
): Filter {
  return FilterGroup.or(
    fields.map(
      (field) =>
        new FilterCondition({
          field,
          operator: FilterOperator.contains,
          value: needle,
        }),
    ),
  );
}
