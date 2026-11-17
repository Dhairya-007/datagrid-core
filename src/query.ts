/**
 * The request a grid makes of its data source.
 *
 * @module
 */

import { AggregateResult, type Aggregation } from './aggregate';
import { foldText } from './compare';
import type { ColumnStats } from './decoration';
import type { FetchSignal } from './fetch';
import { Filter } from './filter';
import { GroupSpec, type GroupNode } from './group';
import {
  GRID_SCHEMA_VERSION,
  GRID_SCHEMA_VERSION_KEY,
  requireSupportedSchema,
  type JsonMap,
} from './schema';
import { SortSpec } from './sort';

/** Options for a {@link GridQuery}. */
export interface GridQueryOptions {
  sorts?: readonly SortSpec[];
  /** Structured filter tree from the filter row or filter builder. */
  filter?: Filter | null;
  /**
   * Free-text search applied across {@link searchFields}, or across every
   * visible column when that is empty.
   */
  search?: string;
  searchFields?: readonly string[];
  groups?: readonly GroupSpec[];
  /** Aggregates to compute for group rows and the footer. */
  aggregations?: readonly Aggregation[];
  /** First row to return. */
  offset?: number;
  /** Maximum number of rows to return; null means all of them. */
  limit?: number | null;
  /**
   * Tells the source the grid has given up on this fetch, so a remote request
   * can be aborted rather than merely ignored when it lands.
   *
   * Null when the query was built by hand. Not part of {@link
   * GridQuery.toJSON}: it describes one attempt, not what the grid wants to
   * show.
   */
  signal?: FetchSignal | null;
  /**
   * Asks for group headers without their rows.
   *
   * Grouping normally needs every matching row, because a header has to count
   * its group — which means grouping a remote source downloads the whole
   * table. A source that can group server-side answers a lazy query with
   * headers and counts only (see `GroupNode.declaredCount`), and the grid
   * asks for a group's contents when the user opens it.
   */
  lazyGroups?: boolean;
}

/**
 * A complete description of what the grid wants to show.
 *
 * Everything the view state implies — ordering, filtering, grouping, the
 * search box, the current page — is collected here and handed to a
 * `GridDataSource`. An in-memory source executes it locally; a remote source
 * translates it into SQL or query parameters. The grid itself never assumes
 * which.
 */
export class GridQuery {
  readonly sorts: readonly SortSpec[];
  readonly filter: Filter | null;
  readonly search: string;
  readonly searchFields: readonly string[];
  readonly groups: readonly GroupSpec[];
  readonly aggregations: readonly Aggregation[];
  readonly offset: number;
  readonly limit: number | null;
  readonly signal: FetchSignal | null;
  readonly lazyGroups: boolean;

  constructor(options: GridQueryOptions = {}) {
    this.sorts = options.sorts ?? [];
    this.filter = options.filter ?? null;
    this.search = options.search ?? '';
    this.searchFields = options.searchFields ?? [];
    this.groups = options.groups ?? [];
    this.aggregations = options.aggregations ?? [];
    this.offset = options.offset ?? 0;
    this.limit = options.limit ?? null;
    this.signal = options.signal ?? null;
    this.lazyGroups = options.lazyGroups ?? false;
    Object.freeze(this);
  }

  /**
   * The search text as matching actually uses it: trimmed, lowercased and
   * with diacritics folded away, so that typing `creme` finds `Crème`.
   *
   * Defined here rather than in each source, so that a source and the cache
   * key it stores a result under cannot disagree about what was searched for.
   */
  get needle(): string {
    return foldText(this.search.trim());
  }

  // -- Cache identity ------------------------------------------------------
  //
  // Each stage of the pipeline is memoised against the part of the query it
  // depends on, and these are that part's identity. They are built from each
  // spec's own `fingerprint` rather than assembled from fields here, because
  // a key assembled by its caller is a key that forgets a field the next time
  // one is added — which is exactly how regrouping with a different `keyOf`
  // came to serve the previous buckets.

