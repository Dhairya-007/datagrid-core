import { describe, expect, it } from 'vitest';
import {
  AsyncDataSource,
  CellAddress,
  ColumnPin,
  GridController,
  GridResult,
  InMemoryDataSource,
  parseClipboardText,
  RowUpdate,
  SelectionMode,
  toClipboardText,
} from '../src/index';
import { Product, productColumns, sampleProducts } from './fixtures';

/**
 * name, price, stock, active — two editable columns side by side, which is
 * what a pasted block needs to land in.
 */
function pasteGrid(
  options: { selectionMode?: SelectionMode } = {},
): GridController<Product> {
  const columns = productColumns();
  return new GridController<Product>({
    columns: [
      columns[0] as never,
      columns[2] as never,
      columns[3] as never,
      columns[4] as never,
    ],
    dataSource: new InMemoryDataSource<Product>(sampleProducts()),
    selectionMode: options.selectionMode ?? SelectionMode.multiRow,
  });
}

/**
 * Counts how many batches reach the source, so a paste can be shown to be one
 * write rather than one per cell.
 */
class CountingSource extends InMemoryDataSource<Product> {
  constructor(
    rows: Product[],
    private readonly onWrite: () => void,
  ) {
    super(rows);
  }

  override commitAll(writes: readonly RowUpdate<Product>[]): Promise<Product[]> {
    this.onWrite();
    return super.commitAll(writes);
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('parseClipboardText', () => {
  it('splits rows and cells', () => {
    expect(parseClipboardText('a\tb\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('accepts any line ending a clipboard can carry', () => {
    expect(parseClipboardText('a\r\nb\rc\nd')).toHaveLength(4);
  });

  it('ignores one trailing newline but keeps an empty row in the middle', () => {
    expect(parseClipboardText('a\nb\n')).toHaveLength(2);
    expect(parseClipboardText('a\n\nb')).toEqual([['a'], [''], ['b']]);
  });

  it('is the inverse of toClipboardText', () => {
    const cells = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    expect(parseClipboardText(toClipboardText(cells))).toEqual(cells);
  });

  it('reads no rows at all from empty text', () => {
    expect(parseClipboardText('')).toEqual([]);
    expect(parseClipboardText('\n')).toEqual([]);
  });

  it('understands a quoted cell holding a delimiter or a line break', () => {
    expect(parseClipboardText('"a\tb"\tc')).toEqual([['a\tb', 'c']]);
    expect(parseClipboardText('"two\nlines"\tc')).toEqual([
      ['two\nlines', 'c'],
    ]);
    expect(parseClipboardText('"say ""hi"""')).toEqual([['say "hi"']]);
  });
});

describe('pasteText', () => {
  it('writes a block rightwards and downwards from the target', () => {
    const grid = pasteGrid();
    const result = grid.pasteText('Keypad\t10\nTrackball\t20', {
      at: new CellAddress(0, 'name'),
    });
    expect(result.applied).toBe(true);
    expect(result.rowsChanged).toBe(2);
    expect(result.cellsChanged).toBe(4);
    expect(grid.dataAt(0)?.name).toBe('Keypad');
    expect(grid.dataAt(0)?.price).toBe(10);
    expect(grid.dataAt(1)?.name).toBe('Trackball');
    expect(grid.dataAt(1)?.price).toBe(20);
  });

  it('pastes into the active cell when no target is given', () => {
    const grid = pasteGrid({ selectionMode: SelectionMode.cellRange });
    grid.selectCell(new CellAddress(1, 'name'));
    grid.pasteText('Trackpad');
    expect(grid.dataAt(1)?.name).toBe('Trackpad');
  });

  it('does nothing and says so with nowhere to paste', () => {
    const grid = pasteGrid();
    const result = grid.pasteText('x');
    expect(result.applied).toBe(false);
    expect(result.isEmpty).toBe(true);
  });

  it('coerces each cell into its column type', () => {
    const grid = pasteGrid();
    grid.pasteText('40', { at: new CellAddress(0, 'price') });
    expect(grid.dataAt(0)?.price).toBe(40);
    expect(typeof grid.dataAt(0)?.price).toBe('number');
  });

  it('writes nothing at all for one bad cell', () => {
    const grid = pasteGrid();
    const before = grid.dataAt(0)?.name;
    const result = grid.pasteText('Keypad\tnot-a-number', {
      at: new CellAddress(0, 'name'),
    });
    expect(result.applied).toBe(false);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.reason).toBe('Not a number');
    expect(result.rejections[0]?.cell.field).toBe('price');
    expect(grid.dataAt(0)?.name).toBe(before);
  });

  it('writes what it can and reports the rest with allOrNothing off', () => {
    const grid = pasteGrid();
    const result = grid.pasteText('Keypad\tnot-a-number', {
      at: new CellAddress(0, 'name'),
      allOrNothing: false,
    });
    expect(result.applied).toBe(true);
    expect(result.cellsChanged).toBe(1);
    expect(result.rejections).toHaveLength(1);
    expect(grid.dataAt(0)?.name).toBe('Keypad');
  });

  it("reports a validator's own words for a value it rejects", () => {
    const grid = pasteGrid();
    const result = grid.pasteText('-5', { at: new CellAddress(0, 'price') });
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.reason).toBe('Must be at least 0');
  });

  it('rejects a read-only column rather than silently skipping it', () => {
    const grid = pasteGrid();
    const result = grid.pasteText('99', { at: new CellAddress(0, 'stock') });
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.reason).toBe('Column is not editable');
  });

  it('clips a block past the end of the grid rather than growing it', () => {
    const grid = pasteGrid();
    const result = grid.pasteText('a\nb\nc', {
      at: new CellAddress(5, 'name'),
      allOrNothing: false,
    });
    expect(grid.rowCount).toBe(6);
    expect(result.rowsChanged).toBe(1);
    expect(result.cellsClipped).toBe(2);
  });

  it('clips a block past the last column too', () => {
    const grid = pasteGrid();
    const result = grid.pasteText('x\ty\tz', {
      at: new CellAddress(0, 'active'),
      allOrNothing: false,
    });
    expect(result.cellsClipped).toBe(2);
  });

  it('follows screen order, so a pinned column is pasted where it looks', () => {
    const grid = pasteGrid();
    grid.setColumnPin('price', ColumnPin.start);
    grid.pasteText('5\tKeypad', { at: new CellAddress(0, 'price') });
    expect(grid.dataAt(0)?.price).toBe(5);
    expect(grid.dataAt(0)?.name).toBe('Keypad');
  });

  it('does not count a value equal to the one already there as a change', () => {
    const grid = pasteGrid();
    const result = grid.pasteText('Keyboard', {
      at: new CellAddress(0, 'name'),
    });
    expect(result.cellsChanged).toBe(0);
    expect(result.applied).toBe(false);
  });

  it('is refused by a source that cannot save', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(
        async () =>
          new GridResult<Product>({ rows: sampleProducts(), totalCount: 6 }),
      ),
    });
    await tick();
    const result = grid.pasteText('x', { at: new CellAddress(0, 'name') });
    expect(result.applied).toBe(false);
    expect(result.rejections[0]?.reason).toContain('cannot save edits');
  });

  it('writes several cells of one row as a single change', () => {
    let writes = 0;
    const source = new CountingSource(sampleProducts(), () => writes++);
    const columns = productColumns();
    const grid = new GridController<Product>({
      columns: [columns[0] as never, columns[2] as never],
      dataSource: source,
    });
    grid.pasteText('Keypad\t10', { at: new CellAddress(0, 'name') });
    expect(writes).toBe(1);
  });
});
