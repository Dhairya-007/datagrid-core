/**
 * The grid's single source of truth.
 *
 * @module
 */

import { AggregateResult, type Aggregation } from './aggregate';
import {
  ColumnPin,
  type ColumnType,
  type GridColumn,
} from './column';
import type { CellValue } from './compare';
import {
  AsyncDataSource,
  DistinctValues,
  GridDataSource,
  RowUpdate,
  type SourceCapabilities,
} from './data-source';
import { CellDecoration, type ColumnStats } from './decoration';
import { coerceValue, EditResult, EditSession } from './editing';
import { GridArgumentError, GridStateError } from './errors';
import {
  CsvExporter,
  parseClipboardText,
  toClipboardText,
  type ExportOptions,
} from './export';
import { FetchCancelled, FetchSignal } from './fetch';
import {
  Filter,
  FilterGroup,
  operatorsFor,
  pruneFilter,
  type FilterCondition,
  type FilterOperator,
} from './filter';
import {
  GroupSpec,
  pathKeySegment,
  type GroupNode,
} from './group';
import {
  CellEdit,
  EditAction,
  EditHistory,
  ReplayOutcome,
} from './history';
import {
  ColumnFit,
  computeLayout,
  orderColumnsForDisplay,
  type GridLayout,
} from './layout';
import {
  GridChange,
  GridChangeNotifier,
  type GridListener,
} from './notifier';
import { PasteRejection, PasteResult } from './paste';
import { GridQuery, GridResult } from './query';
import {
  DataGridRow,
  DetailRowList,
  emptyRowList,
  flattenGroups,
  GroupExpansionState,
  GroupedRowList,
  GroupGridRow,
  isDataRow,
  isGroupRow,
  LazyDataRowList,
  MaterialisedRowList,
  withDetailRows,
  type GridRow,
  type GridRowList,
  type RowKey,
} from './rows';
import {
  CellAddress,
  noModifiers,
  SelectionCoverage,
  SelectionMode,
  SelectionState,
  type SelectionModifiers,
} from './selection';
import {
  buildComparator,
  cycleSort,
  SortSpec,
} from './sort';
import { describeHeaderProblems, type HeaderRow } from './stacked-header';
import { flattenTree, type TreeSpec } from './tree';
import { ColumnViewState, GridViewState } from './view-state';

/** Everything a {@link GridController} can be given. */
export interface GridControllerOptions<T> {
  columns: readonly GridColumn<T>[];
  dataSource: GridDataSource<T>;
  sorts?: readonly SortSpec[];
  groups?: readonly GroupSpec[];
  aggregations?: readonly Aggregation[];
  filter?: Filter | null;
  selectionMode?: SelectionMode;
  stackedHeaders?: readonly HeaderRow[];
  frozenRowCount?: number;
  frozenRowCountBottom?: number;
  pageSize?: number | null;
  groupsExpandedByDefault?: boolean;
  columnFit?: ColumnFit;

  /**
   * Recognises a row across rebuilds: a primary key, not a position.
   *
   * Everything the user has aimed at a particular row — the selection, the
   * active cell, an open edit session — is stored as a row index, because an
   * index is what an adapter renders. An index is a position, so without a
   * way to recognise the row it pointed at, re-sorting or a background
   * refresh silently moves the user's selection onto a different row.
   *
   * Supply this and those indices are rewritten to wherever the rows went.
   * Leave it out and the old positional behaviour applies, which is correct
   * only for a grid whose order never changes under the user.
   *
   * The key must be stable for the life of a row and must compare by value —
   * a string id, a number, or a string built from both for a composite key.
   * Frozen rows stay positional on purpose.
   */
  rowKey?: (row: T) => RowKey;

  /**
   * How long to wait, in milliseconds, before sending a coalescing refresh,
   * or null for none.
   *
   * Applies to the interactions a user drives a character at a time — the
   * search box and the filter row — and only to a source that is not local. A
   * few hundred milliseconds turns a typed word into one request.
   */
  fetchDebounceMs?: number | null;

  /**
   * Whether a failed fetch keeps the rows it was replacing.
   *
   * Off by default, because stale rows presented as current are a worse lie
   * than an empty grid. Turn it on for a dashboard that polls, where one
   * dropped response should not blank the screen; show `error` alongside them
   * so the user knows what they are looking at is not fresh.
   */
  keepRowsOnError?: boolean;

  /**
   * Whether grouping may be resolved one group at a time by the source.
   *
   * Grouping otherwise needs every matching row, because the grid counts the
   * groups itself — so grouping a million-row backend downloads a million
   * rows. With this on, and a source whose `supportsLazyGroups` is true, the
   * query asks for headers and counts only and each group's contents are
   * fetched when it is opened. Pair it with `groupsExpandedByDefault: false`,
   * or the first render asks for every group at once and the saving is lost.
   */
  lazyGrouping?: boolean;

  /**
   * The parent/child hierarchy among the rows, if there is one.
   *
   * Null for a flat grid. Ignored while the grid is grouped: a tree inside a
   * group is two hierarchies drawn in one column of indentation, which cannot
   * be read.
   */
  tree?: TreeSpec<T> | null;

  treeExpandedByDefault?: boolean;

  /**
   * How many rows a {@link GridController.loadMore} asks for, or null to page
   * instead.
   *
   * Setting it turns the grid into an infinite list: the first fetch asks for
   * this many rows and each `loadMore` appends another slice, rather than one
   * page replacing the last. Paging and loading more are the same request
   * with different book-keeping, so a grid does one or the other — `pageSize`
   * is ignored while this is set.
   */
  loadMoreSize?: number | null;

  /**
   * Height of the panel {@link GridController.toggleDetail} opens under a
   * row, or null when the grid has no detail panels.
   *
   * A fixed height rather than a measured one, because row offsets are a
   * prefix-sum table and a table cannot wait for a layout pass.
   */
  detailHeight?: number | null;
}

/** A promise with its resolver, for the debounced refresh. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  done: boolean;
}

function defer(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const deferred: Deferred = {
    promise,
    done: false,
    resolve: () => {
      if (deferred.done) return;
      deferred.done = true;
      resolve();
    },
  };
  return deferred;
}

/** One row written and not yet confirmed, and the write that owns it. */
interface PendingWrite<T> {
  readonly row: T;
  /** Which write put this here, so a finishing write only clears its own. */
  readonly sequence: number;
}

/**
 * A row and the cell values bound for it.
 *
 * A paste or an undo can touch several cells of the same row, and the row has
 * to be written once with all of them applied — not once per cell.
 */
interface RowPatch<T> {
  readonly row: T;
  readonly values: Map<string, CellValue>;
}

/**
 * A group header's identity, so the selection can follow it the way it
 * follows a data row.
 *
 * Prefixed with characters a key cannot contain in practice, so that a header
 * can never be confused with a row whose key happens to be the same string.
 */
function headerIdentity(path: string): string {
  return `\u0000header\u0000${path}`;
}

/**
 * Owns every piece of grid state and the pipeline that turns it into rows.
 *
 * A UI adapter is meant to be a thin shell over this: listen for changes,
 * read {@link visibleRows} and {@link layoutFor}, and call these methods from
 * events. All of the behaviour a data grid is judged on lives here, in plain
 * TypeScript that can be unit tested without rendering a single frame.
 */
export class GridController<T> extends GridChangeNotifier {
  private columnList: GridColumn<T>[];
  private source: GridDataSource<T>;

  private sortList: SortSpec[];
  private groupList: GroupSpec[];
  private readonly aggregationList: Aggregation[];
  private filterValue: Filter | null;
  private readonly columnFilterMap = new Map<string, FilterCondition>();
  private searchText = '';
  private pageSizeValue: number | null;
  private pageIndexValue = 0;

  private readonly columnWidths = new Map<string, number>();
  private stackedHeaderRows: HeaderRow[];
  private frozenTop: number;
  private frozenBottom: number;

  private result: GridResult<T> | null = null;
  private rows: GridRowList<T> = emptyRowList<T>();
  private loading = false;
  private errorValue: unknown = null;
  private fetchToken = 0;

  private edit: EditSession<T> | null = null;

  /** Row and cell selection. */
  readonly selection: SelectionState;

  /** Which group headers are open. */
  readonly expansion: GroupExpansionState;

  /**
   * Which tree branches are open, keyed by `DataGridRow.treePath`.
   *
   * Separate from {@link expansion} because a grid can be grouped or a tree
   * but the two states mean different things, and closing a group should not
   * close a branch that happens to share a key.
   */
  readonly treeExpansion: GroupExpansionState;

  /** The parent/child hierarchy among the rows, if there is one. */
  readonly tree: TreeSpec<T> | null;

  /** How spare horizontal space is used. */
  columnFit: ColumnFit;

  /** How long to wait before sending a coalescing refresh, in milliseconds. */
  fetchDebounceMs: number | null;

  /** Whether a failed fetch keeps the rows it was replacing. */
  keepRowsOnError: boolean;

  /** Whether grouping may be resolved one group at a time by the source. */
  readonly lazyGrouping: boolean;

  /** Height of the panel {@link toggleDetail} opens under a row. */
  readonly detailHeight: number | null;

  /** How many rows a {@link loadMore} asks for, or null to page instead. */
  readonly loadMoreSize: number | null;

  /** Recognises a row across rebuilds. */
  readonly rowKey: ((row: T) => RowKey) | null;

  constructor(options: GridControllerOptions<T>) {
    super();
    const {
      columns,
      dataSource,
      sorts = [],
      groups = [],
      aggregations = [],
      filter = null,
      selectionMode = SelectionMode.multiRow,
      stackedHeaders = [],
      frozenRowCount = 0,
      frozenRowCountBottom = 0,
      pageSize = null,
      groupsExpandedByDefault = true,
      columnFit = ColumnFit.none,
      rowKey,
      fetchDebounceMs = null,
      keepRowsOnError = false,
      lazyGrouping = false,
      tree = null,
      treeExpandedByDefault = true,
      loadMoreSize = null,
      detailHeight = null,
    } = options;

    requireDistinctFields(columns);

    this.columnList = [...columns];
    this.source = dataSource;
    this.sortList = [...sorts];
    this.groupList = [...groups];
    this.aggregationList = [...aggregations];
    this.filterValue = filter;
    this.stackedHeaderRows = [...stackedHeaders];
    this.frozenTop = frozenRowCount;
    this.frozenBottom = frozenRowCountBottom;
    this.pageSizeValue = pageSize;
    this.columnFit = columnFit;
    this.rowKey = rowKey ?? null;
    this.fetchDebounceMs = fetchDebounceMs;
    this.keepRowsOnError = keepRowsOnError;
    this.lazyGrouping = lazyGrouping;
    this.tree = tree;
    this.loadMoreSize = loadMoreSize;
    this.detailHeight = detailHeight;
    this.selection = new SelectionState({ mode: selectionMode });
    this.expansion = new GroupExpansionState({
      expandedByDefault: groupsExpandedByDefault,
    });
    this.treeExpansion = new GroupExpansionState({
      expandedByDefault: treeExpandedByDefault,
    });

    if (tree !== null && this.rowKey === null) {
      throw new GridArgumentError(
        'A tree needs a rowKey: a branch is remembered by the identity of ' +
          'the rows above it.',
      );
    }
    requireValidHeaders(this.stackedHeaderRows, this.columnList);

    this.source.columns = this.columnsByField;
    this.sourceListener = (): void => {
      void this.refresh();
    };
    this.source.addListener(this.sourceListener);
    void this.refresh();
  }

  private readonly sourceListener: GridListener;

  // -- Detail panels --------------------------------------------------------

  /** Which rows have their detail panel open, keyed by `rowKey`. */
  private readonly openDetailKeys = new Set<RowKey>();

  /**
   * Whether detail panels are available at all: a height was given and rows
   * can be recognised.
   */
  get hasDetailPanels(): boolean {
    return this.detailHeight !== null && this.rowKey !== null;
  }

  /** Whether the panel under the row with this identity is open. */
  isDetailOpen(key: RowKey): boolean {
    return this.openDetailKeys.has(key);
  }

