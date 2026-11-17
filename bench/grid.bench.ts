/**
 * What each operation costs, so a claim about speed is a measurement.
 *
 * Run with `npm run bench`. These are the operations a user drives: a header
 * click, a keystroke in the search box, opening a group, editing a cell. The
 * sizes are the ones the engine is meant to stay interactive at.
 */
import { bench, describe } from 'vitest';
import {
  Aggregation,
  ColumnType,
  FilterCondition,
  FilterOperator,
  GridColumn,
  GridController,
  GridQuery,
  GroupSpec,
  InMemoryDataSource,
  SortDirection,
  SortSpec,
} from '../src/index';

interface Trade {
  id: number;
  symbol: string;
  desk: string;
  quantity: number;
  price: number;
  note: string;
}

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOG'];
const DESKS = ['Equities', 'Rates', 'Credit', 'FX', 'Commodities'];

function trades(count: number): Trade[] {
  const out: Trade[] = new Array<Trade>(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      id: i,
      symbol: SYMBOLS[i % SYMBOLS.length] as string,
      desk: DESKS[i % DESKS.length] as string,
      quantity: ((i * 7919) % 10_000) + 1,
      price: ((i * 104_729) % 100_000) / 100,
      note: `fill ${i} on ${SYMBOLS[i % SYMBOLS.length] as string}`,
    };
  }
  return out;
}

function columns(): GridColumn<Trade>[] {
  return [
    new GridColumn<Trade>({ field: 'symbol', value: (t) => t.symbol }),
    new GridColumn<Trade>({ field: 'desk', value: (t) => t.desk }),
    new GridColumn<Trade>({
      field: 'quantity',
      type: ColumnType.number,
      value: (t) => t.quantity,
    }),
    new GridColumn<Trade>({
      field: 'price',
      type: ColumnType.number,
      value: (t) => t.price,
      setValue: (t, v) => ({ ...t, price: v as number }),
    }),
    new GridColumn<Trade>({ field: 'note', value: (t) => t.note }),
  ];
}

function sourceOf(count: number): InMemoryDataSource<Trade> {
  const source = new InMemoryDataSource<Trade>(trades(count));
  source.columns = new Map(columns().map((c) => [c.field, c]));
  return source;
}

for (const size of [10_000, 50_000]) {
  describe(`${size.toLocaleString('en-US')} rows`, () => {
    bench('sort one column', () => {
      const source = sourceOf(size);
      source.fetchSync(new GridQuery({ sorts: [new SortSpec('quantity')] }));
    });

    bench('sort three columns', () => {
      const source = sourceOf(size);
      source.fetchSync(
        new GridQuery({
          sorts: [
            new SortSpec('desk'),
            new SortSpec('symbol'),
            new SortSpec('quantity', {
              direction: SortDirection.descending,
            }),
          ],
        }),
      );
    });

    bench('reverse a sort already in hand', () => {
      const source = sourceOf(size);
      source.fetchSync(new GridQuery({ sorts: [new SortSpec('quantity')] }));
      source.fetchSync(
        new GridQuery({
          sorts: [
            new SortSpec('quantity', { direction: SortDirection.descending }),
          ],
        }),
      );
    });

    bench('search the whole table', () => {
      const source = sourceOf(size);
      source.fetchSync(new GridQuery({ search: 'nvda' }));
    });

    bench('type another character into the search box', () => {
      const source = sourceOf(size);
      source.fetchSync(new GridQuery({ search: 'nvd' }));
      source.fetchSync(new GridQuery({ search: 'nvda' }));
    });

    bench('filter on one column', () => {
      const source = sourceOf(size);
      source.fetchSync(
        new GridQuery({
          filter: new FilterCondition({
            field: 'quantity',
            operator: FilterOperator.greaterThan,
            value: 5000,
          }),
        }),
      );
    });

    bench('isIn over 500 values', () => {
      const source = sourceOf(size);
      const values: string[] = [];
      for (let i = 0; i < 500; i++) {
        values.push(`fill ${i} on ${SYMBOLS[i % SYMBOLS.length] as string}`);
      }
      source.fetchSync(
        new GridQuery({
          filter: new FilterCondition({
            field: 'note',
            operator: FilterOperator.isIn,
            value: values,
          }),
        }),
      );
    });

    bench('group with a subtotal per group', () => {
      const source = sourceOf(size);
      source.fetchSync(
        new GridQuery({
          groups: [new GroupSpec('desk')],
          aggregations: [Aggregation.sum('quantity')],
        }),
      );
    });

    bench('turn a page', () => {
      const source = sourceOf(size);
      const sorts = [new SortSpec('quantity')];
      source.fetchSync(new GridQuery({ sorts, offset: 0, limit: 50 }));
      source.fetchSync(new GridQuery({ sorts, offset: 50, limit: 50 }));
    });

    bench('edit one cell under a sort and a search', () => {
      const source = sourceOf(size);
      const query = new GridQuery({
        sorts: [new SortSpec('price')],
        search: 'nvda',
      });
      source.fetchSync(query);
      const row = source.rows[0] as Trade;
      source.replaceAt(0, { ...row, price: 1 });
      source.fetchSync(query);
    });

    bench('read the first screenful of rows', () => {
      const grid = new GridController<Trade>({
        columns: columns(),
        dataSource: sourceOf(size),
        sorts: [new SortSpec('quantity')],
      });
      for (let i = 0; i < 40; i++) grid.visibleRows.at(i);
      grid.dispose();
    });

    bench('open a group', () => {
      const grid = new GridController<Trade>({
        columns: columns(),
        dataSource: sourceOf(size),
        groups: [new GroupSpec('desk')],
        groupsExpandedByDefault: false,
      });
      const path = grid.visibleRows.at(0);
      grid.toggleGroup((path as unknown as { path: string }).path);
      grid.dispose();
    });

    bench('select every row', () => {
      const grid = new GridController<Trade>({
        columns: columns(),
        dataSource: sourceOf(size),
      });
      grid.selectAllRows();
      grid.dispose();
    });
  });
}
