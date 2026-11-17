// The pipeline stages this exercises are the engine's inner layer.
import { describe, expect, it } from 'vitest';
import {
  AsyncDataSource,
  buildGroups,
  GridController,
  GridDataSource,
  GridQuery,
  GridResult,
  GroupChildren,
  GroupKey,
  GroupNode,
  GroupSpec,
  InMemoryDataSource,
  isGroupRow,
} from '../src/advanced';
import {
  labelsOf,
  Product,
  productColumnMap,
  productColumns,
  sampleProducts,
} from './fixtures';

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A source that groups the way a database would: it answers with headers and
 * counts, and hands over a group's rows only when asked for them.
 */
class GroupingBackend extends GridDataSource<Product> {
  /** Which group paths were asked for, in order. */
  readonly requested: string[] = [];
  headerFetches = 0;
  failNext = false;

  constructor(private readonly data: Product[]) {
    super();
  }

  override get supportsLazyGroups(): boolean {
    return true;
  }

  override async fetch(query: GridQuery): Promise<GridResult<Product>> {
    this.headerFetches++;
    if (!query.lazyGroups) {
      // The eager path: every row, which is the cost lazy grouping avoids.
      return new GridResult<Product>({
        rows: [...this.data],
        totalCount: this.data.length,
      });
    }
    const counts = new Map<string, number>();
    for (const row of this.data) {
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    }
    const keys = [...counts.keys()].sort();
    return new GridResult<Product>({
      rows: [],
      totalCount: this.data.length,
      groups: keys.map(
        (key) =>
          new GroupNode<Product>({
            field: 'category',
            key,
            label: key,
            depth: 0,
            path: key,
            keys: [new GroupKey('category', key)],
            declaredCount: counts.get(key) as number,
            loaded: false,
          }),
      ),
    });
  }

  override async fetchGroupChildren(
    _query: GridQuery,
    node: GroupNode<Product>,
  ): Promise<GroupChildren<Product>> {
    this.requested.push(node.path);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('group unavailable');
    }
    const wanted = node.keys[0]?.key;
    return new GroupChildren<Product>({
      rows: this.data.filter((row) => row.category === wanted),
    });
  }
}

function lazyGrid(
  backend: GroupingBackend,
  options: { expanded?: boolean } = {},
): GridController<Product> {
  return new GridController<Product>({
    columns: productColumns(),
    dataSource: backend,
    groups: [new GroupSpec('category')],
    lazyGrouping: true,
    groupsExpandedByDefault: options.expanded ?? false,
  });
}

