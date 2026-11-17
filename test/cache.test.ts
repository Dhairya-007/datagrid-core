// The pipeline is memoised, so these tests exist to prove it can never serve
// a stale answer. Each one changes something the cache key has to notice.
import { describe, expect, it } from 'vitest';
import {
  AggregateType,
  Aggregation,
  FilterCondition,
  FilterOperator,
  GridQuery,
  GridResult,
  GroupSpec,
  InMemoryDataSource,
  isDataRow,
  isGroupRow,
  NullsPosition,
  SortDirection,
  SortSpec,
  type CellValue,
} from '../src/index';
import {
  Product,
  productColumnMap,
  productGrid,
  sampleProducts,
} from './fixtures';

function source(rows?: Product[]): InMemoryDataSource<Product> {
  const data = new InMemoryDataSource<Product>(rows ?? sampleProducts());
  data.columns = productColumnMap();
  return data;
}

const namesOf = (result: GridResult<Product>): string[] =>
  result.rows.map((row) => row.name);

describe('revision', () => {
  it('starts at a known point and advances on every mutation', () => {
    const data = source();
    const start = data.revision;
    data.add(new Product({ id: 7, name: 'Hub', category: 'Input', price: 30 }));
    expect(data.revision).toBeGreaterThan(start);
    const afterAdd = data.revision;
    data.removeAt(0);
    expect(data.revision).toBeGreaterThan(afterAdd);
  });

  it('does not advance when a mutator changed nothing', () => {
    const data = source([]);
    const start = data.revision;
    data.clear();
    data.removeWhere(() => false);
    expect(data.revision).toBe(start);
  });

  it('advances when the columns are replaced', () => {
    const data = source();
    const start = data.revision;
    data.columns = productColumnMap();
    expect(data.revision).toBeGreaterThan(start);
  });
});

describe('stale results after a mutation', () => {
  it('shows an added row in a repeated query', () => {
    const data = source();
    const query = new GridQuery({ sorts: [new SortSpec('name')] });
    expect(data.fetchSync(query).rows).toHaveLength(6);
    data.add(
      new Product({ id: 7, name: 'Aardvark', category: 'Input', price: 1 }),
    );
    const again = data.fetchSync(query);
    expect(again.rows).toHaveLength(7);
    expect(again.rows[0]?.name).toBe('Aardvark');
  });

  it('drops a removed row', () => {
    const data = source();
    const query = new GridQuery({ sorts: [new SortSpec('price')] });
    expect(namesOf(data.fetchSync(query))[0]).toBe('Mouse');
    data.removeWhere((p) => p.name === 'Mouse');
    expect(namesOf(data.fetchSync(query))[0]).toBe('Webcam');
  });

  it('re-filters and re-sorts an edited value', () => {
    const rows = sampleProducts();
    const data = source(rows);
    const query = new GridQuery({
      sorts: [new SortSpec('price')],
      filter: new FilterCondition({
        field: 'price',
        operator: FilterOperator.lessThan,
        value: 100,
      }),
    });
    expect(namesOf(data.fetchSync(query))).toEqual([
      'Mouse',
      'Webcam',
      'Keyboard',
    ]);

    (rows[1] as Product).price = 5000;
    data.replaceAt(1, rows[1] as Product);
    expect(namesOf(data.fetchSync(query))).toEqual(['Webcam', 'Keyboard']);
  });

  it('sees the new text in a search repeated after a mutation', () => {
    const rows = sampleProducts();
    const data = source(rows);
    const query = new GridQuery({ search: 'keyb' });
    expect(data.fetchSync(query).rows).toHaveLength(1);

    (rows[0] as Product).name = 'Trackpad';
    data.replaceAt(0, rows[0] as Product);
    expect(data.fetchSync(query).rows).toEqual([]);
  });

  it('changes what search matches when a formatter is replaced', () => {
    const data = source();
    const query = new GridQuery({ search: 'usd' });
    expect(data.fetchSync(query).rows).toHaveLength(6);

    const relabelled = new Map(
      [...productColumnMap()].map(([field, column]) => [
        field,
        field === 'price'
          ? column.copyWith({
              format: (v: CellValue) => `EUR ${String(v)}`,
            })
          : column,
      ]),
    );
    data.columns = relabelled;
    expect(data.fetchSync(query).rows).toEqual([]);
    expect(data.fetchSync(new GridQuery({ search: 'eur' })).rows).toHaveLength(
      6,
    );
  });

  it('empties a cached query when the rows are cleared', () => {
    const data = source();
    const query = new GridQuery({ sorts: [new SortSpec('name')] });
    expect(data.fetchSync(query).rows.length).toBeGreaterThan(0);
    data.clear();
    expect(data.fetchSync(query).rows).toEqual([]);
    expect(data.fetchSync(query).totalCount).toBe(0);
  });
});