  /** Identities of the rows whose panels are open, for a saved view. */
  get openDetails(): ReadonlySet<RowKey> {
    return new Set(this.openDetailKeys);
  }

  /**
   * Opens or closes the panel under `key`, which is a `rowKey` value.
   *
   * Keyed by identity rather than by index for the reason the selection is: a
   * panel the user opened belongs to a row, and a sort must not move it onto
   * a different one.
   */
  toggleDetail(key: RowKey): void {
    if (!this.openDetailKeys.delete(key)) this.openDetailKeys.add(key);
    this.reapply();
  }

  setDetailOpen(key: RowKey, open: boolean): void {
    const had = this.openDetailKeys.has(key);
    if (open === had) return;
    if (open) this.openDetailKeys.add(key);
    else this.openDetailKeys.delete(key);
    this.reapply();
  }

  closeAllDetails(): void {
    if (this.openDetailKeys.size === 0) return;
    this.openDetailKeys.clear();
    this.reapply();
  }

  /** Whether the grid is accumulating slices rather than paging. */
  get isInfinite(): boolean {
    return this.loadMoreSize !== null && this.loadMoreSize > 0;
  }

  /**
   * Whether rows are being shown as a tree, i.e. {@link tree} is set and the
   * grid is not grouped.
   */
  get isTree(): boolean {
    return this.tree !== null && !this.isGrouped;
  }

  /** Whether rows can be recognised across rebuilds, i.e. a rowKey was given. */
  get hasRowIdentity(): boolean {
    return this.rowKey !== null;
  }

  /** The identity of `row`, or null when no rowKey was supplied. */
  keyFor(row: T): RowKey | null {
    return this.rowKey === null ? null : this.rowKey(row);
  }

  // -- Read-only view of the state -----------------------------------------

  get columns(): readonly GridColumn<T>[] {
    return this.columnList;
  }

  /**
   * Columns taking part in layout, in the order they appear on screen.
   *
   * Pinning moves a column on screen without moving it in the column list, so
   * this is {@link orderColumnsForDisplay} over the declared columns rather
   * than the list itself. Keyboard navigation, range selection and export all
   * read this, which is what keeps them agreeing with the screen.
   */
  get visibleColumns(): GridColumn<T>[] {
    return orderColumnsForDisplay<T>(this.columnList);
  }

  private byField: Map<string, GridColumn<T>> | null = null;

  /**
   * The columns by field.
   *
   * Cached, because this is read on paths that run per cell: conditional
   * formatting over a 40x200 viewport asked for a column 8,000 times a frame,
   * and both this and {@link column} walked or rebuilt the whole list every
   * time. The cache is dropped whenever the columns change.
   */
  get columnsByField(): ReadonlyMap<string, GridColumn<T>> {
    if (this.byField === null) {
      this.byField = new Map(this.columnList.map((c) => [c.field, c]));
    }
    return this.byField;
  }

  column(field: string): GridColumn<T> | null {
    return this.columnsByField.get(field) ?? null;
  }

  /** Drops the by-field cache. Called by everything that changes the columns. */
  private columnsChanged(): void {
    this.byField = null;
  }

  get dataSource(): GridDataSource<T> {
    return this.source;
  }

  /**
   * What the current source can do, as it declares it.
   *
   * An adapter reads this to stop offering what cannot be honoured, rather
   * than inferring it from the source's type.
   */
  get sourceCapabilities(): SourceCapabilities {
    return this.source.capabilities;
  }

  get sorts(): readonly SortSpec[] {
    return this.sortList;
  }

  get groups(): readonly GroupSpec[] {
    return this.groupList;
  }

  get aggregations(): readonly Aggregation[] {
    return this.aggregationList;
  }

  get filter(): Filter | null {
    return this.filterValue;
  }

  get columnFilters(): ReadonlyMap<string, FilterCondition> {
    return new Map(this.columnFilterMap);
  }

  /**
   * Fields that something in the current state refers to and the grid has no
   * column for.
   *
   * Those filters, sorts and groupings are kept but left out of the query, so
   * an adapter can offer to clear them — the header they belonged to is gone,
   * so the user cannot.
   */
  get inactiveFields(): Set<string> {
    const known = this.columnsByField;
    const referenced = new Set<string>();
    for (const field of this.filterValue?.fields ?? []) referenced.add(field);
    for (const field of this.columnFilterMap.keys()) referenced.add(field);
    for (const sort of this.sortList) referenced.add(sort.field);
    for (const group of this.groupList) referenced.add(group.field);
    const out = new Set<string>();
    for (const field of referenced) {
      if (!known.has(field)) out.add(field);
    }
    return out;
  }

  get search(): string {
    return this.searchText;
  }

