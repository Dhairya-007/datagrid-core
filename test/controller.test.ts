import { describe, expect, it } from 'vitest';
import {
  Aggregation,
  AsyncDataSource,
  CellAddress,
  ColumnPin,
  EditOutcome,
  FilterCondition,
  FilterOperator,
  GridController,
  GridResult,
  GroupSpec,
  InMemoryDataSource,
  isDataRow,
  isGroupRow,
  SelectionMode,
  SortSpec,
  togglingModifier,
  type GroupGridRow,
} from '../src/index';
import {
  labelsOf,
  Product,
  productColumns,
  productGrid,
  sampleProducts,
} from './fixtures';

/** A promise whose resolution the test controls, as Dart's Completer is. */
function completer<V>(): {
  promise: Promise<V>;
  resolve: (value: V) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: V) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('first build', () => {
  it('resolves rows synchronously in the constructor for a local source', () => {
    const grid = productGrid();
    expect(grid.isLoading).toBe(false);
    expect(grid.rowCount).toBe(6);
    expect(grid.totalCount).toBe(6);
    expect(grid.matchedCount).toBe(6);
  });

  it('gives each visible row its source index', () => {
    const grid = productGrid();
    const row = grid.visibleRows.at(0);
    expect(isDataRow(row)).toBe(true);
    if (!isDataRow(row)) return;
    expect(row.index).toBe(0);
    expect(row.sourceIndex).toBe(0);
    expect(row.data.name).toBe('Keyboard');
  });

  it('applies an initial sort before the first render', () => {
    const grid = productGrid({ sorts: [new SortSpec('price')] });
    expect(labelsOf(grid)[0]).toBe('Mouse');
  });

  it('reports an empty source as empty without being loading', () => {
    const grid = productGrid({ rows: [] });
    expect(grid.isEmpty).toBe(true);
    expect(grid.rowCount).toBe(0);
  });
});

describe('sorting through the controller', () => {
  it('cycles and notifies on toggleSort', () => {
    const grid = productGrid();
    let notifications = 0;
    grid.addListener(() => notifications++);

    grid.toggleSort('price');
    expect(labelsOf(grid)[0]).toBe('Mouse');
    grid.toggleSort('price');
    expect(labelsOf(grid)[0]).toBe('Laptop');
    grid.toggleSort('price');
    expect(grid.sorts).toEqual([]);
    expect(labelsOf(grid)[0]).toBe('Keyboard');
    expect(notifications).toBe(3);
  });

  it('replaces the ordering on a plain toggle and appends on ctrl-click', () => {
    const grid = productGrid();
    grid.toggleSort('category');
    grid.toggleSort('price');
    expect(grid.sorts.map((s) => s.field)).toEqual(['price']);
    grid.toggleSort('category', { additive: true });
    expect(grid.sorts.map((s) => s.field)).toEqual(['price', 'category']);
  });

  it('numbers the levels for the header arrows', () => {
    const grid = productGrid();
    grid.toggleSort('category');
    grid.toggleSort('price', { additive: true });
    expect(grid.sortPriority('category')).toBe(1);
    expect(grid.sortPriority('price')).toBe(2);
    expect(grid.sortPriority('name')).toBeNull();
    expect(grid.sortFor('price')?.isAscending).toBe(true);
  });

  it('ignores header clicks on an unsortable column', () => {
    const columns = productColumns();
    columns[0] = (columns[0] as (typeof columns)[0]).copyWith({
      sortable: false,
    });
    const grid = new GridController<Product>({
      columns,
      dataSource: new InMemoryDataSource(sampleProducts()),
    });
    grid.toggleSort('name');
    expect(grid.sorts).toEqual([]);
  });

  it('restores the source order on clearSorts', () => {
    const grid = productGrid({ sorts: [new SortSpec('price')] });
    grid.clearSorts();
    expect(labelsOf(grid)[0]).toBe('Keyboard');
  });
});