describe('cached stages answer each query shape correctly', () => {
  it('reverses the same rows when only the sort direction changes', () => {
    const data = source();
    const ascending = namesOf(
      data.fetchSync(new GridQuery({ sorts: [new SortSpec('price')] })),
    );
    const descending = namesOf(
      data.fetchSync(
        new GridQuery({
          sorts: [
            new SortSpec('price', { direction: SortDirection.descending }),
          ],
        }),
      ),
    );
    expect(descending).toEqual([...ascending].reverse());
  });

  it('re-slices the same ordering when only the page changes', () => {
    const data = source();
    const all = namesOf(
      data.fetchSync(new GridQuery({ sorts: [new SortSpec('price')] })),
    );
    const second = namesOf(
      data.fetchSync(
        new GridQuery({
          sorts: [new SortSpec('price')],
          offset: 2,
          limit: 2,
        }),
      ),
    );
    expect(second).toEqual(all.slice(2, 4));
  });

  it('honours null placement through the cache', () => {
    const data = source();
    const last = new GridQuery({ sorts: [new SortSpec('stock')] });
    const first = new GridQuery({
      sorts: [new SortSpec('stock', { nulls: NullsPosition.first })],
    });
    const lastRows = data.fetchSync(last).rows;
    expect(lastRows[lastRows.length - 1]?.stock).toBeNull();
    expect(data.fetchSync(first).rows[0]?.stock).toBeNull();
    const again = data.fetchSync(last).rows;
    expect(again[again.length - 1]?.stock).toBeNull();
  });

  it('narrows a cached search further with a filter', () => {
    const data = source();
    expect(data.fetchSync(new GridQuery({ search: 'o' })).rows).toHaveLength(5);
    const narrowed = data.fetchSync(
      new GridQuery({
        search: 'o',
        filter: new FilterCondition({
          field: 'category',
          operator: FilterOperator.equals,
          value: 'Compute',
        }),
      }),
    );
    expect(namesOf(narrowed)).toEqual(['Laptop', 'Dock']);
  });

  it('tracks the current filter in its aggregates, not a previous one', () => {
    const data = source();
    const all = new GridQuery({ aggregations: [Aggregation.sum('price')] });
    const input = new GridQuery({
      aggregations: [Aggregation.sum('price')],
      filter: new FilterCondition({
        field: 'category',
        operator: FilterOperator.equals,
        value: 'Input',
      }),
    });
    expect(data.fetchSync(all).aggregates.get('price.sum')).toBe(2115);
    expect(data.fetchSync(input).aggregates.get('price.sum')).toBe(165);
    expect(data.fetchSync(all).aggregates.get('price.sum')).toBe(2115);
  });

  it('follows the current sort in an order-sensitive aggregate', () => {
    const data = source();
    const first = new Aggregation('name', {
      type: AggregateType.first,
      id: 'firstName',
    });
    expect(
      data
        .fetchSync(
          new GridQuery({
            sorts: [new SortSpec('price')],
            aggregations: [first],
          }),
        )
        .aggregates.get('firstName'),
    ).toBe('Mouse');
    expect(
      data
        .fetchSync(
          new GridQuery({
            sorts: [
              new SortSpec('price', { direction: SortDirection.descending }),
            ],
            aggregations: [first],
          }),
        )
        .aggregates.get('firstName'),
    ).toBe('Laptop');
  });

  it('regroups when the group field changes', () => {
    const data = source();
    const byCategory = data.fetchSync(
      new GridQuery({ groups: [new GroupSpec('category')] }),
    );
    expect(byCategory.groups).toHaveLength(3);
    const byActive = data.fetchSync(
      new GridQuery({ groups: [new GroupSpec('active')] }),
    );
    expect(byActive.groups).toHaveLength(2);
    expect(
      data.fetchSync(new GridQuery({ groups: [new GroupSpec('category')] }))
        .groups,
    ).toHaveLength(3);
  });
});

