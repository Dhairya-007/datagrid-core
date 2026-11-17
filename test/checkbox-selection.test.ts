import { describe, expect, it } from 'vitest';
import {
  GroupSpec,
  SelectionCoverage,
  SelectionMode,
  SelectionState,
  togglingModifier,
} from '../src/index';
import { productGrid } from './fixtures';

describe('coverage', () => {
  it('reports none, some and all', () => {
    const selection = new SelectionState();
    expect(selection.coverageOf(3)).toBe(SelectionCoverage.none);

    selection.selectRow(0);
    expect(selection.coverageOf(3)).toBe(SelectionCoverage.some);

    selection.selectAll(3);
    expect(selection.coverageOf(3)).toBe(SelectionCoverage.all);
  });

  it('never calls an empty grid partly selected', () => {
    const selection = new SelectionState();
    selection.selectRow(0);
    expect(selection.coverageOf(0)).toBe(SelectionCoverage.none);
  });

  it('does not let stale indices make a partial selection look complete', () => {
    const selection = new SelectionState();
    selection.selectAll(10);
    // The grid shrank to 3 rows; 7 of the selected indices no longer exist.
    expect(selection.coverageOf(3)).toBe(SelectionCoverage.all);

    const partial = new SelectionState();
    partial.selectRow(7, togglingModifier);
    partial.selectRow(8, togglingModifier);
    expect(partial.coverageOf(3)).toBe(SelectionCoverage.none);
  });

  it('calls one row of one complete', () => {
    const selection = new SelectionState();
    selection.selectRow(0);
    expect(selection.coverageOf(1)).toBe(SelectionCoverage.all);
  });
});

describe('through the controller', () => {
  it('selects everything, then clears it', () => {
    const grid = productGrid();
    expect(grid.selectionCoverage).toBe(SelectionCoverage.none);

    grid.toggleSelectAll();
    expect(grid.selectionCoverage).toBe(SelectionCoverage.all);
    expect(grid.selection.rowCount).toBe(6);

    grid.toggleSelectAll();
    expect(grid.selectionCoverage).toBe(SelectionCoverage.none);
  });

  it('turns a partial selection into a full one, not an empty one', () => {
    const grid = productGrid();
    grid.selectRow(2);
    expect(grid.selectionCoverage).toBe(SelectionCoverage.some);
    grid.toggleSelectAll();
    expect(grid.selectionCoverage).toBe(SelectionCoverage.all);
  });

  it('toggles only its own row from a row checkbox', () => {
    const grid = productGrid();
    grid.setRowSelected(1, true);
    grid.setRowSelected(3, true);
    expect(grid.selection.selectedRows).toEqual([1, 3]);

    grid.setRowSelected(1, false);
    expect(grid.selection.selectedRows).toEqual([3]);
  });

  it('does nothing when a row is set to the state it already has', () => {
    const grid = productGrid();
    grid.setRowSelected(1, true);
    let notified = 0;
    grid.addListener(() => notified++);
    grid.setRowSelected(1, true);
    expect(notified).toBe(0);
    expect(grid.selection.selectedRows).toEqual([1]);
  });

  it('does not clear the rest from a checkbox, unlike a row click', () => {
    const grid = productGrid();
    grid.setRowSelected(0, true);
    grid.setRowSelected(1, true);
    expect(grid.selection.rowCount).toBe(2);

    // A plain click is the replacing gesture.
    grid.selectRow(4);
    expect(grid.selection.selectedRows).toEqual([4]);
  });

  it('follows a filter that shrinks the grid', () => {
    const grid = productGrid();
    grid.selectAllRows();
    expect(grid.selectionCoverage).toBe(SelectionCoverage.all);

    grid.setSearch('Input');
    // Selection was clamped to the three remaining rows.
    expect(grid.rowCount).toBe(3);
    expect(grid.selectionCoverage).toBe(SelectionCoverage.all);
  });

  it('counts header rows, which are selectable too', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    grid.toggleSelectAll();
    expect(grid.selection.rowCount).toBe(9);
    expect(grid.selectedData).toHaveLength(6);
  });

  it('selects nothing at all in none mode', () => {
    const grid = productGrid({ selectionMode: SelectionMode.none });
    grid.toggleSelectAll();
    expect(grid.selectionCoverage).toBe(SelectionCoverage.none);
    grid.setRowSelected(0, true);
    expect(grid.selection.isEmpty).toBe(true);
  });
});