describe('filtering and search', () => {
  it('narrows the rows and resets to the first page', () => {
    const grid = productGrid({ pageSize: 2 });
    grid.goToPage(2);
    grid.setColumnFilter(
      'category',
      new FilterCondition({
        field: 'category',
        operator: FilterOperator.equals,
        value: 'Input',
      }),
    );
    expect(grid.pageIndex).toBe(0);
    expect(grid.matchedCount).toBe(3);
  });

  it('combines column filters from several columns with AND', () => {
    const grid = productGrid();
    grid.setColumnFilter(
      'category',
      new FilterCondition({
        field: 'category',
        operator: FilterOperator.equals,
        value: 'Input',
      }),
    );
    grid.setColumnFilter(
      'price',
      new FilterCondition({
        field: 'price',
        operator: FilterOperator.greaterThan,
        value: 50,
      }),
    );
    expect(labelsOf(grid)).toEqual(['Keyboard', 'Webcam']);
  });

  it('clears a column filter given an empty condition', () => {
    const grid = productGrid();
    grid.setColumnFilter(
      'category',
      new FilterCondition({
        field: 'category',
        operator: FilterOperator.equals,
        value: 'Input',
      }),
    );
    expect(grid.matchedCount).toBe(3);
    grid.setColumnFilter('category', null);
    expect(grid.matchedCount).toBe(6);
    expect(grid.columnFilters.size).toBe(0);
  });

  it('stacks search and filters', () => {
    const grid = productGrid();
    grid.setColumnFilter(
      'category',
      new FilterCondition({
        field: 'category',
        operator: FilterOperator.equals,
        value: 'Input',
      }),
    );
    grid.setSearch('mouse');
    expect(labelsOf(grid)).toEqual(['Mouse']);
  });

  it('drops filters, search and the structured filter on clearFilters', () => {
    const grid = productGrid();
    grid.setSearch('mouse');
    grid.setFilter(
      new FilterCondition({
        field: 'price',
        operator: FilterOperator.greaterThan,
        value: 1000,
      }),
    );
    expect(grid.rowCount).toBe(0);
    grid.clearFilters();
    expect(grid.search).toBe('');
    expect(grid.filter).toBeNull();
    expect(grid.rowCount).toBe(6);
  });

  it('does not re-notify when the same search is set twice', () => {
    const grid = productGrid();
    grid.setSearch('mouse');
    let notifications = 0;
    grid.addListener(() => notifications++);
    grid.setSearch('mouse');
    expect(notifications).toBe(0);
  });

  it('shrinks the selection to rows that still exist', () => {
    const grid = productGrid();
    grid.selectAllRows();
    expect(grid.selection.rowCount).toBe(6);
    grid.setSearch('mouse');
    expect(grid.selection.selectedRows).toEqual([0]);
  });
});

describe('paging', () => {
  it('slices and counts pages from the filtered rows', () => {
    const grid = productGrid({ pageSize: 2, sorts: [new SortSpec('price')] });
    expect(grid.pageCount).toBe(3);
    expect(labelsOf(grid)).toEqual(['Mouse', 'Webcam']);
    grid.nextPage();
    expect(grid.pageIndex).toBe(1);
    expect(labelsOf(grid)).toEqual(['Keyboard', 'Dock']);
    grid.nextPage();
    expect(labelsOf(grid)).toEqual(['Monitor', 'Laptop']);
    expect(grid.hasNextPage).toBe(false);
  });

  it('keeps source indices absolute across pages', () => {
    const grid = productGrid({ pageSize: 2 });
    grid.goToPage(1);
    const row = grid.visibleRows.at(0);
    expect(isDataRow(row) && row.sourceIndex).toBe(2);
  });

  it('clamps paging at both ends', () => {
    const grid = productGrid({ pageSize: 2 });
    grid.previousPage();
    expect(grid.pageIndex).toBe(0);
    grid.goToPage(99);
    expect(grid.pageIndex).toBe(2);
    expect(grid.hasPreviousPage).toBe(true);
  });

  it('keeps the current first row in view when the page size changes', () => {
    const grid = productGrid({ pageSize: 2 });
    grid.goToPage(2);
    grid.setPageSize(4);
    expect(grid.pageIndex).toBe(1);
  });

  it('treats no page size as one page of everything', () => {
    const grid = productGrid();
    expect(grid.pageCount).toBe(1);
    expect(grid.rowCount).toBe(6);
  });

  it('still reports one page when a filter empties the grid', () => {
    const grid = productGrid({ pageSize: 2 });
    grid.setSearch('nothing matches this');
    expect(grid.pageCount).toBe(1);
    expect(grid.rowCount).toBe(0);
  });
});