  /** The rows to render, group headers included. */
  get visibleRows(): GridRowList<T> {
    return this.rows;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  /** Rows that matched the current filters, before paging. */
  get matchedCount(): number {
    return this.result?.matchedCount ?? 0;
  }

  /** Rows in the source, before any filtering. */
  get totalCount(): number {
    return this.result?.totalCount ?? 0;
  }

  /** Grid-wide aggregates for a summary footer. */
  get aggregates(): AggregateResult {
    return this.result?.aggregates ?? AggregateResult.empty;
  }

  get isLoading(): boolean {
    return this.loading;
  }

  /** Error thrown by the last fetch, if it failed. */
  get error(): unknown {
    return this.errorValue;
  }

  /**
   * Whether the rows on screen are left over from before a failed fetch.
   *
   * Only ever true with {@link keepRowsOnError} set, which is the mode that
   * asks for exactly that. Without it a failed fetch clears the result, so
   * the counts and aggregates cannot go on describing rows that are gone.
   */
  get isStale(): boolean {
    return this.errorValue !== null && this.result !== null;
  }

  get isGrouped(): boolean {
    return this.groupList.length > 0;
  }

  get isEmpty(): boolean {
    return !this.loading && this.rows.length === 0;
  }

  /** The in-flight cell edit, if the grid is editing. */
  get editSession(): EditSession<T> | null {
    return this.edit;
  }

  // -- Paging ---------------------------------------------------------------

  get pageSize(): number | null {
    return this.pageSizeValue;
  }

  get pageIndex(): number {
    return this.pageIndexValue;
  }

  /**
   * How many pages the current result has.
   *
   * Always 1 while grouped: grouping needs every matching row, because a
   * header counts its group, so the query asks for all of them and paging has
   * nothing to turn. Advertising three pages that `nextPage` could not turn
   * was worse than saying there is one.
   */
  get pageCount(): number {
    const size = this.pageSizeValue;
    if (size === null || size <= 0 || this.isGrouped) return 1;
    const count = Math.ceil(this.matchedCount / size);
    return count < 1 ? 1 : count;
  }

  get hasNextPage(): boolean {
    return this.pageIndexValue < this.pageCount - 1;
  }

  get hasPreviousPage(): boolean {
    return this.pageIndexValue > 0;
  }

  /**
   * Sets the page size, keeping the first row of the current page in view
   * rather than jumping back to the top.
   */
  setPageSize(size: number | null): void {
    if (this.pageSizeValue === size) return;
    const firstRow =
      this.pageSizeValue === null ? 0 : this.pageIndexValue * this.pageSizeValue;
    this.pageSizeValue = size;
    this.pageIndexValue =
      size === null || size <= 0 ? 0 : Math.floor(firstRow / size);
    void this.refresh();
  }

  goToPage(index: number): void {
    const clamped = Math.min(Math.max(index, 0), this.pageCount - 1);
    if (clamped === this.pageIndexValue) return;
    this.pageIndexValue = clamped;
    void this.refresh();
  }

  nextPage(): void {
    this.goToPage(this.pageIndexValue + 1);
  }

  previousPage(): void {
    this.goToPage(this.pageIndexValue - 1);
  }

  // -- Query building -------------------------------------------------------

  /** The query the current state describes. */
  get query(): GridQuery {
    const known = this.columnsByField;
    const isKnown = (field: string): boolean => known.has(field);
    const conditions: Filter[] = [];
    // A filter on a column that is no longer here would test a field no row
    // answers to, which hides every row — and with the header gone there is
    // nothing left to clear it from. The condition is kept in state and left
    // out of the query, so putting the column back brings its filter back
    // too.
    const pruned = pruneFilter(this.filterValue, isKnown);
    if (pruned !== null) conditions.push(pruned);
    for (const condition of this.columnFilterMap.values()) {
      if (!condition.isEmpty && isKnown(condition.field)) {
        conditions.push(condition);
      }
    }
    const size = this.pageSizeValue;
    const paged = size !== null && size > 0;
    return new GridQuery({
      sorts: this.sortList.filter((sort) => isKnown(sort.field)),
      filter:
        conditions.length === 0
          ? null
          : conditions.length === 1
            ? (conditions[0] as Filter)
            : FilterGroup.and(conditions),
      search: this.searchText,
      searchFields: this.visibleColumns
        .filter((c) => c.filterable)
        .map((c) => c.field),
      groups: this.groupList.filter((group) => isKnown(group.field)),
      aggregations: this.aggregationList,
      // Infinite mode asks for one slice at a time, from where the last one
      // ended. It used to ask from the top for everything loaded so far, so
      // ten slices of 100 transferred 5,500 rows to show 1,000 — O(n^2)
      // against a remote API, and the whole list re-sorted on every scroll. A
      // query change starts again from the top, because a slice fetched under
      // the old order describes rows that are no longer there.
      offset: this.isInfinite
        ? this.appending
          ? this.loadedRows.length
          : 0
        : !paged || this.isGrouped
          ? 0
          : this.pageIndexValue * (size as number),
      limit: this.isGrouped
        ? null
        : this.isInfinite
          ? this.loadMoreSize
          : paged
            ? size
            : null,
      lazyGroups: this.isLazilyGrouped,
    });
  }

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounced: Deferred | null = null;
  private signal: FetchSignal | null = null;

  /**
   * Re-runs the query and rebuilds {@link visibleRows}.
   *
   * Concurrent fetches are token-guarded, so a slow response from an earlier
   * query can never overwrite the result of a newer one, and the superseded
   * fetch is handed a cancelled {@link FetchSignal} so a source that honours
   * it can stop work it no longer has to finish.
   *
   * With `coalesce` true and {@link fetchDebounceMs} set, the fetch is
   * deferred and folded into any other coalescing refresh that arrives inside
   * the window. That is what keeps a filter row from sending one request per
   * keystroke. A local source is never debounced: it answers inside the
   * frame, so delaying it would only make typing feel slow.
   */
  refresh(options: { coalesce?: boolean } = {}): Promise<void> {
    const delay = this.fetchDebounceMs;
    if (
      options.coalesce === true &&
      delay !== null &&
      delay > 0 &&
      !this.source.isLocal
    ) {
      // The in-flight request is answering a query the user has already moved
      // on from.
      this.cancelFetch('superseded by a newer query');
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      const deferred = (this.debounced ??= defer());
      this.loading = true;
      this.errorValue = null;
      this.notifyListeners([GridChange.status]);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.debounced = null;
        void this.fetchNow().finally(() => {
          deferred.resolve();
        });
      }, delay);
      return deferred.promise;
    }
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    // A direct refresh answers the coalesced one too. Cancelling the timer
    // without completing the promise left every caller awaiting the debounced
    // refresh hanging forever.
    const pending = this.debounced;
    this.debounced = null;
    const fetch = this.fetchNow();
    if (pending === null) return fetch;
    return fetch.finally(() => {
      pending.resolve();
    });
  }

  /** Whether a debounced refresh is waiting to be sent. */
  get isFetchPending(): boolean {
    return this.debounceTimer !== null;
  }

  // -- Loading more ---------------------------------------------------------

  /** Rows gathered so far in infinite mode, slice by slice. */
  private loadedRows: readonly T[] = [];

  /**
   * Whether the fetch being built is appending a slice rather than starting
   * the list again.
   */
  private appending = false;

  /** Whether the source has said there is nothing left. */
  private exhausted = false;

  private loadingMore = false;

  /** How many rows have been gathered in infinite mode. */
  get loadedRowCount(): number {
    return this.loadedRows.length;
  }

  /** Whether a {@link loadMore} is in flight, for a spinner at the tail. */
  get isLoadingMore(): boolean {
    return this.loadingMore;
  }

  /**
   * Whether asking for more rows would do anything.
   *
   * False while one request is already out, so a scroll that reaches the end
   * twice in two frames asks once.
   */
  get canLoadMore(): boolean {
    if (!this.isInfinite || this.isGrouped || this.loadingMore || this.exhausted) {
      return false;
    }
    const capabilities = this.source.capabilities;
    if (!capabilities.supportsLoadMore) return false;
    // A local source knows its own total; a remote one answers for itself.
    if (capabilities.isLocal) return this.loadedRows.length < this.matchedCount;
    return this.source.hasMore || this.loadedRows.length < this.matchedCount;
  }

  /**
   * Appends another slice of rows.
   *
   * Resolves when the rows are on screen, or immediately if there is nothing
   * to ask for. The adapter calls this when the viewport reaches the end; the
   * engine owns how much to ask for and when asking is pointless.
   */
  async loadMore(): Promise<void> {
    if (!this.canLoadMore) return;
    this.loadingMore = true;
    this.appending = true;
    this.notifyListeners([GridChange.status]);
    try {
      await this.fetchNow();
    } finally {
      this.appending = false;
      this.loadingMore = false;
      if (!this.isDisposed) this.notifyListeners([GridChange.status]);
    }
  }

  /**
   * Forgets the current position in the data: the page, and any slices
   * accumulated by {@link loadMore}.
   *
   * Called by everything that changes which rows match or in what order,
   * because a slice fetched under the old query describes rows that are no
   * longer in those positions.
   */
  private resetPaging(): void {
    this.pageIndexValue = 0;
    if (this.isInfinite) {
      this.loadedRows = [];
      this.exhausted = false;
    }
  }

  /**
   * Drops back to the first slice, as a pull-to-refresh does.
   *
   * The gesture belongs to the adapter; what it means — forget what was
   * accumulated and ask again — belongs here.
   */
  reload(): Promise<void> {
    if (this.isInfinite) {
      this.loadedRows = [];
      this.exhausted = false;
    }
    // Everything fetched a piece at a time is refetched too, keeping which
    // branches and groups are open: reload used to leave a lazy tree showing
    // the children it had already loaded, whatever the server now held.
    this.loadedGroups.clear();
    this.groupErrors.clear();
    this.loadingGroups.clear();
    this.loadedChildren.clear();
    this.childErrors.clear();
    this.source.bumpRevision();
    return this.refresh();
  }

  private cancelFetch(reason: string): void {
    this.signal?.cancel(reason);
    this.signal = null;
  }

  private async fetchNow(): Promise<void> {
    const token = ++this.fetchToken;
    const source = this.source;
    this.cancelFetch('superseded by a newer query');

    // A source that can answer now does; resolving it inline avoids a frame
    // of empty grid on the very first render. The capability is declared, not
    // inferred from the type — see GridDataSource.isSynchronous.
    if (source.isSynchronous) {
      this.loading = false;
      this.errorValue = null;
      this.apply(source.fetchSync(this.query));
      return;
    }

    const signal = new FetchSignal();
    this.signal = signal;
    this.loading = true;
    this.errorValue = null;
    this.notifyListeners([GridChange.status]);
    try {
      const result = await source.fetch(this.query.copyWith({ signal }));
      if (token !== this.fetchToken || this.isDisposed) return;
      this.loading = false;
      // The groups the source just sent supersede anything cached for the
      // query they replace — including loads still in flight, which answer
      // the query the user has moved on from.
      this.loadedGroups.clear();
      this.groupErrors.clear();
      this.loadingGroups.clear();
      this.apply(result);
    } catch (error) {
      if (token !== this.fetchToken || this.isDisposed) return;
      // A fetch the grid itself cancelled has no answer and is not a failure:
      // the refresh that replaced it owns the state now. One the grid did
      // *not* cancel is a real failure dressed as a cancellation — a source
      // that maps an aborted HTTP call onto FetchCancelled — and swallowing
      // it left the spinner running for good.
      if (error instanceof FetchCancelled && signal.isCancelled) return;
      this.loading = false;
      this.errorValue = error;
      if (!this.keepRowsOnError) this.clearResult();
      this.notifyListeners([GridChange.rows, GridChange.status]);
    }
  }

  /** Guards the re-slice in {@link apply} against recursion. */
  private reslicing = false;

  /**
   * Folds an incoming slice into the rows gathered so far.
   *
   * A slice shorter than asked for means the source has run out, which is how
   * a backend that cannot report a total says "that is all".
   */
  private accumulate(incoming: GridResult<T>): GridResult<T> {
    const slice = this.loadMoreSize as number;
    if (this.appending) {
      this.loadedRows = [...this.loadedRows, ...incoming.rows];
    } else {
      this.loadedRows = incoming.rows;
    }
    if (incoming.rows.length < slice) this.exhausted = true;
    return new GridResult<T>({
      rows: this.loadedRows,
      totalCount: incoming.totalCount,
      filteredCount: incoming.filteredCount,
      groups: incoming.groups,
      aggregates: incoming.aggregates,
      stats: incoming.stats,
      sourceIndexOf: incoming.sourceIndexOf,
    });
  }

  /**
   * Forgets the last result, so nothing describes rows that are not shown.
   *
   * A failed fetch used to empty the rows and keep the result, so the footer
   * still read "6 rows" and the aggregates still summed the rows that had
   * just disappeared.
   */
  private clearResult(): void {
    this.result = null;
    this.rows = emptyRowList<T>();
    this.loadedGroups.clear();
    this.loadingGroups.clear();
  }

  private apply(incoming: GridResult<T>): void {
    // Read the identities the user is pointing at before the rows change
    // under them.
    const tracked = this.trackedRowKeys();

    const result = this.isInfinite ? this.accumulate(incoming) : incoming;
    this.result = result;

    // The page the user is on may no longer exist: rows removed elsewhere, or
    // a filter that now matches less, left pageIndex past pageCount and the
    // grid showing nothing at all while rows sat on an earlier page. A
    // synchronous source can re-slice now; a remote one is asked again.
    let applied = result;
    const lastPage = this.pageCount - 1;
    if (this.pageIndexValue > lastPage) {
      this.pageIndexValue = lastPage < 0 ? 0 : lastPage;
      if (this.source.isSynchronous && !this.reslicing) {
        this.reslicing = true;
        try {
          applied = this.source.fetchSync(this.query);
          this.result = applied;
        } finally {
          this.reslicing = false;
        }
      } else if (!this.reslicing) {
        queueMicrotask(() => {
          if (!this.isDisposed) void this.refresh();
        });
      }
    }
    this.rows = this.rowsFor(applied);

    if (tracked !== null) {
      const positions = this.rowPositions();
      // A group header has no identity to follow, so it keeps its position. A
      // data row whose identity is gone — filtered out, or deleted elsewhere
      // — is dropped rather than left pointing at its neighbour.
      const movedFrom = (index: number): number | null => {
        const identity = tracked.get(index);
        if (identity === undefined) return index;
        return positions.get(identity) ?? null;
      };

      this.selection.remapRows(movedFrom, this.rows.length);

      const session = this.edit;
      if (session !== null) {
        const movedTo = movedFrom(session.cell.row);
        if (movedTo === null) {
          // Keeping the editor open over an unrelated row would write the
          // half-typed value into it.
          this.edit = null;
        } else {
          session.relocate(movedTo);
        }
      }
    }
    this.selection.clampTo(this.rows.length);
    this.notifyListeners([
      GridChange.rows,
      GridChange.selection,
      GridChange.status,
    ]);
    if (this.isLazilyGrouped) this.requestOpenGroups();
    if (this.isLazyTree) this.requestOpenBranches();
  }

  // -- Lazy grouping --------------------------------------------------------

  /** Contents of the groups fetched so far, keyed by `GroupNode.path`. */
  private readonly loadedGroups = new Map<
    string,
    { rows: readonly T[]; groups: readonly GroupNode<T>[]; aggregates: AggregateResult | null }
  >();

  private readonly loadingGroups = new Set<string>();
  private readonly groupErrors = new Map<string, unknown>();

  /**
   * Whether grouping is being resolved a group at a time by the source.
   *
   * True when {@link lazyGrouping} is on, the grid is grouped, and the source
   * says it can answer a lazy-groups query. A local source always groups in
   * full: it already holds every row, so there is nothing to defer.
   */
  get isLazilyGrouped(): boolean {
    return (
      this.lazyGrouping &&
      this.isGrouped &&
      !this.source.isLocal &&
      this.source.supportsLazyGroups
    );
  }

  /** Whether the grid is waiting for the contents of `path`. */
  isGroupLoading(path: string): boolean {
    return this.loadingGroups.has(path);
  }

  /** Error from the last attempt to load `path`, if it failed. */
  groupError(path: string): unknown {
    return this.groupErrors.get(path) ?? null;
  }

  /**
   * Forgets a group's contents so they are fetched again when it is next
   * open. Called after a write, or by a UI's retry.
   */
  invalidateGroup(path: string): void {
    this.loadedGroups.delete(path);
    this.groupErrors.delete(path);
    this.rebuildRows();
  }

  /** Grafts the contents fetched for a group onto the header the source sent. */
  private mergeLoadedGroups(
    nodes: readonly GroupNode<T>[],
  ): readonly GroupNode<T>[] {
    if (this.loadedGroups.size === 0) return nodes;
    return nodes.map((node) => {
      const loaded = this.loadedGroups.get(node.path);
      if (loaded !== undefined) {
        return node.withContents({
          children: this.mergeLoadedGroups(loaded.groups),
          rows: loaded.rows,
          aggregates: loaded.aggregates ?? undefined,
        });
      }
      if (node.children.length === 0) return node;
      return node.withChildren(this.mergeLoadedGroups(node.children));
    });
  }

  /**
   * Asks the source for the contents of every open group it has not sent.
   *
   * Driven from the rows rather than from the tree, so only groups the user
   * can actually see are fetched: an open group inside a closed one costs
   * nothing until its parent is opened.
   */
  private requestOpenGroups(): void {
    const pending: GroupNode<T>[] = [];
    for (const row of this.rows) {
      if (!isGroupRow(row)) continue;
      if (!row.expanded || row.isLoaded) continue;
      const path = row.node.path;
      if (this.loadingGroups.has(path)) continue;
      if (this.loadedGroups.has(path)) continue;
      // A group that failed is not retried on every rebuild; see
      // invalidateGroup.
      if (this.groupErrors.has(path)) continue;
      pending.push(row.node);
    }
    if (pending.length === 0) return;

    for (const node of pending) this.loadingGroups.add(node.path);
    // Re-flatten before the requests go out, so an open group says it is
    // loading rather than looking empty. Every path is marked by now, so this
    // cannot ask for the same group twice.
    this.rebuildRows();
    for (const node of pending) void this.loadGroup(node);
  }

  private async loadGroup(node: GroupNode<T>): Promise<void> {
    const source = this.source;
    const generation = this.sourceGeneration;
    const token = this.fetchToken;
    const signal = new FetchSignal();
    const pending = this.query.copyWith({ signal });
    try {
      const children = await source.fetchGroupChildren(pending, node);
      // The answer describes the query that asked for it. A search or a
      // filter that landed while this was in flight makes it an answer to a
      // question nobody is asking any more, and grafting it onto the new
      // headers showed pre-search rows after the search.
      if (
        this.isDisposed ||
        source !== this.source ||
        generation !== this.sourceGeneration ||
        token !== this.fetchToken
      ) {
        return;
      }
      this.loadedGroups.set(node.path, {
        rows: children.rows,
        groups: children.groups,
        aggregates: children.aggregates,
      });
    } catch (error) {
      if (error instanceof FetchCancelled) return;
      if (this.isDisposed || generation !== this.sourceGeneration) return;
      if (token !== this.fetchToken) return;
      // A group that would not load is a failure of this group, not of the
      // grid: the other groups are still good.
      this.groupErrors.set(node.path, error);
    } finally {
      this.loadingGroups.delete(node.path);
      if (!this.isDisposed && generation === this.sourceGeneration) {
        this.rebuildRows();
      }
    }
  }

  /** Turns a result into the flat list of rows to render. */
  private rowsFor(result: GridResult<T>): GridRowList<T> {
    const hierarchy = this.tree;
    const details = this.detailHeight;
    const key = this.rowKey;
    const hasDetails =
      details !== null && key !== null && this.openDetailKeys.size > 0;
    const substitute =
      this.pendingWrites.size === 0
        ? null
        : (row: T): T => this.substituteWrite(row);
    const sourceIndexOf = result.sourceIndexOf;

    if (result.isGrouped) {
      // Pending writes are substituted into the tree before it is flattened.
      // Doing it only in the flat row lists meant an optimistic edit was
      // invisible in a grouped or tree grid: the cell showed the old value
      // until the server answered, which is the whole thing the overlay
      // exists to prevent.
      let groups = this.mergeLoadedGroups(result.groups);
      if (substitute !== null) {
        groups = groups.map((node) => node.mapRows(substitute));
      }
      if (!hasDetails) {
        // Lazy: a toggle rebuilds an index over the groups, not a wrapper per
        // visible row. See GroupedRowList.
        return new GroupedRowList<T>(groups, this.expansion, {
          loadingPaths: this.loadingGroups,
          sourceIndexOf,
        });
      }
      // Detail panels are interleaved into a materialised list; a grid with
      // panels open is a grid with few enough rows for that to be fine.
      const flattened = flattenGroups<T>(groups, this.expansion, {
        loadingPaths: this.loadingGroups,
        sourceIndexOf,
      });
      return new MaterialisedRowList<T>(
        withDetailRows<T>(flattened, {
          open: this.openDetailKeys,
          height: details,
          keyOf: key,
        }),
      );
    }

    if (hierarchy !== null && key !== null) {
      const flattened = flattenTree<T>({
        rows:
          substitute === null ? result.rows : result.rows.map(substitute),
        spec: hierarchy,
        keyOf: key,
        expansion: this.treeExpansion,
        loadedChildren: this.loadedChildren,
        loadingKeys: this.loadingChildren,
        substitute,
        sourceIndexOf,
        // A nested model's children never reach the data source, so the sort
        // has to be applied to each level as the tree is flattened.
        childComparator:
          this.sortList.length === 0 || !hierarchy.isNested
            ? null
            : buildComparator<T>(this.sortList, this.columnsByField),
      });
      return new MaterialisedRowList<T>(
        hasDetails
          ? withDetailRows<T>(flattened, {
              open: this.openDetailKeys,
              height: details,
              keyOf: key,
            })
          : flattened,
      );
    }

    if (!hasDetails) {
      // Lazy: an ungrouped 50k-row grid must not allocate 50k wrappers on
      // every change. See LazyDataRowList.
      return new LazyDataRowList<T>(result.rows, {
        offset: this.query.offset,
        substitute,
        sourceIndexOf,
      });
    }
    // Still lazy with panels open: the positions are resolved arithmetically
    // rather than by building a list. See DetailRowList.
    const openAt: number[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      if (this.openDetailKeys.has(key(result.rows[i] as T))) openAt.push(i);
    }
    return new DetailRowList<T>(result.rows, {
      openAt,
      height: details,
      keyOf: key,
      offset: this.query.offset,
      substitute,
      sourceIndexOf,
    });
  }

  /**
   * Identities of the rows the selection, the active cell and any open edit
   * are pointing at, keyed by their current index.
   *
   * Null when nothing needs tracking — no rowKey, or nothing selected — which
   * is what keeps the common refresh free of a scan over every row.
   */
  private trackedRowKeys(): Map<number, RowKey> | null {
    const key = this.rowKey;
    if (key === null) return null;
    // Only the rows whose identity has to be followed: for a select-all that
    // is the handful of exceptions, not every row in the grid.
    const indices = new Set<number>(this.selection.followedRows);
    const active = this.selection.activeCell;
    if (active !== null) indices.add(active.row);
    const anchor = this.selection.anchor;
    if (anchor !== null) indices.add(anchor.row);
    const range = this.selection.range;
    if (range !== null) {
      indices.add(range.anchor.row);
      indices.add(range.focus.row);
    }
    const session = this.edit;
    if (session !== null) indices.add(session.cell.row);
    if (indices.size === 0) return null;

    const out = new Map<number, RowKey>();
    for (const index of indices) {
      if (index < 0 || index >= this.rows.length) continue;
      const row = this.rows.at(index);
      if (isDataRow(row)) {
        out.set(index, key(row.data));
      } else if (isGroupRow(row)) {
        // A header has an identity too — its path — and keeping its raw index
        // meant collapsing a group above it slid the selection onto a
        // different group's header.
        out.set(index, headerIdentity(row.path));
      }
    }
    return out.size === 0 ? null : out;
  }

  /** Where each row now sits, by identity. */
  private rowPositions(): Map<RowKey, number> {
    const key = this.rowKey;
    const out = new Map<RowKey, number>();
    if (key === null) return out;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows.at(i);
      // First occurrence wins, so a duplicated key degrades to the topmost
      // row rather than to an arbitrary one.
      if (isDataRow(row)) {
        const identity = key(row.data);
        if (!out.has(identity)) out.set(identity, i);
      } else if (isGroupRow(row)) {
        const identity = headerIdentity(row.path);
        if (!out.has(identity)) out.set(identity, i);
      }
    }
    return out;
  }

  // -- Sorting --------------------------------------------------------------

  /**
   * Applies the header-click sort cycle to `field`.
   *
   * `additive` is the ctrl/cmd-click behaviour that builds a multi-level sort
   * instead of replacing it.
   */
  toggleSort(field: string, options: { additive?: boolean } = {}): void {
    const column = this.column(field);
    if (column === null || !column.sortable) return;
    this.sortList = cycleSort(this.sortList, field, {
      additive: options.additive ?? false,
    });
    this.resetPaging();
    void this.refresh();
  }

  setSorts(sorts: readonly SortSpec[]): void {
    this.sortList = [...sorts];
    this.resetPaging();
    void this.refresh();
  }

  clearSorts(): void {
    this.setSorts([]);
  }

  /**
   * Which sort level `field` occupies, or null when it is unsorted. Adapters
   * use this to number the arrows in a multi-column sort.
   */
  sortPriority(field: string): number | null {
    const index = this.sortList.findIndex((s) => s.field === field);
    return index < 0 ? null : index + 1;
  }

  sortFor(field: string): SortSpec | null {
    return this.sortList.find((s) => s.field === field) ?? null;
  }

  // -- Filtering ------------------------------------------------------------

  /**
   * Sets the filter row condition for one column. A null or empty condition
   * clears it.
   */
  setColumnFilter(field: string, condition: FilterCondition | null): void {
    if (condition === null || condition.isEmpty) {
      if (!this.columnFilterMap.delete(field)) return;
    } else {
      this.columnFilterMap.set(field, condition);
    }
    this.resetPaging();
    void this.refresh({ coalesce: true });
  }

  /** Sets a structured filter that sits alongside the per-column filter row. */
  setFilter(filter: Filter | null): void {
    this.filterValue = filter;
    this.resetPaging();
    void this.refresh();
  }

  clearFilters(): void {
    if (
      this.filterValue === null &&
      this.columnFilterMap.size === 0 &&
      this.searchText.length === 0
    ) {
      return;
    }
    this.filterValue = null;
    this.columnFilterMap.clear();
    this.searchText = '';
    this.resetPaging();
    void this.refresh();
  }

  /** Sets the quick-search text applied across filterable columns. */
  setSearch(text: string): void {
    if (this.searchText === text) return;
    this.searchText = text;
    this.resetPaging();
    void this.refresh({ coalesce: true });
  }

  // -- Grouping -------------------------------------------------------------

  groupBy(field: string): void {
    if (this.groupList.some((g) => g.field === field)) return;
    const column = this.column(field);
    if (column === null || !column.groupable) return;
    this.groupList = [...this.groupList, new GroupSpec(field)];
    this.resetPaging();
    void this.refresh();
  }

  setGroups(groups: readonly GroupSpec[]): void {
    this.groupList = [...groups];
    this.resetPaging();
    void this.refresh();
  }

  ungroup(field: string): void {
    const next = this.groupList.filter((g) => g.field !== field);
    if (next.length === this.groupList.length) return;
    this.setGroups(next);
  }

  clearGroups(): void {
    this.setGroups([]);
  }

  /** Opens or closes one group header. */
  toggleGroup(path: string): void {
    this.expansion.toggle(path);
    this.rebuildRows();
  }

  setGroupExpanded(path: string, expanded: boolean): void {
    this.expansion.setExpanded(path, expanded);
    this.rebuildRows();
  }

  expandAllGroups(): void {
    this.expansion.expandAll();
    this.rebuildRows();
  }

  /** Closes every group, including ones not yet on screen. */
  collapseAllGroups(): void {
    this.expansion.collapseAll();
    this.rebuildRows();
  }

  /**
   * Re-flattens without re-querying: expansion does not change which rows
   * matched, only which are on screen.
   */
  private rebuildRows(): void {
    const result = this.result;
    if (result === null || !result.isGrouped) return;
    this.apply(result);
  }

  /** Rebuilds the visible rows from the last result, whatever shape it has. */
  private reapply(): void {
    const result = this.result;
    if (result !== null) this.apply(result);
  }

  // -- Tree rows ------------------------------------------------------------

  /** Children fetched for a lazily loaded tree, keyed by rowKey. */
  private readonly loadedChildren = new Map<RowKey, readonly T[]>();
  private readonly loadingChildren = new Set<RowKey>();
  private readonly childErrors = new Map<RowKey, unknown>();

  /** Whether this grid's children arrive asynchronously. */
  get isLazyTree(): boolean {
    return this.isTree && (this.tree as TreeSpec<T>).isLazy;
  }

  /**
   * Whether the grid is waiting for the children of the row with this
   * identity.
   */
  isLoadingChildren(key: RowKey): boolean {
    return this.loadingChildren.has(key);
  }

  /** Error from the last attempt to load that row's children, if it failed. */
  childrenError(key: RowKey): unknown {
    return this.childErrors.get(key) ?? null;
  }

  /** Forgets a row's children so they are fetched again when it is next open. */
  invalidateChildren(key: RowKey): void {
    this.loadedChildren.delete(key);
    this.childErrors.delete(key);
    this.reapply();
  }

  /**
   * Asks the loader for the children of every open branch that has none.
   *
   * Driven from the rows on screen, like the lazy group loader, so a branch
   * inside a closed one costs nothing until its parent opens.
   */
  private requestOpenBranches(): void {
    const loader = this.tree?.childrenLoader ?? null;
    const key = this.rowKey;
    if (loader === null || key === null) return;
    const pending: T[] = [];
    for (const row of this.rows) {
      if (!isDataRow(row)) continue;
      if (!row.hasChildren || !row.expanded) continue;
      const identity = key(row.data);
      if (this.loadedChildren.has(identity)) continue;
      if (this.loadingChildren.has(identity)) continue;
      if (this.childErrors.has(identity)) continue;
      pending.push(row.data);
    }
    if (pending.length === 0) return;
    for (const row of pending) this.loadingChildren.add(key(row));
    // Re-flatten first, so an open branch says it is loading before the
    // requests go out. Every key is marked by now, so this cannot ask twice.
    this.reapply();
    for (const row of pending) {
      void this.loadChildren(row, key(row), loader);
    }
  }

  private async loadChildren(
    row: T,
    key: RowKey,
    loader: (row: T) => Promise<readonly T[]>,
  ): Promise<void> {
    const generation = this.sourceGeneration;
    try {
      const children = await loader(row);
      if (this.isDisposed || generation !== this.sourceGeneration) return;
      this.loadedChildren.set(key, children);
    } catch (error) {
      if (error instanceof FetchCancelled) return;
      if (this.isDisposed || generation !== this.sourceGeneration) return;
      // One branch that would not load is not a failure of the grid.
      this.childErrors.set(key, error);
    } finally {
      if (generation === this.sourceGeneration) {
        this.loadingChildren.delete(key);
        if (!this.isDisposed) this.reapply();
      }
    }
  }

  /** Opens or closes one branch, addressed by `DataGridRow.treePath`. */
  toggleRow(path: string): void {
    this.treeExpansion.toggle(path);
    this.reapply();
  }

  setRowExpanded(path: string, expanded: boolean): void {
    this.treeExpansion.setExpanded(path, expanded);
    this.reapply();
  }

  /**
   * The `DataGridRow.treePath` of the row with this rowKey.
   *
   * A branch is remembered by its own key rather than by the chain of its
   * ancestors — repeating the ancestors made the paths grow quadratically
   * with depth — and the key is encoded with its type so that `1` and `'1'`
   * cannot name the same branch.
   */
  treePathFor(key: RowKey): string {
    return pathKeySegment(key);
  }

  expandAllRows(): void {
    this.treeExpansion.expandAll();
    this.reapply();
  }

  /** Closes every branch, including ones the user has never opened. */
  collapseAllRows(): void {
    if (this.tree === null) return;
    this.treeExpansion.collapseAll();
    this.reapply();
  }

  // -- Columns --------------------------------------------------------------

  setColumns(columns: readonly GridColumn<T>[]): void {
    requireDistinctFields(columns);
    this.columnList = [...columns];
    this.columnsChanged();
    this.source.columns = this.columnsByField;
    // New columns change the geometry as well as the rows, and the batch
    // unions the two into one notification rather than two rebuilds.
    this.batch(() => {
      this.notifyListeners([GridChange.layout]);
      void this.refresh();
    });
  }

  /** Records an interactive resize, clamped to the column's bounds. */
  resizeColumn(field: string, width: number): void {
    const column = this.column(field);
    if (column === null || !column.resizable) return;
    this.columnWidths.set(field, column.clampWidth(width));
    this.notifyListeners([GridChange.layout]);
  }

  /**
   * Widens or narrows `field` to fit its contents, and returns the width it
   * settled on.
   *
   * The engine cannot measure text — that is the one thing it has to ask the
   * toolkit for — so the caller passes `measure`, which returns the width of
   * a string in logical pixels. The engine samples the rows, formats the
   * values and takes the widest.
   *
   * At most `sampleSize` rows are measured, spread evenly across the view
   * rather than taken from the top, because the widest value in a 50k-row
   * column is rarely in the first screenful and measuring all of them is not
   * affordable. The result is a best fit, not a guarantee: a row that was not
   * sampled can still be clipped.
   */
  autoSizeColumn(
    field: string,
    options: {
      measure: (text: string) => number;
      sampleSize?: number;
      padding?: number;
      includeHeader?: boolean;
    },
  ): number | null {
    const {
      measure,
      sampleSize = 200,
      padding = 24,
      includeHeader = true,
    } = options;
    const column = this.column(field);
    if (column === null || !column.resizable) return null;

    let widest = includeHeader ? measure(column.title) : 0;
    const rows = this.rows;
    const step =
      rows.length <= sampleSize ? 1 : Math.floor(rows.length / sampleSize);
    for (let i = 0; i < rows.length; i += step) {
      const row = rows.at(i);
      if (!isDataRow(row)) continue;
      const width = measure(column.formattedValue(row.data));
      if (width > widest) widest = width;
    }

    const fitted = column.clampWidth(widest + padding);
    this.columnWidths.set(field, fitted);
    this.notifyListeners([GridChange.layout]);
    return fitted;
  }

  /**
   * Fits every visible column, in one notification.
   *
   * `measure` is given the column as well as the text, so an adapter can use
   * each column's own style rather than one style for the grid.
   */
  autoSizeColumns(options: {
    measure: (column: GridColumn<T>, text: string) => number;
    sampleSize?: number;
    padding?: number;
    includeHeader?: boolean;
  }): void {
    const {
      measure,
      sampleSize = 200,
      padding = 24,
      includeHeader = true,
    } = options;
    const rows = this.rows;
    const step =
      rows.length <= sampleSize ? 1 : Math.floor(rows.length / sampleSize);
    let changed = false;
    for (const column of this.visibleColumns) {
      if (!column.resizable) continue;
      let widest = includeHeader ? measure(column, column.title) : 0;
      for (let i = 0; i < rows.length; i += step) {
        const row = rows.at(i);
        if (!isDataRow(row)) continue;
        const width = measure(column, column.formattedValue(row.data));
        if (width > widest) widest = width;
      }
      this.columnWidths.set(column.field, column.clampWidth(widest + padding));
      changed = true;
    }
    if (changed) this.notifyListeners([GridChange.layout]);
  }

  resetColumnWidth(field: string): void {
    if (this.columnWidths.delete(field)) {
      this.notifyListeners([GridChange.layout]);
    }
  }

  widthOf(field: string): number {
    const column = this.column(field);
    if (column === null) return 0;
    return column.clampWidth(this.columnWidths.get(field) ?? column.width);
  }

  setColumnVisible(field: string, visible: boolean): void {
    const index = this.columnList.findIndex((c) => c.field === field);
    if (index < 0 || (this.columnList[index] as GridColumn<T>).visible === visible) {
      return;
    }
    this.columnList[index] = (this.columnList[index] as GridColumn<T>).copyWith({
      visible,
    });
    this.columnsChanged();
    this.batch(() => {
      this.notifyListeners([GridChange.layout]);
      // A hidden column leaves the search fields, so the rows can change too.
      void this.refresh();
    });
  }

  setColumnPin(field: string, pin: ColumnPin): void {
    const index = this.columnList.findIndex((c) => c.field === field);
    if (index < 0 || (this.columnList[index] as GridColumn<T>).pin === pin) {
      return;
    }
    this.columnList[index] = (this.columnList[index] as GridColumn<T>).copyWith({
      pin,
    });
    this.columnsChanged();
    this.notifyListeners([GridChange.layout]);
  }

  /**
   * Moves `field` to `newIndex` in *display* order.
   *
   * Display order is what the user drags in, and it is not the declaration
   * order: a hidden column takes a slot in the list and none on screen, so
   * moving to index 2 used to land at display position 1 whenever a hidden
   * column sat before it.
   *
   * Pinning still wins: a pinned band is drawn as a band whatever the
   * declaration order says, so a column cannot be dragged out of its band
   * without being unpinned first. Within a band this is exact.
   */
  moveColumn(field: string, newIndex: number): void {
    const from = this.columnList.findIndex((c) => c.field === field);
    if (from < 0) return;
    const moved = this.columnList[from] as GridColumn<T>;
    const rest = this.visibleColumns
      .filter((column) => column.field !== field)
      .map((column) => column.field);
    const target = newIndex < 0 ? 0 : Math.min(newIndex, rest.length);
    this.columnList.splice(from, 1);
    let insertAt: number;
    if (rest.length === 0) {
      insertAt = Math.min(from, this.columnList.length);
    } else if (target >= rest.length) {
      insertAt =
        this.columnList.findIndex(
          (c) => c.field === (rest[rest.length - 1] as string),
        ) + 1;
    } else {
      insertAt = this.columnList.findIndex(
        (c) => c.field === (rest[target] as string),
      );
    }
    this.columnList.splice(
      insertAt < 0 ? this.columnList.length : insertAt,
      0,
      moved,
    );
    this.columnsChanged();
    this.notifyListeners([GridChange.layout]);
  }

  /**
   * Header rows spanning several columns, drawn above the column titles,
   * outermost first.
   */
  get stackedHeaders(): readonly HeaderRow[] {
    return this.stackedHeaderRows;
  }

  set stackedHeaders(rows: readonly HeaderRow[]) {
    const next = [...rows];
    requireValidHeaders(next, this.columnList);
    this.stackedHeaderRows = next;
    this.notifyListeners([GridChange.layout]);
  }

  /** Resolves panes and widths for a viewport `width` wide. */
  layoutFor(width: number): GridLayout<T> {
    return computeLayout<T>(this.columnList, {
      viewportWidth: width,
      widthOverrides: this.columnWidths,
      fit: this.columnFit,
    });
  }

  // -- Rows -----------------------------------------------------------------

  rowAt(index: number): GridRow<T> | null {
    return index < 0 || index >= this.rows.length ? null : this.rows.at(index);
  }

  /** The data row at `index`, or null when that row is a group header. */
  dataAt(index: number): T | null {
    const row = this.rowAt(index);
    return row !== null && isDataRow(row) ? row.data : null;
  }

  /** Data rows currently selected, group headers skipped. */
  get selectedData(): T[] {
    const out: T[] = [];
    for (const index of this.selection.selectedRows) {
      const data = this.dataAt(index);
      if (data !== null) out.push(data);
    }
    return out;
  }

  /** Fields in display order, which range selection needs to resolve columns. */
  get visibleFields(): string[] {
    return this.visibleColumns.map((c) => c.field);
  }

  selectRow(index: number, modifiers: SelectionModifiers = noModifiers): void {
    this.selection.selectRow(index, modifiers);
    this.notifyListeners([GridChange.selection]);
  }

  selectCell(
    address: CellAddress,
    modifiers: SelectionModifiers = noModifiers,
  ): void {
    this.selection.selectCell(address, this.visibleFields, modifiers);
    this.notifyListeners([GridChange.selection]);
  }

  extendSelectionTo(address: CellAddress): void {
    this.selection.extendTo(address, this.visibleFields);
    this.notifyListeners([GridChange.selection]);
  }

  selectAllRows(): void {
    this.selection.selectAll(this.rows.length);
    this.notifyListeners([GridChange.selection]);
  }

  /** How much of the grid is selected, for a select-all checkbox. */
  get selectionCoverage(): SelectionCoverage {
    return this.selection.coverageOf(this.rows.length);
  }

  /**
   * What a header checkbox should do when tapped.
   *
   * Anything short of everything selects the rest; a full selection clears.
   * That is the behaviour of every spreadsheet and mail client, and it means
   * the control never needs a separate "deselect all".
   */
  toggleSelectAll(): void {
    if (this.selectionCoverage === SelectionCoverage.all) {
      this.clearSelection();
    } else {
      this.selectAllRows();
    }
  }

  /**
   * Selects or deselects one row, leaving the rest alone.
   *
   * What a row checkbox does, as distinct from a click on the row, which
   * replaces the selection.
   */
  setRowSelected(index: number, selected: boolean): void {
    if (this.selection.isRowSelected(index) === selected) return;
    this.selection.selectRow(index, { toggle: true });
    this.notifyListeners([GridChange.selection]);
  }

  clearSelection(): void {
    this.selection.clear();
    this.notifyListeners([GridChange.selection]);
  }

  /** Moves the active cell by a row and column delta, as an arrow key does. */
  moveActiveCell(
    rowDelta: number,
    columnDelta: number,
    options: { extend?: boolean } = {},
  ): void {
    const fields = this.visibleFields;
    if (fields.length === 0 || this.rows.length === 0) return;
    const current = this.selection.activeCell;
    const row = Math.min(
      Math.max((current?.row ?? 0) + rowDelta, 0),
      this.rows.length - 1,
    );
    const columnIndex =
      current === null
        ? 0
        : Math.min(
            Math.max(fields.indexOf(current.field) + columnDelta, 0),
            fields.length - 1,
          );
    const next = new CellAddress(row, fields[columnIndex] as string);
    if (options.extend === true) {
      this.extendSelectionTo(next);
    } else {
      this.selectCell(next);
    }
  }

  /**
   * Moves the active cell by whole screenfuls, as PageUp and PageDown do.
   *
   * `rowsPerPage` comes from the adapter, which is the only side that knows
   * how many rows the viewport is showing. A negative `pages` moves up.
   */
  movePages(
    pages: number,
    options: { rowsPerPage: number; extend?: boolean },
  ): void {
    if (options.rowsPerPage <= 0) return;
    this.moveActiveCell(pages * options.rowsPerPage, 0, {
      extend: options.extend ?? false,
    });
  }

  /**
   * Moves the active cell to the first or last column of its row, as Home and
   * End do.
   */
  moveToLineEdge(options: { start: boolean; extend?: boolean }): void {
    const fields = this.visibleFields;
    if (fields.length === 0 || this.rows.length === 0) return;
    const row = this.selection.activeCell?.row ?? 0;
    const next = new CellAddress(
      row,
      options.start
        ? (fields[0] as string)
        : (fields[fields.length - 1] as string),
    );
    if (options.extend === true) this.extendSelectionTo(next);
    else this.selectCell(next);
  }

  /**
   * Moves the active cell to the very first or very last cell of the grid, as
   * ctrl-Home and ctrl-End do.
   */
  moveToGridEdge(options: { start: boolean; extend?: boolean }): void {
    const fields = this.visibleFields;
    if (fields.length === 0 || this.rows.length === 0) return;
    const next = options.start
      ? new CellAddress(0, fields[0] as string)
      : new CellAddress(
          this.rows.length - 1,
          fields[fields.length - 1] as string,
        );
    if (options.extend === true) this.extendSelectionTo(next);
    else this.selectCell(next);
  }

  /**
   * Moves the active cell to the next editable cell in reading order, as Tab
   * does, and returns where it landed.
   *
   * Skips columns that cannot be edited and rows that are group headers,
   * wrapping to the next row at the end of one. With `wrap` true it also
   * wraps from the last editable cell round to the first, which is what makes
   * Tab a way to walk a form; with it false the walk stops at the end and
   * returns null, leaving the selection where it was.
   *
   * Returns null when the grid has no editable cell at all, which is also how
   * an adapter can tell that Tab should move focus out of the grid instead.
   */
  moveToNextEditableCell(
    options: { backwards?: boolean; wrap?: boolean } = {},
  ): CellAddress | null {
    const backwards = options.backwards ?? false;
    const wrap = options.wrap ?? true;
    // A column with a setter is only editable if the source can save it — the
    // same door beginEdit refuses at. Walking into cells that cannot be
    // edited gave the user a tab order to nowhere.
    if (!this.canEdit) return null;
    const fields = this.visibleColumns
      .filter((column) => column.editable)
      .map((column) => column.field);
    if (fields.length === 0 || this.rows.length === 0) return null;

    const current = this.selection.activeCell;
    const all = this.visibleFields;
    let row = current?.row ?? 0;
    // Where in the editable fields the active cell sits. A cell in a column
    // that is not editable still has a place in the order: the next editable
    // column to its right.
    let slot = current === null ? -1 : fields.indexOf(current.field);
    if (current !== null && slot < 0) {
      const at = all.indexOf(current.field);
      slot = -1;
      for (let i = 0; i < fields.length; i++) {
        if (all.indexOf(fields[i] as string) < at) slot = i;
      }
    }

    const step = backwards ? -1 : 1;
    const total = this.rows.length * fields.length;
    for (let moved = 0; moved < total; moved++) {
      slot += step;
      if (slot >= fields.length) {
        slot = 0;
        row++;
      } else if (slot < 0) {
        slot = fields.length - 1;
        row--;
      }
      if (row >= this.rows.length) {
        if (!wrap) return null;
        row = 0;
      } else if (row < 0) {
        if (!wrap) return null;
        row = this.rows.length - 1;
      }
      if (this.dataAt(row) === null) continue;
      const next = new CellAddress(row, fields[slot] as string);
      this.selectCell(next);
      return next;
    }
    return null;
  }

  // -- Frozen rows ----------------------------------------------------------

  /**
   * Rows pinned to the top of the viewport, taken from the start of
   * {@link visibleRows}.
   *
   * Freezing is by position rather than by identity, which is what makes it
   * useful: pin two rows and sort, and the pinned rows are whatever now sorts
   * first. A row pinned by identity would instead jump around, which is the
   * opposite of what the name promises.
   */
  get frozenRowCount(): number {
    return this.frozenTop;
  }

  set frozenRowCount(value: number) {
    const clamped = value < 0 ? 0 : value;
    if (clamped === this.frozenTop) return;
    this.frozenTop = clamped;
    this.notifyListeners([GridChange.layout, GridChange.rows]);
  }

  /**
   * Rows pinned to the bottom of the viewport, taken from the end of
   * {@link visibleRows}. A totals row usually lives here.
   */
  get frozenRowCountBottom(): number {
    return this.frozenBottom;
  }

  set frozenRowCountBottom(value: number) {
    const clamped = value < 0 ? 0 : value;
    if (clamped === this.frozenBottom) return;
    this.frozenBottom = clamped;
    this.notifyListeners([GridChange.layout, GridChange.rows]);
  }

  /**
   * How many rows are actually frozen at the top, once the row count is taken
   * into account.
   *
   * Freezing more rows than exist would leave nothing to scroll, so the two
   * frozen bands together are capped at one row fewer than the grid has.
   */
  get effectiveFrozenTop(): number {
    if (this.frozenTop <= 0 || this.rowCount === 0) return 0;
    return this.frozenTop > this.rowCount - 1
      ? this.rowCount - 1
      : this.frozenTop;
  }

  /**
   * How many rows are actually frozen at the bottom. The top band wins when
   * the two would overlap, because it is the one the user is looking at.
   */
  get effectiveFrozenBottom(): number {
    if (this.frozenBottom <= 0 || this.rowCount === 0) return 0;
    const room = this.rowCount - this.effectiveFrozenTop - 1;
    if (room <= 0) return 0;
    return this.frozenBottom > room ? room : this.frozenBottom;
  }

  /**
   * The rows pinned to the top, in display order.
   *
   * A read-only slice onto {@link visibleRows}, not a copy: copying a window
   * onto a lazy row list builds every row in it, and an adapter reads these
   * bands every frame.
   */
  get frozenTopRows(): GridRowList<T> {
    return this.rows.slice(0, this.effectiveFrozenTop);
  }

  /** The rows pinned to the bottom, in display order. */
  get frozenBottomRows(): GridRowList<T> {
    return this.rows.slice(
      this.rows.length - this.effectiveFrozenBottom,
      this.rows.length,
    );
  }

  /** The rows that actually scroll, between the two frozen bands. */
  get scrollableRows(): GridRowList<T> {
    return this.rows.slice(
      this.effectiveFrozenTop,
      this.rows.length - this.effectiveFrozenBottom,
    );
  }

  /** Whether the row at `index` in {@link visibleRows} is frozen. */
  isRowFrozen(index: number): boolean {
    return (
      index < this.effectiveFrozenTop ||
      index >= this.rows.length - this.effectiveFrozenBottom
    );
  }

  // -- Conditional formatting -----------------------------------------------

  /**
   * Range of the values currently shown in `field`.
   *
   * A result that carries stats for the column wins: a remote source knows
   * the range over the whole filtered set, while the grid only holds the page
   * it was sent.
   */
  statsFor(field: string): ColumnStats {
    return this.result?.stats.get(field) ?? this.source.statsFor(field);
  }

  /**
   * The distinct values of `field` for a checkbox filter list, computed over
   * the rows that match every filter except this column's own.
   *
   * Empty when the source cannot answer. `DistinctValues.truncated` says
   * whether there were more than `limit`.
   */
  distinctValuesFor(field: string, limit = 500): DistinctValues {
    return this.source.distinctValuesFor(field, limit);
  }

  /**
   * The filter operators worth offering for `field`, most useful first.
   *
   * Resolved from the column's type, so an adapter builds its menu from the
   * engine's model of the column instead of its own switch.
   */
  operatorsForField(field: string): FilterOperator[] {
    const column = this.column(field);
    return column === null ? [] : operatorsFor(column.type);
  }

  /**
   * How the cell at `field` in `row` should be emphasised.
   *
   * Returns `CellDecoration.none` when the column has no rule, so an adapter
   * can call this for every visible cell without a null check and without
   * paying for columns that are not formatted.
   */
  decorationFor(field: string, row: T): CellDecoration {
    const column = this.column(field);
    const rule = column?.rule ?? null;
    if (column === null || rule === null) return CellDecoration.none;
    return rule.decorate(column.value(row), this.statsFor(field)) ??
      CellDecoration.none;
  }

  // -- Editing --------------------------------------------------------------

  /**
   * Opens an edit session, if the cell is editable. Returns null otherwise.
   *
   * A cell is editable when its column has a setter *and* the data source can
   * write rows back. Refusing at the door is deliberate: an editor the grid
   * cannot save is a worse outcome than no editor, because the user only
   * finds out after typing.
   */
  beginEdit(address: CellAddress): EditSession<T> | null {
    const column = this.column(address.field);
    const data = this.dataAt(address.row);
    if (column === null || data === null || !column.editable) return null;
    if (!this.source.canCommit) return null;
    this.edit = new EditSession<T>({
      cell: address,
      column,
      row: data,
      initialValue: column.value(data),
    });
    this.notifyListeners([GridChange.edit]);
    return this.edit;
  }

  /** Updates the in-flight value, re-running validation. */
  updateEdit(value: CellValue): void {
    this.edit?.update(value);
    this.notifyListeners([GridChange.edit]);
  }

  /**
   * Validates and writes the edit back through the source's `commit`.
   *
   * A rejected edit keeps the session open with its error set, so the user
   * can correct the value instead of losing it.
   *
   * The write itself is asynchronous, because a remote source has a round
   * trip to make, and this returns as soon as the value has passed
   * validation. The new value is on screen from that moment: it is held as a
   * pending write and substituted into whatever the source returns next, so
   * the re-fetch that follows a write cannot show the old value again. If the
   * write fails, the pending value is dropped — the cell goes back to what
   * the source holds — and the reason appears in {@link writeError}. Await
   * {@link pendingWrite} to observe the outcome.
   */
  commitEdit(): EditResult<T> {
    const session = this.edit;
    if (session === null) return EditResult.cancelled<T>();
    const dirty = session.isDirty;
    const result = session.commit();
    if (result.isRejected) {
      this.notifyListeners([GridChange.edit]);
      return result;
    }
    this.edit = null;
    const row = result.row;
    if (row === null) {
      this.notifyListeners([GridChange.edit]);
      return result;
    }
    if (!dirty) {
      // Nothing changed, so there is nothing to save and nothing to undo.
      // Writing anyway sent a request to the server and refetched the grid
      // for a cell the user had only looked at.
      this.notifyListeners([GridChange.edit]);
      return result;
    }
    this.history.record(
      new EditAction<T>({
        label: `Edit ${session.column.title}`,
        changes: [
          new CellEdit<T>({
            row,
            field: session.cell.field,
            before: session.originalValue,
            after: session.value,
          }),
        ],
      }),
    );
    this.pendingWritePromise = this.writeAll(
      [new RowUpdate<T>(session.row, row)],
      [new Map([[session.cell.field, session.originalValue]])],
    );
    return result;
  }

  /**
   * Rows written but not yet confirmed by the source, keyed by identity.
   *
   * Each entry remembers which write owns it, so that a write finishing
   * cannot clear the entry a newer write for the same row has since put
   * there. It used to remove the key unconditionally, which made a slow first
   * write wipe the second one: the cell went back to showing the first value
   * while the second was still in flight.
   */
  private readonly pendingWrites = new Map<RowKey, PendingWrite<T>>();
  private writeSequence = 0;
  private writeErrorValue: unknown = null;
  private pendingWritePromise: Promise<void> | null = null;

  /** Whether an edit has been committed and not yet confirmed by the source. */
  get hasPendingWrites(): boolean {
    return this.pendingWrites.size > 0;
  }

  /**
   * Error thrown by the last write, if it failed.
   *
   * Distinct from {@link error}, which is a failed fetch: a rejected write
   * leaves the rows on screen intact and only means one value did not save.
   */
  get writeError(): unknown {
    return this.writeErrorValue;
  }

  clearWriteError(): void {
    if (this.writeErrorValue === null) return;
    this.writeErrorValue = null;
    this.notifyListeners([GridChange.status]);
  }

  /** The write in flight, for tests and for a UI that wants to await it. */
  get pendingWrite(): Promise<void> | null {
    return this.pendingWritePromise;
  }

  /** Whether cells can be edited at all, i.e. the source can write rows back. */
  get canEdit(): boolean {
    return this.source.canCommit;
  }

  /**
   * Identity used to match a pending write to a fetched row.
   *
   * Falls back to the row object itself when there is no rowKey, which is
   * right for a source that hands back the same instances and is the reason
   * an immutable model wants a rowKey.
   */
  private identityOf(row: T): RowKey {
    return this.rowKey === null ? row : this.rowKey(row);
  }

  private substituteWrite(row: T): T {
    return this.pendingWrites.get(this.identityOf(row))?.row ?? row;
  }

  /**
   * Sends committed rows to the source, showing them immediately and rolling
   * them back if the source refuses them.
   *
   * One call is one change: a paste across twenty rows goes down as a single
   * batch and the grid re-queries once, because twenty write-through
   * refreshes would also be twenty re-sorts.
   *
   * `before` holds each row's previous values by field, which is what a
   * rollback needs for a model whose setter mutates in place: dropping the
   * overlay puts the *overlay* back, not the row, and the object stayed
   * mutated with the value the source had just refused.
   */
  private async writeAll(
    writes: readonly RowUpdate<T>[],
    before?: readonly Map<string, CellValue>[],
  ): Promise<void> {
    if (writes.length === 0) return;
    const source = this.source;
    if (!source.canCommit) {
      // beginEdit refuses a read-only source, so reaching this means the
      // source was swapped mid-edit.
      this.writeErrorValue = new GridStateError(
        `${source.constructor.name} cannot save edits.`,
      );
      this.notifyListeners([GridChange.status]);
      return;
    }

    if (source.isLocal) {
      // A local source answers synchronously and its own write-through
      // refresh already shows the new values; an overlay would only buy a
      // second rebuild.
      try {
        await source.commitAll(writes);
      } catch (error) {
        if (this.isDisposed) return;
        this.rollback(writes, before);
        this.writeErrorValue = error;
        this.notifyListeners([GridChange.rows, GridChange.status]);
      }
      return;
    }

    const sequence = ++this.writeSequence;
    const keys = writes.map((write) => this.identityOf(write.original));
    for (let i = 0; i < writes.length; i++) {
      this.pendingWrites.set(keys[i] as RowKey, {
        row: (writes[i] as RowUpdate<T>).updated,
        sequence,
      });
    }
    this.writeErrorValue = null;
    this.reapply();

    /** Drops only the entries this write still owns. */
    const releaseOwn = (): void => {
      for (const key of keys) {
        if (this.pendingWrites.get(key)?.sequence === sequence) {
          this.pendingWrites.delete(key);
        }
      }
    };

    try {
      const stored = await source.commitAll(writes);
      if (this.isDisposed) return;
      // The source may have normalised the values; show what it returned —
      // unless a newer write for the same row has taken the slot, in which
      // case the newer value is the one on screen and the one to keep.
      for (let i = 0; i < keys.length && i < stored.length; i++) {
        const key = keys[i] as RowKey;
        if (this.pendingWrites.get(key)?.sequence === sequence) {
          this.pendingWrites.set(key, { row: stored[i] as T, sequence });
        }
      }
      // Re-query, so an edit that changed a sort or filter key moves its row.
      // The pending values cover the gap until the source's own copies carry
      // them.
      await this.refresh();
      if (this.isDisposed) return;
      releaseOwn();
      this.reapply();
    } catch (error) {
      if (this.isDisposed) return;
      releaseOwn();
      this.rollback(writes, before);
      this.writeErrorValue = error;
      this.reapply();
    }
  }

  /**
   * Puts the previous values back through the columns' setters.
   *
   * For an immutable model this is a no-op in effect — the setter returns a
   * copy and the row the source holds was never touched — and for a model
   * that mutates in place it is the only way back: the row object itself
   * carries the refused value until something overwrites it.
   */
  private rollback(
    writes: readonly RowUpdate<T>[],
    before?: readonly Map<string, CellValue>[],
  ): void {
    if (before === undefined) return;
    const byField = this.columnsByField;
    for (let i = 0; i < writes.length && i < before.length; i++) {
      for (const [field, value] of before[i] as Map<string, CellValue>) {
        byField.get(field)?.setValue?.(
          (writes[i] as RowUpdate<T>).original,
          value,
        );
      }
    }
  }

  // -- Paste ----------------------------------------------------------------

  /**
   * Writes clipboard text into the grid, starting at `at` or at the active
   * cell.
   *
   * The inverse of {@link copySelectionAsText}: the text is split into rows
   * and cells, each cell is parsed into its column's type and put through
   * that column's validator, and the result is written as one change that one
   * {@link undo} takes back.
   *
   * Columns are filled rightwards from the target in screen order and rows
   * downwards. A block that runs past the edge of the grid is clipped rather
   * than growing it — the engine has no way to invent a row — and
   * `PasteResult.cellsClipped` says how much was left out.
   *
   * With `allOrNothing` true, the default, a single bad cell writes nothing:
   * half a pasted block is harder to recover from than none of it, because
   * the user cannot see where it stopped. Pass false to write what fits and
   * read `PasteResult.rejections` for the rest.
   */
  pasteText(
    text: string,
    options: {
      at?: CellAddress | null;
      allOrNothing?: boolean;
      delimiter?: string;
    } = {},
  ): PasteResult {
    const allOrNothing = options.allOrNothing ?? true;
    const delimiter = options.delimiter ?? '\t';
    const target = options.at ?? this.selection.activeCell;
    if (target === null) return PasteResult.noTarget();
    if (!this.source.canCommit) {
      return new PasteResult({
        rejections: [
          new PasteRejection({
            cell: target,
            text,
            reason: `${this.source.constructor.name} cannot save edits`,
          }),
        ],
      });
    }

    const block = parseClipboardText(text, { delimiter });
    if (block.length === 0) return new PasteResult();

    const fields = this.visibleFields;
    const firstColumn = fields.indexOf(target.field);
    if (firstColumn < 0) return PasteResult.noTarget();

    const byField = this.columnsByField;
    const rejections: PasteRejection[] = [];
    const changes: CellEdit<T>[] = [];
    // Several cells can land in one row, and that row has to be written once,
    // with all of them applied.
    const patches: RowPatch<T>[] = [];
    const slots = new Map<RowKey, number>();
    let clipped = 0;

    // A group header or a detail panel is not a row that can be written to,
    // and the clipboard row aimed at it belongs to the next row that can:
    // treating it as "no row here" dropped a row of the user's data in the
    // middle of a paste, silently.
    let cursor = target.row;
    for (let r = 0; r < block.length; r++) {
      const line = block[r] as string[];
      while (cursor < this.rows.length && !isDataRow(this.rows.at(cursor))) {
        cursor++;
      }
      const rowIndex = cursor;
      const data = this.dataAt(rowIndex);
      if (data === null) {
        clipped += line.length;
        continue;
      }
      cursor++;
      const identity = this.identityOf(data);
      for (let c = 0; c < line.length; c++) {
        const columnIndex = firstColumn + c;
        if (columnIndex >= fields.length) {
          clipped++;
          continue;
        }
        const field = fields[columnIndex] as string;
        const column = byField.get(field) ?? null;
        const address = new CellAddress(rowIndex, field);
        const raw = line[c] as string;
        if (column === null || !column.editable) {
          rejections.push(
            new PasteRejection({
              cell: address,
              text: raw,
              reason: 'Column is not editable',
            }),
          );
          continue;
        }
        const value = coerceValue(raw, column.type);
        if (value === null && raw.trim().length > 0) {
          rejections.push(
            new PasteRejection({
              cell: address,
              text: raw,
              reason: `Not a ${column.type}`,
            }),
          );
          continue;
        }
        const error = column.validator?.(value) ?? null;
        if (error !== null) {
          rejections.push(
            new PasteRejection({ cell: address, text: raw, reason: error }),
          );
          continue;
        }
        const before = column.value(data);
        if (sameCellValue(before, value)) continue;
        let slot = slots.get(identity);
        if (slot === undefined) {
          slot = patches.length;
          slots.set(identity, slot);
          patches.push({ row: data, values: new Map<string, CellValue>() });
        }
        (patches[slot] as RowPatch<T>).values.set(field, value);
        changes.push(
          new CellEdit<T>({ row: data, field, before, after: value }),
        );
      }
    }

    if (rejections.length > 0 && allOrNothing) {
      return new PasteResult({ cellsClipped: clipped, rejections });
    }
    if (changes.length === 0) {
      return new PasteResult({ cellsClipped: clipped, rejections });
    }

    this.history.record(new EditAction<T>({ label: 'Paste', changes }));
    const before = this.beforeValuesFor(patches);
    this.pendingWritePromise = this.writeAll(this.updatesFor(patches), before);
    this.notifyListeners([GridChange.rows, GridChange.status]);
    return new PasteResult({
      rowsChanged: patches.length,
      cellsChanged: changes.length,
      cellsClipped: clipped,
      rejections,
      applied: true,
    });
  }

  private updatesFor(patches: readonly RowPatch<T>[]): RowUpdate<T>[] {
    return patches.map(
      (patch) => new RowUpdate<T>(patch.row, this.withValues(patch.row, patch.values)),
    );
  }

  /**
   * The values each patch is about to overwrite, by field.
   *
   * Read before the setters run, because a setter that mutates in place
   * destroys the only copy of them.
   */
  private beforeValuesFor(
    patches: readonly RowPatch<T>[],
  ): Map<string, CellValue>[] {
    return patches.map((patch) => {
      const out = new Map<string, CellValue>();
      for (const field of patch.values.keys()) {
        out.set(field, this.column(field)?.value(patch.row) ?? null);
      }
      return out;
    });
  }

  /**
   * Applies several cell values to one row, through the columns' setters.
   *
   * A setter that returns null has mutated the row in place, so the chain
   * carries on with the row it was given.
   */
  private withValues(row: T, values: ReadonlyMap<string, CellValue>): T {
    let updated = row;
    for (const [field, value] of values) {
      const setValue = this.column(field)?.setValue ?? null;
      if (setValue === null) continue;
      updated = setValue(updated, value) ?? updated;
    }
    return updated;
  }

  // -- Undo and redo --------------------------------------------------------

  /**
   * Undo and redo over committed edits.
   *
   * Read it for `canUndo` and the labels of the next steps; call {@link undo}
   * and {@link redo} rather than its own take methods, so the change is
   * actually written back.
   */
  readonly history: EditHistory<T> = new EditHistory<T>();

  /**
   * Takes back the last committed edit or paste, as one step.
   *
   * Returns false when there is nothing to undo, or when not one of the rows
   * the action touched could be found. The history is only moved when
   * something was actually written, so an undo that cannot be applied leaves
   * the step where it was rather than consuming it — which used to make the
   * edit permanently unrepeatable, with `canUndo` false and `canRedo` true.
   *
   * Rows are resolved through the data source, not through what is on screen,
   * so an undo reaches a row on another page, inside a closed group or
   * filtered out of view. A source that pages a backend cannot offer that —
   * see `GridDataSource.localRows` — and {@link lastReplay} then says how
   * many cells were skipped.
   */
  undo(): boolean {
    const action = this.history.peekUndo();
    if (action === null) return false;
    const outcome = this.replay(action.inverse);
    if (!outcome.didAnything) return false;
    this.history.commitUndo();
    return true;
  }

  /** Re-applies the edit {@link undo} took back. */
  redo(): boolean {
    const action = this.history.peekRedo();
    if (action === null) return false;
    const outcome = this.replay(action);
    if (!outcome.didAnything) return false;
    this.history.commitRedo();
    return true;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  private lastReplayOutcome: ReplayOutcome = ReplayOutcome.nothing();

  /**
   * What came of the last {@link undo} or {@link redo}: how many cells were
   * written and how many could not be found.
   *
   * A partial undo is a real outcome — some of the rows an action touched may
   * be gone — and a bare boolean could not report it.
   */
  get lastReplay(): ReplayOutcome {
    return this.lastReplayOutcome;
  }

  private replay(action: EditAction<T> | null): ReplayOutcome {
    if (action === null || action.isEmpty) {
      this.lastReplayOutcome = ReplayOutcome.nothing();
      return this.lastReplayOutcome;
    }
    const patches: RowPatch<T>[] = [];
    const slots = new Map<RowKey, number>();
    let applied = 0;
    let unresolved = 0;

    for (const change of action.changes) {
      const current = this.currentRowFor(change.row);
      if (current === null) {
        unresolved++;
        continue;
      }
      applied++;
      const identity = this.identityOf(current);
      let slot = slots.get(identity);
      if (slot === undefined) {
        slot = patches.length;
        slots.set(identity, slot);
        patches.push({ row: current, values: new Map<string, CellValue>() });
      }
      (patches[slot] as RowPatch<T>).values.set(change.field, change.after);
    }
    if (patches.length === 0) {
      this.lastReplayOutcome = new ReplayOutcome({ applied: 0, unresolved });
      return this.lastReplayOutcome;
    }

    const before = this.beforeValuesFor(patches);
    this.pendingWritePromise = this.writeAll(this.updatesFor(patches), before);
    this.notifyListeners([GridChange.rows, GridChange.status]);
    this.lastReplayOutcome = new ReplayOutcome({ applied, unresolved });
    return this.lastReplayOutcome;
  }

  /**
   * The instance the grid currently holds for `row`, matched by rowKey where
   * there is one.
   *
   * Looks through the data source rather than through the visible rows: an
   * undo has to reach a row that is filtered out, on another page or inside a
   * closed group, and searching the view silently skipped it.
   */
  private currentRowFor(row: T): T | null {
    const key = this.rowKey;
    if (key === null) return row;
    const wanted = key(row);
    const index = this.keyIndex();
    if (index !== null) return index.get(wanted) ?? null;
    for (const visible of this.rows) {
      if (isDataRow(visible) && key(visible.data) === wanted) {
        return visible.data;
      }
    }
    return null;
  }

  private keyIndexCache: Map<RowKey, T> | null = null;
  private keyIndexRevision = -1;
  private keyIndexGeneration = -1;

  /**
   * Every row the source holds, by rowKey, or null when the source cannot
   * enumerate its rows.
   *
   * Built once per source revision and shared by everything that has to find
   * a row it is not showing.
   */
  private keyIndex(): Map<RowKey, T> | null {
    const key = this.rowKey;
    if (key === null) return null;
    const rows = this.source.localRows;
    if (rows === null) return null;
    if (
      this.keyIndexCache !== null &&
      this.keyIndexRevision === this.source.revision &&
      this.keyIndexGeneration === this.sourceGeneration
    ) {
      return this.keyIndexCache;
    }
    const index = new Map<RowKey, T>();
    for (const row of rows) index.set(key(row), row);
    this.keyIndexCache = index;
    this.keyIndexRevision = this.source.revision;
    this.keyIndexGeneration = this.sourceGeneration;
    return index;
  }

  cancelEdit(): void {
    if (this.edit === null) return;
    this.edit.cancel();
    this.edit = null;
    this.notifyListeners([GridChange.edit]);
  }

  isEditing(address: CellAddress): boolean {
    return this.edit !== null && this.edit.cell.equals(address);
  }

  // -- Export ---------------------------------------------------------------

  /**
   * Exports the current view as CSV, matching what is on screen.
   *
   * Columns are written in screen order, so a pinned column exports where the
   * user sees it. Pass `fields` to override that.
   */
  exportCsv(options: ExportOptions = {}): string {
    const exporter = new CsvExporter<T>(
      options.fields === undefined || options.fields === null
        ? this.visibleColumns
        : this.columnList,
      options,
    );
    const result = this.result;
    if (result === null) return '';
    return exporter.exportResult(result, this.expansion);
  }

  /** Copies the selected range (or rows) as tab-separated clipboard text. */
  copySelectionAsText(options: { includeHeader?: boolean } = {}): string {
    const includeHeader = options.includeHeader ?? false;
    const fields = this.visibleFields;
    const byField = this.columnsByField;
    const lines: string[][] = [];
    const range = this.selection.range;

    // A group header is not a row of data. Emitting a line of empty tabs for
    // it put a blank row at the top of the clipboard, which pastes as a blank
    // row; the header's own label goes in the first cell instead, which is
    // what a spreadsheet user expects of a copied outline.
    const cellsFor = (
      rowIndex: number,
      fieldSet: readonly string[],
    ): string[] | null => {
      if (rowIndex < 0 || rowIndex >= this.rows.length) return null;
      const row = this.rows.at(rowIndex);
      if (isGroupRow(row)) {
        const padding = new Array<string>(
          fieldSet.length === 0 ? 0 : fieldSet.length - 1,
        ).fill('');
        return [`${row.label} (${row.rowCount})`, ...padding];
      }
      const data = this.dataAt(rowIndex);
      if (data === null) return null;
      return fieldSet.map((f) => byField.get(f)?.formattedValue(data) ?? '');
    };

    if (range !== null) {
      const covered = range.coveredFields;
      if (includeHeader) {
        lines.push(covered.map((f) => byField.get(f)?.title ?? f));
      }
      for (let r = range.firstRow; r <= range.lastRow; r++) {
        const cells = cellsFor(r, covered);
        if (cells !== null) lines.push(cells);
      }
    } else {
      if (includeHeader) {
        lines.push(fields.map((f) => byField.get(f)?.title ?? f));
      }
      for (const index of this.selection.selectedRows) {
        const cells = cellsFor(index, fields);
        if (cells !== null) lines.push(cells);
      }
    }
    return toClipboardText(lines);
  }

  // -- Saved views ----------------------------------------------------------

  /**
   * The current arrangement, ready to be stored as JSON.
   *
   * Covers everything the user set: the ordering, the filters and the search,
   * the grouping and which groups they closed, the page, and the column
   * widths, order, pinning and visibility. What it cannot cover is code — an
   * aggregation's reducer, a column's accessors, a group spec's bucketing
   * functions — which stay with the definitions the grid is built from.
   */
  saveState(): GridViewState {
    return new GridViewState({
      sorts: [...this.sortList],
      filter: this.filterValue,
      columnFilters: new Map(this.columnFilterMap),
      search: this.searchText,
      groups: [...this.groupList],
      collapsedGroupPaths: [...this.expansion.overrides],
      columns: this.columnList.map(
        (c) =>
          new ColumnViewState({
            field: c.field,
            // Only a width the user actually dragged.
            width: this.columnWidths.get(c.field) ?? null,
            visible: c.visible,
            pin: c.pin,
          }),
      ),
      pageIndex: this.pageIndexValue,
      pageSize: this.pageSizeValue,
      frozenRowCount: this.frozenTop,
      frozenRowCountBottom: this.frozenBottom,
      columnFit: this.columnFit,
      groupsExpandedByDefault: this.expansion.expandedByDefault,
    });
  }

  /**
   * Applies a saved arrangement and re-queries once.
   *
   * Columns in the view that the grid does not have are ignored, and columns
   * the grid has that the view does not know about keep their definitions and
   * follow the restored ones — so a view saved before a column was added
   * still restores, with the new column at the end.
   *
   * `resolveGroup` is given each restored `GroupSpec` and returns the one to
   * use, which is how a grouping with a `keyOf` survives the round trip: the
   * JSON remembers the field, your code supplies the function.
   */
  restoreState(
    state: GridViewState,
    options: { resolveGroup?: (restored: GroupSpec) => GroupSpec } = {},
  ): void {
    if (state.columns.length > 0) {
      const byField = new Map(this.columnList.map((c) => [c.field, c]));
      const restored: GridColumn<T>[] = [];
      this.columnWidths.clear();
      for (const saved of state.columns) {
        const column = byField.get(saved.field);
        if (column === undefined) continue;
        byField.delete(saved.field);
        restored.push(
          column.copyWith({ visible: saved.visible, pin: saved.pin }),
        );
        if (saved.width !== null) {
          this.columnWidths.set(saved.field, saved.width);
        }
      }
      // Columns the view never saw keep their place relative to each other.
      for (const column of this.columnList) {
        if (byField.has(column.field)) restored.push(column);
      }
      this.columnList = restored;
      this.columnsChanged();
      this.source.columns = this.columnsByField;
    }

    const resolveGroup = options.resolveGroup;
    this.sortList = [...state.sorts];
    this.filterValue = state.filter;
    this.columnFilterMap.clear();
    for (const [field, condition] of state.columnFilters) {
      this.columnFilterMap.set(field, condition);
    }
    this.searchText = state.search;
    this.groupList = state.groups.map((g) =>
      resolveGroup === undefined ? g : resolveGroup(g),
    );
    this.expansion.setOverrides(state.collapsedGroupPaths, {
      expandedByDefault: state.groupsExpandedByDefault,
    });
    this.pageSizeValue = state.pageSize;
    this.pageIndexValue = state.pageIndex < 0 ? 0 : state.pageIndex;
    this.frozenTop = state.frozenRowCount;
    this.frozenBottom = state.frozenRowCountBottom;
    this.columnFit = state.columnFit;
    // One query for the whole restore: setting these one at a time would send
    // a request per property.
    //
    // The layout notification is part of that one change. Restoring widths,
    // the column order and pinning is exactly a layout change, and without
    // saying so an adapter that only relays out on GridChange.layout kept
    // drawing the geometry the view replaced.
    this.notifyListeners([GridChange.layout]);
    void this.refresh();
  }

  /**
   * Swaps the data source, e.g. from a local array to a server-backed one.
   *
   * Everything derived from the old source is dropped: its lazily loaded
   * groups and tree children, the errors they reported, writes still in
   * flight, which detail panels were open, and the undo history — whose
   * actions name rows this source has never heard of. A loader started for
   * the old source checks the generation before it answers, so a reply that
   * is already in the air cannot graft the old data onto the new source.
   */
  setDataSource(source: GridDataSource<T>): void {
    this.source.removeListener(this.sourceListener);
    this.sourceGeneration++;
    this.source = source;
    this.source.columns = this.columnsByField;
    this.source.addListener(this.sourceListener);
    this.loadedGroups.clear();
    this.groupErrors.clear();
    this.loadingGroups.clear();
    this.loadedChildren.clear();
    this.loadingChildren.clear();
    this.childErrors.clear();
    this.openDetailKeys.clear();
    this.pendingWrites.clear();
    this.writeErrorValue = null;
    this.history.clear();
    this.cancelFetch('the data source was replaced');
    this.resetPaging();
    void this.refresh();
  }

  /**
   * Bumped by {@link setDataSource}, so an in-flight loader can tell whether
   * the source it was started for is still the one on screen.
   */
  private sourceGeneration = 0;

  override dispose(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    // A caller awaiting a debounced refresh is owed an answer even when the
    // answer is "never": leaving the promise pending hung that caller for the
    // life of the process and leaked the test that wrote it.
    const pending = this.debounced;
    this.debounced = null;
    pending?.resolve();
    this.cancelFetch('the grid was disposed');
    this.source.removeListener(this.sourceListener);
    super.dispose();
  }
}

/**
 * Whether every column names a different field.
 *
 * Two columns with one field is not a layout choice: the by-field lookup
 * keeps one of them, so the other silently loses its filters, its sort and
 * its editing. Accepting it quietly was the bug.
 */
function requireDistinctFields<T>(columns: readonly GridColumn<T>[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.field)) duplicates.add(column.field);
    seen.add(column.field);
  }
  if (duplicates.size === 0) return;
  throw new GridArgumentError(
    `Two columns cannot share a field: ${[...duplicates].join(', ')}. ` +
      "A field is a column's identity — its filters, its sort and its saved " +
      'width are all keyed on it.',
  );
}

function requireValidHeaders<T>(
  rows: readonly HeaderRow[],
  columns: readonly GridColumn<T>[],
): void {
  const problems = describeHeaderProblems<T>(rows, columns);
  if (problems.length > 0) {
    throw new GridStateError(`Stacked headers:\n  ${problems.join('\n  ')}`);
  }
}

/** Whether two cell values are the same, with dates compared by instant. */
function sameCellValue(a: CellValue, b: CellValue): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** Re-exported for convenience: the quickest source to point at an endpoint. */
export { AsyncDataSource };
