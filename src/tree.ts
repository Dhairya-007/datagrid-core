/**
 * Hierarchical rows: a row that is the parent of other rows.
 *
 * @module
 */

import type { Comparator } from './compare';
import { GridArgumentError } from './errors';
import { pathKeySegment } from './group';
import {
  DataGridRow,
  TreeRowInfo,
  type GridRow,
  type GroupExpansionState,
  type RowKey,
} from './rows';

/** Options for a {@link TreeSpec}. */
export interface TreeSpecOptions<T> {
  /**
   * A row's children, for a model that nests them.
   *
   * Returning an empty array makes the row a leaf.
   */
  childrenOf?: (row: T) => readonly T[];

  /**
   * The key of a row's parent, for a flat model with a parent reference —
   * `managerId`, `parentId`, `folderId`.
   *
   * Null means the row is a root. A key that matches no row in the current
   * result also makes the row a root, so filtering out a manager leaves their
   * reports visible instead of dropping them off the grid.
   */
  parentOf?: (row: T) => RowKey | null;

  /**
   * Fetches a row's children when its branch is first opened.
   *
   * For data that is a tree on a server: a file listing, an org chart one
   * level at a time. The grid asks once per row, keeps what comes back, and
   * marks the branch as loading in between so an open branch does not look
   * like an empty one.
   */
  childrenLoader?: (row: T) => Promise<readonly T[]>;

  /**
   * Whether a row has children, where that is known before they arrive.
   *
   * A lazily loaded tree has to draw a disclosure control before it knows
   * what is underneath, and the answer usually travels with the row — a
   * folder flag, a child count. Without it a row is drawn as a leaf until it
   * is opened, which is the one thing a user cannot do to it.
   */
  hasChildren?: (row: T) => boolean;
}

/**
 * How the rows form a hierarchy.
 *
 * Grouping and a tree look alike on screen and are not the same thing.
 * Grouping invents a parent row out of a shared value — a header for
 * "Compute" that is not in the data. A tree's parents are rows: an employee
 * with reports, a folder with files, an assembly with parts. They can be
 * selected, edited and exported like any other row.
 *
 * Give exactly one of {@link childrenOf}, {@link parentOf} and
 * {@link childrenLoader}: a nested model knows its children, a flat one knows
 * its parent, and a lazy one fetches them.
 */
export class TreeSpec<T> {
  readonly childrenOf: ((row: T) => readonly T[]) | null;
  readonly parentOf: ((row: T) => RowKey | null) | null;
  readonly childrenLoader: ((row: T) => Promise<readonly T[]>) | null;
  readonly hasChildren: ((row: T) => boolean) | null;

  constructor(options: TreeSpecOptions<T>) {
    const given =
      (options.childrenOf === undefined ? 0 : 1) +
      (options.parentOf === undefined ? 0 : 1) +
      (options.childrenLoader === undefined ? 0 : 1);
    if (given !== 1) {
      throw new GridArgumentError(
        'A TreeSpec takes exactly one of childrenOf, parentOf and childrenLoader.',
      );
    }
    this.childrenOf = options.childrenOf ?? null;
    this.parentOf = options.parentOf ?? null;
    this.childrenLoader = options.childrenLoader ?? null;
    this.hasChildren = options.hasChildren ?? null;
    Object.freeze(this);
  }

  get isNested(): boolean {
    return this.childrenOf !== null;
  }

  /** Whether children arrive asynchronously. */
  get isLazy(): boolean {
    return this.childrenLoader !== null;
  }
}

/** Options for {@link flattenTree}. */
export interface FlattenTreeOptions<T> {
  rows: readonly T[];
  spec: TreeSpec<T>;
  keyOf: (row: T) => RowKey;
  expansion: GroupExpansionState;
  loadedChildren?: ReadonlyMap<RowKey, readonly T[]>;
  loadingKeys?: ReadonlySet<RowKey>;
  /**
   * Orders the children of each row, which is how a sort on a nested model
   * reaches past its roots: the pipeline only ever sees the rows the data
   * source holds, so for a `childrenOf` model it sorts the roots and nothing
   * else.
   */
  childComparator?: Comparator<T> | null;
  /**
   * Replaces a row as it is read, so an optimistic write shows up on a child
   * too.
   */
  substitute?: ((row: T) => T) | null;
  sourceIndexOf?: ((row: T) => number) | null;
}

