/**
 * The flat list of visual rows a UI adapter renders.
 *
 * @module
 */

import { AggregateResult } from './aggregate';
import type { GroupNode } from './group';

/** Identity of a row, as `GridController.rowKey` returns it. */
export type RowKey = unknown;

/** What kind of row a {@link GridRow} is, without an `instanceof` test. */
export const GridRowKind = {
  data: 'data',
  group: 'group',
  detail: 'detail',
} as const;
export type GridRowKind = (typeof GridRowKind)[keyof typeof GridRowKind];

/**
 * A single renderable row.
 *
 * Grouping turns a tree into this flat list so that adapters can keep using a
 * plain index-based virtualized list: a group header and a data row are both
 * just rows at some index.
 */
export abstract class GridRow<T> {
  /** Which of the three kinds of row this is. */
  abstract readonly kind: GridRowKind;

  /** Position of this row in the flattened, currently visible list. */
  readonly index: number;

  /** Indentation level: 0 when ungrouped. */
  readonly depth: number;

  constructor(index: number, depth: number) {
    this.index = index;
    this.depth = depth;
  }
}

/**
 * A row's place in a tree.
 *
 * One object rather than three fields on {@link DataGridRow}, and null for
 * the flat and grouped cases. A grouped 50k-row grid allocates a
 * {@link DataGridRow} per visible row every time anything changes, and an
 * ungrouped one builds them on every read, so what those objects cost to
 * construct is a measurable part of a group toggle. A tree pays one small
 * allocation per row it actually nests; everything else pays one null field.
 */
export class TreeRowInfo {
  /**
   * Identity of this row within the tree, built from its own key.
   *
   * Used to remember which branches are open, exactly as a group's path is.
   */
  readonly path: string;

  /** Whether this row has rows of its own beneath it. */
  readonly hasChildren: boolean;

  /** Whether this row's children are shown. */
  readonly expanded: boolean;

  /**
   * Whether the grid is waiting for this row's children.
   *
   * Only ever true for a lazily loaded tree: the row is on screen, its
   * children are in flight, and an open branch should say so rather than look
   * empty.
   */
  readonly loading: boolean;

  constructor(options: {
    path: string;
    hasChildren: boolean;
    expanded: boolean;
    loading?: boolean;
  }) {
    this.path = options.path;
    this.hasChildren = options.hasChildren;
    this.expanded = options.expanded;
    this.loading = options.loading ?? false;
    Object.freeze(this);
  }

  toString(): string {
    return `TreeRowInfo(${this.path})`;
  }
}

/** Options for a {@link DataGridRow}. */
export interface DataGridRowOptions<T> {
  index: number;
  data: T;
  sourceIndex?: number;
  sourceIndexOf?: ((row: T) => number) | null;
  depth?: number;
  tree?: TreeRowInfo | null;
}

/** A row backed by one item of the data source. */
export class DataGridRow<T> extends GridRow<T> {
  override readonly kind = GridRowKind.data;

  readonly data: T;

  /** This row's place in the hierarchy, or null in a flat or grouped grid. */
  readonly tree: TreeRowInfo | null;

  private readonly storedSourceIndex: number;
  private readonly sourceIndexOf: ((row: T) => number) | null;

  constructor(options: DataGridRowOptions<T>) {
    super(options.index, options.depth ?? 0);
    this.data = options.data;
    this.storedSourceIndex = options.sourceIndex ?? -1;
    this.sourceIndexOf = options.sourceIndexOf ?? null;
    this.tree = options.tree ?? null;
  }

  /**
   * Index of {@link data} in the unordered, unfiltered source, or -1 when the
   * source cannot say.
   *
   * A source that holds its rows locally answers this exactly, whatever the
   * sort, the filter or the grouping — it used to report the row's position
   * in the *sorted* result, which is a different number and was only ever
   * right for an unsorted grid. A remote source that pages has no way to
   * know, and reports -1.
   *
   * Resolved on demand. The answer is a lookup by row identity, and a grouped
   * grid flattens every matching row on every toggle: paying for it per row
   * whether or not anyone reads it put milliseconds on a group toggle at 50k
   * rows, for a number most grids never ask for.
   */
  get sourceIndex(): number {
    if (this.storedSourceIndex >= 0) return this.storedSourceIndex;
    return this.sourceIndexOf?.(this.data) ?? this.storedSourceIndex;
  }

