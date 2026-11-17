// The engine halves of the open feature issues: loading more rows, detail
// panels, and a tree whose children arrive asynchronously.
//
// The row-list types these assert on are the engine's inner layer.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DetailRowList,
  GridArgumentError,
  GridColumn,
  GridController,
  GridDataSource,
  GridQuery,
  GridResult,
  GroupSpec,
  InMemoryDataSource,
  isDataRow,
  isDetailRow,
  isGroupRow,
  LazyDataRowList,
  numberRange,
  requiredValue,
  SortSpec,
  TreeSpec,
} from '../src/advanced';
import {
  Product,
  productColumns,
  productGrid,
  sampleProducts,
} from './fixtures';

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** A remote source that serves a slice at a time and says whether more exist. */
class SliceBackend extends GridDataSource<Product> {
  readonly requestedLimits: number[] = [];

  /**
   * Offsets asked for, which is what makes a load-more a slice rather than a
   * re-download of everything so far.
   */
  readonly requestedOffsets: number[] = [];

  private more = true;

  constructor(readonly rows: Product[]) {
    super();
  }

  override get hasMore(): boolean {
    return this.more;
  }

  override async fetch(query: GridQuery): Promise<GridResult<Product>> {
    this.requestedLimits.push(query.limit ?? -1);
    this.requestedOffsets.push(query.offset);
    const start = Math.min(query.offset, this.rows.length);
    const limit = query.limit ?? this.rows.length;
    const end = Math.min(start + limit, this.rows.length);
    this.more = end < this.rows.length;
    return new GridResult<Product>({
      rows: this.rows.slice(start, end),
      totalCount: this.rows.length,
    });
  }
}

/** A lazily loaded tree: children arrive one branch at a time. */
class Folder {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly isFolder = false,
  ) {}
}

describe('loading more rows', () => {
  const manyProducts = (): Product[] => {
    const out: Product[] = [];
    for (let i = 0; i < 25; i++) {
      out.push(
        new Product({ id: i, name: `Item ${i}`, category: 'c', price: i }),
      );
    }
    return out;
  };

  it('asks for one slice first, not the whole table', async () => {
    const backend = new SliceBackend(manyProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: backend,
      loadMoreSize: 10,
    });
    await tick();
    expect(grid.isInfinite).toBe(true);
    expect(backend.requestedLimits).toEqual([10]);
    expect(grid.rowCount).toBe(10);
    expect(grid.canLoadMore).toBe(true);
  });

  it('appends a slice per load rather than replacing the page', async () => {
    const backend = new SliceBackend(manyProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: backend,
      loadMoreSize: 10,
    });
    await tick();

    await grid.loadMore();
    expect(grid.rowCount).toBe(20);
    expect(grid.dataAt(0)?.name, 'the first slice stayed').toBe('Item 0');
    await grid.loadMore();
    expect(grid.rowCount).toBe(25);
    expect(grid.canLoadMore, 'the source said that is all').toBe(false);
    // One slice per request, from where the last one ended: asking from the
    // top each time transferred 55 rows to show 25.
    expect(backend.requestedOffsets).toEqual([0, 10, 20]);
    expect(backend.requestedLimits).toEqual([10, 10, 10]);
    expect(backend.rows, 'and the whole table was never sent').toHaveLength(25);
  });

  it('drops a second request while one is in flight', async () => {
    const backend = new SliceBackend(manyProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: backend,
      loadMoreSize: 10,
    });
    await tick();
    backend.requestedLimits.length = 0;

    const first = grid.loadMore();
    expect(grid.isLoadingMore).toBe(true);
    const second = grid.loadMore();
    await Promise.all([first, second]);
    expect(backend.requestedLimits).toHaveLength(1);
  });

  it('starts again from one slice when the query changes', async () => {
    const backend = new SliceBackend(manyProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: backend,
      loadMoreSize: 10,
    });
    await tick();
    await grid.loadMore();
    expect(grid.rowCount).toBe(20);

    grid.toggleSort('price');
    await tick();
    expect(grid.rowCount, 'slices under the old order are gone').toBe(10);
  });

  it('knows when a local source has run out', async () => {
    const grid = productGrid({ rows: sampleProducts() });
    expect(grid.isInfinite).toBe(false);
    expect(grid.canLoadMore).toBe(false);

    const infinite = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(manyProducts()),
      loadMoreSize: 10,
    });
    expect(infinite.rowCount).toBe(10);
    expect(infinite.canLoadMore).toBe(true);
    // Awaited, because one request at a time is the rule: a second ask while
    // the first is out is dropped on purpose.
    await infinite.loadMore();
    expect(infinite.rowCount).toBe(20);
    await infinite.loadMore();
    expect(infinite.rowCount).toBe(25);
    expect(infinite.canLoadMore).toBe(false);
  });

  it('drops back to the first slice on reload', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(manyProducts()),
      loadMoreSize: 10,
    });
    await grid.loadMore();
    expect(grid.rowCount).toBe(20);
    await grid.reload();
    expect(grid.rowCount).toBe(10);
  });

  it('does not load more while grouped: grouping needs every row', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(manyProducts()),
      loadMoreSize: 10,
      groups: [new GroupSpec('category')],
    });
    expect(grid.canLoadMore).toBe(false);
  });
});

