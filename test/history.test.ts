import { describe, expect, it } from 'vitest';
import {
  CellAddress,
  CellEdit,
  EditAction,
  EditHistory,
  GridController,
  InMemoryDataSource,
  SortSpec,
} from '../src/index';
import { labelsOf, Product, productColumns, sampleProducts } from './fixtures';

function editGrid(): GridController<Product> {
  const columns = productColumns();
  return new GridController<Product>({
    columns: [columns[0] as never, columns[2] as never, columns[3] as never],
    dataSource: new InMemoryDataSource<Product>(sampleProducts()),
    rowKey: (p) => p.id,
  });
}

describe('EditHistory', () => {
  it('records actions and reports what the next step would be', () => {
    const history = new EditHistory<Product>();
    expect(history.canUndo).toBe(false);
    expect(history.undoLabel).toBeNull();

    history.record(
      new EditAction<Product>({
        label: 'Edit Name',
        changes: [
          new CellEdit<Product>({
            row: sampleProducts()[0] as Product,
            field: 'name',
            before: 'a',
            after: 'b',
          }),
        ],
      }),
    );
    expect(history.canUndo).toBe(true);
    expect(history.undoLabel).toBe('Edit Name');
  });

  it('does not spend a step on an empty action', () => {
    const history = new EditHistory<Product>();
    history.record(new EditAction<Product>({ label: 'Nothing', changes: [] }));
    expect(history.canUndo).toBe(false);
  });

  it('drops the oldest action past its limit', () => {
    const history = new EditHistory<Product>({ limit: 2 });
    for (let i = 0; i < 5; i++) {
      history.record(
        new EditAction<Product>({
          label: `Edit ${i}`,
          changes: [
            new CellEdit<Product>({
              row: sampleProducts()[0] as Product,
              field: 'name',
              before: i,
              after: i + 1,
            }),
          ],
        }),
      );
    }
    expect(history.length).toBe(2);
    expect(history.undoLabel).toBe('Edit 4');
  });

  it('makes the undone future unreachable once the user edits again', () => {
    const history = new EditHistory<Product>();
    const change = (i: number): CellEdit<Product> =>
      new CellEdit<Product>({
        row: sampleProducts()[0] as Product,
        field: 'name',
        before: i,
        after: i + 1,
      });
    history.record(
      new EditAction<Product>({ label: 'one', changes: [change(1)] }),
    );
    history.takeUndo();
    expect(history.canRedo).toBe(true);
    history.record(
      new EditAction<Product>({ label: 'two', changes: [change(2)] }),
    );
    expect(history.canRedo).toBe(false);
  });

  it('replays the cells backwards in an inverse action', () => {
    const row = sampleProducts()[0] as Product;
    const action = new EditAction<Product>({
      label: 'Paste',
      changes: [
        new CellEdit<Product>({
          row,
          field: 'name',
          before: 'a',
          after: 'b',
        }),
        new CellEdit<Product>({ row, field: 'price', before: 1, after: 2 }),
      ],
    });
    const inverse = action.inverse;
    expect(inverse.changes[0]?.field).toBe('price');
    expect(inverse.changes[0]?.before).toBe(2);
    expect(inverse.changes[0]?.after).toBe(1);
  });

  it('leaves the step in place when an undo could not be applied', () => {
    // peekUndo plus commitUndo, rather than takeUndo: a step consumed by an
    // undo that wrote nothing made the edit permanently unrepeatable.
    const history = new EditHistory<Product>();
    history.record(
      new EditAction<Product>({
        label: 'one',
        changes: [
          new CellEdit<Product>({
            row: sampleProducts()[0] as Product,
            field: 'name',
            before: 'a',
            after: 'b',
          }),
        ],
      }),
    );
    expect(history.peekUndo()?.label).toBe('one');
    expect(history.canUndo).toBe(true);
    history.commitUndo();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
  });
});