  /** Identity of this row within a tree, empty in a flat or grouped grid. */
  get treePath(): string {
    return this.tree?.path ?? '';
  }

  /**
   * Whether this row is a parent, i.e. it has rows of its own beneath it.
   *
   * Always false in a flat or grouped grid, so an adapter can ask any row
   * without first asking what kind of grid it is in.
   */
  get hasChildren(): boolean {
    return this.tree?.hasChildren ?? false;
  }

  /** Whether this row's children are shown. Meaningless unless {@link hasChildren}. */
  get expanded(): boolean {
    return this.tree?.expanded ?? true;
  }

  /** Whether the grid is waiting for this row's children to arrive. */
  get isLoadingChildren(): boolean {
    return this.tree?.loading ?? false;
  }

  override toString(): string {
    return `DataGridRow(${this.index} <- ${this.sourceIndex})`;
  }
}

/**
 * A panel opened under its row, for the fields a row has no room for.
 *
 * A row of a grid holds a dozen fields and a record usually has more, so the
 * common answer is a panel underneath holding whatever the application wants
 * to draw. It is a row in the flat list rather than something the view layer
 * bolts on, because everything that walks rows — virtualization,
 * scroll-to-reveal, keyboard navigation, the frozen bands — has to count it.
 *
 * The engine decides that it is there and how tall it is; what goes in it is
 * the adapter's business.
 */
export class DetailGridRow<T> extends GridRow<T> {
  override readonly kind = GridRowKind.detail;

  /** The row this panel belongs to. */
  readonly data: T;

  /** Identity of that row, which is what the open state is keyed by. */
  readonly rowKey: RowKey;

  /**
   * How tall the panel is, in logical pixels.
   *
   * Stated by the engine so that row offsets can be computed without
   * measuring anything: a prefix-sum table cannot wait for a layout pass.
   */
  readonly height: number;

  constructor(options: {
    index: number;
    data: T;
    rowKey: RowKey;
    height: number;
    depth?: number;
  }) {
    super(options.index, options.depth ?? 0);
    this.data = options.data;
    this.rowKey = options.rowKey;
    this.height = options.height;
  }

  override toString(): string {
    return `DetailGridRow(${String(this.rowKey)})`;
  }
}

/** A collapsible group header row. */
export class GroupGridRow<T> extends GridRow<T> {
  override readonly kind = GridRowKind.group;

  readonly node: GroupNode<T>;
  readonly expanded: boolean;

  /**
   * Whether the grid is waiting for this group's contents.
   *
   * Only ever true for a lazily grouped source: the header is on screen, the
   * rows are in flight, and the adapter should say so rather than leave an
   * open group looking empty.
   */
  readonly loading: boolean;

  constructor(options: {
    index: number;
    depth: number;
    node: GroupNode<T>;
    expanded: boolean;
    loading?: boolean;
  }) {
    super(options.index, options.depth);
    this.node = options.node;
    this.expanded = options.expanded;
    this.loading = options.loading ?? false;
  }

  /**
   * Whether this group's contents are in hand. False for a header whose rows
   * a lazy source has not been asked for yet.
   */
  get isLoaded(): boolean {
    return this.node.loaded;
  }

  get field(): string {
    return this.node.field;
  }

  get key(): unknown {
    return this.node.key;
  }

  get label(): string {
    return this.node.label;
  }

  get path(): string {
    return this.node.path;
  }

  get rowCount(): number {
    return this.node.rowCount;
  }

  get aggregates(): AggregateResult {
    return this.node.aggregates;
  }

