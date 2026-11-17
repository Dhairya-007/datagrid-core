// The pipeline stages this exercises are the engine's inner layer.
import { describe, expect, it } from 'vitest';
import {
  AggregateType,
  ColumnType,
  GridColumn,
  Aggregation,
  buildGroups,
  collectGroupPaths,
  computeAggregates,
  flattenGroups,
  GroupExpansionState,
  groupPathSegment,
  GroupSpec,
  isDataRow,
  isGroupRow,
  SortDirection,
  SortSpec,
  sortRows,
  type CellValue,
  type GroupNode,
} from '../src/advanced';
import { Product, productColumnMap, productGrid, sampleProducts } from './fixtures';

const columns = productColumnMap();

const read = (row: Product, field: string): CellValue =>
  columns.get(field)?.value(row);

const labelUpper = (key: CellValue): string => String(key).toUpperCase();
const keyBig = (value: CellValue): CellValue => (value as number) > 100;
const keyEven = (value: CellValue): CellValue => (value as number) % 2 === 0;

function groupLabels(grid: ReturnType<typeof productGrid>): string[] {
  const out: string[] = [];
  for (const row of grid.visibleRows) {
    if (isGroupRow(row)) out.push(row.label);
  }
  return out;
}

describe('buildGroups', () => {
  it('buckets rows by one field, ordered by group key', () => {
    const groups = buildGroups(
      sampleProducts(),
      [new GroupSpec('category')],
      columns,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Compute',
      'Display',
      'Input',
    ]);
    expect(groups.map((g) => g.rowCount)).toEqual([2, 1, 3]);
  });

  it('orders group headers descending when asked', () => {
    const groups = buildGroups(
      sampleProducts(),
      [new GroupSpec('category', { direction: SortDirection.descending })],
      columns,
    );
    expect(groups[0]?.label).toBe('Input');
  });

  it('preserves incoming row order inside a bucket', () => {
    const sorted = sortRows(
      sampleProducts(),
      [new SortSpec('price', { direction: SortDirection.descending })],
      columns,
    );
    const groups = buildGroups(sorted, [new GroupSpec('category')], columns);
    const input = groups.find((g) => g.label === 'Input') as GroupNode<Product>;
    expect(input.rows.map((p) => p.name)).toEqual([
      'Keyboard',
      'Webcam',
      'Mouse',
    ]);
  });

  it('nests multiple levels and gives every node a key path', () => {
    const groups = buildGroups(
      sampleProducts(),
      [new GroupSpec('category'), new GroupSpec('active')],
      columns,
    );
    const compute = groups.find(
      (g) => g.label === 'Compute',
    ) as GroupNode<Product>;
    expect(compute.children.map((g) => g.label)).toEqual(['false', 'true']);
    // The path names the field and the key's type at every level, so that `1`
    // and `'1'` — or two grouping fields — cannot collide.
    expect(compute.children[0]?.path).toBe(
      `${groupPathSegment('category', 'Compute')}\u001f${groupPathSegment('active', false)}`,
    );
    expect(compute.isLeafGroup).toBe(false);
    expect(compute.rows).toEqual([]);
    expect(compute.rowCount).toBe(2);
  });

  it('labels a null key as blank', () => {
    const groups = buildGroups(
      sampleProducts(),
      [new GroupSpec('stock')],
      columns,
    );
    expect(groups[groups.length - 1]?.label).toBe('(blank)');
  });

  it('buckets by a derived key with keyOf', () => {
    const groups = buildGroups(
      sampleProducts(),
      [
        new GroupSpec('price', {
          keyOf: (v) => ((v as number) >= 100 ? 'premium' : 'budget'),
          labelOf: (k) => `${String(k)} tier`,
        }),
      ],
      columns,
    );
    expect(groups.map((g) => g.label)).toEqual(['budget tier', 'premium tier']);
    expect(groups[0]?.rowCount).toBe(3);
  });

  it('walks the whole subtree in display order with allRows', () => {
    const groups = buildGroups(
      sampleProducts(),
      [new GroupSpec('category'), new GroupSpec('active')],
      columns,
    );
    expect(groups.flatMap((g) => g.allRows)).toHaveLength(6);
  });

  it('returns nothing for no specs or no rows', () => {
    expect(buildGroups(sampleProducts(), [], columns)).toEqual([]);
    expect(buildGroups([], [new GroupSpec('category')], columns)).toEqual([]);
  });

  it('groups a date column by value, not by object identity', () => {
    // A JavaScript Map compares object keys by identity, so two equal dates
    // used to make two buckets of one row each.
    interface Dated extends Record<string, CellValue> {
      when: Date;
    }
    const rows: Dated[] = [
      { when: new Date(2026, 0, 1) },
      { when: new Date(2026, 0, 1) },
      { when: new Date(2026, 0, 2) },
    ];
    const byField = new Map([
      ['when', new GridColumn<Dated>({ field: 'when', type: ColumnType.date })],
    ]);
    const groups = buildGroups(rows, [new GroupSpec('when')], byField);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.rowCount)).toEqual([2, 1]);
  });
});

