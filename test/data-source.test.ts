import { describe, expect, it } from 'vitest';
import {
  Aggregation,
  AsyncDataSource,
  FilterCondition,
  FilterOperator,
  GridQuery,
  GridResult,
  GridStateError,
  GroupSpec,
  InMemoryDataSource,
  SortSpec,
} from '../src/index';
import { Product, productColumnMap, sampleProducts } from './fixtures';

function source(rows?: Product[]): InMemoryDataSource<Product> {
  const data = new InMemoryDataSource<Product>(rows ?? sampleProducts());
  data.columns = productColumnMap();
  return data;
}

describe('pipeline', () => {
  it('returns every row for an empty query', () => {
    const result = source().fetchSync(new GridQuery());
    expect(result.rows).toHaveLength(6);
    expect(result.totalCount).toBe(6);
    expect(result.matchedCount).toBe(6);
  });

  it('filters, and reports matched against total', () => {
    const result = source().fetchSync(
      new GridQuery({
        filter: new FilterCondition({
          field: 'category',
          operator: FilterOperator.equals,
          value: 'Input',
        }),
      }),
    );
    expect(result.rows).toHaveLength(3);
    expect(result.matchedCount).toBe(3);
    expect(result.totalCount).toBe(6);
  });

  it('sorts after filtering', () => {
    const result = source().fetchSync(
      new GridQuery({
        filter: new FilterCondition({
          field: 'category',
          operator: FilterOperator.equals,
          value: 'Input',
        }),
        sorts: [new SortSpec('price')],
      }),
    );
    expect(result.rows.map((p) => p.name)).toEqual([
      'Mouse',
      'Webcam',
      'Keyboard',
    ]);
  });

  it('matches the displayed text across visible columns when searching', () => {
    const result = source().fetchSync(new GridQuery({ search: 'input' }));
    expect(result.rows).toHaveLength(3);
  });

  it('searches case-insensitively and respects column formatters', () => {
    expect(source().fetchSync(new GridQuery({ search: 'USD' })).rows).toHaveLength(6);
    expect(
      source().fetchSync(new GridQuery({ search: 'KEYBOARD' })).rows,
    ).toHaveLength(1);
  });

  it('narrows a search to the given fields', () => {
    const result = source().fetchSync(
      new GridQuery({ search: 'Input', searchFields: ['name'] }),
    );
    expect(result.rows).toEqual([]);
  });

  it('matches everything for a blank search', () => {
    expect(source().fetchSync(new GridQuery({ search: '   ' })).rows).toHaveLength(6);
  });

  it('does not hide rows for an unfilled filter condition', () => {
    const result = source().fetchSync(
      new GridQuery({
        filter: new FilterCondition({
          field: 'name',
          operator: FilterOperator.contains,
        }),
      }),
    );
    expect(result.rows).toHaveLength(6);
  });
});

describe('paging', () => {
  it('slices the sorted result by offset and limit', () => {
    const result = source().fetchSync(
      new GridQuery({ sorts: [new SortSpec('price')], offset: 2, limit: 2 }),
    );
    expect(result.rows.map((p) => p.name)).toEqual(['Keyboard', 'Dock']);
    expect(result.matchedCount).toBe(6);
  });

  it('comes back empty for a page past the end rather than throwing', () => {
    const result = source().fetchSync(new GridQuery({ offset: 100, limit: 10 }));
    expect(result.rows).toEqual([]);
    expect(result.matchedCount).toBe(6);
  });

  it('returns what there is for a limit longer than the data', () => {
    expect(source().fetchSync(new GridQuery({ limit: 100 })).rows).toHaveLength(6);
  });

  it('counts filtered rows, not all rows', () => {
    const result = source().fetchSync(
      new GridQuery({ search: 'Input', limit: 2 }),
    );
    expect(result.rows).toHaveLength(2);
    expect(result.matchedCount).toBe(3);
    expect(result.totalCount).toBe(6);
  });
});

describe('grouping and aggregates', () => {
  it('returns a tree and no flat rows for a grouped query', () => {
    const result = source().fetchSync(
      new GridQuery({ groups: [new GroupSpec('category')] }),
    );
    expect(result.isGrouped).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.groups).toHaveLength(3);
  });

  it('ignores paging while grouped, so group counts stay whole', () => {
    const result = source().fetchSync(
      new GridQuery({ groups: [new GroupSpec('category')], limit: 2 }),
    );
    expect(result.groups.reduce((sum, g) => sum + g.rowCount, 0)).toBe(6);
  });

  it('covers the filtered set with grid-wide aggregates, not the page', () => {
    const result = source().fetchSync(
      new GridQuery({ aggregations: [Aggregation.sum('price')], limit: 1 }),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.aggregates.get('price.sum')).toBe(2115);
  });

  it('follows the filter with its aggregates', () => {
    const result = source().fetchSync(
      new GridQuery({
        search: 'Input',
        aggregations: [Aggregation.sum('price')],
      }),
    );
    expect(result.aggregates.get('price.sum')).toBe(165);
  });
});

