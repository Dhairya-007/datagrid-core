// The pipeline stages this exercises are the engine's inner layer.
import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  CellAddress,
  ColumnPin,
  CsvExporter,
  GridColumn,
  GridResult,
  GroupExpansionState,
  GroupSpec,
  SelectionMode,
  toClipboardText,
  type ExportOptions,
  type GroupNode,
} from '../src/advanced';
import {
  Product,
  productColumnMap,
  productColumns,
  productGrid,
  sampleProducts,
} from './fixtures';

const lines = (csv: string): string[] =>
  csv.split('\r\n').filter((l) => l.length > 0);

describe('CsvExporter', () => {
  it('writes a header then one line per row, CRLF terminated', () => {
    const csv = new CsvExporter(productColumns()).exportRows(sampleProducts());
    expect(csv.endsWith('\r\n')).toBe(true);
    const rows = lines(csv);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toBe('Name,Category,Price,Stock,Active');
    expect(rows[1]).toBe('Keyboard,Input,80.00 USD,12,true');
  });

  it('omits the header when asked', () => {
    const csv = new CsvExporter(productColumns(), {
      includeHeader: false,
    }).exportRows(sampleProducts());
    expect(lines(csv)).toHaveLength(6);
  });

  it('exports formatted text by default and raw values on request', () => {
    expect(
      lines(new CsvExporter(productColumns()).exportRows(sampleProducts()))[1],
    ).toContain('80.00 USD');
    expect(
      lines(
        new CsvExporter(productColumns(), { formatted: false }).exportRows(
          sampleProducts(),
        ),
      )[1],
    ).toContain(',80,');
  });

  it('exports only the requested fields, in the order given', () => {
    const csv = new CsvExporter(productColumns(), {
      fields: ['price', 'name'],
    }).exportRows(sampleProducts());
    expect(lines(csv)[0]).toBe('Price,Name');
    expect(lines(csv)[1]).toBe('80.00 USD,Keyboard');
  });

  it('skips hidden columns', () => {
    const columns = productColumns();
    columns[1] = (columns[1] as (typeof columns)[0]).copyWith({
      visible: false,
    });
    expect(
      lines(new CsvExporter(columns).exportRows(sampleProducts()))[0],
    ).toBe('Name,Price,Stock,Active');
  });

  it('writes an empty cell for a null value', () => {
    const csv = new CsvExporter(productColumns()).exportRows([
      new Product({ id: 1, name: 'Laptop', category: 'Compute', price: 10 }),
    ]);
    expect(lines(csv)[1]).toBe('Laptop,Compute,10.00 USD,,true');
  });

  it('honours a custom delimiter and line ending', () => {
    const csv = new CsvExporter(productColumns(), {
      delimiter: ';',
      lineEnding: '\n',
    }).exportRows([
      new Product({
        id: 1,
        name: 'Mouse',
        category: 'Input',
        price: 25,
        stock: 1,
      }),
    ]);
    expect(csv.split('\n')[1]).toBe('Mouse;Input;25.00 USD;1;true');
  });
});