  override toString(): string {
    return `GroupGridRow(${this.path}, ${this.rowCount} rows)`;
  }
}

/** Whether `row` is a data row, narrowing its type. */
export function isDataRow<T>(row: GridRow<T>): row is DataGridRow<T> {
  return row.kind === GridRowKind.data;
}

/** Whether `row` is a group header, narrowing its type. */
export function isGroupRow<T>(row: GridRow<T>): row is GroupGridRow<T> {
  return row.kind === GridRowKind.group;
}

/** Whether `row` is a detail panel, narrowing its type. */
export function isDetailRow<T>(row: GridRow<T>): row is DetailGridRow<T> {
  return row.kind === GridRowKind.detail;
}

/**
 * Tracks which group paths are open.
 *
 * Expansion is keyed by `GroupNode.path` rather than by object identity, so
 * it survives re-sorting, re-filtering and data reloads.
 */
export class GroupExpansionState {
  private defaultExpanded: boolean;

  /** Paths whose state differs from {@link expandedByDefault}. */
  private readonly overrideSet: Set<string>;

  constructor(
    options: { expanded?: Iterable<string>; expandedByDefault?: boolean } = {},
  ) {
    this.defaultExpanded = options.expandedByDefault ?? true;
    this.overrideSet = new Set(options.expanded ?? []);
  }

  /**
   * Whether a group not yet touched by the user counts as open.
   *
   * Flipped by {@link collapseAll} and {@link expandAll}, which is what lets
   * them mean "every group" rather than "every group I have seen so far".
   */
  get expandedByDefault(): boolean {
    return this.defaultExpanded;
  }

  /**
   * The paths the user has changed from the default, for a saved view.
   *
   * Saving the overrides rather than the open paths is what lets a restored
   * view stay correct when the data has grown: a group the user never touched
   * takes the grid's default, whenever it first appeared.
   */
  get overrides(): ReadonlySet<string> {
    return new Set(this.overrideSet);
  }

  /**
   * Replaces the override set, as restoring a saved view does.
   *
   * `expandedByDefault` restores the mode as well, because "collapse all" is
   * recorded as the mode and not as a list of paths.
   */
  setOverrides(
    paths: Iterable<string>,
    options: { expandedByDefault?: boolean } = {},
  ): void {
    if (options.expandedByDefault !== undefined) {
      this.defaultExpanded = options.expandedByDefault;
    }
    this.overrideSet.clear();
    for (const path of paths) this.overrideSet.add(path);
  }

  isExpanded(path: string): boolean {
    return this.overrideSet.has(path)
      ? !this.defaultExpanded
      : this.defaultExpanded;
  }

  toggle(path: string): void {
    if (!this.overrideSet.delete(path)) this.overrideSet.add(path);
  }

  setExpanded(path: string, expanded: boolean): void {
    if (expanded === this.defaultExpanded) {
      this.overrideSet.delete(path);
    } else {
      this.overrideSet.add(path);
    }
  }

  /** Opens every group, including ones not yet seen. */
  expandAll(): void {
    this.defaultExpanded = true;
    this.overrideSet.clear();
  }

  /**
   * Closes every group, including ones not yet seen.
   *
   * Enumerating the paths it knew about could only close the groups already
   * on screen, so a group that arrived later — a new page, a changed filter,
   * a lazily loaded level — opened itself again straight after a
   * collapse-all. Flipping the default is the only version of this that means
   * what it says.
   */
  collapseAll(): void {
    this.defaultExpanded = false;
    this.overrideSet.clear();
  }

  copy(): GroupExpansionState {
    return new GroupExpansionState({
      expanded: this.overrideSet,
      expandedByDefault: this.defaultExpanded,
    });
  }
}