describe('grouping', () => {
  it('emits headers and indented rows', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    expect(grid.isGrouped).toBe(true);
    expect(labelsOf(grid)[0]).toBe('Compute');
    expect(grid.rowCount).toBe(9);
  });

  it('hides the rows of a collapsed group without re-querying', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    const header = grid.visibleRows.at(0) as GroupGridRow<Product>;
    grid.toggleGroup(header.path);
    expect(grid.rowCount).toBe(7);
    grid.toggleGroup(header.path);
    expect(grid.rowCount).toBe(9);
  });

  it('covers every level with collapseAll and expandAll', () => {
    const grid = productGrid({
      groups: [new GroupSpec('category'), new GroupSpec('active')],
    });
    grid.collapseAllGroups();
    expect(grid.rowCount).toBe(3);
    grid.expandAllGroups();
    expect(grid.rowCount).toBe(3 + 4 + 6);
  });

  it('adds a level with groupBy and removes it with ungroup', () => {
    const grid = productGrid();
    grid.groupBy('category');
    expect(grid.groups).toHaveLength(1);
    grid.groupBy('category');
    expect(grid.groups, 'no duplicate levels').toHaveLength(1);
    grid.groupBy('active');
    expect(grid.groups).toHaveLength(2);
    grid.ungroup('category');
    expect(grid.groups.map((g) => g.field)).toEqual(['active']);
    grid.clearGroups();
    expect(grid.isGrouped).toBe(false);
  });

  it('ignores paging while grouped, so group counts stay whole', () => {
    const grid = productGrid({
      groups: [new GroupSpec('category')],
      pageSize: 2,
    });
    expect(grid.rowCount).toBe(9);
  });

  it('puts group aggregates on the header row', () => {
    const grid = productGrid({
      groups: [new GroupSpec('category')],
      aggregations: [Aggregation.sum('price')],
    });
    const header = grid.visibleRows
      .toArray()
      .filter(isGroupRow)
      .find((r) => r.label === 'Input');
    expect(header?.aggregates.get('price.sum')).toBe(165);
    expect(grid.aggregates.get('price.sum')).toBe(2115);
  });

  it('returns null from dataAt for a group header row', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    expect(grid.dataAt(0)).toBeNull();
    expect(grid.dataAt(1)).not.toBeNull();
  });
});

describe('columns', () => {
  it('clamps a resize and reflects it in the layout', () => {
    const grid = productGrid();
    grid.resizeColumn('name', 300);
    expect(grid.widthOf('name')).toBe(300);
    expect(grid.layoutFor(2000).allColumns[0]?.width).toBe(300);
    grid.resizeColumn('name', 10);
    expect(grid.widthOf('name')).toBe(48);
    grid.resetColumnWidth('name');
    expect(grid.widthOf('name')).toBe(140);
  });

  it('refuses a resize on a non-resizable column', () => {
    const columns = productColumns();
    columns[0] = (columns[0] as (typeof columns)[0]).copyWith({
      resizable: false,
    });
    const grid = new GridController<Product>({
      columns,
      dataSource: new InMemoryDataSource(sampleProducts()),
    });
    grid.resizeColumn('name', 300);
    expect(grid.widthOf('name')).toBe(140);
  });

  it('removes a hidden column from the layout and the visible fields', () => {
    const grid = productGrid();
    grid.setColumnVisible('category', false);
    expect(grid.visibleFields).toEqual(['name', 'price', 'stock', 'active']);
    expect(grid.layoutFor(2000).columnCount).toBe(4);
  });

  it('moves a pinned column into a frozen pane', () => {
    const grid = productGrid();
    grid.setColumnPin('name', ColumnPin.start);
    const layout = grid.layoutFor(2000);
    expect(layout.leading.map((c) => c.column.field)).toEqual(['name']);
    expect(layout.scrolling.map((c) => c.column.field)).not.toContain('name');
  });

  it('changes the order fields are reported in when pinning', () => {
    const grid = productGrid();
    grid.setColumnPin('price', ColumnPin.start);
    grid.setColumnPin('name', ColumnPin.end);
    // Screen order: the leading pane, the scrolling pane, then the trailing
    // pane — not the order the columns were declared in.
    expect(grid.visibleFields).toEqual([
      'price',
      'category',
      'stock',
      'active',
      'name',
    ]);
  });

  it('moves arrow keys to the next column on screen, not in the list', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.setColumnPin('stock', ColumnPin.start);
    grid.selectCell(new CellAddress(0, 'stock'));
    grid.moveActiveCell(0, 1);
    expect(grid.selection.activeCell?.field).toBe('name');
  });

  it('changes display order when a column is moved', () => {
    const grid = productGrid();
    grid.moveColumn('name', 2);
    expect(grid.visibleFields.slice(0, 3)).toEqual([
      'category',
      'price',
      'name',
    ]);
  });

  it('clamps a move to an out-of-range index instead of throwing', () => {
    const grid = productGrid();
    grid.moveColumn('name', 99);
    expect(grid.visibleFields[grid.visibleFields.length - 1]).toBe('name');
  });
});