describe('aggregates', () => {
  it('computes sum, average, min, max and count per group', () => {
    const groups = buildGroups(
      sampleProducts(),
      [new GroupSpec('category')],
      columns,
      {
        aggregations: [
          Aggregation.sum('price'),
          Aggregation.average('price'),
          Aggregation.min('price'),
          Aggregation.max('price'),
          Aggregation.count('price'),
        ],
      },
    );
    const input = groups.find(
      (g) => g.label === 'Input',
    ) as GroupNode<Product>;
    expect(input.aggregates.get('price.sum')).toBe(165);
    expect(input.aggregates.get('price.average')).toBe(55);
    expect(input.aggregates.get('price.min')).toBe(25);
    expect(input.aggregates.get('price.max')).toBe(80);
    expect(input.aggregates.get('price.count')).toBe(3);
  });

  it('skips nulls in numeric aggregates, like SQL', () => {
    const result = computeAggregates(
      sampleProducts(),
      [Aggregation.sum('stock'), Aggregation.average('stock')],
      read,
    );
    expect(result.get('stock.sum')).toBe(64);
    expect(result.get('stock.average')).toBe(64 / 5);
  });

  it('aggregates an all-null or empty group to null, not zero', () => {
    const result = computeAggregates(
      [new Product({ id: 9, name: 'Ghost', category: 'None', price: 0 })],
      [Aggregation.sum('stock'), Aggregation.min('stock')],
      read,
    );
    expect(result.get('stock.sum')).toBeNull();
    expect(result.get('stock.min')).toBeNull();
    expect(
      computeAggregates([], [Aggregation.sum('price')], read).get('price.sum'),
    ).toBeNull();
  });

  it('counts rows with count and values with countDistinct', () => {
    const result = computeAggregates(
      sampleProducts(),
      [
        new Aggregation('category', { type: AggregateType.count }),
        new Aggregation('category', { type: AggregateType.countDistinct }),
      ],
      read,
    );
    expect(result.get('category.count')).toBe(6);
    expect(result.get('category.countDistinct')).toBe(3);
  });

  it('applies min and max to non-numeric values', () => {
    const result = computeAggregates(
      sampleProducts(),
      [Aggregation.min('name'), Aggregation.max('name')],
      read,
    );
    expect(result.get('name.min')).toBe('Dock');
    expect(result.get('name.max')).toBe('Webcam');
  });

  it('gives a custom aggregate every value', () => {
    const result = computeAggregates(
      sampleProducts(),
      [
        new Aggregation('name', {
          type: AggregateType.custom,
          id: 'initials',
          compute: (values) => values.map((v) => String(v)[0]).join(''),
        }),
      ],
      read,
    );
    expect(result.get('initials')).toBe('KMMLDW');
  });

  it('yields an empty result for no aggregations', () => {
    expect(computeAggregates(sampleProducts(), [], read).isEmpty).toBe(true);
  });
});