describe('detail panels', () => {
  function panelGrid(
    options: { height?: number; groups?: GroupSpec[] } = {},
  ): GridController<Product> {
    return new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      rowKey: (p) => p.id,
      detailHeight: options.height ?? 100,
      groups: options.groups ?? [],
    });
  }

  it('is a row of its own, under the row it belongs to', () => {
    const plain = productGrid({ identified: true });
    const grid = panelGrid({ height: 160 });
    expect(plain.hasDetailPanels).toBe(false);
    expect(grid.hasDetailPanels).toBe(true);

    // Product 2 is Mouse, the second row, so its panel is the third.
    grid.toggleDetail(2);
    expect(grid.rowCount).toBe(7);
    const panel = grid.visibleRows.at(2);
    if (!isDetailRow(panel)) throw new Error('expected a detail panel');
    expect(panel.rowKey).toBe(2);
    expect(panel.data.name).toBe('Mouse');
    expect(panel.height).toBe(160);
    expect(grid.isDetailOpen(2)).toBe(true);
  });

  it('renumbers the rows after a panel, so selection still lines up', () => {
    const grid = panelGrid();
    grid.toggleDetail(1);
    // Row 0 is Keyboard, row 1 its panel, row 2 Mouse.
    expect(grid.dataAt(0)?.name).toBe('Keyboard');
    expect(grid.dataAt(1), 'a panel is not a data row').toBeNull();
    expect(grid.dataAt(2)?.name).toBe('Mouse');
    for (let i = 0; i < grid.rowCount; i++) {
      expect(grid.visibleRows.at(i).index).toBe(i);
    }
  });

  it('follows its row through a sort', () => {
    const grid = panelGrid();
    grid.toggleDetail(4); // Laptop
    grid.setSorts([new SortSpec('name')]);
    const index = grid.visibleRows.findIndex((r) => isDetailRow(r));
    const panel = grid.visibleRows.at(index);
    expect(isDetailRow(panel) && panel.data.name).toBe('Laptop');
    expect(grid.dataAt(index - 1)?.name).toBe('Laptop');
  });

  it('works inside groups too', () => {
    const grid = panelGrid({ groups: [new GroupSpec('category')] });
    const before = grid.rowCount;
    grid.toggleDetail(1);
    expect(grid.rowCount).toBe(before + 1);
    expect(grid.visibleRows.toArray().filter(isDetailRow)).toHaveLength(1);
  });

  it('leaves the rows as they were once they are all closed', () => {
    const grid = panelGrid();
    grid.setDetailOpen(1, true);
    grid.setDetailOpen(3, true);
    expect(grid.openDetails).toEqual(new Set([1, 3]));
    expect(grid.rowCount).toBe(8);
    grid.closeAllDetails();
    expect(grid.rowCount).toBe(6);
    expect(grid.visibleRows.toArray().filter(isDetailRow)).toEqual([]);
  });

  it('pays nothing while none are open: the row list stays lazy', () => {
    const grid = panelGrid();
    expect(grid.visibleRows).toBeInstanceOf(LazyDataRowList);
    grid.toggleDetail(1);
    expect(grid.visibleRows).toBeInstanceOf(DetailRowList);
  });

  it('resolves every index of a list with panels to the right row', () => {
    const grid = panelGrid();
    // Panels on the first, a middle and the last row — the three places an
    // arithmetic mapping gets wrong.
    grid.setDetailOpen(1, true);
    grid.setDetailOpen(3, true);
    grid.setDetailOpen(6, true);
    const shape = grid.visibleRows.map((row) =>
      isDetailRow(row) ? `panel:${String(row.rowKey)}` : 'row',
    );
    expect(shape).toEqual([
      'row',
      'panel:1',
      'row',
      'row',
      'panel:3',
      'row',
      'row',
      'row',
      'panel:6',
    ]);
  });
});