describe('auto-sizing', () => {
  // A stand-in for a text measurer: 7 pixels a character is close enough to a
  // proportional font for a test about the arithmetic around it.
  const measure = (text: string): number => text.length * 7;

  it('fits the widest sampled value plus the cell padding', () => {
    const grid = productGrid();
    // 'Keyboard' is the longest name at 8 characters.
    expect(grid.autoSizeColumn('name', { measure, padding: 10 })).toBe(
      8 * 7 + 10,
    );
    expect(grid.widthOf('name')).toBe(8 * 7 + 10);
  });

  it('takes the header into account, and can be told not to', () => {
    const grid = productGrid();
    const withHeader = grid.autoSizeColumn('active', { measure });
    grid.resetColumnWidth('active');
    const without = grid.autoSizeColumn('active', {
      measure,
      includeHeader: false,
    });
    expect(withHeader).toBeGreaterThan(without as number);
  });

  it('measures formatted text, not the raw value', () => {
    const grid = productGrid();
    // The price column formats as '1450.00 USD'.
    expect(grid.autoSizeColumn('price', { measure, padding: 0 })).toBe(
      '1450.00 USD'.length * 7,
    );
  });

  it('clamps to the column bounds', () => {
    const columns = productColumns();
    columns[0] = (columns[0] as (typeof columns)[0]).copyWith({
      maxWidth: 60,
    });
    const grid = new GridController<Product>({
      columns,
      dataSource: new InMemoryDataSource(sampleProducts()),
    });
    expect(grid.autoSizeColumn('name', { measure })).toBe(60);
  });

  it('refuses a column that cannot be resized', () => {
    const columns = productColumns();
    columns[0] = (columns[0] as (typeof columns)[0]).copyWith({
      resizable: false,
    });
    const grid = new GridController<Product>({
      columns,
      dataSource: new InMemoryDataSource(sampleProducts()),
    });
    expect(grid.autoSizeColumn('name', { measure })).toBeNull();
    expect(grid.autoSizeColumn('nope', { measure })).toBeNull();
  });

  it('samples at most sampleSize rows', () => {
    const rows: Product[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(
        new Product({
          id: i,
          name: i === 99 ? 'a very long name indeed' : 'short',
          category: 'x',
          price: i,
        }),
      );
    }
    const grid = productGrid({ rows });
    let calls = 0;
    grid.autoSizeColumn('name', {
      measure: (text) => {
        calls++;
        return text.length * 7;
      },
      sampleSize: 10,
    });
    expect(calls, '10 rows and the header').toBeLessThanOrEqual(11);
  });

  it('fits every visible column at once', () => {
    const grid = productGrid();
    grid.setColumnVisible('active', false);
    const seen = new Set<string>();
    grid.autoSizeColumns({
      measure: (column, text) => {
        seen.add(column.field);
        return text.length * 7;
      },
    });
    expect(seen).toEqual(new Set(['name', 'category', 'price', 'stock']));
    expect(grid.widthOf('name')).toBe(8 * 7 + 24);
  });
});