describe('incremental search', () => {
  it('matches a one-shot search exactly when typing forward', () => {
    const data = source();
    const typed: number[] = [];
    for (const needle of ['k', 'ke', 'key', 'keyb']) {
      typed.push(data.fetchSync(new GridQuery({ search: needle })).rows.length);
    }
    const control = source();
    expect(typed).toEqual(
      ['k', 'ke', 'key', 'keyb'].map(
        (needle) =>
          control.fetchSync(new GridQuery({ search: needle })).rows.length,
      ),
    );
    expect(typed[typed.length - 1]).toBe(1);
  });

  it('widens the result again when backspacing', () => {
    const data = source();
    expect(data.fetchSync(new GridQuery({ search: 'keyb' })).rows).toHaveLength(
      1,
    );
    expect(data.fetchSync(new GridQuery({ search: 'key' })).rows).toHaveLength(
      1,
    );
    // 'k' is in Keyboard and Dock, and nowhere else in the sample.
    expect(data.fetchSync(new GridQuery({ search: 'k' })).rows).toHaveLength(2);
    expect(data.fetchSync(new GridQuery({ search: '' })).rows).toHaveLength(6);
  });

  it('gives the same answer after clearing and retyping', () => {
    const data = source();
    const once = data.fetchSync(new GridQuery({ search: 'mo' })).rows.length;
    data.fetchSync(new GridQuery({ search: '' }));
    const twice = data.fetchSync(new GridQuery({ search: 'mo' })).rows.length;
    expect(twice).toBe(once);
    expect(twice).toBe(2);
  });

  it('cannot match text spanning two columns', () => {
    // 'Keyboard' then 'Input' are adjacent in the row, and the index joins
    // columns with a character a user cannot type.
    const data = source();
    expect(
      data.fetchSync(new GridQuery({ search: 'keyboardinput' })).rows,
    ).toEqual([]);
    expect(
      data.fetchSync(new GridQuery({ search: 'keyboard' })).rows,
    ).toHaveLength(1);
  });

  it('narrows within an unchanged filter', () => {
    const data = source();
    const filter = new FilterCondition({
      field: 'category',
      operator: FilterOperator.equals,
      value: 'Input',
    });
    expect(data.fetchSync(new GridQuery({ filter })).rows).toHaveLength(3);
    expect(
      namesOf(data.fetchSync(new GridQuery({ filter, search: 'm' }))),
    ).toEqual(['Mouse', 'Webcam']);
    expect(
      namesOf(data.fetchSync(new GridQuery({ filter, search: 'mo' }))),
    ).toEqual(['Mouse']);
  });

  it('re-evaluates both when the filter changes under a search', () => {
    const data = source();
    expect(
      data.fetchSync(
        new GridQuery({
          search: 'o',
          filter: new FilterCondition({
            field: 'category',
            operator: FilterOperator.equals,
            value: 'Input',
          }),
        }),
      ).rows,
    ).toHaveLength(2);
    expect(
      namesOf(
        data.fetchSync(
          new GridQuery({
            search: 'o',
            filter: new FilterCondition({
              field: 'category',
              operator: FilterOperator.equals,
              value: 'Compute',
            }),
          }),
        ),
      ),
    ).toEqual(['Laptop', 'Dock']);
  });

  it('restricts a search to the fields asked for', () => {
    const data = source();
    expect(
      data.fetchSync(new GridQuery({ search: 'input', searchFields: ['name'] }))
        .rows,
    ).toEqual([]);
    expect(
      data.fetchSync(
        new GridQuery({ search: 'input', searchFields: ['category'] }),
      ).rows,
    ).toHaveLength(3);
  });
});

describe('the lazy row list', () => {
  it('materialises rows on read with the right indices', () => {
    const grid = productGrid();
    expect(grid.visibleRows.length).toBe(6);
    const row = grid.visibleRows.at(3);
    if (!isDataRow(row)) throw new Error('expected a data row');
    expect(row.index).toBe(3);
    expect(row.sourceIndex).toBe(3);
    expect(row.data.name).toBe('Laptop');
  });

  it('carries the page offset into sourceIndex', () => {
    const grid = productGrid({ pageSize: 2 });
    grid.goToPage(2);
    const row = grid.visibleRows.at(0);
    if (!isDataRow(row)) throw new Error('expected a data row');
    expect(row.index).toBe(0);
    expect(row.sourceIndex).toBe(4);
  });

  it('refuses a read outside the list', () => {
    const grid = productGrid();
    expect(() => grid.visibleRows.at(6)).toThrow(RangeError);
    expect(() => grid.visibleRows.at(-1)).toThrow(RangeError);
  });

  it('builds a fresh wrapper per read, so compare data or index', () => {
    const grid = productGrid();
    const first = grid.visibleRows.at(0);
    const second = grid.visibleRows.at(0);
    expect(second).not.toBe(first);
    expect(isDataRow(first) && isDataRow(second) && first.data).toBe(
      isDataRow(second) ? second.data : null,
    );
  });

  it('iterates every row in order', () => {
    const grid = productGrid({ sorts: [new SortSpec('name')] });
    expect(
      grid.visibleRows
        .toArray()
        .filter(isDataRow)
        .map((r) => r.data.name),
    ).toEqual(['Dock', 'Keyboard', 'Laptop', 'Monitor', 'Mouse', 'Webcam']);
  });

  it('indexes a grouped grid over its groups', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    expect(isGroupRow(grid.visibleRows.at(0))).toBe(true);
    expect(grid.visibleRows.length).toBe(9);
  });
});