describe('RFC 4180 quoting', () => {
  function cellFor(name: string, delimiter = ','): string {
    const csv = new CsvExporter(
      [new GridColumn<Product>({ field: 'name', value: (p) => p.name })],
      { includeHeader: false, delimiter },
    ).exportRows([new Product({ id: 1, name, category: 'x', price: 0 })]);
    return csv.trimEnd();
  }

  it('quotes a value containing the delimiter', () => {
    expect(cellFor('Mouse, wireless')).toBe('"Mouse, wireless"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(cellFor('24" Monitor')).toBe('"24"" Monitor"');
  });

  it('quotes a value containing a newline', () => {
    expect(cellFor('line one\nline two')).toBe('"line one\nline two"');
  });

  it('leaves a plain value unquoted', () => {
    expect(cellFor('Keyboard')).toBe('Keyboard');
  });

  it('quotes against a custom delimiter, not the comma', () => {
    expect(cellFor('a,b', ';')).toBe('a,b');
    expect(cellFor('a;b', ';')).toBe('"a;b"');
  });
});

describe('grouped export', () => {
  const groups = (): GroupNode<Product>[] =>
    buildGroups(
      sampleProducts(),
      [new GroupSpec('category')],
      productColumnMap(),
    );

  it('writes an indented header line with the group count', () => {
    const csv = new CsvExporter(productColumns()).exportGroups(
      groups(),
      new GroupExpansionState(),
    );
    const rows = lines(csv);
    expect(rows[1]?.startsWith('Compute (2)')).toBe(true);
    expect(rows[2]?.startsWith('    Laptop')).toBe(true);
  });

  it('can leave group headers out entirely', () => {
    const csv = new CsvExporter(productColumns(), {
      includeGroupRows: false,
    }).exportGroups(groups(), new GroupExpansionState());
    expect(lines(csv)).toHaveLength(7);
  });

  it('indents nested groups by depth', () => {
    const nested = buildGroups(
      sampleProducts(),
      [new GroupSpec('category'), new GroupSpec('active')],
      productColumnMap(),
    );
    const rows = lines(
      new CsvExporter(productColumns()).exportGroups(
        nested,
        new GroupExpansionState(),
      ),
    );
    expect(rows[1]?.startsWith('Compute (2)')).toBe(true);
    expect(rows[2]?.startsWith('    false (1)')).toBe(true);
    expect(rows[3]?.startsWith('        Dock')).toBe(true);
  });

  it('picks the shape the result carries', () => {
    const flat = new GridResult<Product>({
      rows: sampleProducts(),
      totalCount: 6,
    });
    const grouped = new GridResult<Product>({
      rows: [],
      groups: groups(),
      totalCount: 6,
    });
    const exporter = new CsvExporter(productColumns());
    expect(
      lines(exporter.exportResult(flat, new GroupExpansionState())),
    ).toHaveLength(7);
    expect(
      lines(exporter.exportResult(grouped, new GroupExpansionState())),
    ).toHaveLength(10);
  });

  it('exports a collapsed group as its header alone', () => {
    const nodes = groups();
    const expansion = new GroupExpansionState();
    expansion.setExpanded(nodes[0]?.path as string, false);
    const csv = new CsvExporter(productColumns()).exportGroups(
      nodes,
      expansion,
    );
    expect(lines(csv)).toHaveLength(8);
  });
});

describe('formula injection', () => {
  function cellFor(name: string, options: ExportOptions = {}): string {
    const csv = new CsvExporter(
      [new GridColumn<Product>({ field: 'name', value: (p) => p.name })],
      { includeHeader: false, ...options },
    ).exportRows([new Product({ id: 1, name, category: 'x', price: 0 })]);
    return csv.trimEnd();
  }

  it('recognises every character a spreadsheet executes', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      expect(
        CsvExporter.isFormula(`${start}cmd`),
        `should treat a leading "${start}" as a formula`,
      ).toBe(true);
    }
    expect(CsvExporter.isFormula('Keyboard')).toBe(false);
    expect(CsvExporter.isFormula('')).toBe(false);
  });

  it('neutralises a formula by default', () => {
    expect(cellFor('=1+1')).toBe("'=1+1");
    expect(cellFor('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('neutralises the attack that fetches a remote payload', () => {
    // The canonical CSV injection: a cell that runs a command on open.
    const attack = "=cmd|' /C calc'!A0";
    const exported = cellFor(attack);
    expect(exported.startsWith("'")).toBe(true);
    expect(exported.startsWith('=')).toBe(false);
  });

  it('puts the prefix inside the quotes, not outside them', () => {
    // Outside, a reader would strip it with the quotes and run the formula.
    const exported = cellFor('=A1,B1');
    expect(exported.startsWith('"\'')).toBe(true);
    expect(exported.endsWith('"')).toBe(true);
  });

  it('leaves ordinary values untouched', () => {
    expect(cellFor('Keyboard')).toBe('Keyboard');
    expect(cellFor('12.50 USD')).toBe('12.50 USD');
    expect(cellFor('a=b')).toBe('a=b');
  });

  it('exports a negative number as a number', () => {
    // It used to be sanitised as a formula, which made a spreadsheet read the
    // whole column as text and every sum over it come out empty.
    expect(cellFor('-5')).toBe('-5');
    expect(cellFor('-12.5')).toBe('-12.5');
    expect(cellFor('+3')).toBe('+3');
    // A value that only looks like one is still neutralised.
    expect(cellFor('-5+cmd')).toBe("'-5+cmd");
    expect(cellFor('-5', { sanitizeFormulas: false })).toBe('-5');
  });

  it('can be turned off for a machine-read export', () => {
    expect(cellFor('=1+1', { sanitizeFormulas: false })).toBe('=1+1');
  });

  it('honours a custom prefix', () => {
    const csv = new CsvExporter(
      [new GridColumn<Product>({ field: 'name', value: (p) => p.name })],
      { includeHeader: false, formulaPrefix: '_' },
    ).exportRows([
      new Product({ id: 1, name: '=1+1', category: 'x', price: 0 }),
    ]);
    expect(csv.trimEnd()).toBe('_=1+1');
  });

  it('does not let leading spaces hide a formula', () => {
    // Spreadsheets trim them on import, and a grouped export indents its
    // rows, so the check has to look past them.
    expect(CsvExporter.isFormula('   =cmd')).toBe(true);
    expect(CsvExporter.isFormula('   safe')).toBe(false);
    expect(cellFor('   =cmd')).toBe("'   =cmd");
  });

  it('puts group labels and headers through the same guard', () => {
    const columns = [
      new GridColumn<Product>({ field: 'name', value: (p) => p.name }),
      new GridColumn<Product>({ field: 'category', value: (p) => p.category }),
    ];
    const groups = buildGroups(
      [new Product({ id: 1, name: '=evil()', category: 'Input', price: 1 })],
      [new GroupSpec('category')],
      new Map(columns.map((c) => [c.field, c])),
    );
    const csv = new CsvExporter(columns).exportGroups(
      groups,
      new GroupExpansionState(),
    );
    // The prefix lands ahead of the indent, so the apostrophe is the first
    // character the spreadsheet sees.
    expect(csv).toContain("'    =evil()");
    for (const line of csv.split('\r\n')) {
      expect(CsvExporter.isFormula(line)).toBe(false);
    }
  });

  it('sanitises clipboard text too', () => {
    expect(toClipboardText([['=1+1', 'safe']])).toBe("'=1+1\tsafe");
    expect(toClipboardText([['=1+1']], { sanitizeFormulas: false })).toBe(
      '=1+1',
    );
  });
});

describe('export matches the screen', () => {
  it('writes columns in screen order, pinning included', () => {
    const grid = productGrid();
    grid.setColumnPin('price', ColumnPin.start);
    const header = grid.exportCsv().split('\r\n')[0];
    expect(header).toBe('Price,Name,Category,Stock,Active');
  });

  it('lets an explicit field list win over screen order', () => {
    const grid = productGrid();
    grid.setColumnPin('price', ColumnPin.start);
    const header = grid
      .exportCsv({ fields: ['name', 'price'] })
      .split('\r\n')[0];
    expect(header).toBe('Name,Price');
  });

  it('copies a range over the columns that are next to each other', () => {
    const grid = productGrid({ selectionMode: SelectionMode.cellRange });
    grid.setColumnPin('stock', ColumnPin.start);
    grid.selectCell(new CellAddress(0, 'stock'));
    grid.extendSelectionTo(new CellAddress(0, 'name'));
    expect(grid.copySelectionAsText()).toBe('12\tKeyboard');
  });
});

it('joins cells with tabs and rows with newlines', () => {
  expect(
    toClipboardText([
      ['a', 'b'],
      ['c', 'd'],
    ]),
  ).toBe('a\tb\nc\td');
});