/**
 * Flattens rows into the visible rows of a tree, skipping what is closed.
 *
 * A row's path is its own key, type-tagged, and not the chain of its
 * ancestors: a row is rendered once whatever claims it, so its key already
 * identifies it, and repeating every ancestor made the paths grow
 * quadratically with depth — megabytes of path characters over a 4,000-deep
 * chain, which is time spent building strings nobody reads.
 *
 * A row that is reachable twice — a cycle in a parent reference, or a child
 * listed under two parents — is rendered once, under the first parent that
 * claims it. A grid that hangs is a worse answer to bad data than a grid that
 * is missing a branch.
 */
export function flattenTree<T>(options: FlattenTreeOptions<T>): GridRow<T>[] {
  const {
    rows,
    spec,
    keyOf,
    expansion,
    loadedChildren = new Map<RowKey, readonly T[]>(),
    loadingKeys = new Set<RowKey>(),
    childComparator = null,
    substitute = null,
    sourceIndexOf = null,
  } = options;

  const out: GridRow<T>[] = [];
  const seen = new Set<RowKey>();

  const childrenOf = spec.childrenOf;
  const parentOf = spec.parentOf;

  // The flat form: index the rows by their parent's key once, rather than
  // scanning every row per parent.
  const byParent = new Map<RowKey, T[]>();
  const present = new Set<RowKey>();
  if (parentOf !== null) {
    for (const row of rows) present.add(keyOf(row));
    for (const row of rows) {
      const parent = parentOf(row);
      if (parent === null || parent === undefined || !present.has(parent)) {
        continue;
      }
      const bucket = byParent.get(parent);
      if (bucket === undefined) byParent.set(parent, [row]);
      else bucket.push(row);
    }
  }

  const rawChildren = (row: T): readonly T[] => {
    if (childrenOf !== null) return childrenOf(row);
    if (spec.isLazy) return loadedChildren.get(keyOf(row)) ?? [];
    return byParent.get(keyOf(row)) ?? [];
  };

  const children = (row: T): readonly T[] => {
    const kids = rawChildren(row);
    if (childComparator === null || kids.length < 2) return kids;
    // A nested model's children never reach the pipeline, so the sort the
    // user asked for is applied to each level here.
    return [...kids].sort(childComparator);
  };

  /**
   * Whether a disclosure control belongs on this row.
   *
   * A lazily loaded row may have children nobody has asked for yet, so the
   * spec is asked first and the loaded children are only a fallback.
   */
  const mayHaveChildren = (row: T, loaded: readonly T[]): boolean => {
    const declared = spec.hasChildren?.(row);
    if (declared !== undefined) return declared;
    return loaded.length > 0;
  };

  // An explicit stack, not recursion: a folder tree or a bill of materials
  // from real data reaches thousands of levels, and the recursive version
  // overflowed the stack a few thousand deep — a crash with no bad input to
  // point at.
  const walk = (roots: readonly T[]): void => {
    const stack: { row: T; depth: number }[] = [];
    for (let i = roots.length - 1; i >= 0; i--) {
      stack.push({ row: roots[i] as T, depth: 0 });
    }
    while (stack.length > 0) {
      const pending = stack.pop() as { row: T; depth: number };
      const row = pending.row;
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      const kids = children(row);
      const path = pathKeySegment(key);
      const expanded = expansion.isExpanded(path);
      out.push(
        new DataGridRow<T>({
          index: out.length,
          data: substitute === null ? row : substitute(row),
          sourceIndexOf,
          depth: pending.depth,
          tree: new TreeRowInfo({
            path,
            hasChildren: mayHaveChildren(row, kids),
            expanded,
            loading: loadingKeys.has(key),
          }),
        }),
      );
      if (kids.length === 0 || !expanded) continue;
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ row: kids[i] as T, depth: pending.depth + 1 });
      }
    }
  };

  if (parentOf === null) {
    walk(rows);
    return out;
  }
  walk(rootsOf<T>(rows, parentOf, keyOf, present, children));
  return out;
}

/**
 * The rows to draw at depth zero of a flat, parent-referencing model.
 *
 * A row is a root when it names no parent, or names one that is not in the
 * result — filtering out a manager leaves their reports visible rather than
 * dropping them. Rows that no root can reach are roots too: a cycle has no
 * root of its own, and its rows would otherwise vanish from the grid
 * altogether. A row drawn at the wrong depth is recoverable; a row that is
 * not drawn at all is not.
 */