describe('selection', () => {
  it('maps selected indices back to rows', () => {
    const grid = productGrid();
    grid.selectRow(0);
    grid.selectRow(2, togglingModifier);
    expect(grid.selectedData.map((p) => p.name)).toEqual([
      'Keyboard',
      'Monitor',
    ]);
  });

  it('skips group headers in selectedData', () => {
    const grid = productGrid({
      groups: [new GroupSpec('category')],
      selectionMode: SelectionMode.multiRow,
    });
    grid.selectAllRows();
    expect(grid.selection.rowCount).toBe(9);
    expect(grid.selectedData).toHaveLength(6);
  });

  it('moves the active cell within bounds', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(0, 'name'));
    grid.moveActiveCell(1, 1);
    expect(
      grid.selection.activeCell?.equals(new CellAddress(1, 'category')),
    ).toBe(true);
    grid.moveActiveCell(-5, -5);
    expect(grid.selection.activeCell?.equals(new CellAddress(0, 'name'))).toBe(
      true,
    );
    grid.moveActiveCell(99, 99);
    expect(
      grid.selection.activeCell?.equals(new CellAddress(5, 'active')),
    ).toBe(true);
  });

  it('extends the range instead of moving it on shift-arrow', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(0, 'name'));
    grid.moveActiveCell(2, 0, { extend: true });
    expect(grid.selection.range?.rowCount).toBe(3);
    expect(
      grid.selection.range?.anchor.equals(new CellAddress(0, 'name')),
    ).toBe(true);
  });

  it('copies a range as tab-separated display text', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(0, 'name'));
    grid.extendSelectionTo(new CellAddress(1, 'category'));
    expect(grid.copySelectionAsText()).toBe('Keyboard\tInput\nMouse\tInput');
  });

  it('can include the headers of a copied range', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(0, 'name'));
    grid.extendSelectionTo(new CellAddress(0, 'category'));
    expect(grid.copySelectionAsText({ includeHeader: true })).toBe(
      'Name\tCategory\nKeyboard\tInput',
    );
  });

  it('covers every visible column when copying selected rows', () => {
    const grid = productGrid();
    grid.selectRow(0);
    expect(grid.copySelectionAsText()).toBe(
      'Keyboard\tInput\t80.00 USD\t12\ttrue',
    );
  });

  it('empties everything on clearSelection', () => {
    const grid = productGrid();
    grid.selectAllRows();
    grid.clearSelection();
    expect(grid.selection.isEmpty).toBe(true);
  });
});

describe('editing', () => {
  it('writes through and refreshes the rows on commit', () => {
    const grid = productGrid();
    const session = grid.beginEdit(new CellAddress(0, 'name'));
    expect(session?.value).toBe('Keyboard');
    grid.updateEdit('Keypad');
    const result = grid.commitEdit();
    expect(result.isCommitted).toBe(true);
    expect(grid.editSession).toBeNull();
    expect(labelsOf(grid)[0]).toBe('Keypad');
  });

  it('moves a row immediately when an edit changes the sort key', () => {
    const grid = productGrid({ sorts: [new SortSpec('price')] });
    expect(labelsOf(grid)[0]).toBe('Mouse');
    grid.beginEdit(new CellAddress(0, 'price'));
    grid.updateEdit(9999);
    grid.commitEdit();
    const labels = labelsOf(grid);
    expect(labels[labels.length - 1]).toBe('Mouse');
  });

  it('rejects an invalid edit and keeps the session open', () => {
    const grid = productGrid();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('');
    const result = grid.commitEdit();
    expect(result.isRejected).toBe(true);
    expect(grid.editSession).not.toBeNull();
    expect(grid.editSession?.error).toBe('Required');
    expect(labelsOf(grid)[0]).toBe('Keyboard');
  });

  it('leaves the row as it was when an edit is cancelled', () => {
    const grid = productGrid();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('Nonsense');
    grid.cancelEdit();
    expect(grid.editSession).toBeNull();
    expect(labelsOf(grid)[0]).toBe('Keyboard');
  });

  it('cannot start a session on a non-editable column', () => {
    const grid = productGrid();
    expect(grid.beginEdit(new CellAddress(0, 'category'))).toBeNull();
    expect(grid.editSession).toBeNull();
  });

  it('cannot start a session on a group header row', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    expect(grid.beginEdit(new CellAddress(0, 'name'))).toBeNull();
  });

  it('identifies just the cell being edited', () => {
    const grid = productGrid();
    grid.beginEdit(new CellAddress(0, 'name'));
    expect(grid.isEditing(new CellAddress(0, 'name'))).toBe(true);
    expect(grid.isEditing(new CellAddress(1, 'name'))).toBe(false);
  });

  it('does nothing when committing with no session open', () => {
    const grid = productGrid();
    expect(grid.commitEdit().outcome).toBe(EditOutcome.cancelled);
  });
});