/**
 * A read-only list of visual rows.
 *
 * Not a plain array: an ungrouped grid of 50k rows would otherwise allocate
 * 50k wrapper objects every time anything changed, which costs more than the
 * sort that preceded it. Adapters only ever touch the rows in the viewport,
 * so {@link at} builds a wrapper as it is read.
 *
 * Because a wrapper is created per read, two reads of the same index are
 * equal in content but not identical. Compare `DataGridRow.data` or
 * {@link GridRow.index} rather than identity.
 */
export abstract class GridRowList<T> implements Iterable<GridRow<T>> {
  abstract get length(): number;

  /** The row at `index`. Throws `RangeError` outside the list. */
  abstract at(index: number): GridRow<T>;

  get isEmpty(): boolean {
    return this.length === 0;
  }

  get isNotEmpty(): boolean {
    return this.length > 0;
  }

  /** The first row, or null when the list is empty. */
  get first(): GridRow<T> | null {
    return this.length === 0 ? null : this.at(0);
  }

  /** The last row, or null when the list is empty. */
  get last(): GridRow<T> | null {
    return this.length === 0 ? null : this.at(this.length - 1);
  }

  /**
   * A window onto part of this list, which reads through rather than copying.
   *
   * Row indices are not renumbered — they are positions in the full visible
   * list, which is what the selection, the frozen bands and scroll-to-reveal
   * all speak in.
   */
  slice(start: number, end: number = this.length): GridRowList<T> {
    return new RowSlice<T>(this, start, end);
  }

  /** Every row, materialised. O(rows) in both time and allocation. */
  toArray(): GridRow<T>[] {
    const out = new Array<GridRow<T>>(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.at(i);
    return out;
  }

  forEach(visit: (row: GridRow<T>, index: number) => void): void {
    for (let i = 0; i < this.length; i++) visit(this.at(i), i);
  }

  map<R>(transform: (row: GridRow<T>, index: number) => R): R[] {
    const out = new Array<R>(this.length);
    for (let i = 0; i < this.length; i++) out[i] = transform(this.at(i), i);
    return out;
  }

  find(
    test: (row: GridRow<T>, index: number) => boolean,
  ): GridRow<T> | undefined {
    for (let i = 0; i < this.length; i++) {
      const row = this.at(i);
      if (test(row, i)) return row;
    }
    return undefined;
  }

  findIndex(test: (row: GridRow<T>, index: number) => boolean): number {
    for (let i = 0; i < this.length; i++) {
      if (test(this.at(i), i)) return i;
    }
    return -1;
  }

  *[Symbol.iterator](): IterableIterator<GridRow<T>> {
    for (let i = 0; i < this.length; i++) yield this.at(i);
  }

  /** Throws the error an out-of-range read deserves. */
  protected checkRange(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(
        `Row index ${index} is outside 0..${this.length - 1}.`,
      );
    }
  }
}

/** A row list over rows that have already been built. */
export class MaterialisedRowList<T> extends GridRowList<T> {
  constructor(private readonly rows: readonly GridRow<T>[]) {
    super();
  }

  override get length(): number {
    return this.rows.length;
  }

  override at(index: number): GridRow<T> {
    this.checkRange(index);
    return this.rows[index] as GridRow<T>;
  }

  override toArray(): GridRow<T>[] {
    return [...this.rows];
  }
}

/** An empty row list, for a grid with nothing to show. */
export function emptyRowList<T>(): GridRowList<T> {
  return new MaterialisedRowList<T>([]);
}

/**
 * A read-only row list that materialises each {@link DataGridRow} on demand.
 */
export class LazyDataRowList<T> extends GridRowList<T> {
  /** Index of the first row in the unfiltered source, for remote paging. */
  readonly offset: number;

  private readonly rows: readonly T[];

  /**
   * Replaces a row as it is read, or null to read it through unchanged.
   *
   * This is how an edit that has been committed but not yet confirmed by a
   * remote source stays on screen: the substitution happens per read, so a
   * grid with no pending write pays nothing for it.
   */
  private readonly substitute: ((row: T) => T) | null;

  /** Where a row sits in the source, when the source can say. */
  private readonly sourceIndexOf: ((row: T) => number) | null;

