/**
 * A saved view: how the user arranged the grid, as plain JSON.
 *
 * @module
 */

import { ColumnPin } from './column';
import { GridFormatError } from './errors';
import { Filter, FilterCondition } from './filter';
import { GroupSpec } from './group';
import { ColumnFit } from './layout';
import {
  GRID_SCHEMA_VERSION,
  GRID_SCHEMA_VERSION_KEY,
  requireSupportedSchema,
  type JsonMap,
} from './schema';
import { SortSpec } from './sort';

/** One column's arrangement. */
export class ColumnViewState {
  /** Which column this describes. */
  readonly field: string;

  /**
   * The user's resized width, or null if they never dragged it.
   *
   * Null rather than the column's declared width on purpose: a saved view
   * that records a width the user never chose would pin the layout to
   * whatever the default was on the day they saved it.
   */
  readonly width: number | null;

  readonly visible: boolean;
  readonly pin: ColumnPin;

  constructor(options: {
    field: string;
    width?: number | null;
    visible?: boolean;
    pin?: ColumnPin;
  }) {
    this.field = options.field;
    this.width = options.width ?? null;
    this.visible = options.visible ?? true;
    this.pin = options.pin ?? ColumnPin.none;
    Object.freeze(this);
  }

  /**
   * Position in the column list is carried by the order of
   * {@link GridViewState.columns}, not by an index here, so a view restored
   * onto a grid whose columns have changed cannot leave two columns claiming
   * the same slot.
   */
  toJSON(): JsonMap {
    const json: JsonMap = { field: this.field };
    if (this.width !== null) json['width'] = this.width;
    if (!this.visible) json['visible'] = false;
    if (this.pin !== ColumnPin.none) json['pin'] = this.pin;
    return json;
  }

  static fromJSON(json: JsonMap): ColumnViewState {
    const field = json['field'];
    if (typeof field !== 'string' || field.length === 0) {
      throw new GridFormatError('A saved column needs a non-empty "field"');
    }
    const width = json['width'];
    const pin = json['pin'];
    return new ColumnViewState({
      field,
      width: typeof width === 'number' ? width : null,
      visible: json['visible'] !== false,
      pin:
        pin === ColumnPin.start || pin === ColumnPin.end ? pin : ColumnPin.none,
    });
  }

  toString(): string {
    return `ColumnViewState(${this.field})`;
  }
}

/** Options for a {@link GridViewState}. */
export interface GridViewStateOptions {
  sorts?: readonly SortSpec[];
  filter?: Filter | null;
  columnFilters?: ReadonlyMap<string, FilterCondition>;
  search?: string;
  groups?: readonly GroupSpec[];
  collapsedGroupPaths?: readonly string[];
  columns?: readonly ColumnViewState[];
  pageIndex?: number;
  pageSize?: number | null;
  frozenRowCount?: number;
  frozenRowCountBottom?: number;
  columnFit?: ColumnFit;
  groupsExpandedByDefault?: boolean;
}

/**
 * Everything about how a grid is arranged, in a form that round-trips through
 * storage or an HTTP backend.
 *
 * "Remember my layout" is one of the first things a user asks of a grid, and
 * it needs more than the query: the widths they dragged, the order they moved
 * columns into, what they hid and what they pinned.
 *
 * What a view cannot carry is functions. Aggregations, a column's accessors
 * and a `GroupSpec`'s `keyOf`/`labelOf` are code, so they stay with the
 * column and group definitions the grid is built from; restoring a view
 * re-applies the saved group fields to the specs you supply. See
 * `GridController.restoreState`.
 */
export class GridViewState {
  readonly sorts: readonly SortSpec[];

  /** The structured filter set alongside the filter row, if any. */
  readonly filter: Filter | null;

  /** Filter-row conditions, keyed by field. */
  readonly columnFilters: ReadonlyMap<string, FilterCondition>;

  readonly search: string;
  readonly groups: readonly GroupSpec[];

  /**
   * Group paths whose expansion differs from the grid's default.
   *
   * Named for what it usually means — the groups the user closed — but it is
   * the override set, so on a grid built with `groupsExpandedByDefault:
   * false` these are the groups they opened.
   */
  readonly collapsedGroupPaths: readonly string[];

  /** Column arrangement, in the order the columns should appear. */
  readonly columns: readonly ColumnViewState[];

  readonly pageIndex: number;
  readonly pageSize: number | null;
  readonly frozenRowCount: number;
  readonly frozenRowCountBottom: number;
  readonly columnFit: ColumnFit;

  /**
   * Whether a group the user never touched counts as open.
   *
   * Saved as well as the overrides, because "collapse all" is recorded as
   * this flag rather than as a list of paths — it has to mean groups that are
   * not on screen yet — and a view that saved only the overrides came back
   * with every group open again.
   */
  readonly groupsExpandedByDefault: boolean;

  constructor(options: GridViewStateOptions = {}) {
    this.sorts = options.sorts ?? [];
    this.filter = options.filter ?? null;
    this.columnFilters =
      options.columnFilters ?? new Map<string, FilterCondition>();
    this.search = options.search ?? '';
    this.groups = options.groups ?? [];
    this.collapsedGroupPaths = options.collapsedGroupPaths ?? [];
    this.columns = options.columns ?? [];
    this.pageIndex = options.pageIndex ?? 0;
    this.pageSize = options.pageSize ?? null;
    this.frozenRowCount = options.frozenRowCount ?? 0;
    this.frozenRowCountBottom = options.frozenRowCountBottom ?? 0;
    this.columnFit = options.columnFit ?? ColumnFit.none;
    this.groupsExpandedByDefault = options.groupsExpandedByDefault ?? true;
    Object.freeze(this);
  }

