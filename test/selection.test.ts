import { describe, expect, it } from 'vitest';
import {
  CellAddress,
  extendingModifier,
  SelectionMode,
  SelectionState,
  togglingModifier,
} from '../src/index';

const fields = ['name', 'category', 'price', 'stock'];

describe('row selection', () => {
  it('replaces the selection on a plain click', () => {
    const selection = new SelectionState();
    selection.selectRow(1);
    selection.selectRow(3);
    expect(selection.selectedRows).toEqual([3]);
  });

  it('toggles rows in and out on ctrl-click', () => {
    const selection = new SelectionState();
    selection.selectRow(1);
    selection.selectRow(3, togglingModifier);
    expect(selection.selectedRows).toEqual([1, 3]);
    selection.selectRow(1, togglingModifier);
    expect(selection.selectedRows).toEqual([3]);
  });

  it('selects the span from the anchor on shift-click', () => {
    const selection = new SelectionState();
    selection.selectRow(1);
    selection.selectRow(4, extendingModifier);
    expect(selection.selectedRows).toEqual([1, 2, 3, 4]);
  });

  it('works backwards from the anchor', () => {
    const selection = new SelectionState();
    selection.selectRow(4);
    selection.selectRow(1, extendingModifier);
    expect(selection.selectedRows).toEqual([1, 2, 3, 4]);
  });

  it('re-spans from the same anchor on a second shift-click', () => {
    const selection = new SelectionState();
    selection.selectRow(1);
    selection.selectRow(5, extendingModifier);
    selection.selectRow(3, extendingModifier);
    expect(selection.selectedRows).toEqual([1, 2, 3]);
  });

  it('moves the anchor on ctrl-click, for the next shift-click', () => {
    const selection = new SelectionState();
    selection.selectRow(1);
    selection.selectRow(4, togglingModifier);
    selection.selectRow(6, extendingModifier);
    expect(selection.selectedRows).toEqual([4, 5, 6]);
  });

  it('never holds more than one row in singleRow mode', () => {
    const selection = new SelectionState({ mode: SelectionMode.singleRow });
    selection.selectRow(1);
    selection.selectRow(3, togglingModifier);
    expect(selection.selectedRows).toEqual([3]);
    selection.selectRow(5, extendingModifier);
    expect(selection.selectedRows).toEqual([5]);
  });

  it('selects nothing at all in none mode', () => {
    const selection = new SelectionState({ mode: SelectionMode.none });
    selection.selectRow(1);
    selection.selectCell(new CellAddress(1, 'name'), fields);
    expect(selection.isEmpty).toBe(true);
  });

  it('takes every row with selectAll, and empties on clear', () => {
    const selection = new SelectionState();
    selection.selectAll(4);
    expect(selection.selectedRows).toEqual([0, 1, 2, 3]);
    selection.clear();
    expect(selection.isEmpty).toBe(true);
    expect(selection.activeCell).toBeNull();
  });

  it('does nothing on selectAll in a single-selection mode', () => {
    const selection = new SelectionState({ mode: SelectionMode.singleRow });
    selection.selectAll(4);
    expect(selection.selectedRows).toEqual([]);
  });

  it('holds select-all as a flag rather than as every index', () => {
    const selection = new SelectionState();
    selection.selectAll(1_000_000);
    expect(selection.isEverythingSelected).toBe(true);
    expect(selection.rowCount).toBe(1_000_000);
    expect(selection.isRowSelected(999_999)).toBe(true);
    expect([...selection.followedRows]).toEqual([]);
    selection.selectRow(5, togglingModifier);
    expect(selection.isRowSelected(5)).toBe(false);
    expect(selection.rowCount).toBe(999_999);
  });
});