  /**
   * Identity of everything that decides which rows match, apart from the
   * search text.
   *
   * Separate from {@link matchFingerprint} because a source can narrow the
   * previous result when only the needle grew, and that shortcut needs to
   * know the rest of the filter is unchanged.
   */
  get filterFingerprint(): string {
    return `${this.filter?.fingerprint ?? ''}\u0000${this.searchFields.join(',')}`;
  }

  /** Identity of which rows match. */
  get matchFingerprint(): string {
    return `${this.filterFingerprint}\u0000${this.needle}`;
  }

  /** Identity of which rows match and in what order. */
  get orderFingerprint(): string {
    const sorts = this.sorts.map((s) => s.fingerprint).join(',');
    return `${this.matchFingerprint}\u0000${sorts}`;
  }

  /** Identity of the aggregates computed over the matching rows. */
  get aggregateFingerprint(): string {
    const aggregations = this.aggregations.map((a) => a.fingerprint).join(',');
    return `${this.orderFingerprint}\u0000${aggregations}`;
  }

  /** Identity of the group tree, aggregates included. */
  get groupFingerprint(): string {
    const groups = this.groups.map((g) => g.fingerprint).join(',');
    return `${this.aggregateFingerprint}\u0000${groups}`;
  }

  get hasSearch(): boolean {
    return this.search.trim().length > 0;
  }

  get isGrouped(): boolean {
    return this.groups.length > 0;
  }

  get isPaged(): boolean {
    return this.limit !== null;
  }

  /**
   * A copy with the given fields replaced. `undefined` keeps what is there;
   * `null` clears `filter` or `limit`.
   */
  copyWith(patch: GridQueryOptions): GridQuery {
    return new GridQuery({
      sorts: patch.sorts ?? this.sorts,
      filter: patch.filter === undefined ? this.filter : patch.filter,
      search: patch.search ?? this.search,
      searchFields: patch.searchFields ?? this.searchFields,
      groups: patch.groups ?? this.groups,
      aggregations: patch.aggregations ?? this.aggregations,
      offset: patch.offset ?? this.offset,
      limit: patch.limit === undefined ? this.limit : patch.limit,
      signal: patch.signal ?? this.signal,
      lazyGroups: patch.lazyGroups ?? this.lazyGroups,
    });
  }

  /** JSON for storage or for an HTTP backend, stamped with the schema version. */
  toJSON(): JsonMap {
    const json: JsonMap = {
      [GRID_SCHEMA_VERSION_KEY]: GRID_SCHEMA_VERSION,
    };
    if (this.sorts.length > 0)
      json['sorts'] = this.sorts.map((s) => s.toJSON());
    if (this.filter !== null) json['filter'] = this.filter.toJSON();
    if (this.hasSearch) json['search'] = this.search;
    if (this.searchFields.length > 0) {
      json['searchFields'] = [...this.searchFields];
    }
    if (this.groups.length > 0) {
      json['groups'] = this.groups.map((g) => g.toJSON());
    }
    if (this.offset !== 0) json['offset'] = this.offset;
    if (this.limit !== null) json['limit'] = this.limit;
    if (this.lazyGroups) json['lazyGroups'] = true;
    return json;
  }

