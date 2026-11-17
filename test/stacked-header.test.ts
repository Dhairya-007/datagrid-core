// The pipeline stages this exercises are the engine's inner layer.
import { describe, expect, it } from 'vitest';
import {
  ColumnPin,
  computeLayout,
  describeHeaderProblems,
  GridColumn,
  GridController,
  GridStateError,
  HeaderBand,
  HeaderBandLayout,
  HeaderRow,
  InMemoryDataSource,
  layoutHeaderRow,
} from '../src/advanced';
import { Product, sampleProducts } from './fixtures';

function cols(
  options: { namePin?: ColumnPin; hideCategory?: boolean } = {},
): GridColumn<Product>[] {
  return [
    new GridColumn<Product>({
      field: 'name',
      value: (p) => p.name,
      width: 100,
      pin: options.namePin ?? ColumnPin.none,
    }),
    new GridColumn<Product>({
      field: 'category',
      value: (p) => p.category,
      width: 100,
      visible: options.hideCategory !== true,
    }),
    new GridColumn<Product>({
      field: 'price',
      value: (p) => p.price,
      width: 100,
    }),
    new GridColumn<Product>({
      field: 'stock',
      value: (p) => p.stock,
      width: 100,
    }),
  ];
}

const identity = new HeaderRow([
  new HeaderBand({ title: 'Identity', fields: ['name', 'category'] }),
  new HeaderBand({ title: 'Numbers', fields: ['price', 'stock'] }),
]);

function layoutOf(
  row: HeaderRow,
  options: { columns?: GridColumn<Product>[]; viewport?: number } = {},
): HeaderBandLayout<Product>[] {
  const layout = computeLayout<Product>(options.columns ?? cols(), {
    viewportWidth: options.viewport ?? 1000,
  });
  return layoutHeaderRow<Product>(layout.scrolling, row);
}

describe('spans', () => {
  it('covers the width of the columns a band names', () => {
    const segments = layoutOf(identity);
    expect(segments.map((s) => s.band?.title)).toEqual([
      'Identity',
      'Numbers',
    ]);
    expect(segments[0]?.offset).toBe(0);
    expect(segments[0]?.width).toBe(200);
    expect(segments[segments.length - 1]?.offset).toBe(200);
    expect(segments[segments.length - 1]?.width).toBe(200);
  });

  it('knows which columns a band ended up over', () => {
    const segments = layoutOf(identity);
    expect(segments[0]?.columns.map((c) => c.column.field)).toEqual([
      'name',
      'category',
    ]);
  });

  it('turns columns no band covers into a gap, not a crash', () => {
    const row = new HeaderRow([
      new HeaderBand({ title: 'Numbers', fields: ['price', 'stock'] }),
    ]);
    const segments = layoutOf(row);
    expect(segments[0]?.isGap).toBe(true);
    expect(segments[0]?.width).toBe(200);
    expect(segments[segments.length - 1]?.band?.title).toBe('Numbers');
  });

  it('makes a single-column band as wide as that column', () => {
    const row = new HeaderRow([
      new HeaderBand({ title: 'Just price', fields: ['price'] }),
    ]);
    const priced = layoutOf(row).find((s) => !s.isGap);
    expect(priced?.width).toBe(100);
    expect(priced?.offset).toBe(200);
  });

  it('produces nothing for an empty pane', () => {
    expect(layoutHeaderRow<Product>([], identity)).toEqual([]);
  });
});

