import { describe, expect, it } from 'vitest';
import {
  Filter,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  GridFormatError,
  type CellValue,
} from '../src/index';

function row(
  overrides: { name?: CellValue; price?: CellValue; stock?: CellValue } = {},
): Record<string, CellValue> {
  return {
    name: 'name' in overrides ? overrides.name : 'Keyboard',
    price: 'price' in overrides ? overrides.price : 80,
    stock: 'stock' in overrides ? overrides.stock : 12,
  };
}

function matches(
  condition: FilterCondition,
  on: Record<string, CellValue> = row(),
): boolean {
  return condition.matches(on);
}

describe('equality and text operators', () => {
  it('applies equals and notEquals', () => {
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.equals,
          value: 'Keyboard',
        }),
      ),
    ).toBe(true);
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.notEquals,
          value: 'Keyboard',
        }),
      ),
    ).toBe(false);
  });

  it('ignores case in contains, startsWith and endsWith by default', () => {
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.contains,
          value: 'BOARD',
        }),
      ),
    ).toBe(true);
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.startsWith,
          value: 'key',
        }),
      ),
    ).toBe(true);
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.endsWith,
          value: 'ARD',
        }),
      ),
    ).toBe(true);
  });

  it('makes text comparisons exact when caseSensitive is set', () => {
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.contains,
          value: 'BOARD',
          caseSensitive: true,
        }),
      ),
    ).toBe(false);
  });

  it('negates contains with notContains', () => {
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.notContains,
          value: 'mouse',
        }),
      ),
    ).toBe(true);
  });
});

describe('ordering operators', () => {
  it('compares greater and less, inclusive and exclusive', () => {
    expect(
      matches(
        new FilterCondition({
          field: 'price',
          operator: FilterOperator.greaterThan,
          value: 50,
        }),
      ),
    ).toBe(true);
    expect(
      matches(
        new FilterCondition({
          field: 'price',
          operator: FilterOperator.greaterOrEqual,
          value: 80,
        }),
      ),
    ).toBe(true);
    expect(
      matches(
        new FilterCondition({
          field: 'price',
          operator: FilterOperator.lessThan,
          value: 80,
        }),
      ),
    ).toBe(false);
    expect(
      matches(
        new FilterCondition({
          field: 'price',
          operator: FilterOperator.lessOrEqual,
          value: 80,
        }),
      ),
    ).toBe(true);
  });

  it('includes both ends of a between', () => {
    const condition = new FilterCondition({
      field: 'price',
      operator: FilterOperator.between,
      value: 80,
      secondValue: 100,
    });
    expect(matches(condition)).toBe(true);
    expect(matches(condition, row({ price: 100 }))).toBe(true);
    expect(matches(condition, row({ price: 101 }))).toBe(false);
  });

  it('never satisfies an ordering comparison with a null value', () => {
    expect(
      matches(
        new FilterCondition({
          field: 'stock',
          operator: FilterOperator.greaterThan,
          value: 0,
        }),
        row({ stock: null }),
      ),
    ).toBe(false);
    expect(
      matches(
        new FilterCondition({
          field: 'stock',
          operator: FilterOperator.lessThan,
          value: 100,
        }),
        row({ stock: null }),
      ),
    ).toBe(false);
  });

  it('reads a range typed backwards as the same range', () => {
    const condition = new FilterCondition({
      field: 'price',
      operator: FilterOperator.between,
      value: 100,
      secondValue: 80,
    });
    expect(matches(condition)).toBe(true);
  });
});

describe('set and null operators', () => {
  it('matches any member with isIn', () => {
    const condition = new FilterCondition({
      field: 'name',
      operator: FilterOperator.isIn,
      value: ['Mouse', 'Keyboard'],
    });
    expect(matches(condition)).toBe(true);
    expect(matches(condition, row({ name: 'Monitor' }))).toBe(false);
  });

  it('applies isNull, isNotNull, isEmpty and isNotEmpty', () => {
    expect(
      matches(
        new FilterCondition({
          field: 'stock',
          operator: FilterOperator.isNull,
        }),
        row({ stock: null }),
      ),
    ).toBe(true);
    expect(
      matches(
        new FilterCondition({
          field: 'stock',
          operator: FilterOperator.isNotNull,
        }),
      ),
    ).toBe(true);
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.isEmpty,
        }),
        row({ name: '' }),
      ),
    ).toBe(true);
    expect(
      matches(
        new FilterCondition({
          field: 'name',
          operator: FilterOperator.isNotEmpty,
        }),
      ),
    ).toBe(true);
  });
});