describe('flattening and expansion', () => {
  const twoLevels = (): GroupNode<Product>[] =>
    buildGroups(
      sampleProducts(),
      [new GroupSpec('category'), new GroupSpec('active')],
      columns,
    );

  it('emits a header then its rows for an expanded group', () => {
    const rows = flattenGroups(
      buildGroups(sampleProducts(), [new GroupSpec('category')], columns),
      new GroupExpansionState(),
    );
    expect(isGroupRow(rows[0] as never)).toBe(true);
    expect(rows).toHaveLength(3 + 6);
    expect(isDataRow(rows[1] as never)).toBe(true);
    expect(rows[1]?.depth).toBe(1);
  });

  it('hides the contents of a collapsed group but keeps the header', () => {
    const expansion = new GroupExpansionState({ expandedByDefault: false });
    const rows = flattenGroups(
      buildGroups(sampleProducts(), [new GroupSpec('category')], columns),
      expansion,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => isGroupRow(r))).toBe(true);
  });

  it('numbers rows contiguously, matching list position', () => {
    const rows = flattenGroups(twoLevels(), new GroupExpansionState());
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]?.index).toBe(i);
    }
  });

  it('leaves siblings alone when one group is toggled', () => {
    const expansion = new GroupExpansionState();
    expansion.toggle(groupPathSegment('category', 'Input'));
    const rows = flattenGroups(
      buildGroups(sampleProducts(), [new GroupSpec('category')], columns),
      expansion,
    );
    const labels = rows.filter(isGroupRow).map((r) => r.label);
    expect(labels).toEqual(['Compute', 'Display', 'Input']);
    expect(rows).toHaveLength(3 + 3);
  });

  it('keys expansion by path, so it survives a rebuild', () => {
    const expansion = new GroupExpansionState();
    expansion.setExpanded(groupPathSegment('category', 'Compute'), false);
    const again = flattenGroups(twoLevels(), expansion);
    const compute = again
      .filter(isGroupRow)
      .find((r) => r.label === 'Compute');
    expect(compute?.expanded).toBe(false);
  });

  it('closes everything with collapseAll and reopens it with expandAll', () => {
    const nodes = twoLevels();
    const expansion = new GroupExpansionState();
    expansion.collapseAll();
    expect(flattenGroups(nodes, expansion)).toHaveLength(3);
    expansion.expandAll();
    expect(flattenGroups(nodes, expansion).length).toBeGreaterThan(3);
  });

  it('reaches every level with collectGroupPaths', () => {
    expect(collectGroupPaths(twoLevels())).toHaveLength(3 + 4);
  });
});

describe('regrouping the same field', () => {
  it('rebuilds the buckets for a different keyOf instead of serving the old ones', () => {
    const grid = productGrid({
      groups: [
        new GroupSpec('price', {
          keyOf: (v) => ((v as number) > 100 ? 'big' : 'small'),
        }),
      ],
    });
    expect(groupLabels(grid)).toEqual(['big', 'small']);

    grid.setGroups([
      new GroupSpec('price', {
        keyOf: (v) => ((v as number) % 2 === 0 ? 'even' : 'odd'),
      }),
    ]);
    expect(groupLabels(grid)).toEqual(['even', 'odd']);
  });

  it('relabels the same buckets for a different labelOf', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    grid.setGroups([
      new GroupSpec('category', { labelOf: (k) => `${String(k)} group` }),
    ]);
    expect(groupLabels(grid)).toEqual([
      'Compute group',
      'Display group',
      'Input group',
    ]);
  });

  it('still hits the cache for a spec rebuilt with the same function', () => {
    const spec = (): GroupSpec =>
      new GroupSpec('category', { labelOf: labelUpper });
    expect(spec().fingerprint).toBe(spec().fingerprint);
    expect(spec().equals(spec())).toBe(true);
  });

  it('does not call specs equal when only their keyOf differs', () => {
    expect(
      new GroupSpec('price', { keyOf: keyBig }).equals(
        new GroupSpec('price', { keyOf: keyEven }),
      ),
    ).toBe(false);
  });
});