describe('undo over a committed edit', () => {
  it('puts the old value back', () => {
    const grid = editGrid();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('Keypad');
    grid.commitEdit();
    expect(grid.dataAt(0)?.name).toBe('Keypad');

    expect(grid.canUndo).toBe(true);
    expect(grid.undo()).toBe(true);
    expect(grid.dataAt(0)?.name).toBe('Keyboard');
  });

  it('puts the new one back again on redo', () => {
    const grid = editGrid();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('Keypad');
    grid.commitEdit();
    grid.undo();
    expect(grid.canRedo).toBe(true);
    expect(grid.redo()).toBe(true);
    expect(grid.dataAt(0)?.name).toBe('Keypad');
  });

  it('does not count an edit that changed nothing as a step', () => {
    const grid = editGrid();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('Keyboard');
    grid.commitEdit();
    expect(grid.canUndo).toBe(false);
  });

  it('does not count a rejected edit as a step either', () => {
    const grid = editGrid();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('');
    grid.commitEdit();
    expect(grid.canUndo).toBe(false);
  });

  it('says so rather than throwing when there is nothing to undo', () => {
    const grid = editGrid();
    expect(grid.undo()).toBe(false);
    expect(grid.redo()).toBe(false);
  });

  it('names what will be taken back', () => {
    const grid = editGrid();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('Keypad');
    grid.commitEdit();
    expect(grid.history.undoLabel).toBe('Edit Name');
  });
});

describe('undo over a paste', () => {
  it('brings a whole block back in one step', () => {
    const grid = editGrid();
    grid.pasteText('Keypad\t10\nTrackball\t20', {
      at: new CellAddress(0, 'name'),
    });
    expect(grid.dataAt(0)?.name).toBe('Keypad');
    expect(grid.dataAt(1)?.price).toBe(20);

    expect(grid.undo()).toBe(true);
    expect(grid.dataAt(0)?.name).toBe('Keyboard');
    expect(grid.dataAt(0)?.price).toBe(80);
    expect(grid.dataAt(1)?.name).toBe('Mouse');
    expect(grid.dataAt(1)?.price).toBe(25);
    expect(grid.canUndo).toBe(false);
  });

  it('and puts it back in one step too', () => {
    const grid = editGrid();
    grid.pasteText('Keypad\t10', { at: new CellAddress(0, 'name') });
    grid.undo();
    grid.redo();
    expect(grid.dataAt(0)?.name).toBe('Keypad');
    expect(grid.dataAt(0)?.price).toBe(10);
  });

  it('leaves no step to undo when a paste wrote nothing', () => {
    const grid = editGrid();
    grid.pasteText('Keypad\tnope', { at: new CellAddress(0, 'name') });
    expect(grid.canUndo).toBe(false);
  });

  it('finds its rows after a sort has moved them', () => {
    const grid = editGrid();
    grid.pasteText('Zebra', { at: new CellAddress(0, 'name') });
    grid.setSorts([new SortSpec('name')]);
    const labels = labelsOf(grid);
    expect(labels[labels.length - 1]).toBe('Zebra');
    expect(grid.undo()).toBe(true);
    expect(labelsOf(grid)).toContain('Keyboard');
    expect(labelsOf(grid)).not.toContain('Zebra');
  });

  it('reaches a row the current search hides', () => {
    // The row is still in the data, so the edit is still undoable: looking
    // for it among the visible rows alone left the change in place for good,
    // because the step had already moved to the redo stack.
    const grid = editGrid();
    grid.pasteText('Zebra', { at: new CellAddress(0, 'name') });
    grid.setSearch('mouse');
    expect(grid.undo()).toBe(true);
    expect(grid.lastReplay.isComplete).toBe(true);
    grid.setSearch('');
    expect(labelsOf(grid)).toContain('Keyboard');
    expect(labelsOf(grid)).not.toContain('Zebra');
  });
});
