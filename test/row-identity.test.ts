import { describe, expect, it } from 'vitest';
import {
  CellAddress,
  GridController,
  GroupSpec,
  InMemoryDataSource,
  isGroupRow,
  SelectionMode,
  SortDirection,
  SortSpec,
  togglingModifier,
} from '../src/index';
import { labelsOf, Product, productColumns, productGrid, sampleProducts } from './fixtures';

describe('without a row key', () => {
  it('follows the position, which is all a selection can do', () => {
    const grid = productGrid();
    grid.selectRow(1);
    expect(grid.selectedData[0]?.name).toBe('Mouse');
    grid.setSorts([new SortSpec('name')]);
    expect(grid.selectedData[0]?.name).toBe(labelsOf(grid)[1]);
  });

  it('reports that rows cannot be recognised', () => {
    expect(productGrid().hasRowIdentity).toBe(false);
  });
});

describe('with a row key', () => {
  it('keeps a selected row selected after a sort moves it', () => {
    const grid = productGrid({ identified: true });
    grid.selectRow(1);
    expect(grid.selectedData[0]?.name).toBe('Mouse');
    grid.setSorts([new SortSpec('name')]);
    expect(grid.selectedData[0]?.name).toBe('Mouse');
    expect(grid.selection.selectedRows[0]).toBe(labelsOf(grid).indexOf('Mouse'));
  });

  it('follows all of the rows of a multi-row selection', () => {
    const grid = productGrid({ identified: true });
    grid.selectRow(0);
    grid.selectRow(3, togglingModifier);
    const before = new Set(grid.selectedData.map((p) => p.name));
    grid.setSorts([
      new SortSpec('price', { direction: SortDirection.descending }),
    ]);
    expect(new Set(grid.selectedData.map((p) => p.name))).toEqual(before);
  });

  it('follows the active cell to its row and keeps its column', () => {
    const grid = productGrid({
      identified: true,
      selectionMode: SelectionMode.cellRange,
    });
    grid.selectCell(new CellAddress(2, 'price'));
    expect(grid.dataAt(2)?.name).toBe('Monitor');
    grid.setSorts([new SortSpec('name')]);
    const active = grid.selection.activeCell as CellAddress;
    expect(active.field).toBe('price');
    expect(grid.dataAt(active.row)?.name).toBe('Monitor');
  });

  it('deselects a selected row filtered out of the view', () => {
    const grid = productGrid({ identified: true });
    grid.selectRow(1);
    grid.setSearch('keyboard');
    expect(grid.selection.rowCount).toBe(0);
  });

  it('survives the source replacing its rows', () => {
    const rows = sampleProducts();
    const source = new InMemoryDataSource<Product>(rows);
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      rowKey: (p) => p.id,
    });
    grid.selectRow(4);
    expect(grid.selectedData[0]?.id).toBe(5);
    // A refresh that hands back the same rows in a new order, as a server
    // poll would.
    source.setRows([...rows].reverse());
    expect(grid.selectedData[0]?.id).toBe(5);
    expect(grid.selection.selectedRows[0]).toBe(1);
  });

  it('follows an open edit session to its row', () => {
    const grid = productGrid({ identified: true });
    const session = grid.beginEdit(new CellAddress(1, 'name'));
    expect(session?.row.name).toBe('Mouse');
    grid.updateEdit('Mouse Pro');
    grid.setSorts([new SortSpec('price')]);
    expect(grid.editSession).not.toBeNull();
    expect(grid.editSession?.value).toBe('Mouse Pro');
    expect(grid.dataAt(grid.editSession?.cell.row as number)?.id).toBe(2);
  });

  it('closes an edit session over a row that disappears', () => {
    const grid = productGrid({ identified: true });
    grid.beginEdit(new CellAddress(1, 'name'));
    grid.setSearch('keyboard');
    expect(grid.editSession).toBeNull();
  });

  it('keeps the ends of a range selection on the same rows', () => {
    const grid = productGrid({
      identified: true,
      selectionMode: SelectionMode.cellRange,
    });
    grid.selectCell(new CellAddress(0, 'name'));
    grid.extendSelectionTo(new CellAddress(2, 'price'));
    expect(grid.selection.range?.rowCount).toBe(3);
    grid.setSorts([new SortSpec('name')]);
    const range = grid.selection.range as NonNullable<
      typeof grid.selection.range
    >;
    const rows = new Set([
      grid.dataAt(range.anchor.row)?.name,
      grid.dataAt(range.focus.row)?.name,
    ]);
    expect(rows).toEqual(new Set(['Keyboard', 'Monitor']));
  });

  it('keeps group header rows in position, having no identity of their own', () => {
    const grid = productGrid({
      identified: true,
      groups: [new GroupSpec('category')],
    });
    grid.selectRow(0);
    expect(isGroupRow(grid.visibleRows.at(0))).toBe(true);
    void grid.refresh();
    expect(grid.selection.selectedRows).toEqual([0]);
  });

  it('resolves a duplicated key to the topmost of the two rows', () => {
    const rows = [
      new Product({ id: 1, name: 'A', category: 'x', price: 1 }),
      new Product({ id: 1, name: 'B', category: 'x', price: 2 }),
    ];
    const source = new InMemoryDataSource<Product>(rows);
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      rowKey: (p) => p.id,
    });
    grid.selectRow(1);
    source.setRows(rows);
    expect(grid.selection.selectedRows).toEqual([0]);
  });
});