describe('isEmpty', () => {
  it('treats an unfilled condition as inert, matching everything', () => {
    const condition = new FilterCondition({
      field: 'name',
      operator: FilterOperator.contains,
    });
    expect(condition.isEmpty).toBe(true);
    expect(matches(condition)).toBe(true);
  });

  it('counts an empty string as unfilled', () => {
    expect(
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.contains,
        value: '',
      }).isEmpty,
    ).toBe(true);
  });

  it('counts a half-filled between as unfilled', () => {
    expect(
      new FilterCondition({
        field: 'price',
        operator: FilterOperator.between,
        value: 10,
      }).isEmpty,
    ).toBe(true);
  });

  it('never counts a null check as unfilled', () => {
    expect(
      new FilterCondition({ field: 'stock', operator: FilterOperator.isNull })
        .isEmpty,
    ).toBe(false);
  });

  it('counts an empty isIn list as unfilled', () => {
    expect(
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.isIn,
        value: [],
      }).isEmpty,
    ).toBe(true);
  });

  it('treats an isIn that is not a list as malformed, not as hiding every row', () => {
    const condition = new FilterCondition({
      field: 'name',
      operator: FilterOperator.isIn,
      value: 'Mouse',
    });
    expect(condition.isEmpty).toBe(true);
    expect(matches(condition)).toBe(true);
  });
});

describe('FilterGroup', () => {
  const expensive = new FilterCondition({
    field: 'price',
    operator: FilterOperator.greaterThan,
    value: 50,
  });
  const named = new FilterCondition({
    field: 'name',
    operator: FilterOperator.contains,
    value: 'mouse',
  });

  it('requires every child of an and', () => {
    expect(FilterGroup.and([expensive, named]).matches(row())).toBe(false);
    expect(FilterGroup.and([expensive]).matches(row())).toBe(true);
  });

  it('requires any child of an or', () => {
    expect(FilterGroup.or([expensive, named]).matches(row())).toBe(true);
    expect(FilterGroup.or([named]).matches(row())).toBe(false);
  });

  it('matches everything with an empty group', () => {
    expect(FilterGroup.and([]).matches(row())).toBe(true);
    expect(FilterGroup.or([]).matches(row())).toBe(true);
  });

  it('nests to arbitrary depth', () => {
    const filter = FilterGroup.and([
      expensive,
      FilterGroup.or([
        named,
        new FilterCondition({
          field: 'stock',
          operator: FilterOperator.greaterThan,
          value: 10,
        }),
      ]),
    ]);
    expect(filter.matches(row())).toBe(true);
    expect(filter.matches(row({ stock: 1 }))).toBe(false);
  });

  it('reports every field it touches', () => {
    expect(FilterGroup.and([expensive, named]).fields).toEqual(
      new Set(['price', 'name']),
    );
  });
});

describe('serialisation', () => {
  it('round-trips a condition', () => {
    const condition = new FilterCondition({
      field: 'price',
      operator: FilterOperator.between,
      value: 10,
      secondValue: 20,
      caseSensitive: true,
    });
    const restored = Filter.fromJSON(condition.toJSON());
    expect((restored as FilterCondition).equals(condition)).toBe(true);
  });

  it('round-trips a nested group and still matches the same rows', () => {
    const filter = FilterGroup.or([
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.startsWith,
        value: 'Key',
      }),
      FilterGroup.and([
        new FilterCondition({
          field: 'price',
          operator: FilterOperator.lessThan,
          value: 10,
        }),
      ]),
    ]);
    const restored = Filter.fromJSON(filter.toJSON());
    expect(restored.matches(row())).toBe(filter.matches(row()));
    expect(restored.fields).toEqual(filter.fields);
  });

  it('rejects an unknown operator rather than silently ignoring it', () => {
    // A format error, not an argument error: the input is a document read
    // back from storage, and a caller restoring a saved view wants to report
    // a corrupt document rather than handle a programming mistake.
    expect(() => Filter.fromJSON({ field: 'name', op: 'sideways' })).toThrow(
      GridFormatError,
    );
  });

  it('skips a malformed condition inside a group rather than failing', () => {
    const warnings: string[] = [];
    const filter = Filter.fromJSON(
      {
        join: 'and',
        children: [
          { field: 'name', op: 'equals', value: 'a' },
          { op: 'equals', value: 'b' },
        ],
      },
      warnings,
    ) as FilterGroup;
    expect(filter.children).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it('keeps a date operand a date across a JSON round trip', () => {
    const when = new Date(Date.UTC(2024, 5, 1));
    const condition = new FilterCondition({
      field: 'when',
      operator: FilterOperator.greaterThan,
      value: when,
    });
    const encoded = JSON.stringify(condition.toJSON());
    const restored = FilterCondition.fromJSON(
      JSON.parse(encoded) as Record<string, unknown>,
    );
    expect(restored.value).toBeInstanceOf(Date);
    expect((restored.value as Date).getTime()).toBe(when.getTime());
    expect(restored.equals(condition)).toBe(true);
  });

  it('keeps a bigint operand a bigint, which JSON cannot carry on its own', () => {
    const condition = new FilterCondition({
      field: 'id',
      operator: FilterOperator.equals,
      value: 99999999999999999999n,
    });
    const encoded = JSON.stringify(condition.toJSON());
    const restored = FilterCondition.fromJSON(
      JSON.parse(encoded) as Record<string, unknown>,
    );
    expect(restored.value).toBe(99999999999999999999n);
  });
});