describe('the awkward cases', () => {
  it('shrinks the band over a hidden column', () => {
    const segments = layoutOf(identity, {
      columns: cols({ hideCategory: true }),
    });
    expect(segments[0]?.band?.title).toBe('Identity');
    expect(segments[0]?.width).toBe(100);
    expect(segments[segments.length - 1]?.offset).toBe(100);
  });

  it('draws a band split by a frozen pane in both panes', () => {
    const layout = computeLayout<Product>(cols({ namePin: ColumnPin.start }), {
      viewportWidth: 1000,
    });
    const leading = layoutHeaderRow<Product>(layout.leading, identity);
    const scrolling = layoutHeaderRow<Product>(layout.scrolling, identity);

    expect(leading).toHaveLength(1);
    expect(leading[0]?.band?.title).toBe('Identity');
    expect(leading[0]?.width).toBe(100);
    expect(scrolling[0]?.band?.title).toBe('Identity');
    expect(scrolling[0]?.width).toBe(100);
  });

  it('titles a split band in the first pane only, given a shared drawn set', () => {
    const layout = computeLayout<Product>(cols({ namePin: ColumnPin.start }), {
      viewportWidth: 1000,
    });
    const drawn = new Set<HeaderBand>();
    const leading = layoutHeaderRow<Product>(layout.leading, identity, {
      drawn,
    });
    const scrolling = layoutHeaderRow<Product>(layout.scrolling, identity, {
      drawn,
    });
    expect(leading[0]?.isContinuation).toBe(false);
    expect(scrolling[0]?.isContinuation).toBe(true);
  });

  it('turns an interrupted band into two segments, titled once', () => {
    // The user has dragged 'price' into the middle of the Identity band.
    const base = cols();
    const reordered = [
      base[0] as GridColumn<Product>,
      base[2] as GridColumn<Product>,
      base[1] as GridColumn<Product>,
      base[3] as GridColumn<Product>,
    ];
    const segments = layoutOf(identity, { columns: reordered });

    const identitySegments = segments.filter(
      (s) => s.band?.title === 'Identity',
    );
    expect(identitySegments).toHaveLength(2);
    expect(identitySegments[0]?.isContinuation).toBe(false);
    expect(identitySegments[1]?.isContinuation).toBe(true);
  });

  it('gives a column two bands both claim to the first', () => {
    const overlapping = new HeaderRow([
      new HeaderBand({ title: 'First', fields: ['name', 'category'] }),
      new HeaderBand({ title: 'Second', fields: ['category', 'price'] }),
    ]);
    const segments = layoutOf(overlapping);
    expect(segments[0]?.band?.title).toBe('First');
    expect(segments[0]?.width, 'First keeps category').toBe(200);
    expect(segments[1]?.band?.title).toBe('Second');
    expect(segments[1]?.width, 'Second is left with price').toBe(100);
  });

  it('simply covers nothing for an unknown field', () => {
    const row = new HeaderRow([
      new HeaderBand({ title: 'Ghost', fields: ['nope', 'price'] }),
    ]);
    const covered = layoutOf(row).find((s) => !s.isGap);
    expect(covered?.width).toBe(100);
    expect(covered?.columns).toHaveLength(1);
    expect(covered?.columns[0]?.column.field).toBe('price');
  });

  it('tiles the pane exactly, with no gaps or overlaps', () => {
    const segments = layoutOf(
      new HeaderRow([
        new HeaderBand({ title: 'Ends', fields: ['name', 'stock'] }),
      ]),
    );
    let cursor = 0;
    for (const segment of segments) {
      expect(segment.offset).toBe(cursor);
      cursor = segment.end;
    }
    expect(cursor).toBe(400);
  });
});

describe('validation', () => {
  it('reports an unknown column', () => {
    const problems = describeHeaderProblems<Product>(
      [new HeaderRow([new HeaderBand({ title: 'Oops', fields: ['nope'] })])],
      cols(),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unknown column "nope"');
  });

  it('reports a column two bands both cover', () => {
    const problems = describeHeaderProblems<Product>(
      [
        new HeaderRow([
          new HeaderBand({ title: 'A', fields: ['name'] }),
          new HeaderBand({ title: 'B', fields: ['name'] }),
        ]),
      ],
      cols(),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('covered by both "A" and "B"');
  });

  it('reports a band that spans nothing', () => {
    const problems = describeHeaderProblems<Product>(
      [new HeaderRow([new HeaderBand({ title: 'Empty', fields: [] })])],
      cols(),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('spans no columns');
  });

  it('says nothing about a correct header', () => {
    expect(describeHeaderProblems<Product>([identity], cols())).toEqual([]);
  });
});

describe('through the controller', () => {
  it('round-trips rows and notifies', () => {
    const grid = new GridController<Product>({
      columns: cols(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      stackedHeaders: [identity],
    });
    expect(grid.stackedHeaders[0]?.bands).toHaveLength(2);

    let notified = 0;
    grid.addListener(() => notified++);
    grid.stackedHeaders = [
      new HeaderRow([new HeaderBand({ title: 'All', fields: ['name'] })]),
    ];
    expect(notified).toBe(1);
    expect(grid.stackedHeaders[0]?.bands[0]?.title).toBe('All');
  });

  it('hands out a snapshot, so the rows cannot be mutated from outside', () => {
    const grid = new GridController<Product>({
      columns: cols(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      stackedHeaders: [identity],
    });
    (grid.stackedHeaders as HeaderRow[]).push(new HeaderRow([]));
    expect(grid.stackedHeaders).toHaveLength(1);
  });

  it('catches a bad header rather than drawing it', () => {
    const grid = new GridController<Product>({
      columns: cols(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
    });
    expect(() => {
      grid.stackedHeaders = [
        new HeaderRow([new HeaderBand({ title: 'Oops', fields: ['nope'] })]),
      ];
    }).toThrow(GridStateError);
  });

  it('refuses a bad header at construction too', () => {
    expect(
      () =>
        new GridController<Product>({
          columns: cols(),
          dataSource: new InMemoryDataSource<Product>(sampleProducts()),
          stackedHeaders: [
            new HeaderRow([
              new HeaderBand({ title: 'Oops', fields: ['nope'] }),
            ]),
          ],
        }),
    ).toThrow(GridStateError);
  });

  it('follows a column move with its bands', () => {
    const grid = new GridController<Product>({
      columns: cols(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      stackedHeaders: [identity],
    });
    grid.moveColumn('price', 0);
    const segments = layoutHeaderRow<Product>(
      grid.layoutFor(1000).scrolling,
      grid.stackedHeaders[0] as HeaderRow,
    );
    expect(segments[0]?.band?.title).toBe('Numbers');
    expect(segments[0]?.width).toBe(100);
  });
});