describe('export', () => {
  it('exports the current view, filters and sorts included', () => {
    const grid = productGrid({ sorts: [new SortSpec('price')] });
    grid.setSearch('Input');
    const csv = grid.exportCsv();
    const rows = csv.split('\r\n').filter((l) => l.length > 0);
    expect(rows).toHaveLength(4);
    expect(rows[1]?.startsWith('Mouse')).toBe(true);
  });

  it('exports the grouped shape when the grid is grouped', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    expect(grid.exportCsv()).toContain('Compute (2)');
  });
});

describe('async sources', () => {
  it('reports loading, then the rows arrive', async () => {
    const pending = completer<GridResult<Product>>();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(() => pending.promise),
    });
    expect(grid.isLoading).toBe(true);
    pending.resolve(
      new GridResult<Product>({ rows: sampleProducts(), totalCount: 6 }),
    );
    await tick();
    expect(grid.isLoading).toBe(false);
    expect(grid.rowCount).toBe(6);
  });

  it('surfaces the error and empties the rows on a failed fetch', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(async () => {
        throw new Error('backend down');
      }),
    });
    await tick();
    expect(grid.error).toBeInstanceOf(Error);
    expect(grid.isLoading).toBe(false);
    expect(grid.rowCount).toBe(0);
  });

  it('does not let a slow earlier query overwrite a newer result', async () => {
    const pending: ReturnType<typeof completer<GridResult<Product>>>[] = [];
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(() => {
        const next = completer<GridResult<Product>>();
        pending.push(next);
        return next.promise;
      }),
    });

    grid.setSearch('second');
    expect(pending).toHaveLength(2);

    // The newer query answers first, then the stale one answers late.
    pending[1]?.resolve(
      new GridResult<Product>({
        rows: [sampleProducts()[0] as Product],
        totalCount: 1,
      }),
    );
    await tick();
    expect(grid.rowCount).toBe(1);

    pending[0]?.resolve(
      new GridResult<Product>({ rows: sampleProducts(), totalCount: 6 }),
    );
    await tick();
    expect(grid.rowCount, 'the stale response was discarded').toBe(1);
  });

  it('re-queries from the new source when it is swapped', () => {
    const grid = productGrid();
    grid.setDataSource(
      new InMemoryDataSource<Product>([
        new Product({ id: 1, name: 'Only', category: 'X', price: 1 }),
      ]),
    );
    expect(labelsOf(grid)).toEqual(['Only']);
  });

  it('refreshes the grid on a source mutation', () => {
    const source = new InMemoryDataSource<Product>(sampleProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
    });
    source.add(
      new Product({ id: 7, name: 'Hub', category: 'Input', price: 30 }),
    );
    expect(grid.rowCount).toBe(7);
  });

  it('stops listening to its source once disposed', () => {
    const source = new InMemoryDataSource<Product>(sampleProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
    });
    grid.dispose();
    source.add(
      new Product({ id: 7, name: 'Hub', category: 'Input', price: 30 }),
    );
    expect(grid.rowCount).toBe(6);
  });
});
