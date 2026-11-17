// Column, selection and layout fixes from the 0.4.0 review.
import { describe, expect, it } from 'vitest';
import {
  CellAddress,
  CellRange,
  ColumnFit,
  computeLayout,
  FetchSignal,
  FilterCondition,
  FilterOperator,
  GridArgumentError,
  GridChange,
  GridChangeNotifier,
  GridColumn,
  GridController,
  GroupSpec,
  InMemoryDataSource,
  isGroupRow,
  SelectionMode,
  SortSpec,
} from '../src/index';
import { Product, productColumns, sampleProducts } from './fixtures';

describe('a filter on a column that is removed', () => {
  it('stops hiding every row, and comes back with the column', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
    });
    grid.setColumnFilter(
      'category',
      new FilterCondition({
        field: 'category',
        operator: FilterOperator.equals,
        value: 'Input',
      }),
    );
    const matched = grid.matchedCount;
    expect(matched).toBeGreaterThan(0);

    grid.setColumns(productColumns().filter((c) => c.field !== 'category'));
    expect(grid.rowCount).toBe(sampleProducts().length);
    expect(grid.inactiveFields).toEqual(new Set(['category']));

    grid.setColumns(productColumns());
    expect(grid.matchedCount, 'the filter was only parked').toBe(matched);
    expect(grid.inactiveFields.size).toBe(0);
    grid.dispose();
  });

  it('leaves a sort and a grouping on a missing column out too', () => {
    const grid = new GridController<Product>({
      columns: productColumns().filter((c) => c.field !== 'category'),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      sorts: [new SortSpec('category')],
      groups: [new GroupSpec('category')],
    });
    expect(grid.query.sorts).toEqual([]);
    expect(grid.query.groups).toEqual([]);
    expect(grid.rowCount).toBe(sampleProducts().length);
    grid.dispose();
  });
});

describe('moveColumn', () => {
  it('counts positions on screen, not declarations', () => {
    const columns = [
      new GridColumn<Product>({ field: 'a', value: (p) => p.id }),
      new GridColumn<Product>({
        field: 'hidden',
        value: (p) => p.id,
        visible: false,
      }),
      new GridColumn<Product>({ field: 'b', value: (p) => p.name }),
      new GridColumn<Product>({ field: 'c', value: (p) => p.category }),
    ];
    const grid = new GridController<Product>({
      columns,
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
    });
    expect(grid.visibleFields).toEqual(['a', 'b', 'c']);
    grid.moveColumn('a', 2);
    expect(grid.visibleFields).toEqual(['b', 'c', 'a']);
    grid.moveColumn('a', 0);
    expect(grid.visibleFields).toEqual(['a', 'b', 'c']);
    grid.dispose();
  });
});

describe('two columns with one field', () => {
  it('are refused rather than silently merged', () => {
    expect(
      () =>
        new GridController<Product>({
          columns: [
            new GridColumn<Product>({ field: 'name', value: (p) => p.name }),
            new GridColumn<Product>({
              field: 'name',
              value: (p) => p.category,
            }),
          ],
          dataSource: new InMemoryDataSource<Product>(sampleProducts()),
        }),
    ).toThrow(GridArgumentError);
  });
});

describe('a cell range', () => {
  it('does not outlive the rows it covered', () => {
    const source = new InMemoryDataSource<Product>(sampleProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      selectionMode: SelectionMode.cellRange,
    });
    grid.selectCell(new CellAddress(0, 'name'));
    grid.extendSelectionTo(new CellAddress(grid.rowCount - 1, 'price'));
    expect(grid.selection.range?.lastRow).toBe(grid.rowCount - 1);

    source.setRows(sampleProducts().slice(0, 2));
    expect(grid.selection.range?.lastRow).toBeLessThan(2);
    const text = grid.copySelectionAsText();
    expect(text.split('\n')).toHaveLength(2);
    grid.dispose();
  });

  it('contains no cell once its own column has gone', () => {
    const range = new CellRange({
      anchor: new CellAddress(0, 'gone'),
      focus: new CellAddress(1, 'gone'),
      fields: ['name', 'price'],
    });
    expect(range.coveredFields).toEqual([]);
    expect(range.contains(new CellAddress(0, 'gone'))).toBe(false);
    expect(range.contains(new CellAddress(0, 'name'))).toBe(false);
  });
});

describe('a selected group header', () => {
  it('stays on its own group when another collapses', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      groups: [new GroupSpec('category')],
      rowKey: (p) => p.id,
    });
    const headers = grid.visibleRows.toArray().filter(isGroupRow);
    const display = headers.find((h) => h.label === 'Display');
    grid.selection.selectRow(display?.index as number);

    const compute = headers.find((h) => h.label === 'Compute');
    grid.setGroupExpanded(compute?.path as string, false);

    const selected = grid.selection.selectedRows[0] as number;
    const row = grid.visibleRows.at(selected);
    expect(isGroupRow(row) && row.label).toBe('Display');
    grid.dispose();
  });
});

describe('a stretch fit', () => {
  it('offers what a clamped column refuses to the rest', () => {
    const columns = [
      new GridColumn<Product>({
        field: 'a',
        value: (p) => p.id,
        width: 100,
        maxWidth: 110,
      }),
      new GridColumn<Product>({ field: 'b', value: (p) => p.name, width: 100 }),
      new GridColumn<Product>({
        field: 'c',
        value: (p) => p.category,
        width: 100,
      }),
    ];
    const layout = computeLayout<Product>(columns, {
      viewportWidth: 600,
      fit: ColumnFit.stretch,
    });
    const widths = layout.allColumns.map((c) => c.width);
    expect(widths[0]).toBe(110);
    expect(widths[1]).toBeCloseTo(245, 0);
    expect(widths[2]).toBeCloseTo(245, 0);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(600, 0);
  });
});

describe('one listener that throws', () => {
  it('does not stop the listeners after it', () => {
    const notifier = new GridChangeNotifier();
    let later = 0;
    let changes = 0;
    notifier.addListener(() => {
      throw new Error('boom');
    });
    notifier.addListener(() => later++);
    notifier.addChangeListener(() => changes++);
    expect(
      () => notifier.notifyListeners([GridChange.rows]),
      'the failure is still reported',
    ).toThrow('boom');
    expect(later, 'the second listener still ran').toBe(1);
    expect(changes, 'and so did the change listeners').toBe(1);
  });

  it('still reaches every listener of a cancellation', () => {
    const signal = new FetchSignal();
    let later = 0;
    signal.onCancel(() => {
      throw new Error('boom');
    });
    signal.onCancel(() => later++);
    expect(() => signal.cancel()).toThrow('boom');
    expect(later).toBe(1);
    expect(signal.isCancelled).toBe(true);
  });
});
