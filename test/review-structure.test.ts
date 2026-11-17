// Grouping, tree, saved-view and row-identity fixes from the 0.4.0 review.
import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  ColumnType,
  flattenNestedRows,
  flattenTree,
  GridColumn,
  GridController,
  GridFormatError,
  GridViewState,
  GroupExpansionState,
  GroupSpec,
  InMemoryDataSource,
  isDataRow,
  isGroupRow,
  NullsPosition,
  SortDirection,
  SortSpec,
  TreeSpec,
  type CellValue,
} from '../src/advanced';
import { Product, productColumns, sampleProducts } from './fixtures';

type Row = Record<string, CellValue>;

class Node {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly children: Node[] = [],
  ) {}
}

function columnsOf<T>(...columns: GridColumn<T>[]): Map<string, GridColumn<T>> {
  return new Map(columns.map((c) => [c.field, c]));
}

describe('group paths', () => {
  it('treats a null group and a "null" group as two groups', () => {
    const rows: Row[] = [{ k: null }, { k: 'null' }];
    const columns = columnsOf(new GridColumn<Row>({ field: 'k' }));
    const nodes = buildGroups(rows, [new GroupSpec('k')], columns);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.path).not.toBe(nodes[1]?.path);
  });

  it('treats a numeric group and a text group as two groups', () => {
    const rows: Row[] = [{ k: 1 }, { k: '1' }];
    const columns = columnsOf(new GridColumn<Row>({ field: 'k' }));
    const nodes = buildGroups(rows, [new GroupSpec('k')], columns);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.path).not.toBe(nodes[1]?.path);
  });

  it('does not leak expansion between grouping fields', () => {
    const rows: Row[] = [
      { x: true, y: true },
      { x: false, y: false },
    ];
    const columns = [
      new GridColumn<Row>({ field: 'x', type: ColumnType.boolean }),
      new GridColumn<Row>({ field: 'y', type: ColumnType.boolean }),
    ];
    const grid = new GridController<Row>({
      columns,
      dataSource: new InMemoryDataSource<Row>(rows),
      groups: [new GroupSpec('x')],
    });
    const trueGroup = grid.visibleRows
      .toArray()
      .filter(isGroupRow)
      .find((r) => r.key === true);
    grid.setGroupExpanded(trueGroup?.path as string, false);

    grid.setGroups([new GroupSpec('y')]);
    const yTrue = grid.visibleRows
      .toArray()
      .filter(isGroupRow)
      .find((r) => r.key === true);
    expect(yTrue?.expanded, 'a fresh grouping starts open').toBe(true);
    grid.dispose();
  });

  it('cannot let a key containing the separator forge a boundary', () => {
    const rows: Row[] = [{ k: 'a\u001fb' }, { k: 'a' }];
    const columns = columnsOf(new GridColumn<Row>({ field: 'k' }));
    const nodes = buildGroups(rows, [new GroupSpec('k')], columns);
    const paths = new Set(nodes.map((n) => n.path));
    expect(paths.size).toBe(2);
    for (const path of paths) {
      expect(path.split('\u001f')).toHaveLength(1);
    }
  });
});

describe('group header order', () => {
  it('follows the column comparator', () => {
    const order = ['High', 'Medium', 'Low'];
    const rows: Row[] = ['Low', 'High', 'Medium'].map((priority) => ({
      priority,
    }));
    const columns = columnsOf(
      new GridColumn<Row>({
        field: 'priority',
        comparator: (a, b) =>
          order.indexOf(String(a)) - order.indexOf(String(b)),
      }),
    );
    const nodes = buildGroups(rows, [new GroupSpec('priority')], columns);
    expect(nodes.map((n) => n.label)).toEqual(order);
  });

  it('keeps the blank group last when the headers are reversed', () => {
    const rows: Row[] = [{ k: 'a' }, { k: null }, { k: 'b' }];
    const columns = columnsOf(new GridColumn<Row>({ field: 'k' }));
    const down = buildGroups(
      rows,
      [new GroupSpec('k', { direction: SortDirection.descending })],
      columns,
    );
    expect(down.map((n) => n.key)).toEqual(['b', 'a', null]);

    const nullsFirst = buildGroups(
      rows,
      [new GroupSpec('k', { nulls: NullsPosition.first })],
      columns,
    );
    expect(nullsFirst.map((n) => n.key)).toEqual([null, 'a', 'b']);
  });
});

describe('collapseAll', () => {
  it('closes a group that only appears later', () => {
    const source = new InMemoryDataSource<Product>(sampleProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      groups: [new GroupSpec('category')],
    });
    grid.collapseAllGroups();
    expect(
      grid.visibleRows
        .toArray()
        .filter(isGroupRow)
        .every((h) => !h.expanded),
    ).toBe(true);

    // A category nobody has seen yet must arrive closed too.
    source.add(
      new Product({ id: 99, name: 'Lamp', category: 'Light', price: 9 }),
    );
    const light = grid.visibleRows
      .toArray()
      .filter(isGroupRow)
      .find((h) => h.label === 'Light');
    expect(light?.expanded).toBe(false);
    grid.dispose();
  });

  it('survives a saved view', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      groups: [new GroupSpec('category')],
    });
    grid.collapseAllGroups();
    const state = GridViewState.fromJSON(grid.saveState().toJSON());

    const restored = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      groups: [new GroupSpec('category')],
    });
    restored.restoreState(state);
    expect(
      restored.visibleRows
        .toArray()
        .filter(isGroupRow)
        .every((h) => !h.expanded),
    ).toBe(true);
    grid.dispose();
    restored.dispose();
  });
});