  /**
   * Rebuilds a query produced by {@link toJSON}.
   *
   * `aggregations` cannot be serialised — an {@link Aggregation} may carry a
   * reducer function — so they are passed back in. Neither is the
   * cancellation signal, which belongs to one attempt rather than to the
   * query, nor a `GroupSpec`'s bucketing functions; see `GroupSpec.restore`.
   */
  static fromJSON(
    json: JsonMap,
    options: { aggregations?: readonly Aggregation[] } = {},
  ): GridQuery {
    requireSupportedSchema(json, 'This query');
    const sorts = Array.isArray(json['sorts']) ? json['sorts'] : [];
    const groups = Array.isArray(json['groups']) ? json['groups'] : [];
    const searchFields = Array.isArray(json['searchFields'])
      ? json['searchFields']
      : [];
    const filter = json['filter'];
    const search = json['search'];
    return new GridQuery({
      sorts: sorts.map((s) => SortSpec.fromJSON(s as JsonMap)),
      filter:
        typeof filter === 'object' && filter !== null && !Array.isArray(filter)
          ? Filter.fromJSON(filter as JsonMap)
          : null,
      search: typeof search === 'string' ? search : '',
      searchFields: searchFields.map((f) => String(f)),
      groups: groups.map((g) => GroupSpec.fromJSON(g as JsonMap)),
      aggregations: options.aggregations ?? [],
      offset: readInt(json['offset']) ?? 0,
      limit: readInt(json['limit']),
      lazyGroups: json['lazyGroups'] === true,
    });
  }

  toString(): string {
    return `GridQuery(${JSON.stringify(this.toJSON())})`;
  }
}

function readInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return null;
  return Math.trunc(raw);
}

/** Options for a {@link GridResult}. */
export interface GridResultOptions<T> {
  /** The page of data rows, already ordered. Empty when `groups` is used. */
  rows: readonly T[];
  /** Total rows in the source before filtering, for "x of y" labels. */
  totalCount: number;
  /** Rows that matched the filter, before paging. Defaults to `totalCount`. */
  filteredCount?: number | null;
  /** The grouped tree, when the query asked for grouping. */
  groups?: readonly GroupNode<T>[];
  /** Grid-wide aggregates for the summary footer. */
  aggregates?: AggregateResult;
  /**
   * Per-column ranges, keyed by field, for conditional formatting.
   *
   * A local source computes these itself, so this is how a remote one makes
   * data bars and colour scales work at all: without a min and a max there is
   * nothing to draw a bar against, and a rule over a server-paged column
   * silently did nothing. A source that returns stats for a column overrides
   * its own `statsFor` for as long as the result stands.
   */
  stats?: ReadonlyMap<string, ColumnStats>;
  /**
   * Where a row sits in the source, before any filtering or ordering.
   *
   * Supplied by a source that can answer it — one holding its rows locally —
   * and read by the grid for `DataGridRow.sourceIndex`. Null from a source
   * that pages remotely and cannot know, which reports -1 instead.
   *
   * A function rather than an array so that a source can build its lookup on
   * the first call: a grid that never reads `sourceIndex` must not pay for an
   * index over every matching row.
   */
  sourceIndexOf?: ((row: T) => number) | null;
}

/** The answer to a {@link GridQuery}. */
export class GridResult<T> {
  readonly rows: readonly T[];
  readonly totalCount: number;
  readonly filteredCount: number | null;
  readonly groups: readonly GroupNode<T>[];
  readonly aggregates: AggregateResult;
  readonly stats: ReadonlyMap<string, ColumnStats>;
  readonly sourceIndexOf: ((row: T) => number) | null;

  constructor(options: GridResultOptions<T>) {
    this.rows = options.rows;
    this.totalCount = options.totalCount;
    this.filteredCount = options.filteredCount ?? null;
    this.groups = options.groups ?? [];
    this.aggregates = options.aggregates ?? AggregateResult.empty;
    this.stats = options.stats ?? new Map<string, ColumnStats>();
    this.sourceIndexOf = options.sourceIndexOf ?? null;
  }

  get matchedCount(): number {
    return this.filteredCount ?? this.totalCount;
  }

  get isGrouped(): boolean {
    return this.groups.length > 0;
  }

  get isEmpty(): boolean {
    return this.rows.length === 0 && this.groups.length === 0;
  }

  toString(): string {
    return `GridResult(${this.rows.length} rows of ${this.matchedCount}/${this.totalCount})`;
  }
}
