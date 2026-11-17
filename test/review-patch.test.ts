// An edit patches the memoised pipeline instead of throwing it away.
//
// The patch is only worth having if it is indistinguishable from a full
// recompute, so that is what these tests check: the same rows, in the same
// order, as a source that has never cached anything would produce. A wrong
// answer here is a wrong grid, so the comparison is differential and
// randomised rather than a handful of cases somebody thought of.
import { describe, expect, it } from 'vitest';
import {
  AggregateType,
  Aggregation,
  CellAddress,
  ColumnType,
  FilterCondition,
  FilterOperator,
  GridColumn,
  GridController,
  GridQuery,
  GroupSpec,
  InMemoryDataSource,
  isDataRow,
  NullsPosition,
  RowUpdate,
  SortDirection,
  SortSpec,
} from '../src/index';

class Row {
  constructor(
    readonly id: number,
    public name: string,
    public score: number | null,
    public tag: string,
  ) {}

  toString(): string {
    return `Row(${this.id}, ${this.name}, ${String(this.score)}, ${this.tag})`;
  }
}

function columns(): GridColumn<Row>[] {
  return [
    new GridColumn<Row>({
      field: 'id',
      type: ColumnType.number,
      value: (r) => r.id,
    }),
    new GridColumn<Row>({ field: 'name', value: (r) => r.name }),
    new GridColumn<Row>({
      field: 'score',
      type: ColumnType.number,
      value: (r) => r.score,
    }),
    new GridColumn<Row>({ field: 'tag', value: (r) => r.tag }),
  ];
}

function columnMap(): Map<string, GridColumn<Row>> {
  return new Map(columns().map((c) => [c.field, c]));
}

const names = ['ada', 'Bo', 'cy', 'Di', 'eve', 'fay'];
const tags = ['red', 'green', 'blue'];

/**
 * A seeded generator, so a failure can be reproduced. Dart's `Random(seed)`
 * has no equivalent in the standard library; mulberry32 is small, fast and
 * deterministic, which is all this needs.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intIn(random: () => number, bound: number): number {
  return Math.floor(random() * bound);
}

function seedRows(count: number, random: () => number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      new Row(
        i,
        names[intIn(random, names.length)] as string,
        intIn(random, 5) === 0 ? null : intIn(random, 20),
        tags[intIn(random, tags.length)] as string,
      ),
    );
  }
  return out;
}

/**
 * The queries worth checking: each one exercises a different combination of
 * the stages the patch has to keep consistent.
 */
function queries(): GridQuery[] {
  return [
    new GridQuery(),
    new GridQuery({ sorts: [new SortSpec('score')] }),
    new GridQuery({ sorts: [new SortSpec('name'), new SortSpec('score')] }),
    new GridQuery({
      sorts: [new SortSpec('score', { direction: SortDirection.descending })],
    }),
    new GridQuery({
      sorts: [new SortSpec('score', { nulls: NullsPosition.first })],
    }),
    new GridQuery({ search: 'e' }),
    new GridQuery({ search: 'e', sorts: [new SortSpec('name')] }),
    new GridQuery({
      filter: new FilterCondition({
        field: 'tag',
        operator: FilterOperator.equals,
        value: 'red',
      }),
    }),
    new GridQuery({
      filter: new FilterCondition({
        field: 'score',
        operator: FilterOperator.greaterThan,
        value: 8,
      }),
      sorts: [new SortSpec('score')],
    }),
    new GridQuery({
      filter: new FilterCondition({
        field: 'score',
        operator: FilterOperator.greaterThan,
        value: 8,
      }),
      search: 'a',
      sorts: [new SortSpec('name'), new SortSpec('id')],
    }),
    new GridQuery({ sorts: [new SortSpec('name')], offset: 2, limit: 5 }),
  ];
}

/** A source that has cached nothing. */
function fresh(rows: readonly Row[]): InMemoryDataSource<Row> {
  const source = new InMemoryDataSource<Row>(rows);
  source.columns = columnMap();
  return source;
}

describe('a batch write', () => {
  it('gives the same rows as a source that cached nothing', async () => {
    const random = seeded(99);
    const source = fresh(seedRows(50, random));
    const query = new GridQuery({
      sorts: [new SortSpec('score'), new SortSpec('id')],
      search: 'a',
    });
    source.fetchSync(query);

    for (let batch = 0; batch < 20; batch++) {
      // Distinct rows: a batch that names one row twice is a caller error,
      // and the source says so rather than writing twice.
      const picked = new Set<number>();
      while (picked.size < 5) picked.add(intIn(random, source.length));
      const rows = source.rows;
      const writes: RowUpdate<Row>[] = [];
      for (const at of picked) {
        const old = rows[at] as Row;
        writes.push(
          new RowUpdate<Row>(
            old,
            new Row(
              old.id,
              names[intIn(random, names.length)] as string,
              intIn(random, 20),
              old.tag,
            ),
          ),
        );
      }
      await source.commitAll(writes);
      const patched = source.fetchSync(query);
      expect(
        patched.rows.map((row) => row.id),
        `after batch ${batch}`,
      ).toEqual(
        fresh(source.rows)
          .fetchSync(query)
          .rows.map((row) => row.id),
      );
    }
  });
});