describe('sourceIndex', () => {
  it('is the position in the source, not in the sorted result', () => {
    const products = sampleProducts();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(products),
      sorts: [new SortSpec('price', { direction: SortDirection.descending })],
    });
    const first = grid.visibleRows.at(0);
    if (!isDataRow(first)) throw new Error('expected a data row');
    expect(first.sourceIndex).toBe(products.indexOf(first.data));
    grid.dispose();
  });

  it('is reported for grouped rows too', () => {
    const products = sampleProducts();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(products),
      groups: [new GroupSpec('category')],
    });
    for (const row of grid.visibleRows.toArray().filter(isDataRow)) {
      expect(row.sourceIndex).toBe(products.indexOf(row.data));
    }
    grid.dispose();
  });
});

describe('a deep tree', () => {
  // Built from the leaf upwards, because building it the other way round
  // would overflow the stack in the test rather than in the code it tests.
  function chain(depth: number): Node[] {
    let node = new Node(`n${depth}`, `n${depth}`);
    for (let level = depth - 1; level >= 0; level--) {
      node = new Node(`n${level}`, `n${level}`, [node]);
    }
    return [node];
  }

  it('flattens 10,000 levels without overflowing the stack', () => {
    const rows = flattenTree<Node>({
      rows: chain(10_000),
      spec: new TreeSpec<Node>({ childrenOf: (n) => n.children }),
      keyOf: (n) => n.id,
      expansion: new GroupExpansionState(),
    });
    expect(rows).toHaveLength(10_001);
  });

  it('places a collapsed chain without overflowing the stack', () => {
    const rows = flattenTree<Node>({
      rows: chain(20_000),
      spec: new TreeSpec<Node>({ childrenOf: (n) => n.children }),
      keyOf: (n) => n.id,
      expansion: new GroupExpansionState({ expandedByDefault: false }),
    });
    expect(rows).toHaveLength(1);
  });

  it('keeps the path length flat as the tree deepens', () => {
    const rows = flattenTree<Node>({
      rows: chain(2000),
      spec: new TreeSpec<Node>({ childrenOf: (n) => n.children }),
      keyOf: (n) => n.id,
      expansion: new GroupExpansionState(),
    });
    const deepest = rows[rows.length - 1];
    if (deepest === undefined || !isDataRow(deepest)) {
      throw new Error('expected a data row');
    }
    // The old path repeated every ancestor, so this was kilobytes long.
    expect(deepest.treePath.length).toBeLessThan(16);
  });
});

describe('a nested tree', () => {
  it('sorts the children of each level', () => {
    const roots = [
      new Node('a', 'Ada', [new Node('c', 'Cy'), new Node('b', 'Bo')]),
    ];
    const grid = new GridController<Node>({
      columns: [new GridColumn<Node>({ field: 'name', value: (n) => n.name })],
      dataSource: new InMemoryDataSource<Node>(roots),
      rowKey: (n) => n.id,
      tree: new TreeSpec<Node>({ childrenOf: (n) => n.children }),
      sorts: [new SortSpec('name')],
    });
    expect(
      grid.visibleRows
        .toArray()
        .filter(isDataRow)
        .map((r) => r.data.name),
    ).toEqual(['Ada', 'Bo', 'Cy']);
    grid.dispose();
  });

  it('gives the pipeline every row through flattenNestedRows', () => {
    const roots = [new Node('a', 'Ada', [new Node('b', 'Bo')])];
    const flat = flattenNestedRows<Node>(roots, {
      childrenOf: (n) => n.children,
      keyOf: (n) => n.id,
    });
    const grid = new GridController<Node>({
      columns: [new GridColumn<Node>({ field: 'name', value: (n) => n.name })],
      dataSource: new InMemoryDataSource<Node>(flat.rows),
      rowKey: (n) => n.id,
      tree: new TreeSpec<Node>({ parentOf: (n) => flat.parentOf(n) }),
    });
    expect(grid.rowCount).toBe(2);
    // The search a nested model could not answer.
    grid.setSearch('Bo');
    expect(grid.rowCount).toBe(1);
    expect(grid.dataAt(0)?.name).toBe('Bo');
    grid.dispose();
  });
});

describe('a saved view that is partly unreadable', () => {
  it('restores what it can and reports the rest', () => {
    const warnings: string[] = [];
    const state = GridViewState.fromJSON(
      {
        sorts: [{ field: 'name', dir: 'ascending' }, { dir: 'descending' }],
        columns: [{ field: 'name', width: 120 }, { width: 80 }],
      },
      warnings,
    );
    expect(state.sorts).toHaveLength(1);
    expect(state.columns).toHaveLength(1);
    expect(warnings).toHaveLength(2);
  });

  it('reads an isIn condition whose value is not a list', () => {
    const state = GridViewState.fromJSON({
      columnFilters: {
        name: { field: 'name', op: 'isIn', value: 'a' },
      },
    });
    expect(state.columnFilters.get('name')?.value).toEqual(['a']);
  });

  it('still refuses a future schema version', () => {
    expect(() => GridViewState.fromJSON({ v: 99 })).toThrow(GridFormatError);
  });
});
