import { describe, expect, it } from 'vitest';
import {
  ColumnAlign,
  ColumnFit,
  ColumnPin,
  ColumnType,
  computeLayout,
  GridColumn,
  GridStateError,
} from '../src/index';
import { Product, productColumnMap } from './fixtures';

function columns(
  options: { width?: number; pin?: ColumnPin } = {},
): GridColumn<Product>[] {
  const width = options.width ?? 100;
  const pin = options.pin ?? ColumnPin.none;
  return [
    new GridColumn<Product>({
      field: 'name',
      value: (p) => p.name,
      width,
      pin,
    }),
    new GridColumn<Product>({
      field: 'category',
      value: (p) => p.category,
      width,
    }),
    new GridColumn<Product>({ field: 'price', value: (p) => p.price, width }),
  ];
}

describe('widths and offsets', () => {
  it('lays columns out end to end', () => {
    const layout = computeLayout(columns(), { viewportWidth: 1000 });
    expect(layout.scrolling.map((c) => c.offset)).toEqual([0, 100, 200]);
    expect(layout.scrolling.map((c) => c.end)).toEqual([100, 200, 300]);
    expect(layout.totalWidth).toBe(300);
  });

  it('leaves hidden columns out of both layout and count', () => {
    const withHidden = columns();
    withHidden[1] = (withHidden[1] as GridColumn<Product>).copyWith({
      visible: false,
    });
    const layout = computeLayout(withHidden, { viewportWidth: 1000 });
    expect(layout.columnCount).toBe(2);
    expect(layout.scrolling.map((c) => c.column.field)).toEqual([
      'name',
      'price',
    ]);
    expect(layout.scrolling[layout.scrolling.length - 1]?.offset).toBe(100);
  });

  it('lets a width override win over the declared width', () => {
    const layout = computeLayout(columns(), {
      viewportWidth: 1000,
      widthOverrides: new Map([['name', 250]]),
    });
    expect(layout.scrolling[0]?.width).toBe(250);
    expect(layout.scrolling[1]?.offset).toBe(250);
  });

  it('clamps an override to the column bounds', () => {
    const bounded = [
      new GridColumn<Product>({
        field: 'name',
        value: (p) => p.name,
        width: 100,
        minWidth: 80,
        maxWidth: 200,
      }),
    ];
    expect(
      computeLayout(bounded, {
        viewportWidth: 1000,
        widthOverrides: new Map([['name', 20]]),
      }).scrolling[0]?.width,
    ).toBe(80);
    expect(
      computeLayout(bounded, {
        viewportWidth: 1000,
        widthOverrides: new Map([['name', 9999]]),
      }).scrolling[0]?.width,
    ).toBe(200);
  });
});

describe('frozen panes', () => {
  const pinnedColumns = (): GridColumn<Product>[] => {
    const base = columns();
    return [
      (base[0] as GridColumn<Product>).copyWith({ pin: ColumnPin.start }),
      base[1] as GridColumn<Product>,
      (base[2] as GridColumn<Product>).copyWith({ pin: ColumnPin.end }),
    ];
  };

  it('splits pinned columns out and offsets them within their own pane', () => {
    const layout = computeLayout(pinnedColumns(), { viewportWidth: 1000 });
    expect(layout.leading.map((c) => c.column.field)).toEqual(['name']);
    expect(layout.scrolling.map((c) => c.column.field)).toEqual(['category']);
    expect(layout.trailing.map((c) => c.column.field)).toEqual(['price']);
    expect(layout.leading[0]?.offset).toBe(0);
    expect(layout.trailing[0]?.offset).toBe(0);
    expect(layout.leadingWidth).toBe(100);
    expect(layout.trailingWidth).toBe(100);
  });

  it('leaves the scrolling viewport whatever the frozen panes do not take', () => {
    const layout = computeLayout(pinnedColumns(), { viewportWidth: 500 });
    expect(layout.scrollViewportWidth).toBe(300);
  });

  it('never reports negative space for frozen panes wider than the viewport', () => {
    const layout = computeLayout(columns({ pin: ColumnPin.start }), {
      viewportWidth: 50,
    });
    expect(layout.scrollViewportWidth).toBe(0);
  });
});

describe('ColumnFit', () => {
  it('leaves the natural widths and scrolls with none', () => {
    const layout = computeLayout(columns(), { viewportWidth: 900 });
    expect(layout.totalWidth).toBe(300);
  });

  it('fills the viewport exactly with stretch', () => {
    const layout = computeLayout(columns(), {
      viewportWidth: 900,
      fit: ColumnFit.stretch,
    });
    expect(layout.totalWidth).toBeCloseTo(900, 3);
    for (const c of layout.scrolling) expect(c.width).toBeCloseTo(300, 3);
  });

  it('respects maxWidth and hands the remainder to a growable column', () => {
    const capped = [
      new GridColumn<Product>({
        field: 'name',
        value: (p) => p.name,
        width: 100,
        maxWidth: 120,
      }),
      new GridColumn<Product>({
        field: 'category',
        value: (p) => p.category,
        width: 100,
      }),
    ];
    const layout = computeLayout(capped, {
      viewportWidth: 400,
      fit: ColumnFit.stretch,
    });
    expect(layout.scrolling[0]?.width).toBe(120);
    expect(layout.totalWidth).toBeCloseTo(400, 3);
  });

  it('grows only the final column with lastColumn', () => {
    const layout = computeLayout(columns(), {
      viewportWidth: 900,
      fit: ColumnFit.lastColumn,
    });
    expect(layout.scrolling[0]?.width).toBe(100);
    expect(layout.scrolling[layout.scrolling.length - 1]?.width).toBe(700);
  });

  it('leaves a viewport narrower than the columns alone', () => {
    const layout = computeLayout(columns(), {
      viewportWidth: 200,
      fit: ColumnFit.stretch,
    });
    expect(layout.totalWidth).toBe(300);
  });
});