  /** JSON for storage, stamped with the schema version. */
  toJSON(): JsonMap {
    const json: JsonMap = {
      [GRID_SCHEMA_VERSION_KEY]: GRID_SCHEMA_VERSION,
    };
    if (this.sorts.length > 0) {
      json['sorts'] = this.sorts.map((s) => s.toJSON());
    }
    if (this.filter !== null) json['filter'] = this.filter.toJSON();
    if (this.columnFilters.size > 0) {
      const filters: JsonMap = {};
      for (const [field, condition] of this.columnFilters) {
        filters[field] = condition.toJSON();
      }
      json['columnFilters'] = filters;
    }
    if (this.search.length > 0) json['search'] = this.search;
    if (this.groups.length > 0) {
      json['groups'] = this.groups.map((g) => g.toJSON());
    }
    if (this.collapsedGroupPaths.length > 0) {
      json['collapsed'] = [...this.collapsedGroupPaths];
    }
    if (this.columns.length > 0) {
      json['columns'] = this.columns.map((c) => c.toJSON());
    }
    if (this.pageIndex !== 0) json['pageIndex'] = this.pageIndex;
    if (this.pageSize !== null) json['pageSize'] = this.pageSize;
    if (this.frozenRowCount !== 0) json['frozenRows'] = this.frozenRowCount;
    if (this.frozenRowCountBottom !== 0) {
      json['frozenRowsBottom'] = this.frozenRowCountBottom;
    }
    if (this.columnFit !== ColumnFit.none) json['fit'] = this.columnFit;
    if (!this.groupsExpandedByDefault) json['groupsExpanded'] = false;
    return json;
  }

  /**
   * Rebuilds a view produced by {@link toJSON}.
   *
   * Unknown fields are ignored, missing ones take their defaults, and an
   * entry this build cannot read is skipped rather than fatal: a saved view
   * is a user's own work, read back by a later version of an app, and one
   * malformed sort should not cost them the whole layout. `warnings`, when
   * given, collects a line per entry that was skipped.
   *
   * A {@link GridFormatError} is still thrown for a document written by a
   * newer schema version.
   */
  static fromJSON(json: JsonMap, warnings?: string[]): GridViewState {
    requireSupportedSchema(json, 'This saved view');

    const readList = <R>(
      raw: unknown,
      what: string,
      read: (entry: JsonMap) => R,
    ): R[] => {
      if (!Array.isArray(raw)) return [];
      const out: R[] = [];
      for (const entry of raw) {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          Array.isArray(entry)
        ) {
          warnings?.push(`A ${what} that is not an object was skipped.`);
          continue;
        }
        try {
          out.push(read(entry as JsonMap));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          warnings?.push(`A ${what} was skipped: ${message}`);
        }
      }
      return out;
    };

    const readFilter = (raw: unknown, what: string): Filter | null => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return null;
      }
      try {
        return Filter.fromJSON(raw as JsonMap, warnings);
      } catch (error) {
        if (!(error instanceof GridFormatError)) throw error;
        warnings?.push(`The ${what} was dropped: ${error.message}`);
        return null;
      }
    };

    const filters = json['columnFilters'];
    const columnFilters = new Map<string, FilterCondition>();
    if (
      typeof filters === 'object' &&
      filters !== null &&
      !Array.isArray(filters)
    ) {
      for (const [field, value] of Object.entries(filters as JsonMap)) {
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value)
        ) {
          warnings?.push(`The filter on ${field} was dropped.`);
          continue;
        }
        try {
          columnFilters.set(field, FilterCondition.fromJSON(value as JsonMap));
        } catch (error) {
          if (!(error instanceof GridFormatError)) throw error;
          warnings?.push(
            `The filter on ${field} was dropped: ${error.message}`,
          );
        }
      }
    }

    const search = json['search'];
    const collapsed = json['collapsed'];
    const fit = json['fit'];

    return new GridViewState({
      sorts: readList(json['sorts'], 'sort', (entry) =>
        SortSpec.fromJSON(entry),
      ),
      filter: readFilter(json['filter'], 'filter'),
      columnFilters,
      search: typeof search === 'string' ? search : '',
      groups: readList(json['groups'], 'grouping', (entry) =>
        GroupSpec.fromJSON(entry),
      ),
      collapsedGroupPaths: Array.isArray(collapsed)
        ? collapsed.map((p) => String(p))
        : [],
      columns: readList(json['columns'], 'column', (entry) =>
        ColumnViewState.fromJSON(entry),
      ),
      pageIndex: readInt(json['pageIndex']) ?? 0,
      pageSize: readInt(json['pageSize']),
      frozenRowCount: readInt(json['frozenRows']) ?? 0,
      frozenRowCountBottom: readInt(json['frozenRowsBottom']) ?? 0,
      columnFit:
        fit === ColumnFit.stretch || fit === ColumnFit.lastColumn
          ? fit
          : ColumnFit.none,
      groupsExpandedByDefault: json['groupsExpanded'] !== false,
    });
  }

  toString(): string {
    return `GridViewState(${JSON.stringify(this.toJSON())})`;
  }
}

function readInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return null;
  return Math.trunc(raw);
}