describe('a tree whose children arrive later', () => {
  const loaded: string[] = [];

  async function loadChildren(row: Folder): Promise<Folder[]> {
    loaded.push(row.id);
    if (row.id === 'broken') throw new Error('no permission');
    return [
      new Folder(`${row.id}/a`, 'a'),
      new Folder(`${row.id}/b`, 'b', true),
    ];
  }

  function folderGrid(
    options: { roots?: Folder[] } = {},
  ): GridController<Folder> {
    return new GridController<Folder>({
      columns: [
        new GridColumn<Folder>({ field: 'name', value: (f) => f.name }),
      ],
      dataSource: new InMemoryDataSource<Folder>(
        options.roots ?? [new Folder('root', 'root', true)],
      ),
      rowKey: (f) => f.id,
      tree: new TreeSpec<Folder>({
        childrenLoader: loadChildren,
        hasChildren: (f) => f.isFolder,
      }),
      treeExpandedByDefault: false,
    });
  }

  beforeEach(() => {
    loaded.length = 0;
  });

  it('draws a folder as expandable before its children exist', () => {
    const grid = folderGrid();
    expect(grid.rowCount).toBe(1);
    const root = grid.visibleRows.at(0);
    expect(grid.isLazyTree).toBe(true);
    expect(isDataRow(root) && root.hasChildren).toBe(true);
    expect(loaded, 'nothing was asked for yet').toEqual([]);
  });

  it('fetches a branch when it is opened, and says so while it waits', async () => {
    const grid = folderGrid();
    grid.setRowExpanded(grid.treePathFor('root'), true);
    expect(grid.isLoadingChildren('root')).toBe(true);
    const root = grid.visibleRows.at(0);
    expect(isDataRow(root) && root.isLoadingChildren).toBe(true);
    expect(grid.rowCount, 'an open branch is not yet filled').toBe(1);

    await tick();
    expect(loaded).toEqual(['root']);
    expect(grid.rowCount).toBe(3);
    expect(grid.isLoadingChildren('root')).toBe(false);
    expect(grid.dataAt(1)?.name).toBe('a');
  });

  it('fetches a branch once, however often it is reopened', async () => {
    const grid = folderGrid();
    grid.setRowExpanded(grid.treePathFor('root'), true);
    await tick();
    grid.setRowExpanded(grid.treePathFor('root'), false);
    grid.setRowExpanded(grid.treePathFor('root'), true);
    await tick();
    expect(loaded).toEqual(['root']);
  });

  it('leaves a nested branch unfetched until it is opened', async () => {
    const grid = folderGrid();
    grid.setRowExpanded(grid.treePathFor('root'), true);
    await tick();
    expect(loaded).toEqual(['root']);

    grid.setRowExpanded(grid.treePathFor('root/b'), true);
    await tick();
    expect(loaded).toEqual(['root', 'root/b']);
    expect(grid.rowCount).toBe(5);
  });

  it('reports a branch that fails, and does not retry it every frame', async () => {
    const grid = folderGrid({
      roots: [new Folder('broken', 'broken', true)],
    });
    grid.setRowExpanded(grid.treePathFor('broken'), true);
    await tick();
    expect(grid.childrenError('broken')).toBeInstanceOf(Error);
    expect(loaded).toHaveLength(1);

    await grid.refresh();
    await tick();
    expect(loaded, 'not retried').toHaveLength(1);

    grid.invalidateChildren('broken');
    await tick();
    expect(loaded, 'asked again when told to').toHaveLength(2);
  });

  it('takes exactly one way of finding children', () => {
    expect(
      () =>
        new TreeSpec<Folder>({
          childrenOf: () => [],
          childrenLoader: loadChildren,
        }),
    ).toThrow(GridArgumentError);
  });
});

describe('the one string the engine owns', () => {
  it('takes the blank group label in any language', () => {
    const rows = [
      new Product({ id: 1, name: 'a', category: 'x', price: 1 }),
      new Product({ id: 2, name: 'b', category: 'x', price: 2, stock: 5 }),
    ];
    const grid = productGrid({
      rows,
      groups: [new GroupSpec('stock', { blankLabel: '(leer)' })],
    });
    const labels = grid.visibleRows
      .toArray()
      .filter(isGroupRow)
      .map((row) => row.label);
    expect(labels).toContain('(leer)');
  });

  it('makes it part of the group identity, so changing it regroups', () => {
    const english = new GroupSpec('stock');
    const german = new GroupSpec('stock', { blankLabel: '(leer)' });
    expect(english.fingerprint).not.toBe(german.fingerprint);
    expect(english.equals(german)).toBe(false);
  });

  it('still lets the validators take their message', () => {
    expect(requiredValue('Pflichtfeld')(null)).toBe('Pflichtfeld');
    expect(numberRange({ min: 0, message: 'Zu klein' })(-1)).toBe('Zu klein');
  });
});