  constructor(
    rows: readonly T[],
    options: {
      offset?: number;
      substitute?: ((row: T) => T) | null;
      sourceIndexOf?: ((row: T) => number) | null;
    } = {},
  ) {
    super();
    this.rows = rows;
    this.offset = options.offset ?? 0;
    this.substitute = options.substitute ?? null;
    this.sourceIndexOf = options.sourceIndexOf ?? null;
  }

  override get length(): number {
    return this.rows.length;
  }

  override at(index: number): GridRow<T> {
    this.checkRange(index);
    const row = this.rows[index] as T;
    return new DataGridRow<T>({
      index,
      data: this.substitute === null ? row : this.substitute(row),
      sourceIndex: this.sourceIndexOf === null ? this.offset + index : -1,
      sourceIndexOf: this.sourceIndexOf,
    });
  }
}

/**
 * A read-only window onto part of a row list.
 *
 * Copying a window onto a lazy row list materialises every row in it: reading
 * `scrollableRows` on an ungrouped 50k-row grid built 50k wrapper objects,
 * several times a frame, to show forty of them. A slice reads through
 * instead, so it costs nothing until it is indexed.
 */
export class RowSlice<T> extends GridRowList<T> {
  readonly start: number;
  readonly end: number;

  constructor(
    private readonly rows: GridRowList<T>,
    start: number,
    end: number,
  ) {
    super();
    if (start < 0 || start > end) {
      throw new RangeError(
        `A row slice needs an empty or forward range, got ${start}..${end}.`,
      );
    }
    this.start = start;
    this.end = end;
  }

  override get length(): number {
    const count = this.end - this.start;
    return count < 0 ? 0 : count;
  }

  override at(index: number): GridRow<T> {
    this.checkRange(index);
    return this.rows.at(this.start + index);
  }
}

/**
 * Inserts a {@link DetailGridRow} after every row whose panel is open,
 * renumbering the rows as it goes.
 *
 * For a list that is already materialised — a grouped or tree flattening. The
 * flat case has {@link DetailRowList}, which does the same thing without
 * building anything.
 */