describe('mutation and notification', () => {
  it('notifies listeners from every mutator', () => {
    const data = source();
    let notifications = 0;
    data.addListener(() => notifications++);

    data.add(new Product({ id: 7, name: 'Hub', category: 'Input', price: 30 }));
    data.addAll([
      new Product({ id: 8, name: 'Pad', category: 'Input', price: 5 }),
    ]);
    data.insert(
      0,
      new Product({ id: 9, name: 'Cable', category: 'Input', price: 9 }),
    );
    data.removeAt(0);
    data.setRows(sampleProducts());
    data.clear();
    expect(notifications).toBe(6);
    expect(data.length).toBe(0);
  });

  it('does not notify when clearing an empty source', () => {
    const data = source([]);
    let notifications = 0;
    data.addListener(() => notifications++);
    data.clear();
    expect(notifications).toBe(0);
  });

  it('notifies from removeWhere only when something was removed', () => {
    const data = source();
    let notifications = 0;
    data.addListener(() => notifications++);
    data.removeWhere((p) => p.category === 'Nothing');
    expect(notifications).toBe(0);
    data.removeWhere((p) => p.category === 'Input');
    expect(notifications).toBe(1);
    expect(data.length).toBe(3);
  });

  it('swaps a row in place with replaceAt', () => {
    const data = source();
    data.replaceAt(
      0,
      new Product({ id: 99, name: 'Swapped', category: 'X', price: 1 }),
    );
    expect(data.rows[0]?.name).toBe('Swapped');
    expect(data.length).toBe(6);
  });

  it('hands out a snapshot, so the source cannot be mutated from outside', () => {
    const data = source();
    const rows = data.rows as Product[];
    rows.push(new Product({ id: 1, name: 'x', category: 'y', price: 0 }));
    expect(data.length).toBe(6);
  });

  it('collapses many changes into one notification with a batch', () => {
    const data = source();
    let notifications = 0;
    data.addListener(() => notifications++);
    data.batch(() => {
      data.add(new Product({ id: 7, name: 'a', category: 'x', price: 1 }));
      data.add(new Product({ id: 8, name: 'b', category: 'x', price: 1 }));
      data.add(new Product({ id: 9, name: 'c', category: 'x', price: 1 }));
    });
    expect(notifications).toBe(1);
    expect(data.length).toBe(9);
  });

  it('stops telling a removed listener about changes', () => {
    const data = source();
    let notifications = 0;
    const listener = (): void => {
      notifications++;
    };
    data.addListener(listener);
    data.removeListener(listener);
    data.add(new Product({ id: 7, name: 'a', category: 'x', price: 1 }));
    expect(notifications).toBe(0);
  });

  it('removes a listener through the handle addListener returns', () => {
    const data = source();
    let notifications = 0;
    const off = data.addListener(() => notifications++);
    off();
    data.add(new Product({ id: 7, name: 'a', category: 'x', price: 1 }));
    expect(notifications).toBe(0);
  });

  it('treats using a disposed source as an error, not silent breakage', () => {
    const data = source();
    data.dispose();
    expect(data.isDisposed).toBe(true);
    expect(() => data.addListener(() => {})).toThrow(GridStateError);
  });
});

describe('AsyncDataSource', () => {
  it('passes the query through and returns what the callback gives', async () => {
    let seen: GridQuery | null = null;
    const data = new AsyncDataSource<Product>(async (query) => {
      seen = query;
      return new GridResult<Product>({ rows: sampleProducts(), totalCount: 6 });
    });
    const result = await data.fetch(new GridQuery({ search: 'abc' }));
    expect((seen as unknown as GridQuery).search).toBe('abc');
    expect(result.rows).toHaveLength(6);
    expect(data.isLocal).toBe(false);
  });
});

describe('GridQuery', () => {
  it('replaces only what copyWith is given', () => {
    const query = new GridQuery({
      search: 'a',
      sorts: [new SortSpec('name')],
      limit: 10,
    });
    const next = query.copyWith({ search: 'b' });
    expect(next.search).toBe('b');
    expect(next.sorts).toEqual(query.sorts);
    expect(next.limit).toBe(10);
  });

  it('clears the filter and the limit with an explicit null', () => {
    const query = new GridQuery({
      filter: new FilterCondition({
        field: 'name',
        operator: FilterOperator.contains,
        value: 'a',
      }),
      limit: 10,
    });
    const next = query.copyWith({ filter: null, limit: null });
    expect(next.filter).toBeNull();
    expect(next.limit).toBeNull();
    expect(next.isPaged).toBe(false);
  });

  it('serialises only the parts that are set, plus the schema version', () => {
    expect(new GridQuery().toJSON()).toEqual({ v: 1 });
    const json = new GridQuery({
      sorts: [new SortSpec('name')],
      search: 'abc',
      limit: 25,
    }).toJSON();
    expect(Object.keys(json)).toEqual(
      expect.arrayContaining(['sorts', 'search', 'limit']),
    );
    expect('filter' in json).toBe(false);
  });
});