describe('lazy grouping', () => {
  it('asks for headers only, and does not download the rows', async () => {
    const backend = new GroupingBackend(sampleProducts());
    const grid = lazyGrid(backend);
    await tick();

    expect(grid.isLazilyGrouped).toBe(true);
    expect(backend.requested).toEqual([]);
    expect(grid.rowCount, 'three closed headers').toBe(3);
    const header = grid.visibleRows.at(0);
    if (!isGroupRow(header)) throw new Error('expected a group header');
    expect(header.isLoaded).toBe(false);
    expect(header.label).toBe('Compute');
    expect(header.rowCount, 'the count the source declared').toBe(2);
  });

  it('fetches a group when it is opened, and only that group', async () => {
    const backend = new GroupingBackend(sampleProducts());
    const grid = lazyGrid(backend);
    await tick();

    grid.setGroupExpanded('Input', true);
    expect(grid.isGroupLoading('Input')).toBe(true);
    await tick();

    expect(backend.requested).toEqual(['Input']);
    expect(grid.isGroupLoading('Input')).toBe(false);
    expect(labelsOf(grid)).toEqual([
      'Compute',
      'Display',
      'Input',
      'Keyboard',
      'Mouse',
      'Webcam',
    ]);
  });

  it('shows the header alone for an open group with nothing in hand', async () => {
    const backend = new GroupingBackend(sampleProducts());
    const grid = lazyGrid(backend);
    await tick();
    grid.setGroupExpanded('Input', true);
    // Before the fetch resolves.
    expect(grid.rowCount).toBe(3);
    const header = grid.visibleRows
      .toArray()
      .filter(isGroupRow)
      .find((r) => r.label === 'Input');
    expect(header?.expanded).toBe(true);
    expect(header?.loading).toBe(true);
    await tick();
  });

  it('fetches a group once, however often it is reopened', async () => {
    const backend = new GroupingBackend(sampleProducts());
    const grid = lazyGrid(backend);
    await tick();

    grid.toggleGroup('Input');
    await tick();
    grid.toggleGroup('Input');
    grid.toggleGroup('Input');
    await tick();
    expect(backend.requested).toEqual(['Input']);
  });

  it('fetches every group that is open by default on the first render', async () => {
    const backend = new GroupingBackend(sampleProducts());
    lazyGrid(backend, { expanded: true });
    await tick();
    await tick();
    expect(new Set(backend.requested)).toEqual(
      new Set(['Compute', 'Display', 'Input']),
    );
  });

  it('drops what was cached for the old query', async () => {
    const backend = new GroupingBackend(sampleProducts());
    const grid = lazyGrid(backend);
    await tick();
    grid.setGroupExpanded('Input', true);
    await tick();

    grid.setSearch('o');
    await tick();
    await tick();
    expect(backend.requested).toEqual(['Input', 'Input']);
  });

  it('reports a group that fails, and does not retry it every frame', async () => {
    const backend = new GroupingBackend(sampleProducts());
    backend.failNext = true;
    const grid = lazyGrid(backend);
    await tick();

    grid.setGroupExpanded('Input', true);
    await tick();
    expect(grid.groupError('Input')).toBeInstanceOf(Error);
    expect(backend.requested).toHaveLength(1);

    grid.setGroupExpanded('Display', true);
    await tick();
    expect(backend.requested, 'Input is not retried').toHaveLength(2);

    grid.invalidateGroup('Input');
    await tick();
    expect(grid.groupError('Input')).toBeNull();
    expect(backend.requested).toHaveLength(3);
  });

  it('groups a local source in full, having nothing to defer', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      groups: [new GroupSpec('category')],
      lazyGrouping: true,
    });
    expect(grid.isLazilyGrouped).toBe(false);
    expect(grid.query.lazyGroups).toBe(false);
    expect(grid.rowCount).toBe(3 + 6);
  });

  it('asks the eager query of a source that cannot group lazily', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(
        async () =>
          new GridResult<Product>({
            rows: sampleProducts(),
            totalCount: 6,
            groups: buildGroups<Product>(
              sampleProducts(),
              [new GroupSpec('category')],
              productColumnMap(),
            ),
          }),
      ),
      groups: [new GroupSpec('category')],
      lazyGrouping: true,
    });
    await tick();
    expect(grid.isLazilyGrouped).toBe(false);
    expect(grid.rowCount).toBe(3 + 6);
  });
});

describe('a declared count', () => {
  it('is what the header reports, even with rows in hand', () => {
    const node = new GroupNode<Product>({
      field: 'category',
      key: 'Input',
      label: 'Input',
      depth: 0,
      path: 'Input',
      rows: [sampleProducts()[0] as Product],
      declaredCount: 900,
    });
    expect(node.rowCount).toBe(900);
  });

  it('is kept when the contents are grafted on', () => {
    const node = new GroupNode<Product>({
      field: 'category',
      key: 'Input',
      label: 'Input',
      depth: 0,
      path: 'Input',
      keys: [new GroupKey('category', 'Input')],
      declaredCount: 3,
      loaded: false,
    });
    const filled = node.withContents({ rows: sampleProducts() });
    expect(filled.loaded).toBe(true);
    expect(filled.rowCount).toBe(3);
    expect(filled.keys).toEqual(node.keys);
  });
});

describe('group keys', () => {
  it('records the path a source would filter on', () => {
    const nodes = buildGroups<Product>(
      sampleProducts(),
      [new GroupSpec('category'), new GroupSpec('active')],
      productColumnMap(),
    );
    const leaf = nodes[0]?.children[0];
    expect(leaf?.keys.map((k) => k.field)).toEqual(['category', 'active']);
    expect(leaf?.keys[0]?.key).toBe('Compute');
  });
});
