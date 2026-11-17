// The pipeline stages this exercises are the engine's inner layer.
import { describe, expect, it } from 'vitest';
import {
  ColumnType,
  compareStrings,
  compareValues,
  compareValuesCaseInsensitive,
  compareValuesNatural,
  cycleSort,
  GridColumn,
  naturalSortKey,
  NullsPosition,
  SortDirection,
  SortSpec,
  sortRows,
  type CellValue,
} from '../src/advanced';
import { Product, productColumnMap, sampleProducts } from './fixtures';

type Row = Record<string, CellValue>;

function columnsOf<T>(...columns: GridColumn<T>[]): Map<string, GridColumn<T>> {
  return new Map(columns.map((c) => [c.field, c]));
}

const columns = productColumnMap();

describe('compareValues', () => {
  it('orders nulls last regardless of operand order', () => {
    expect(compareValues(null, 5)).toBeGreaterThan(0);
    expect(compareValues(5, null)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
  });

  it('compares numbers, strings, dates and booleans naturally', () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues('a', 'b')).toBeLessThan(0);
    expect(
      compareValues(new Date(2026, 0, 1), new Date(2026, 1, 1)),
    ).toBeLessThan(0);
    expect(compareValues(false, true)).toBeLessThan(0);
  });

  it('falls back to a defined order for mismatched types', () => {
    expect(compareValues(1, 'a')).not.toBe(0);
  });

  it('reads embedded numbers in the natural order', () => {
    const values = ['item10', 'item2', 'item1'];
    values.sort(compareValuesNatural);
    expect(values).toEqual(['item1', 'item2', 'item10']);
  });

  it('keeps the case-insensitive order total on a fold tie', () => {
    expect(compareValuesCaseInsensitive('Apple', 'apple')).not.toBe(0);
    expect(compareValuesCaseInsensitive('apple', 'Banana')).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  it('sorts ascending and descending by one column', () => {
    const rows = sampleProducts();
    const asc = sortRows(rows, [new SortSpec('price')], columns);
    expect(asc[0]?.name).toBe('Mouse');
    const desc = sortRows(
      rows,
      [new SortSpec('price', { direction: SortDirection.descending })],
      columns,
    );
    expect(desc[0]?.name).toBe('Laptop');
  });

  it('applies later sort levels only to ties in earlier ones', () => {
    const sorted = sortRows(
      sampleProducts(),
      [
        new SortSpec('category'),
        new SortSpec('price', { direction: SortDirection.descending }),
      ],
      columns,
    );
    expect(sorted.map((p) => p.name)).toEqual([
      'Laptop',
      'Dock',
      'Monitor',
      'Keyboard',
      'Webcam',
      'Mouse',
    ]);
  });

  it('is stable for rows the sort cannot distinguish', () => {
    const rows = [
      new Product({ id: 1, name: 'a', category: 'x', price: 1 }),
      new Product({ id: 2, name: 'b', category: 'x', price: 1 }),
      new Product({ id: 3, name: 'c', category: 'x', price: 1 }),
    ];
    const sorted = sortRows(rows, [new SortSpec('category')], columns);
    expect(sorted.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('places nulls last in both directions by default', () => {
    const rows = sampleProducts();
    const up = sortRows(rows, [new SortSpec('stock')], columns);
    expect(up[up.length - 1]?.stock).toBeNull();
    const down = sortRows(
      rows,
      [new SortSpec('stock', { direction: SortDirection.descending })],
      columns,
    );
    expect(down[down.length - 1]?.stock).toBeNull();
  });

  it('honours a nulls-first spec', () => {
    const sorted = sortRows(
      sampleProducts(),
      [new SortSpec('stock', { nulls: NullsPosition.first })],
      columns,
    );
    expect(sorted[0]?.stock).toBeNull();
  });

  it('uses a column comparator when one is given', () => {
    const byLength = columnsOf(
      new GridColumn<Product>({
        field: 'name',
        value: (p) => p.name,
        comparator: (a, b) => (a as string).length - (b as string).length,
      }),
    );
    const sorted = sortRows(sampleProducts(), [new SortSpec('name')], byLength);
    expect(sorted[0]?.name).toBe('Dock');
  });

  it('leaves rows untouched when no sort applies', () => {
    const rows = sampleProducts();
    expect(sortRows(rows, [], columns).map((p) => p.id)).toEqual(
      rows.map((p) => p.id),
    );
    expect(
      sortRows(rows, [new SortSpec('missing')], columns).map((p) => p.id),
    ).toEqual(rows.map((p) => p.id));
  });

  it('does not mutate the input array', () => {
    const rows = sampleProducts();
    const before = rows.map((p) => p.id);
    sortRows(rows, [new SortSpec('price')], columns);
    expect(rows.map((p) => p.id)).toEqual(before);
  });
});

describe('cycleSort', () => {
  it('walks unsorted to ascending to descending to unsorted', () => {
    let sorts = cycleSort([], 'price');
    expect(sorts).toHaveLength(1);
    expect(sorts[0]?.direction).toBe(SortDirection.ascending);
    sorts = cycleSort(sorts, 'price');
    expect(sorts[0]?.direction).toBe(SortDirection.descending);
    sorts = cycleSort(sorts, 'price');
    expect(sorts).toEqual([]);
  });

  it('replaces the whole ordering on a plain click', () => {
    const sorts = cycleSort([new SortSpec('name')], 'price');
    expect(sorts.map((s) => s.field)).toEqual(['price']);
  });

  it('appends and then removes a level when additive', () => {
    let sorts = cycleSort([new SortSpec('name')], 'price', { additive: true });
    expect(sorts.map((s) => s.field)).toEqual(['name', 'price']);
    sorts = cycleSort(sorts, 'price', { additive: true });
    expect(sorts[sorts.length - 1]?.direction).toBe(SortDirection.descending);
    sorts = cycleSort(sorts, 'price', { additive: true });
    expect(sorts.map((s) => s.field)).toEqual(['name']);
  });
});

it('round-trips a SortSpec through JSON', () => {
  const spec = new SortSpec('price', {
    direction: SortDirection.descending,
    nulls: NullsPosition.first,
  });
  expect(SortSpec.fromJSON(spec.toJSON()).equals(spec)).toBe(true);
});

// Added with the 0.4.0 review fixes: the default order for a text column, and
// the per-row sort key that makes an expensive order affordable.
describe('default text ordering', () => {
  it('sorts text case-insensitively rather than by code unit', () => {
    const rows: Row[] = [
      { name: 'banana' },
      { name: 'Cherry' },
      { name: 'apple' },
    ];
    const byField = columnsOf(new GridColumn<Row>({ field: 'name' }));
    const sorted = sortRows(rows, [new SortSpec('name')], byField);
    expect(sorted.map((r) => r['name'])).toEqual(['apple', 'banana', 'Cherry']);
  });

  it('keeps two spellings of one word in a stable order', () => {
    const rows: Row[] = [{ name: 'apple' }, { name: 'Apple' }];
    const byField = columnsOf(new GridColumn<Row>({ field: 'name' }));
    const sorted = sortRows(rows, [new SortSpec('name')], byField);
    expect(sorted).toHaveLength(2);
    // Whichever way round, reversing the direction reverses the result.
    const down = sortRows(
      rows,
      [new SortSpec('name', { direction: SortDirection.descending })],
      byField,
    );
    expect(down[0]).toBe(sorted[sorted.length - 1]);
  });

  it('leaves a non-text column in its natural order', () => {
    const rows: Row[] = [{ n: 10 }, { n: 9 }];
    const byField = columnsOf(
      new GridColumn<Row>({ field: 'n', type: ColumnType.number }),
    );
    const sorted = sortRows(rows, [new SortSpec('n')], byField);
    expect(sorted.map((r) => r['n'])).toEqual([9, 10]);
  });

  it('lets a column comparator win over the default', () => {
    const rows: Row[] = [{ name: 'apple' }, { name: 'Cherry' }];
    const byField = columnsOf(
      new GridColumn<Row>({
        field: 'name',
        comparator: (a, b) => compareStrings(String(a), String(b)),
      }),
    );
    const sorted = sortRows(rows, [new SortSpec('name')], byField);
    expect(sorted.map((r) => r['name'])).toEqual(['Cherry', 'apple']);
  });
});

describe('a column sort key', () => {
  it('orders by the key rather than by the displayed value', () => {
    const rows: Row[] = [{ code: 'item10' }, { code: 'item2' }];
    const byField = columnsOf(
      new GridColumn<Row>({
        field: 'code',
        sortKey: (r) => naturalSortKey(r['code']),
      }),
    );
    const sorted = sortRows(rows, [new SortSpec('code')], byField);
    expect(sorted.map((r) => r['code'])).toEqual(['item2', 'item10']);
  });

  it('is read once per row, not once per comparison', () => {
    let reads = 0;
    const rows: Row[] = [];
    for (let i = 0; i < 64; i++) rows.push({ n: (i * 37) % 64 });
    const byField = columnsOf(
      new GridColumn<Row>({
        field: 'n',
        type: ColumnType.number,
        sortKey: (r) => {
          reads++;
          return r['n'];
        },
      }),
    );
    sortRows(rows, [new SortSpec('n')], byField);
    expect(reads).toBe(64);
  });
});
