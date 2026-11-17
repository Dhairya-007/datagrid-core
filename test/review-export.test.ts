// Export, clipboard, aggregate and coercion fixes from the 0.4.0 review.
import { describe, expect, it } from 'vitest';
import {
  AggregateType,
  Aggregation,
  CellAddress,
  coerceValue,
  ColumnType,
  computeColumnStats,
  GridController,
  GroupSpec,
  InMemoryDataSource,
  InMemoryDataSource as Source,
  isDataRow,
  isGroupRow,
  numberRange,
  parseClipboardText,
  toClipboardText,
  togglingModifier,
} from '../src/advanced';
import { Product, productColumns, sampleProducts } from './fixtures';

function groupedGrid(): GridController<Product> {
  return new GridController<Product>({
    columns: productColumns(),
    dataSource: new Source<Product>(sampleProducts()),
    groups: [new GroupSpec('category')],
  });
}

describe('grouped export', () => {
  it('indents the first cell only, so numbers stay numbers', () => {
    const grid = groupedGrid();
    const csv = grid.exportCsv();
    const lines = csv.trim().split('\r\n');
    const dataLine = lines.find((l) => l.includes('Laptop')) as string;
    expect(dataLine.startsWith('    Laptop,')).toBe(true);
    expect(dataLine).toContain(',1450.00 USD');
    expect(dataLine).not.toContain('"    1450');
    grid.dispose();
  });

  it('leaves out a collapsed group, as the screen does', () => {
    const grid = groupedGrid();
    expect(grid.exportCsv()).toContain('Laptop');

    grid.collapseAllGroups();
    const collapsed = grid.exportCsv();
    expect(collapsed).toContain('Compute');
    expect(collapsed).not.toContain('Laptop');

    const regardless = grid.exportCsv({ respectCollapsed: false });
    expect(regardless).toContain('Laptop');
    grid.dispose();
  });

  it('exports nothing rather than failing when no columns are asked for', () => {
    const grid = groupedGrid();
    expect(() => grid.exportCsv({ fields: [] })).not.toThrow();
    expect(grid.exportCsv({ fields: [] })).toBe('');
    grid.dispose();
  });

  it('writes one cell per group header in a single-column export', () => {
    const grid = groupedGrid();
    const csv = grid.exportCsv({ fields: ['name'] });
    expect(csv).toContain('Compute (2)');
    grid.dispose();
  });
});

describe('a numeric column', () => {
  it('exports a negative number as a number', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>([
        new Product({ id: 1, name: 'Refund', category: 'c', price: -5 }),
      ]),
    });
    const csv = grid.exportCsv({ formatted: false });
    expect(csv).toContain(',-5,');
    expect(csv).not.toContain("'-5");
    grid.dispose();
  });
});

describe('the clipboard', () => {
  it('round-trips a cell holding a line break', () => {
    const cells = [
      ['line1\nline2', 'b'],
      ['c', 'd'],
    ];
    const text = toClipboardText(cells);
    expect(parseClipboardText(text)).toEqual(cells);
    expect(parseClipboardText(text)).toHaveLength(2);
  });

  it('round-trips a cell holding a tab and a quote', () => {
    const cells = [['a\tb', 'say "hi"']];
    expect(parseClipboardText(toClipboardText(cells))).toEqual(cells);
  });

  it('reads the quoted text a spreadsheet produces', () => {
    expect(parseClipboardText('"one\ttwo"\tthree')).toEqual([
      ['one\ttwo', 'three'],
    ]);
  });

  it('writes a group label rather than a blank row when copying across one', () => {
    const grid = groupedGrid();
    const header = grid.visibleRows.toArray().filter(isGroupRow)[0];
    grid.selection.selectRow(header?.index as number);
    grid.selection.selectRow((header?.index as number) + 1, togglingModifier);
    const lines = grid.copySelectionAsText().split('\n');
    expect(lines[0]?.startsWith('Compute (2)')).toBe(true);
    expect((lines[0] as string).replace(/\t/g, '').length).toBeGreaterThan(0);
    grid.dispose();
  });
});

describe('pasting across a group header', () => {
  it('fills the next data row instead of dropping one', () => {
    const products = sampleProducts();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(products),
      groups: [new GroupSpec('category')],
      rowKey: (p) => p.id,
    });
    // The first data row of the first group.
    const firstData = grid.visibleRows.toArray().filter(isDataRow)[0];
    const names = grid.visibleRows
      .toArray()
      .filter(isDataRow)
      .map((r) => r.data.name);
    const result = grid.pasteText('A\nB\nC', {
      at: new CellAddress(firstData?.index as number, 'name'),
    });
    expect(result.rowsChanged, 'no row is lost to a header').toBe(3);
    const after = grid.visibleRows
      .toArray()
      .filter(isDataRow)
      .map((r) => r.data.name);
    expect(after.filter((n) => ['A', 'B', 'C'].includes(n))).toHaveLength(3);
    expect(after).not.toEqual(names);
    grid.dispose();
  });
});

describe('aggregates', () => {
  it('does not count null as a distinct value', () => {
    const count = new Aggregation('f', { type: AggregateType.countDistinct });
    expect(count.apply(['a', 'b', null, 'a'])).toBe(2);
  });

  it('ignores text that parses as NaN in sum and average', () => {
    const sum = new Aggregation('f', { type: AggregateType.sum });
    const average = new Aggregation('f', { type: AggregateType.average });
    expect(sum.apply([1, 'NaN', 2])).toBe(3);
    expect(sum.apply([1, 'Infinity'])).toBe(1);
    expect(average.apply([1, 'NaN', 3])).toBe(2);
    expect(sum.apply([Number.NaN])).toBeNull();
  });

  it('does not format a tiny negative average as minus zero', () => {
    const average = new Aggregation('f', { type: AggregateType.average });
    expect(average.formatted(-0.001)).toBe('0.00');
    expect(average.formatted(-0.02)).toBe('-0.02');
  });

  it('divides the mean by the numbers it added up', () => {
    const stats = computeColumnStats([10, 'n/a']);
    expect(stats.count).toBe(2);
    expect(stats.numberCount).toBe(1);
    expect(stats.mean).toBe(10);
  });
});

describe('number coercion', () => {
  it('accepts a decimal and refuses hex, NaN and infinity', () => {
    expect(coerceValue('42', ColumnType.number)).toBe(42);
    expect(coerceValue('-3.5', ColumnType.number)).toBe(-3.5);
    expect(coerceValue('1e3', ColumnType.number)).toBe(1000);
    expect(coerceValue('0x10', ColumnType.number)).toBeNull();
    expect(coerceValue('NaN', ColumnType.number)).toBeNull();
    expect(coerceValue('Infinity', ColumnType.number)).toBeNull();
  });

  it('rejects a value that is not finite', () => {
    const validator = numberRange({ min: 0, max: 10 });
    expect(validator(5)).toBeNull();
    expect(validator(Number.NaN)).not.toBeNull();
    expect(validator(Number.POSITIVE_INFINITY)).not.toBeNull();
  });
});