describe('cell and range selection', () => {
  it('makes a clicked cell active and starts a one-cell range', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(2, 'category'), fields);
    expect(selection.activeCell?.equals(new CellAddress(2, 'category'))).toBe(
      true,
    );
    expect(selection.range?.rowCount).toBe(1);
    expect(selection.range?.columnCount).toBe(1);
  });

  it('extends to a rectangle on shift-click', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(1, 'name'), fields);
    selection.selectCell(
      new CellAddress(3, 'price'),
      fields,
      extendingModifier,
    );
    const range = selection.range;
    expect(range?.firstRow).toBe(1);
    expect(range?.lastRow).toBe(3);
    expect(range?.coveredFields).toEqual(['name', 'category', 'price']);
    expect(range?.rowCount).toBe(3);
    expect(range?.columnCount).toBe(3);
  });

  it('normalises a range dragged up and to the left', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(3, 'price'), fields);
    selection.extendTo(new CellAddress(1, 'name'), fields);
    const range = selection.range;
    expect(range?.firstRow).toBe(1);
    expect(range?.lastRow).toBe(3);
    expect(range?.coveredFields).toEqual(['name', 'category', 'price']);
  });

  it('keeps the anchor and moves the focus when extending', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(1, 'name'), fields);
    selection.extendTo(new CellAddress(2, 'category'), fields);
    selection.extendTo(new CellAddress(3, 'price'), fields);
    expect(selection.range?.anchor.equals(new CellAddress(1, 'name'))).toBe(
      true,
    );
    expect(selection.range?.focus.equals(new CellAddress(3, 'price'))).toBe(
      true,
    );
  });

  it('covers the inside and rejects the outside', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(1, 'name'), fields);
    selection.extendTo(new CellAddress(2, 'category'), fields);
    const range = selection.range;
    expect(range?.contains(new CellAddress(2, 'name'))).toBe(true);
    expect(range?.contains(new CellAddress(3, 'name'))).toBe(false);
    expect(range?.contains(new CellAddress(1, 'price'))).toBe(false);
  });

  it('enumerates cells row-major, which is what a copy needs', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(0, 'name'), fields);
    selection.extendTo(new CellAddress(1, 'category'), fields);
    expect(
      [...(selection.range?.cells() ?? [])].map((c) => `${c.row}:${c.field}`),
    ).toEqual(['0:name', '0:category', '1:name', '1:category']);
  });

  it('also selects the row for a cell click in a row mode', () => {
    const selection = new SelectionState();
    selection.selectCell(new CellAddress(2, 'name'), fields);
    expect(selection.selectedRows).toEqual([2]);
    expect(selection.range).toBeNull();
  });

  it('reflects the range and the active cell in isCellSelected', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(1, 'name'), fields);
    selection.extendTo(new CellAddress(1, 'category'), fields);
    expect(selection.isCellSelected(new CellAddress(1, 'category'))).toBe(true);
    expect(selection.isCellSelected(new CellAddress(1, 'price'))).toBe(false);
  });

  it('behaves as a plain click when extending without an anchor', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.extendTo(new CellAddress(2, 'price'), fields);
    expect(selection.activeCell?.equals(new CellAddress(2, 'price'))).toBe(
      true,
    );
    expect(selection.range?.rowCount).toBe(1);
  });

  it('yields an empty range for a field no longer visible, rather than a crash', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(1, 'gone'), ['name', 'price']);
    expect(selection.range?.coveredFields).toEqual([]);
    expect(selection.range?.contains(new CellAddress(1, 'name'))).toBe(false);
  });
});

describe('clampTo', () => {
  it('drops rows that no longer exist', () => {
    const selection = new SelectionState();
    selection.selectAll(10);
    selection.clampTo(4);
    expect(selection.selectedRows).toEqual([0, 1, 2, 3]);
  });

  it('pulls the active cell back into range', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(9, 'name'), fields);
    selection.clampTo(4);
    expect(selection.activeCell?.equals(new CellAddress(3, 'name'))).toBe(true);
  });

  it('clears the active cell when every row is gone', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(2, 'name'), fields);
    selection.clampTo(0);
    expect(selection.activeCell).toBeNull();
    expect(selection.selectedRows).toEqual([]);
  });

  it('leaves a selection that is still valid alone', () => {
    const selection = new SelectionState();
    selection.selectRow(1);
    selection.clampTo(10);
    expect(selection.selectedRows).toEqual([1]);
  });

  it('clamps a range, so a copy cannot emit rows that are not there', () => {
    const selection = new SelectionState({ mode: SelectionMode.cellRange });
    selection.selectCell(new CellAddress(0, 'name'), fields);
    selection.extendTo(new CellAddress(5, 'price'), fields);
    selection.clampTo(2);
    expect(selection.range?.lastRow).toBe(1);
  });
});

it('compares a cell address by row and field', () => {
  expect(new CellAddress(1, 'name').equals(new CellAddress(1, 'name'))).toBe(
    true,
  );
  expect(new CellAddress(1, 'name').equals(new CellAddress(2, 'name'))).toBe(
    false,
  );
  // Equal addresses must collapse in a set, which is what the key is for:
  // JavaScript compares objects by identity.
  const deduped = new Set<string>();
  deduped.add(new CellAddress(1, 'name').key);
  deduped.add(new CellAddress(1, 'name').key);
  expect(deduped.size).toBe(1);
});
