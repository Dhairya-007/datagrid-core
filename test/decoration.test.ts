// The pipeline stages this exercises are the engine's inner layer.
import { describe, expect, it } from 'vitest';
import {
  CellDecoration,
  CellTone,
  ColorScaleRule,
  ColumnStats,
  computeColumnStats,
  DataBarRule,
  FirstMatchRule,
  GridController,
  InMemoryDataSource,
  MergedRule,
  ThresholdRule,
  ValueToneRule,
} from '../src/advanced';
import { Product, productColumns, sampleProducts } from './fixtures';

describe('ColumnStats', () => {
  it('finds the range and counts nulls separately', () => {
    const stats = computeColumnStats([5, 1, 9, null, 3]);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(9);
    expect(stats.count).toBe(4);
    expect(stats.nullCount).toBe(1);
    expect(stats.sum).toBe(18);
    expect(stats.mean).toBe(4.5);
  });

  it('works on non-numeric values, leaving sum unset', () => {
    const stats = computeColumnStats(['pear', 'apple', 'fig']);
    expect(stats.min).toBe('apple');
    expect(stats.max).toBe('pear');
    expect(stats.sum).toBeNull();
    expect(stats.mean).toBeNull();
  });

  it('calls an empty column empty, not zero', () => {
    const stats = computeColumnStats([null, null]);
    expect(stats.isEmpty).toBe(true);
    expect(stats.min).toBeNull();
    expect(stats.mean).toBeNull();
  });

  it('places a value in the range with fractionOf', () => {
    const stats = computeColumnStats([0, 50, 100]);
    expect(stats.fractionOf(0)).toBe(0);
    expect(stats.fractionOf(50)).toBe(0.5);
    expect(stats.fractionOf(100)).toBe(1);
  });

  it('clamps outside the range and rejects non-numbers', () => {
    const stats = computeColumnStats([10, 20]);
    expect(stats.fractionOf(-5)).toBe(0);
    expect(stats.fractionOf(500)).toBe(1);
    expect(stats.fractionOf('x')).toBeNull();
    expect(stats.fractionOf(null)).toBeNull();
  });

  it('has no usable range when every value is equal', () => {
    const stats = computeColumnStats([7, 7, 7]);
    expect(stats.fractionOf(7)).toBe(1);
    expect(stats.fractionOf(1)).toBeNull();
  });

  it('counts a non-finite value as a value but not as a number', () => {
    // One Infinity in a column would otherwise make every sum, mean and data
    // bar over it NaN.
    const stats = computeColumnStats([10, Number.POSITIVE_INFINITY]);
    expect(stats.count).toBe(2);
    expect(stats.numberCount).toBe(1);
    expect(stats.sum).toBe(10);
  });
});

describe('DataBarRule', () => {
  const stats = computeColumnStats([0, 25, 50, 75, 100]);

  it('fills in proportion to the column range', () => {
    const rule = new DataBarRule();
    expect(rule.decorate(50, stats)?.bar).toBe(0.5);
    expect(rule.decorate(100, stats)?.bar).toBe(1);
  });

  it('keeps a sliver visible for a small non-zero value', () => {
    const rule = new DataBarRule({ minimumFraction: 0.05 });
    expect(rule.decorate(1, stats)?.bar).toBe(0.05);
    expect(rule.decorate(0, stats)?.bar).toBe(0);
  });

  it('measures against the maximum with fromZero, not the minimum', () => {
    const offset = computeColumnStats([80, 90, 100]);
    expect(new DataBarRule().decorate(90, offset)?.bar).toBe(0.5);
    expect(
      new DataBarRule({ fromZero: true }).decorate(90, offset)?.bar,
    ).toBeCloseTo(0.9, 4);
  });

  it('leaves non-numeric and unmeasurable cells alone', () => {
    expect(new DataBarRule().decorate('x', stats)).toBeNull();
    expect(new DataBarRule().decorate(5, ColumnStats.empty)).toBeNull();
  });
});

describe('ColorScaleRule', () => {
  const stats = computeColumnStats([0, 100]);

  it('tones the ends differently', () => {
    const rule = new ColorScaleRule();
    expect(rule.decorate(100, stats)?.tone).toBe(CellTone.severe);
    expect(rule.decorate(0, stats)?.tone).toBe(CellTone.positive);
  });

  it('is strongest at the ends and quiet in the middle', () => {
    const rule = new ColorScaleRule();
    expect(rule.decorate(100, stats)?.intensity).toBe(1);
    expect(rule.decorate(0, stats)?.intensity).toBe(1);
    expect(rule.decorate(50, stats)?.intensity).toBeLessThan(0.1);
  });

  it('swaps which end is which when reversed', () => {
    const rule = new ColorScaleRule({ reverse: true });
    expect(rule.decorate(100, stats)?.tone).toBe(CellTone.positive);
    expect(rule.decorate(0, stats)?.tone).toBe(CellTone.severe);
  });

  it('moves the crossover with an off-centre midpoint', () => {
    const rule = new ColorScaleRule({ midpoint: 0.9 });
    expect(rule.decorate(80, stats)?.tone).toBe(CellTone.positive);
    expect(rule.decorate(95, stats)?.tone).toBe(CellTone.severe);
  });
});

