import { describe, expect, it } from 'vitest';
import {
  Aggregation,
  AggregateType,
  AsyncDataSource,
  CellAddress,
  ColumnFit,
  ColumnPin,
  everyGridChange,
  GridChange,
  GridController,
  GridDataSource,
  GridQuery,
  GridResult,
  GridStateError,
  GroupSpec,
  InMemoryDataSource,
  NullsPosition,
  SelectionMode,
  SortSpec,
  type CellValue,
} from '../src/index';
import {
  productColumns,
  productGrid,
  Product,
  sampleProducts,
} from './fixtures';

/**
 * A synchronous source that is not InMemoryDataSource, which is what the
 * controller used to require before it asked about capabilities.
 */
class SyncSource extends GridDataSource<Product> {
  asyncFetches = 0;

  constructor(private readonly data: Product[]) {
    super();
  }

  override get isLocal(): boolean {
    return true;
  }

  override get isSynchronous(): boolean {
    return true;
  }

  override fetchSync(): GridResult<Product> {
    return new GridResult<Product>({
      rows: [...this.data],
      totalCount: this.data.length,
    });
  }

  override async fetch(): Promise<GridResult<Product>> {
    this.asyncFetches++;
    return this.fetchSync();
  }
}

const sumValues = (values: CellValue[]): CellValue => values.length;
const countValues = (values: CellValue[]): CellValue => values.length + 1;
const odd = (value: CellValue): CellValue => (value as number) % 2 === 1;

describe('one display order', () => {
  it('has the layout, the fields and the export agree once a column is pinned', () => {
    const grid = productGrid();
    grid.setColumnPin('price', ColumnPin.start);
    grid.setColumnPin('name', ColumnPin.end);

    const layout = grid.layoutFor(2000);
    const fromLayout = layout.allColumns.map((c) => c.column.field);
    expect(fromLayout).toEqual(grid.visibleFields);
    expect((grid.exportCsv().split('\r\n')[0] as string).split(',')).toEqual(
      grid.visibleFields.map((f) => grid.column(f)?.title),
    );
  });

  it('gives a laid-out column the index of its position on screen', () => {
    const grid = productGrid();
    grid.setColumnPin('stock', ColumnPin.start);
    const layout = grid.layoutFor(2000);
    for (const laid of layout.allColumns) {
      expect(laid.index).toBe(grid.visibleFields.indexOf(laid.column.field));
    }
  });

  it('grows the last column on screen with the lastColumn fit', () => {
    const grid = productGrid();
    grid.columnFit = ColumnFit.lastColumn;
    grid.setColumnPin('name', ColumnPin.end);
    const layout = grid.layoutFor(2000);
    // 'name' is pinned to the trailing edge, so it is the last one there.
    expect(layout.allColumns[layout.allColumns.length - 1]?.column.field).toBe(
      'name',
    );
    expect(layout.trailing).toHaveLength(1);
    expect(layout.trailing[0]?.width).toBeGreaterThan(140);
  });
});

describe('cache keys come from each spec', () => {
  it('has a sort spec state every field that changes its result', () => {
    const ascending = new SortSpec('price');
    const descending = ascending.reversed;
    const nullsFirst = new SortSpec('price', { nulls: NullsPosition.first });
    expect(ascending.fingerprint).not.toBe(descending.fingerprint);
    expect(ascending.fingerprint).not.toBe(nullsFirst.fingerprint);
    expect(ascending.fingerprint).toBe(new SortSpec('price').fingerprint);
  });

  it('tells two custom aggregations with one id but different reducers apart', () => {
    const first = new Aggregation('price', {
      type: AggregateType.custom,
      id: 'x',
      compute: sumValues,
    });
    const second = new Aggregation('price', {
      type: AggregateType.custom,
      id: 'x',
      compute: countValues,
    });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('fingerprints each stage of the pipeline', () => {
    const base = new GridQuery({
      sorts: [new SortSpec('price')],
      search: 'mo',
    });
    // Changing the ordering leaves the matched set alone.
    const reordered = base.copyWith({ sorts: [new SortSpec('name')] });
    expect(reordered.matchFingerprint).toBe(base.matchFingerprint);
    expect(reordered.orderFingerprint).not.toBe(base.orderFingerprint);

    // Changing the needle changes both.
    const searched = base.copyWith({ search: 'mouse' });
    expect(searched.matchFingerprint).not.toBe(base.matchFingerprint);

    // The needle is compared as matching uses it.
    expect(base.copyWith({ search: ' MO ' }).matchFingerprint).toBe(
      base.matchFingerprint,
    );
  });

  it('misses the cache when regrouping with a different keyOf, as it must', () => {
    const groups = new GridQuery({ groups: [new GroupSpec('price')] });
    const other = new GridQuery({
      groups: [new GroupSpec('price', { keyOf: odd })],
    });
    expect(other.groupFingerprint).not.toBe(groups.groupFingerprint);
  });

  it('makes aggregations part of the group identity', () => {
    const plain = new GridQuery({ groups: [new GroupSpec('category')] });
    const withSum = plain.copyWith({
      aggregations: [Aggregation.sum('price')],
    });
    expect(withSum.groupFingerprint).not.toBe(plain.groupFingerprint);
  });
});

describe('capabilities instead of type checks', () => {
  it('resolves a synchronous source in the constructor, whatever its type', () => {
    const source = new SyncSource(sampleProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
    });
    expect(grid.isLoading).toBe(false);
    expect(grid.rowCount).toBe(6);
    expect(source.asyncFetches, 'the sync path was taken').toBe(0);
  });

  it('treats a source that says nothing as remote', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(
        async () =>
          new GridResult<Product>({ rows: sampleProducts(), totalCount: 6 }),
      ),
    });
    expect(grid.isLoading).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(grid.rowCount).toBe(6);
  });

  it('throws from fetchSync rather than lying about an empty result', () => {
    const source = new AsyncDataSource<Product>(
      async () => new GridResult<Product>({ rows: [], totalCount: 0 }),
    );
    expect(source.isSynchronous).toBe(false);
    expect(() => source.fetchSync(new GridQuery())).toThrow(GridStateError);
  });

  it('has an in-memory source declare what it can do', () => {
    const capabilities = productGrid().sourceCapabilities;
    expect(capabilities.isLocal).toBe(true);
    expect(capabilities.isSynchronous).toBe(true);
    expect(capabilities.canWrite).toBe(true);
    expect(capabilities.providesStats).toBe(true);
    expect(capabilities.providesDistinctValues).toBe(true);
    expect(capabilities.supportsLazyGroups).toBe(false);
    expect(String(capabilities)).toContain('local');
  });

  it('has a bare async source claim nothing it cannot honour', () => {
    const source = new AsyncDataSource<Product>(
      async () => new GridResult<Product>({ rows: [], totalCount: 0 }),
    );
    const capabilities = source.capabilities;
    expect(capabilities.isLocal).toBe(false);
    expect(capabilities.canWrite).toBe(false);
    expect(capabilities.providesStats).toBe(false);
    expect(capabilities.supportsCancellation).toBe(false);
  });
});

