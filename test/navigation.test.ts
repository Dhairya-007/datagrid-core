import { describe, expect, it } from 'vitest';
import {
  AggregateType,
  Aggregation,
  CellAddress,
  ColumnPin,
  GridColumn,
  GridController,
  GroupSpec,
  InMemoryDataSource,
  isGroupRow,
  SelectionMode,
  type CellValue,
} from '../src/index';
import { Product, productGrid, sampleProducts } from './fixtures';

const money = (value: CellValue): string =>
  value === null || value === undefined
    ? ''
    : `${(value as number).toFixed(2)} USD`;

describe('paging the active cell', () => {
  it('moves a screenful down and stops at the last row', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(0, 'name'));
    grid.movePages(1, { rowsPerPage: 4 });
    expect(grid.selection.activeCell?.equals(new CellAddress(4, 'name'))).toBe(
      true,
    );
    grid.movePages(1, { rowsPerPage: 4 });
    expect(grid.selection.activeCell?.equals(new CellAddress(5, 'name'))).toBe(
      true,
    );
  });

  it('stops at the first row going up', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(3, 'name'));
    grid.movePages(-1, { rowsPerPage: 10 });
    expect(grid.selection.activeCell?.equals(new CellAddress(0, 'name'))).toBe(
      true,
    );
  });

  it('does not move for a viewport of no rows', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(2, 'name'));
    grid.movePages(1, { rowsPerPage: 0 });
    expect(grid.selection.activeCell?.equals(new CellAddress(2, 'name'))).toBe(
      true,
    );
  });

  it('extends the range instead of replacing it on shift-PageDown', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(0, 'name'));
    grid.movePages(1, { rowsPerPage: 3, extend: true });
    expect(grid.selection.range?.rowCount).toBe(4);
  });
});

describe('Home and End', () => {
  it('move to the first and last column of the row', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(2, 'price'));
    grid.moveToLineEdge({ start: true });
    expect(grid.selection.activeCell?.equals(new CellAddress(2, 'name'))).toBe(
      true,
    );
    grid.moveToLineEdge({ start: false });
    expect(
      grid.selection.activeCell?.equals(new CellAddress(2, 'active')),
    ).toBe(true);
  });

  it('follow screen order, so pinning moves where Home lands', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.setColumnPin('stock', ColumnPin.start);
    grid.selectCell(new CellAddress(0, 'price'));
    grid.moveToLineEdge({ start: true });
    expect(grid.selection.activeCell?.field).toBe('stock');
  });

  it('go to the corners of the grid with ctrl held', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(2, 'price'));
    grid.moveToGridEdge({ start: false });
    expect(
      grid.selection.activeCell?.equals(new CellAddress(5, 'active')),
    ).toBe(true);
    grid.moveToGridEdge({ start: true });
    expect(grid.selection.activeCell?.equals(new CellAddress(0, 'name'))).toBe(
      true,
    );
  });

  it('do not move in an empty grid', () => {
    const grid = productGrid({ rows: [] });
    grid.moveToGridEdge({ start: true });
    grid.moveToLineEdge({ start: true });
    expect(grid.selection.activeCell).toBeNull();
  });
});

describe('Tab between editable cells', () => {
  it('skips the columns that cannot be edited', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(0, 'name'));
    expect(
      grid.moveToNextEditableCell()?.equals(new CellAddress(0, 'price')),
    ).toBe(true);
    expect(
      grid.moveToNextEditableCell()?.equals(new CellAddress(1, 'name')),
    ).toBe(true);
  });

  it('walks back on shift-Tab', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(1, 'name'));
    expect(
      grid
        .moveToNextEditableCell({ backwards: true })
        ?.equals(new CellAddress(0, 'price')),
    ).toBe(true);
  });

  it('wraps round at the end, or stops if told not to', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(5, 'price'));
    expect(grid.moveToNextEditableCell({ wrap: false })).toBeNull();
    expect(
      grid.selection.activeCell?.equals(new CellAddress(5, 'price')),
    ).toBe(true);
    expect(
      grid.moveToNextEditableCell()?.equals(new CellAddress(0, 'name')),
    ).toBe(true);
  });

  it('starts from a non-editable column at the next editable one', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(0, 'category'));
    expect(
      grid.moveToNextEditableCell()?.equals(new CellAddress(0, 'price')),
    ).toBe(true);
  });

  it('steps over a group header rather than landing on it', () => {
    const grid = productGrid({
      groups: [new GroupSpec('category')],
      selectionMode: SelectionMode.cellRange,
    });
    const lastOfGroup =
      grid.visibleRows.findIndex((r) => isGroupRow(r) && r.index > 0) - 1;
    grid.selectCell(new CellAddress(lastOfGroup, 'price'));
    const next = grid.moveToNextEditableCell();
    expect(next).not.toBeNull();
    expect(grid.dataAt((next as CellAddress).row)).not.toBeNull();
  });

  it('has nowhere to go in a grid with no editable column', () => {
    const grid = new GridController<Product>({
      columns: [
        new GridColumn<Product>({ field: 'name', value: (p) => p.name }),
      ],
      dataSource: new InMemoryDataSource(sampleProducts()),
      selectionMode: SelectionMode.cellRange,
    });
    expect(grid.moveToNextEditableCell()).toBeNull();
  });
});

describe('aggregate formatting', () => {
  it('reads a count as a count and a sum in its own units', () => {
    const count = Aggregation.count('price');
    const sum = Aggregation.sum('price', { format: money });
    expect(count.formatted(count.apply([1, 2, 3]))).toBe('3');
    expect(sum.formatted(sum.apply([1, 2, 3]))).toBe('6.00 USD');
  });

  it('cuts a fractional result to two places and a whole one to none', () => {
    const average = Aggregation.average('price');
    expect(average.formatted(average.apply([1, 2]))).toBe('1.50');
    expect(average.formatted(average.apply([2, 4]))).toBe('3');
    expect(average.formatted(average.apply([1, 2, 2]))).toBe('1.67');
  });

  it('formats an empty group as empty, not as zero', () => {
    const sum = Aggregation.sum('price');
    expect(sum.formatted(sum.apply([]))).toBe('');
  });

  it('still prints a non-numeric result', () => {
    const first = new Aggregation('name', { type: AggregateType.first });
    expect(first.formatted(first.apply(['a', 'b']))).toBe('a');
  });

  it('rounds a negative zero to plain zero', () => {
    const sum = Aggregation.sum('price');
    expect(sum.formatted(-0.001)).toBe('0.00');
  });
});