export function rootsOf<T>(
  rows: readonly T[],
  parentOf: (row: T) => RowKey | null,
  keyOf: (row: T) => RowKey,
  present: ReadonlySet<RowKey>,
  childrenOf: (row: T) => readonly T[],
): T[] {
  const roots: T[] = [];
  for (const row of rows) {
    const parent = parentOf(row);
    if (parent === null || parent === undefined || !present.has(parent)) {
      roots.push(row);
    }
  }

  // Reachability ignores expansion: a child hidden under a closed branch is
  // placed, it is just not on screen. Marked with an explicit stack, because
  // this walks the whole tree whether or not anything is open — a collapsed
  // 20,000-deep chain used to overflow here while the grid showed one row.
  const reachable = new Set<RowKey>();
  const stack: T[] = [...roots];
  while (stack.length > 0) {
    const row = stack.pop() as T;
    const key = keyOf(row);
    if (reachable.has(key)) continue;
    reachable.add(key);
    stack.push(...childrenOf(row));
  }
  if (reachable.size === rows.length) return roots;
  const out = [...roots];
  for (const row of rows) {
    if (!reachable.has(keyOf(row))) out.push(row);
  }
  return out;
}

/**
 * Every tree path in `rows`, for collapsing a tree whose branches the user
 * has never opened.
 */
export function collectTreePaths<T>(options: {
  rows: readonly T[];
  spec: TreeSpec<T>;
  keyOf: (row: T) => RowKey;
}): string[] {
  const { rows, spec, keyOf } = options;
  const out: string[] = [];
  const seen = new Set<RowKey>();
  const childrenOf = spec.childrenOf;
  const parentOf = spec.parentOf;

  const byParent = new Map<RowKey, T[]>();
  const present = new Set<RowKey>();
  if (parentOf !== null) {
    for (const row of rows) present.add(keyOf(row));
    for (const row of rows) {
      const parent = parentOf(row);
      if (parent === null || parent === undefined || !present.has(parent)) {
        continue;
      }
      const bucket = byParent.get(parent);
      if (bucket === undefined) byParent.set(parent, [row]);
      else bucket.push(row);
    }
  }

  const walk = (roots: readonly T[]): void => {
    const stack: T[] = [...roots].reverse();
    while (stack.length > 0) {
      const row = stack.pop() as T;
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pathKeySegment(key));
      const kids =
        childrenOf !== null ? childrenOf(row) : (byParent.get(key) ?? []);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as T);
    }
  };

  if (parentOf === null) {
    walk(rows);
    return out;
  }
  walk(
    rootsOf<T>(
      rows,
      parentOf,
      keyOf,
      present,
      (row) => byParent.get(keyOf(row)) ?? [],
    ),
  );
  return out;
}

/**
 * Flattens a nested model into the rows and parent references a grid can
 * filter, search and sort.
 *
 * A `childrenOf` model only ever hands the grid its roots, so the pipeline
 * has nothing else to work on: searching for a child's name matched nothing,
 * because no row the data source held carried that name. Put the result of
 * this in the data source and use `new TreeSpec({ parentOf })` with the
 * returned lookup, and every stage sees every row.
 *
 * ```ts
 * const flat = flattenNestedRows(roots, {
 *   childrenOf: (n) => n.children,
 *   keyOf: (n) => n.id,
 * });
 * const grid = new GridController<Node>({
 *   columns,
 *   dataSource: new InMemoryDataSource(flat.rows),
 *   rowKey: (n) => n.id,
 *   tree: new TreeSpec({ parentOf: (n) => flat.parentOf(n) }),
 * });
 * ```
 */
export function flattenNestedRows<T>(
  roots: readonly T[],
  options: {
    childrenOf: (row: T) => readonly T[];
    keyOf: (row: T) => RowKey;
  },
): NestedRows<T> {
  const { childrenOf, keyOf } = options;
  const rows: T[] = [];
  const parents = new Map<RowKey, RowKey>();
  const seen = new Set<RowKey>();
  const stack: T[] = [...roots].reverse();
  while (stack.length > 0) {
    const row = stack.pop() as T;
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    const kids = childrenOf(row);
    for (let i = kids.length - 1; i >= 0; i--) {
      const child = kids[i] as T;
      parents.set(keyOf(child), key);
      stack.push(child);
    }
  }
  return new NestedRows<T>(rows, parents, keyOf);
}

/** The flat form of a nested model, from {@link flattenNestedRows}. */
export class NestedRows<T> {
  /** Every row, parents before their children. */
  readonly rows: readonly T[];

  private readonly parents: ReadonlyMap<RowKey, RowKey>;
  private readonly keyOf: (row: T) => RowKey;

  constructor(
    rows: readonly T[],
    parents: ReadonlyMap<RowKey, RowKey>,
    keyOf: (row: T) => RowKey,
  ) {
    this.rows = rows;
    this.parents = parents;
    this.keyOf = keyOf;
  }

  /** The parent reference to give `TreeSpec.parentOf`. */
  parentOf(row: T): RowKey | null {
    return this.parents.get(this.keyOf(row)) ?? null;
  }
}