describe('ThresholdRule', () => {
  const stats = computeColumnStats([0, 100]);

  it('fires at and above the threshold', () => {
    const rule = new ThresholdRule({ threshold: 50 });
    expect(rule.decorate(49, stats)).toBeNull();
    expect(rule.decorate(50, stats)?.tone).toBe(CellTone.severe);
    expect(rule.decorate(51, stats)?.tone).toBe(CellTone.severe);
  });

  it('can fire below instead', () => {
    const rule = new ThresholdRule({ threshold: 50, above: false });
    expect(rule.decorate(49, stats)?.tone).toBe(CellTone.severe);
    expect(rule.decorate(51, stats)).toBeNull();
  });

  it('works on dates as well as numbers', () => {
    const rule = new ThresholdRule({ threshold: new Date(2026, 5, 1) });
    expect(rule.decorate(new Date(2026, 6, 1), stats)).not.toBeNull();
    expect(rule.decorate(new Date(2026, 4, 1), stats)).toBeNull();
  });

  it('never fires on null', () => {
    expect(new ThresholdRule({ threshold: 0 }).decorate(null, stats)).toBeNull();
  });
});

describe('ValueToneRule', () => {
  const stats = ColumnStats.empty;

  it('maps known values and ignores the rest', () => {
    const rule = new ValueToneRule({
      error: CellTone.severe,
      warn: CellTone.caution,
    });
    expect(rule.decorate('error', stats)?.tone).toBe(CellTone.severe);
    expect(rule.decorate('warn', stats)?.tone).toBe(CellTone.caution);
    expect(rule.decorate('info', stats)).toBeNull();
  });

  it('ignores case unless asked not to', () => {
    const rule = new ValueToneRule({ error: CellTone.severe });
    expect(rule.decorate('ERROR', stats)?.tone).toBe(CellTone.severe);
    expect(
      new ValueToneRule(
        { error: CellTone.severe },
        { caseSensitive: true },
      ).decorate('ERROR', stats),
    ).toBeNull();
  });

  it('maps non-string values too', () => {
    const rule = new ValueToneRule(new Map([[false, CellTone.caution]]));
    expect(rule.decorate(false, stats)?.tone).toBe(CellTone.caution);
    expect(rule.decorate(true, stats)).toBeNull();
  });
});

describe('composition', () => {
  const stats = computeColumnStats([0, 100]);

  it('takes the first rule that fires', () => {
    const rule = new FirstMatchRule([
      new ThresholdRule({ threshold: 90 }),
      new ColorScaleRule(),
    ]);
    expect(rule.decorate(95, stats)?.bar).toBeNull();
    expect(rule.decorate(10, stats)?.tone).toBe(CellTone.positive);
  });

  it('falls through to nothing', () => {
    const rule = new FirstMatchRule([new ThresholdRule({ threshold: 1000 })]);
    expect(rule.decorate(5, stats)).toBeNull();
  });

  it('combines a bar with a tone', () => {
    const rule = new MergedRule([
      new DataBarRule(),
      new ThresholdRule({ threshold: 90, bold: true }),
    ]);
    const high = rule.decorate(95, stats);
    expect(high?.bar).toBeCloseTo(0.95, 4);
    expect(high?.tone).toBe(CellTone.severe);
    expect(high?.bold).toBe(true);

    const low = rule.decorate(10, stats);
    expect(low?.bar).toBeCloseTo(0.1, 4);
    expect(low?.tone).toBe(CellTone.info);
    expect(low?.bold).toBe(false);
  });
});

describe('through the controller', () => {
  function gridWithRules(): GridController<Product> {
    const columns = productColumns();
    columns[2] = (columns[2] as GridColumnOf).copyWith({
      rule: new DataBarRule(),
    });
    columns[1] = (columns[1] as GridColumnOf).copyWith({
      rule: new ValueToneRule({ Compute: CellTone.severe }),
    });
    return new GridController<Product>({
      columns,
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
    });
  }
  type GridColumnOf = (ReturnType<typeof productColumns>)[number];

  it('covers the matched rows with its stats', () => {
    const grid = gridWithRules();
    expect(grid.statsFor('price').min).toBe(25);
    expect(grid.statsFor('price').max).toBe(1450);
  });

  it('follows the filter, so bars rescale to what is shown', () => {
    const grid = gridWithRules();
    grid.setSearch('Input');
    expect(grid.statsFor('price').max).toBe(80);
    grid.setSearch('');
    expect(grid.statsFor('price').max).toBe(1450);
  });

  it('follows a mutation', () => {
    const grid = gridWithRules();
    expect(grid.statsFor('price').max).toBe(1450);
    (grid.dataSource as InMemoryDataSource<Product>).add(
      new Product({ id: 9, name: 'Rack', category: 'Compute', price: 9000 }),
    );
    expect(grid.statsFor('price').max).toBe(9000);
  });

  it('applies the column rule', () => {
    const grid = gridWithRules();
    // Measured from the column minimum, so the cheapest row has no bar at all
    // and the dearest fills it.
    expect(grid.decorationFor('price', grid.dataAt(1) as Product).bar).toBe(0);
    expect(grid.decorationFor('price', grid.dataAt(3) as Product).bar).toBe(1);
    expect(
      grid.decorationFor('price', grid.dataAt(4) as Product).bar,
    ).toBeCloseTo((180 - 25) / (1450 - 25), 4);
  });

  it('leaves a column without a rule undecorated, not null', () => {
    const grid = gridWithRules();
    const decoration = grid.decorationFor('name', grid.dataAt(0) as Product);
    expect(decoration.equals(CellDecoration.none)).toBe(true);
    expect(decoration.isEmpty).toBe(true);
  });

  it('reads discrete values with a tone rule', () => {
    const grid = gridWithRules();
    expect(
      grid.decorationFor('category', grid.dataAt(3) as Product).tone,
    ).toBe(CellTone.severe);
    expect(
      grid.decorationFor('category', grid.dataAt(0) as Product).tone,
    ).toBe(CellTone.neutral);
  });

  it('decorates nothing for an unknown field rather than throwing', () => {
    const grid = gridWithRules();
    expect(
      grid
        .decorationFor('nope', grid.dataAt(0) as Product)
        .equals(CellDecoration.none),
    ).toBe(true);
  });
});