export function withDetailRows<T>(
  rows: readonly GridRow<T>[],
  options: {
    open: ReadonlySet<RowKey>;
    height: number;
    keyOf: (row: T) => RowKey;
  },
): GridRow<T>[] {
  const { open, height, keyOf } = options;
  if (open.size === 0) return [...rows];
  const out: GridRow<T>[] = [];
  for (const row of rows) {
    if (isDataRow(row)) {
      out.push(
        new DataGridRow<T>({
          index: out.length,
          data: row.data,
          sourceIndex: row.sourceIndex,
          depth: row.depth,
          tree: row.tree,
        }),
      );
      const key = keyOf(row.data);
      if (!open.has(key)) continue;
      out.push(
        new DetailGridRow<T>({
          index: out.length,
          data: row.data,
          rowKey: key,
          height,
          depth: row.depth,
        }),
      );
      continue;
    }
    if (isGroupRow(row)) {
      out.push(
        new GroupGridRow<T>({
          index: out.length,
          depth: row.depth,
          node: row.node,
          expanded: row.expanded,
          loading: row.loading,
        }),
      );
      continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * A row list that interleaves open detail panels without materialising
 * anything.
 *
 * One open panel must not cost 50k wrapper objects, so the visual index is
 * resolved arithmetically: the panels are held as the sorted data indices
 * they belong to, and a read works out how many of them precede the index
 * being read.
 */
export class DetailRowList<T> extends GridRowList<T> {
  readonly height: number;
  readonly keyOf: (row: T) => RowKey;
  readonly offset: number;

  private readonly rows: readonly T[];

  /** Data indices whose panel is open, ascending. */
  private readonly openAt: readonly number[];

  private readonly substitute: ((row: T) => T) | null;
  private readonly sourceIndexOf: ((row: T) => number) | null;

  constructor(
    rows: readonly T[],
    options: {
      openAt: readonly number[];
      height: number;
      keyOf: (row: T) => RowKey;
      offset?: number;
      substitute?: ((row: T) => T) | null;
      sourceIndexOf?: ((row: T) => number) | null;
    },
  ) {
    super();
    this.rows = rows;
    this.openAt = options.openAt;
    this.height = options.height;
    this.keyOf = options.keyOf;
    this.offset = options.offset ?? 0;
    this.substitute = options.substitute ?? null;
    this.sourceIndexOf = options.sourceIndexOf ?? null;
  }

  override get length(): number {
    return this.rows.length + this.openAt.length;
  }

  /** How many open panels sit strictly before data index `row`. */
  private openBefore(row: number): number {
    let low = 0;
    let high = this.openAt.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.openAt[mid] as number) < row) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /** Visual position of data index `row`. */
  private positionOf(row: number): number {
    return row + this.openBefore(row);
  }

  override at(index: number): GridRow<T> {
    // An out-of-range read is an error, not a row: returning the last row's
    // phantom panel for index 10 of a 3-row list hid the caller's bug and put
    // a row on screen that does not exist.
    this.checkRange(index);
    // The largest data index whose row starts at or before `index`. The
    // mapping is monotonic, so this is a binary search.
    let low = 0;
    let high = this.rows.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.positionOf(mid) <= index) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const raw = this.rows[found] as T;
    const data = this.substitute === null ? raw : this.substitute(raw);
    if (this.positionOf(found) === index) {
      return new DataGridRow<T>({
        index,
        data,
        sourceIndex: this.sourceIndexOf === null ? this.offset + found : -1,
        sourceIndexOf: this.sourceIndexOf,
      });
    }
    // The only other row at this position is the panel under that row.
    return new DetailGridRow<T>({
      index,
      data,
      rowKey: this.keyOf(raw),
      height: this.height,
    });
  }
}

/**
 * Flattens `nodes` into visible rows, skipping the contents of collapsed
 * groups.
 */
export function flattenGroups<T>(
  nodes: readonly GroupNode<T>[],
  expansion: GroupExpansionState,
  options: {
    loadingPaths?: ReadonlySet<string>;
    sourceIndexOf?: ((row: T) => number) | null;
  } = {},
): GridRow<T>[] {
  const loadingPaths = options.loadingPaths ?? new Set<string>();
  const sourceIndexOf = options.sourceIndexOf ?? null;
  const out: GridRow<T>[] = [];
  const walk = (level: readonly GroupNode<T>[]): void => {
    for (const node of level) {
      const expanded = expansion.isExpanded(node.path);
      out.push(
        new GroupGridRow<T>({
          index: out.length,
          depth: node.depth,
          node,
          expanded,
          loading: loadingPaths.has(node.path),
        }),
      );
      if (!expanded) continue;
      // An open group whose rows have not arrived yet shows its header and
      // nothing under it, rather than claiming to be empty.
      if (!node.loaded) continue;
      if (node.isLeafGroup) {
        for (const row of node.rows) {
          out.push(
            new DataGridRow<T>({
              index: out.length,
              data: row,
              sourceIndexOf,
              depth: node.depth + 1,
            }),
          );
        }
      } else {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/**
 * Every group path in a tree.
 *
 * {@link GroupExpansionState.collapseAll} no longer needs it — closing "every
 * group" cannot be a list of the groups currently on screen — but a caller
 * that wants to act on the paths it can see still can.
 */
export function collectGroupPaths<T>(
  nodes: readonly GroupNode<T>[],
): string[] {
  const out: string[] = [];
  const walk = (level: readonly GroupNode<T>[]): void => {
    for (const node of level) {
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** One group's place in a {@link GroupedRowList}. */
interface GroupSlot<T> {
  readonly node: GroupNode<T>;
  /** Visual index of this group's header. */
  readonly start: number;
  /** Rows this group's subtree shows, its header included. */
  readonly total: number;
  readonly children: GroupSlot<T>[];
}

/**
 * A grouped row list that resolves positions arithmetically instead of
 * materialising every row.
 *
 * Flattening built a wrapper object per visible row, so opening or closing
 * one group rebuilt the whole list: tens of milliseconds at 200k rows, for a
 * change that affects one subtree. This holds an index over the *groups* —
 * each one's first visual position and how many rows its subtree shows — and
 * resolves a read by walking down it. A toggle rebuilds the group index,
 * which is O(groups), and touches no row at all.
 */
export class GroupedRowList<T> extends GridRowList<T> {
  readonly expansion: GroupExpansionState;
  readonly loadingPaths: ReadonlySet<string>;

  /** Where a row sits in the source, when the source can say. */
  readonly sourceIndexOf: ((row: T) => number) | null;

  private readonly substitute: ((row: T) => T) | null;

  /** The top level of the group index, in display order. */
  private readonly levels: GroupSlot<T>[];

  constructor(
    nodes: readonly GroupNode<T>[],
    expansion: GroupExpansionState,
    options: {
      loadingPaths?: ReadonlySet<string>;
      sourceIndexOf?: ((row: T) => number) | null;
      substitute?: ((row: T) => T) | null;
    } = {},
  ) {
    super();
    this.expansion = expansion;
    this.loadingPaths = options.loadingPaths ?? new Set<string>();
    this.sourceIndexOf = options.sourceIndexOf ?? null;
    this.substitute = options.substitute ?? null;
    this.levels = indexNodes<T>(nodes, expansion, 0);
  }

  override get length(): number {
    if (this.levels.length === 0) return 0;
    const last = this.levels[this.levels.length - 1] as GroupSlot<T>;
    return last.start + last.total;
  }

  override at(index: number): GridRow<T> {
    this.checkRange(index);
    let level = this.levels;
    for (;;) {
      const slot = slotAt(level, index);
      const node = slot.node;
      if (index === slot.start) {
        return new GroupGridRow<T>({
          index,
          depth: node.depth,
          node,
          expanded: this.expansion.isExpanded(node.path),
          loading: this.loadingPaths.has(node.path),
        });
      }
      if (slot.children.length === 0) {
        // A leaf group: the rows follow its header in order.
        const row = node.rows[index - slot.start - 1] as T;
        return new DataGridRow<T>({
          index,
          data: this.substitute === null ? row : this.substitute(row),
          sourceIndexOf: this.sourceIndexOf,
          depth: node.depth + 1,
        });
      }
      level = slot.children;
    }
  }
}

/**
 * The slot in `level` whose span covers `index`.
 *
 * The slots are contiguous and ascending, so this is a binary search: a grid
 * grouped into thousands of groups must not walk them per read.
 */
function slotAt<T>(level: readonly GroupSlot<T>[], index: number): GroupSlot<T> {
  let low = 0;
  let high = level.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((level[mid] as GroupSlot<T>).start <= index) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return level[low] as GroupSlot<T>;
}

function indexNodes<T>(
  nodes: readonly GroupNode<T>[],
  expansion: GroupExpansionState,
  start: number,
): GroupSlot<T>[] {
  const out: GroupSlot<T>[] = [];
  let cursor = start;
  for (const node of nodes) {
    const expanded = expansion.isExpanded(node.path);
    // A group whose contents have not arrived shows its header alone, rather
    // than claiming to be empty.
    const shows = expanded && node.loaded;
    const children =
      shows && !node.isLeafGroup
        ? indexNodes<T>(node.children, expansion, cursor + 1)
        : [];
    let contents = 0;
    if (shows) {
      if (node.isLeafGroup) {
        contents = node.rows.length;
      } else if (children.length > 0) {
        const last = children[children.length - 1] as GroupSlot<T>;
        contents = last.start + last.total - cursor - 1;
      }
    }
    const total = 1 + contents;
    out.push({ node, start: cursor, total, children });
    cursor += total;
  }
  return out;
}