describe('horizontal windowing', () => {
  const many: GridColumn<Product>[] = [];
  for (let i = 0; i < 50; i++) {
    many.push(
      new GridColumn<Product>({
        field: `c${i}`,
        value: (p) => p.id,
        width: 100,
      }),
    );
  }

  it('builds only the columns intersecting the viewport', () => {
    const layout = computeLayout(many, { viewportWidth: 500 });
    const visible = layout.visibleScrollingColumns({
      scrollOffset: 1000,
      overscan: 0,
    });
    expect(visible.map((c) => c.column.field)).toEqual([
      'c10',
      'c11',
      'c12',
      'c13',
      'c14',
    ]);
  });

  it('widens the window on both sides with overscan', () => {
    const layout = computeLayout(many, { viewportWidth: 500 });
    const visible = layout.visibleScrollingColumns({
      scrollOffset: 1000,
      overscan: 1,
    });
    expect(visible[0]?.column.field).toBe('c9');
    expect(visible[visible.length - 1]?.column.field).toBe('c15');
  });

  it('clamps the window at the edges', () => {
    const layout = computeLayout(many, { viewportWidth: 500 });
    expect(
      layout.visibleScrollingColumns({ scrollOffset: 0, overscan: 2 })[0]
        ?.column.field,
    ).toBe('c0');
    const end = layout.visibleScrollingColumns({
      scrollOffset: 4500,
      overscan: 2,
    });
    expect(end[end.length - 1]?.column.field).toBe('c49');
  });

  it('yields nothing for no columns or no width', () => {
    expect(
      computeLayout<Product>([], { viewportWidth: 500 }).visibleScrollingColumns(
        { scrollOffset: 0 },
      ),
    ).toEqual([]);
    expect(
      computeLayout(many, { viewportWidth: 0 }).visibleScrollingColumns({
        scrollOffset: 0,
      }),
    ).toEqual([]);
  });
});

describe('GridColumn', () => {
  it('derives a readable title from the field name', () => {
    expect(
      new GridColumn<Product>({ field: 'unitPrice', value: () => 0 }).title,
    ).toBe('Unit Price');
    expect(
      new GridColumn<Product>({ field: 'unit_price', value: () => 0 }).title,
    ).toBe('Unit Price');
    expect(
      new GridColumn<Product>({ field: 'price', value: () => 0 }).title,
    ).toBe('Price');
    expect(
      new GridColumn<Product>({ field: 'HTTPStatus', value: () => 0 }).title,
    ).toBe('HTTP Status');
  });

  it('aligns numbers to the end by default', () => {
    expect(
      new GridColumn<Product>({
        field: 'price',
        value: () => 0,
        type: ColumnType.number,
      }).effectiveAlign,
    ).toBe(ColumnAlign.end);
    expect(
      new GridColumn<Product>({ field: 'name', value: () => '' })
        .effectiveAlign,
    ).toBe(ColumnAlign.start);
  });

  it('is editable exactly when it has a setter', () => {
    expect(
      new GridColumn<Product>({ field: 'name', value: () => '' }).editable,
    ).toBe(false);
    expect(productColumnMap().get('name')?.editable).toBe(true);
  });

  it('runs the formatter and maps null to empty text', () => {
    const price = productColumnMap().get('price') as GridColumn<Product>;
    expect(
      price.formattedValue(
        new Product({ id: 1, name: 'x', category: 'y', price: 12.5 }),
      ),
    ).toBe('12.50 USD');
    expect(
      (productColumnMap().get('stock') as GridColumn<Product>).formattedValue(
        new Product({ id: 1, name: 'x', category: 'y', price: 0 }),
      ),
    ).toBe('');
  });

  it('reads an object row by field when no accessor is given', () => {
    const column = new GridColumn<Record<string, unknown>>({ field: 'name' });
    expect(column.value({ name: 'Keyboard' })).toBe('Keyboard');
  });

  it('fails loudly for a primitive row without an accessor', () => {
    const column = new GridColumn<number>({ field: 'name' });
    expect(() => column.value(5)).toThrow(GridStateError);
  });

  it('keeps untouched fields in copyWith', () => {
    const original = productColumnMap().get('price') as GridColumn<Product>;
    const copy = original.copyWith({ width: 300 });
    expect(copy.width).toBe(300);
    expect(copy.field).toBe('price');
    expect(copy.type).toBe(ColumnType.number);
    expect(copy.editable).toBe(true);
  });

  it('clears a callback with an explicit null, which is the only way to', () => {
    const original = productColumnMap().get('price') as GridColumn<Product>;
    expect(original.copyWith({ setValue: null }).editable).toBe(false);
    expect(original.copyWith({ format: null }).formattedValue(
      new Product({ id: 1, name: 'x', category: 'y', price: 12.5 }),
    )).toBe('12.5');
  });

  it('regenerates the default accessor when the field changes', () => {
    const column = new GridColumn<Record<string, unknown>>({ field: 'a' });
    expect(column.copyWith({ field: 'b' }).value({ a: 1, b: 2 })).toBe(2);
  });
});
