// Fixes from the 0.4.0 review that live in the data source and the filter.
import { describe, expect, it } from 'vitest';
import {
  CellAddress,
  ColumnType,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  filtersEqual,
  GridColumn,
  GridController,
  InMemoryDataSource,
  isDataRow,
  RowUpdate,
} from '../src/index';
import { Product, productColumns } from './fixtures';

/**
 * A row model with value equality in the Dart original, which is what records
 * and freezed or equatable classes give you. JavaScript has one equality, so
 * two of these are always two rows — but the batch and edit paths still have
 * to land on the row they were handed.
 */
class Label {
  constructor(readonly text: string) {}

  toString(): string {
    return `Label(${this.text})`;
  }
}

function labelColumns(): GridColumn<Label>[] {
  return [
    new GridColumn<Label>({
      field: 'text',
      value: (l) => l.text,
      setValue: (_l, v) => new Label(String(v ?? '')),
    }),
  ];
}

function namesOf(grid: GridController<Product>): unknown[] {
  return grid.visibleRows
    .toArray()
    .filter(isDataRow)
    .map((r) => r.data.name);
}

describe('writing a row that equals another', () => {
  it('edits the row that was edited, not the first one that looks equal', async () => {
    const source = new InMemoryDataSource<Label>([
      new Label('a'),
      new Label('a'),
    ]);
    const grid = new GridController<Label>({
      columns: labelColumns(),
      dataSource: source,
    });
    grid.beginEdit(new CellAddress(1, 'text'));
    grid.updateEdit('z');
    grid.commitEdit();
    await grid.pendingWrite;

    expect(source.rows.map((row) => row.text)).toEqual(['a', 'z']);
    grid.dispose();
  });

  it('lands one update per row in a batch write', async () => {
    const source = new InMemoryDataSource<Label>([
      new Label('a'),
      new Label('a'),
    ]);
    const rows = source.rows;
    await source.commitAll([
      new RowUpdate(rows[0] as Label, new Label('x')),
      new RowUpdate(rows[1] as Label, new Label('y')),
    ]);
    expect(source.rows.map((row) => row.text)).toEqual(['x', 'y']);
  });
});

describe('case-insensitive filters', () => {
  const grid = (): GridController<Product> =>
    new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>([
        new Product({ id: 1, name: 'Apple', category: 'Fruit', price: 5 }),
        new Product({ id: 2, name: 'banana', category: 'Fruit', price: 7 }),
      ]),
    });

  it('matches a differently cased value with equals', () => {
    const g = grid();
    g.setFilter(
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.equals,
        value: 'apple',
      }),
    );
    expect(namesOf(g)).toEqual(['Apple']);
    g.dispose();
  });

  it('excludes a differently cased value with notEquals', () => {
    const g = grid();
    g.setFilter(
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.notEquals,
        value: 'apple',
      }),
    );
    expect(namesOf(g)).toEqual(['banana']);
    g.dispose();
  });

  it('matches a differently cased value with isIn', () => {
    const g = grid();
    g.setFilter(
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.isIn,
        value: ['apple'],
      }),
    );
    expect(namesOf(g)).toEqual(['Apple']);
    g.dispose();
  });

  it('includes the value a range calls equal', () => {
    const g = grid();
    g.setFilter(
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.greaterOrEqual,
        value: 'apple',
      }),
    );
    expect(namesOf(g)).toEqual(['Apple', 'banana']);
    g.dispose();
  });

  it('covers both bounds of a between, typed either way round', () => {
    const forwards = new FilterCondition({
      field: 'n',
      operator: FilterOperator.between,
      value: 2,
      secondValue: 8,
    });
    const backwards = new FilterCondition({
      field: 'n',
      operator: FilterOperator.between,
      value: 8,
      secondValue: 2,
    });
    for (const condition of [forwards, backwards]) {
      expect(
        condition.matchesRow(() => 2),
        String(condition),
      ).toBe(true);
      expect(
        condition.matchesRow(() => 8),
        String(condition),
      ).toBe(true);
      expect(
        condition.matchesRow(() => 9),
        String(condition),
      ).toBe(false);
    }
  });

  it('folds accents in a search, so creme finds Crème', () => {
    const g = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>([
        new Product({ id: 1, name: 'Crème', category: 'Fruit', price: 5 }),
      ]),
    });
    g.setSearch('creme');
    expect(g.rowCount).toBe(1);
    g.dispose();
  });
});

describe('operand coercion', () => {
  it('compares a typed operand as a number on a number column', () => {
    const g = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>([
        new Product({ id: 1, name: 'a', category: 'c', price: 100 }),
        new Product({ id: 2, name: 'b', category: 'c', price: 20 }),
      ]),
    });
    // As text, '100' < '50' — which is how a filter row's string operand used
    // to hide the wrong rows.
    g.setFilter(
      new FilterCondition({
        field: 'price',
        operator: FilterOperator.greaterThan,
        value: '50',
      }),
    );
    expect(
      g.visibleRows
        .toArray()
        .filter(isDataRow)
        .map((r) => r.data.price),
    ).toEqual([100]);
    g.dispose();
  });

  it('reads an ISO string operand as a date on a date column', () => {
    const compiled = new FilterCondition({
      field: 'when',
      operator: FilterOperator.greaterThan,
      value: '2024-06-01T00:00:00.000',
    }).compile(new Map([['when', ColumnType.date]]));
    expect(compiled.test(() => new Date(2024, 5, 1, 5))).toBe(true);
    expect(compiled.test(() => new Date(2024, 4, 31))).toBe(false);
  });

  it('ignores the time of day in a dateOnly condition', () => {
    const condition = new FilterCondition({
      field: 'when',
      operator: FilterOperator.equals,
      value: '2024-06-01',
      dateOnly: true,
    });
    const compiled = condition.compile(new Map([['when', ColumnType.date]]));
    expect(compiled.test(() => new Date(2024, 5, 1, 14, 30))).toBe(true);
    expect(compiled.test(() => new Date(2024, 5, 2))).toBe(false);
  });
});

describe('filter identity', () => {
  it('calls two isIn conditions over the same values equal', () => {
    const a = new FilterCondition({
      field: 'f',
      operator: FilterOperator.isIn,
      value: ['x', 'y'],
    });
    const b = new FilterCondition({
      field: 'f',
      operator: FilterOperator.isIn,
      value: ['x', 'y'],
    });
    expect(a.equals(b)).toBe(true);
    expect(filtersEqual(a, b)).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('calls two groups over the same children equal', () => {
    const condition = (): FilterCondition =>
      new FilterCondition({
        field: 'f',
        operator: FilterOperator.equals,
        value: 1,
      });
    const a = FilterGroup.and([condition()]);
    const b = FilterGroup.and([condition()]);
    expect(a.equals(b)).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(FilterGroup.or([]).equals(FilterGroup.and([]))).toBe(false);
  });
});

describe('an isIn over many values', () => {
  it('matches without walking every value per row', () => {
    const rows: Product[] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push(
        new Product({
          id: i,
          name: `n${i}`,
          category: `c${i % 500}`,
          price: i,
        }),
      );
    }
    const g = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(rows),
    });
    const values: string[] = [];
    for (let i = 0; i < 500; i++) values.push(`C${i}`);
    g.setFilter(
      new FilterCondition({
        field: 'category',
        operator: FilterOperator.isIn,
        value: values,
      }),
    );
    // Folded, so every row matches one of the 500 values.
    expect(g.matchedCount).toBe(2000);
    g.dispose();
  });
});