describe('what changed', () => {
  function recordOn(grid: GridController<Product>): Set<GridChange>[] {
    const seen: Set<GridChange>[] = [];
    grid.addChangeListener((changes) => seen.push(new Set(changes)));
    return seen;
  }

  it('does not say the rows changed when a cell is clicked', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    const seen = recordOn(grid);
    grid.selectCell(new CellAddress(1, 'name'));
    expect(seen).toEqual([new Set([GridChange.selection])]);
    expect(seen[0]?.has(GridChange.rows)).toBe(false);
  });

  it('calls a resize layout, not rows', () => {
    const grid = productGrid();
    const seen = recordOn(grid);
    grid.resizeColumn('name', 220);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(new Set([GridChange.layout]));
  });

  it('says sorting changes the rows', () => {
    const grid = productGrid();
    const seen = recordOn(grid);
    grid.toggleSort('price');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.has(GridChange.rows)).toBe(true);
    expect(seen[0]?.has(GridChange.layout)).toBe(false);
  });

  it('gives an edit session its own kind of change', () => {
    const grid = productGrid();
    const seen = recordOn(grid);
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('Keypad');
    expect(seen).toEqual([
      new Set([GridChange.edit]),
      new Set([GridChange.edit]),
    ]);
  });

  it('reports both the geometry and the rows, once, when a column is hidden', () => {
    const grid = productGrid();
    const seen = recordOn(grid);
    grid.setColumnVisible('category', false);
    expect(seen, 'batched into one notification').toHaveLength(1);
    expect(seen[0]?.has(GridChange.layout)).toBe(true);
    expect(seen[0]?.has(GridChange.rows)).toBe(true);
  });

  it('notifies once for the union of what a batch did', () => {
    const grid = productGrid();
    const seen = recordOn(grid);
    grid.batch(() => {
      grid.resizeColumn('name', 200);
      grid.selectRow(1);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(new Set([GridChange.layout, GridChange.selection]));
  });

  it('lets a plain listener read what the notification was about', () => {
    const grid = productGrid();
    const seen: ReadonlySet<GridChange>[] = [];
    grid.addListener(() => seen.push(new Set(grid.lastChanges)));
    grid.clearSelection();
    grid.selectRow(0);
    expect(seen[seen.length - 1]).toEqual(new Set([GridChange.selection]));
  });

  it('treats a caller that says nothing as meaning everything', () => {
    const source = new InMemoryDataSource<Product>(sampleProducts());
    const seen: ReadonlySet<GridChange>[] = [];
    source.addChangeListener((changes) => seen.push(changes));
    // A source invalidating itself does not know what it affected.
    source.invalidate();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(everyGridChange);
  });

  it('narrows a blanket notification from its source', () => {
    const source = new InMemoryDataSource<Product>(sampleProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
    });
    const seen = recordOn(grid);
    source.invalidate();
    // It re-queried, so it knows the rows are what changed — not the column
    // geometry, and not the edit session.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.has(GridChange.rows)).toBe(true);
    expect(seen[0]?.has(GridChange.layout)).toBe(false);
    expect(seen[0]?.has(GridChange.edit)).toBe(false);
  });

  it('stops a change listener that was removed', () => {
    const grid = productGrid();
    const seen: ReadonlySet<GridChange>[] = [];
    const listener = (changes: ReadonlySet<GridChange>): void => {
      seen.push(changes);
    };
    grid.addChangeListener(listener);
    grid.selectRow(0);
    grid.removeChangeListener(listener);
    grid.selectRow(1);
    expect(seen).toHaveLength(1);
  });
});
