import { describe, expect, it } from 'vitest';
import {
  AsyncDataSource,
  ColumnStats,
  ColumnType,
  DataBarRule,
  FilterCondition,
  FilterOperator,
  GridColumn,
  GridController,
  GridResult,
  operatorLabel,
  operatorNeedsSecondValue,
  operatorNeedsValue,
  operatorNeedsValueSet,
  operatorsFor,
} from '../src/index';
import {
  Product,
  productColumns,
  productGrid,
  sampleProducts,
} from './fixtures';

const everyOperator = Object.values(FilterOperator);

describe('operatorsFor', () => {
  it('offers text operators for a text column, starting with contains', () => {
    const operators = operatorsFor(ColumnType.text);
    expect(operators[0]).toBe(FilterOperator.contains);
    expect(operators).toContain(FilterOperator.startsWith);
  });

  it('never offers a substring test on a number or a date', () => {
    for (const type of [ColumnType.number, ColumnType.date]) {
      expect(operatorsFor(type)).not.toContain(FilterOperator.contains);
      expect(operatorsFor(type)).toContain(FilterOperator.between);
    }
  });

  it('keeps a boolean column down to the three that mean anything', () => {
    expect(operatorsFor(ColumnType.boolean)).toEqual([
      FilterOperator.equals,
      FilterOperator.isNull,
      FilterOperator.isNotNull,
    ]);
  });

  it('labels every operator, and only ranges take a second value', () => {
    for (const operator of everyOperator) {
      expect(operatorLabel(operator).length).toBeGreaterThan(0);
    }
    expect(operatorNeedsSecondValue(FilterOperator.between)).toBe(true);
    expect(operatorNeedsSecondValue(FilterOperator.equals)).toBe(false);
    expect(operatorNeedsValue(FilterOperator.isEmpty)).toBe(false);
    expect(operatorNeedsValueSet(FilterOperator.isIn)).toBe(true);
  });

  it('resolves the set from the column type, through the controller', () => {
    const grid = productGrid();
    expect(grid.operatorsForField('price')[0]).toBe(FilterOperator.equals);
    expect(grid.operatorsForField('name')[0]).toBe(FilterOperator.contains);
    expect(grid.operatorsForField('nope')).toEqual([]);
  });
});

describe('distinctValuesFor', () => {
  it('lists each value once, in order', () => {
    const grid = productGrid();
    const distinct = grid.distinctValuesFor('category');
    expect(distinct.values).toEqual(['Compute', 'Display', 'Input']);
    expect(distinct.truncated).toBe(false);
  });

  it('covers the rows that match, not the ones filtered away', () => {
    const grid = productGrid();
    grid.setSearch('mouse');
    expect(grid.distinctValuesFor('category').values).toEqual(['Input']);
  });

  it('includes null, which is a value a user filters on', () => {
    const grid = productGrid();
    expect(grid.distinctValuesFor('stock').values).toContain(null);
  });

  it('truncates at the limit, and says that it did', () => {
    const grid = productGrid();
    const distinct = grid.distinctValuesFor('name', 2);
    expect(distinct.values).toHaveLength(2);
    expect(distinct.truncated).toBe(true);
    // The smallest two, so the list is a prefix of the real one rather than
    // an arbitrary sample of it.
    const all = grid.distinctValuesFor('name').values;
    expect(distinct.values).toEqual(all.slice(0, 2));
  });

  it("is not narrowed by the column's own filter", () => {
    // Otherwise picking one value leaves it as the only one on offer, and the
    // user can never add a second.
    const grid = productGrid();
    const before = grid.distinctValuesFor('category').values;
    grid.setColumnFilter(
      'category',
      new FilterCondition({
        field: 'category',
        operator: FilterOperator.equals,
        value: 'Input',
      }),
    );
    expect(grid.distinctValuesFor('category').values).toEqual(before);
    // Another column's filter does narrow it.
    grid.setColumnFilter(
      'name',
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.equals,
        value: 'Mouse',
      }),
    );
    expect(grid.distinctValuesFor('category').values).toEqual(['Input']);
  });

  it('is empty for an unknown column, not an error', () => {
    expect(productGrid().distinctValuesFor('nope').isEmpty).toBe(true);
  });

  it('returns nothing from a source that cannot answer', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(
        async () =>
          new GridResult<Product>({ rows: sampleProducts(), totalCount: 6 }),
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(grid.distinctValuesFor('category').isEmpty).toBe(true);
  });
});

describe('stats from a result', () => {
  it('lets a remote source supply the range its rules need', async () => {
    const grid = new GridController<Product>({
      columns: [
        new GridColumn<Product>({
          field: 'price',
          type: ColumnType.number,
          value: (p) => p.price,
          rule: new DataBarRule({ fromZero: true }),
        }),
      ],
      dataSource: new AsyncDataSource<Product>(
        async () =>
          new GridResult<Product>({
            rows: sampleProducts(),
            totalCount: 6,
            stats: new Map([
              [
                'price',
                new ColumnStats({ min: 0, max: 2000, count: 6, nullCount: 0 }),
              ],
            ]),
          }),
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(grid.statsFor('price').maxNumber).toBe(2000);
    const decoration = grid.decorationFor('price', grid.dataAt(0) as Product);
    expect(decoration.bar).toBeCloseTo(80 / 2000, 3);
  });

  it('leaves a remote rule with nothing to draw against without them', async () => {
    const grid = new GridController<Product>({
      columns: [
        new GridColumn<Product>({
          field: 'price',
          type: ColumnType.number,
          value: (p) => p.price,
          rule: new DataBarRule({ fromZero: true }),
        }),
      ],
      dataSource: new AsyncDataSource<Product>(
        async () =>
          new GridResult<Product>({ rows: sampleProducts(), totalCount: 6 }),
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(grid.statsFor('price').isEmpty).toBe(true);
  });
});