describe('an edit patched into a cached pipeline', () => {
  it('gives the same rows as a source that cached nothing', () => {
    const random = seeded(20261116);
    for (const query of queries()) {
      const source = fresh(seedRows(60, random));
      // Warm every stage, which is the state a patch has to maintain.
      source.fetchSync(query);

      for (let edit = 0; edit < 120; edit++) {
        const at = intIn(random, source.length);
        const old = source.rows[at] as Row;
        source.replaceAt(
          at,
          new Row(
            old.id,
            names[intIn(random, names.length)] as string,
            intIn(random, 5) === 0 ? null : intIn(random, 20),
            tags[intIn(random, tags.length)] as string,
          ),
        );

        const patched = source.fetchSync(query);
        const control = fresh(source.rows).fetchSync(query);
        const where = `after edit ${edit} under ${String(query)}`;
        expect(
          patched.rows.map((row) => row.id),
          where,
        ).toEqual(control.rows.map((row) => row.id));
        for (let i = 0; i < control.rows.length; i++) {
          expect(patched.rows[i], `the same instances, ${where}`).toBe(
            control.rows[i],
          );
        }
        expect(patched.matchedCount, `the count, ${where}`).toBe(
          control.matchedCount,
        );
      }
    }
  });

  it('keeps the aggregates and the stats in step', () => {
    const random = seeded(7);
    const source = fresh(seedRows(40, random));
    const query = new GridQuery({
      sorts: [new SortSpec('score')],
      aggregations: [new Aggregation('score', { type: AggregateType.sum })],
    });
    source.fetchSync(query);

    for (let edit = 0; edit < 40; edit++) {
      const at = intIn(random, source.length);
      const old = source.rows[at] as Row;
      source.replaceAt(
        at,
        new Row(old.id, old.name, intIn(random, 50), old.tag),
      );
      const patched = source.fetchSync(query);
      const control = fresh(source.rows);
      expect(patched.aggregates.asObject).toEqual(
        control.fetchSync(query).aggregates.asObject,
      );
      expect(source.statsFor('score').max).toBe(control.statsFor('score').max);
    }
  });

  it('still recomputes a grouped query, and stays right', () => {
    const random = seeded(11);
    const source = fresh(seedRows(30, random));
    const query = new GridQuery({ groups: [new GroupSpec('tag')] });
    source.fetchSync(query);

    for (let edit = 0; edit < 30; edit++) {
      const at = intIn(random, source.length);
      const old = source.rows[at] as Row;
      source.replaceAt(
        at,
        new Row(
          old.id,
          old.name,
          old.score,
          tags[intIn(random, tags.length)] as string,
        ),
      );
      const patched = source.fetchSync(query);
      const control = fresh(source.rows).fetchSync(query);
      expect(
        patched.groups.map((g) => `${g.label}:${g.rowCount}`),
        `after edit ${edit}`,
      ).toEqual(control.groups.map((g) => `${g.label}:${g.rowCount}`));
    }
  });

  it('moves the row an edit through the grid changed', () => {
    const rows = [
      new Row(1, 'ada', 1, 'red'),
      new Row(2, 'bo', 2, 'red'),
      new Row(3, 'cy', 3, 'red'),
    ];
    const source = new InMemoryDataSource<Row>(rows);
    const grid = new GridController<Row>({
      columns: [
        ...columns(),
        new GridColumn<Row>({
          field: 'editable',
          type: ColumnType.number,
          value: (r) => r.score,
          setValue: (r, v) => {
            r.score = v as number | null;
            return null;
          },
        }),
      ],
      dataSource: source,
      sorts: [new SortSpec('score')],
      rowKey: (r) => r.id,
    });
    const ids = (): number[] =>
      grid.visibleRows
        .toArray()
        .filter(isDataRow)
        .map((r) => r.data.id);
    expect(ids()).toEqual([1, 2, 3]);

    grid.beginEdit(new CellAddress(0, 'editable'));
    grid.updateEdit(99);
    grid.commitEdit();

    expect(ids()).toEqual([2, 3, 1]);
    grid.dispose();
  });
});
