import { describe, expect, it } from 'vitest';
import {
  Aggregation,
  AsyncDataSource,
  ColumnFit,
  ColumnPin,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  GRID_SCHEMA_VERSION,
  GridController,
  GridFormatError,
  GridQuery,
  GridResult,
  GridViewState,
  groupPathSegment,
  GroupSpec,
  isGroupRow,
  requireSupportedSchema,
  type CellValue,
  type JsonMap,
} from '../src/index';
import { labelsOf, Product, productColumns, productGrid, sampleProducts } from './fixtures';

/** Round-trips a view through text, the way an app's storage would. */
function throughJson(state: GridViewState): GridViewState {
  return GridViewState.fromJSON(
    JSON.parse(JSON.stringify(state.toJSON())) as JsonMap,
  );
}

const dear = (value: CellValue): CellValue =>
  (value as number) > 100 ? 'dear' : 'cheap';
const dearLabel = (key: CellValue): string => String(key);

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('a saved view', () => {
  it('remembers everything the user arranged', () => {
    const grid = productGrid();
    grid.toggleSort('price');
    grid.setSearch('o');
    grid.setColumnFilter(
      'category',
      new FilterCondition({
        field: 'category',
        operator: FilterOperator.equals,
        value: 'Input',
      }),
    );
    grid.resizeColumn('name', 260);
    grid.moveColumn('name', 3);
    grid.setColumnVisible('active', false);
    grid.setColumnPin('price', ColumnPin.start);
    grid.setPageSize(1);
    grid.goToPage(1);
    grid.columnFit = ColumnFit.stretch;
    grid.frozenRowCount = 1;

    const restoredInto = productGrid();
    restoredInto.restoreState(throughJson(grid.saveState()));

    expect(restoredInto.sorts.map((s) => s.fingerprint)).toEqual(
      grid.sorts.map((s) => s.fingerprint),
    );
    expect(restoredInto.search).toBe('o');
    expect([...restoredInto.columnFilters.keys()]).toEqual(['category']);
    expect(restoredInto.widthOf('name')).toBe(260);
    expect(restoredInto.columns.map((c) => c.field)).toEqual([
      'category',
      'price',
      'stock',
      'name',
      'active',
    ]);
    expect(restoredInto.column('active')?.visible).toBe(false);
    expect(restoredInto.column('price')?.pin).toBe(ColumnPin.start);
    expect(restoredInto.pageSize).toBe(1);
    expect(restoredInto.pageIndex).toBe(1);
    expect(restoredInto.columnFit).toBe(ColumnFit.stretch);
    expect(restoredInto.frozenRowCount).toBe(1);
    expect(labelsOf(restoredInto)).toEqual(labelsOf(grid));
  });

  it('does not record a width the user never dragged', () => {
    const state = productGrid().saveState();
    expect(state.columns.every((c) => c.width === null)).toBe(true);
    expect('columns' in state.toJSON()).toBe(true);
  });

  it('remembers which groups were closed, not which existed', () => {
    const grid = productGrid({ groups: [new GroupSpec('category')] });
    const path = groupPathSegment('category', 'Input');
    grid.toggleGroup(path);
    const state = throughJson(grid.saveState());
    expect(state.collapsedGroupPaths).toEqual([path]);

    const restored = productGrid();
    restored.restoreState(state);
    const input = restored.visibleRows
      .toArray()
      .filter(isGroupRow)
      .find((r) => r.label === 'Input');
    expect(input?.expanded).toBe(false);
  });

  it('restores a grouping with a keyOf through resolveGroup', () => {
    const grid = productGrid({
      groups: [new GroupSpec('price', { keyOf: dear, labelOf: dearLabel })],
    });
    const state = throughJson(grid.saveState());
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]?.field).toBe('price');
    expect(state.groups[0]?.keyOf, 'a function cannot be serialised').toBeNull();

    const restored = productGrid();
    restored.restoreState(state, {
      resolveGroup: (g) =>
        g.field === 'price'
          ? g.restore({ keyOf: dear, labelOf: dearLabel })
          : g,
    });
    expect(
      restored.visibleRows
        .toArray()
        .filter(isGroupRow)
        .map((r) => r.label),
    ).toEqual(['cheap', 'dear']);
  });

  it('queries once, however much it changes', async () => {
    let fetches = 0;
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(async () => {
        fetches++;
        return new GridResult<Product>({
          rows: sampleProducts(),
          totalCount: 6,
        });
      }),
    });
    await tick();
    fetches = 0;

    const source = productGrid();
    source.toggleSort('price');
    source.setSearch('o');
    source.setPageSize(2);
    grid.restoreState(source.saveState());
    await tick();
    expect(fetches).toBe(1);
  });
});

describe('restoring onto a grid whose columns have changed', () => {
  it('ignores a column the grid no longer has', () => {
    const state = GridViewState.fromJSON({
      columns: [{ field: 'gone' }, { field: 'price', width: 200 }],
    });
    const grid = productGrid();
    grid.restoreState(state);
    expect(grid.column('gone')).toBeNull();
    expect(grid.widthOf('price')).toBe(200);
    expect(grid.columns).toHaveLength(5);
  });

  it('puts a column the view never saw after the ones it did', () => {
    const old = productGrid();
    old.setColumns(old.columns.filter((c) => c.field !== 'active'));
    const grid = productGrid();
    grid.restoreState(old.saveState());
    expect(grid.columns[grid.columns.length - 1]?.field).toBe('active');
  });
});

describe('schema versioning', () => {
  it('says which format a saved view and a query are in', () => {
    expect(productGrid().saveState().toJSON()['v']).toBe(GRID_SCHEMA_VERSION);
    expect(productGrid().query.toJSON()['v']).toBe(GRID_SCHEMA_VERSION);
  });

  it('reads a document written before versioning as version 1', () => {
    // No 'v' key at all, which is every view saved by an earlier build.
    const state = GridViewState.fromJSON({
      search: 'mouse',
      columns: [{ field: 'price', width: 200 }],
    });
    expect(state.search).toBe('mouse');
    const query = GridQuery.fromJSON({ search: 'mouse' });
    expect(query.search).toBe('mouse');
  });

  it('refuses a document from a newer build rather than misreading it', () => {
    expect(() => GridViewState.fromJSON({ v: 99, search: 'x' })).toThrow(
      /newer version/,
    );
    expect(() => GridViewState.fromJSON({ v: 99 })).toThrow(/v99/);
    expect(() => GridQuery.fromJSON({ v: 2 })).toThrow(GridFormatError);
  });

  it('treats a malformed version as an error rather than a guess', () => {
    expect(() => GridViewState.fromJSON({ v: 'yesterday' })).toThrow(
      GridFormatError,
    );
  });

  it('accepts a version equal to this build', () => {
    expect(
      requireSupportedSchema({ v: GRID_SCHEMA_VERSION }, 'This thing'),
    ).toBe(GRID_SCHEMA_VERSION);
  });
});

describe('GridQuery.fromJSON', () => {
  it('round-trips the ordering, filter, search and paging', () => {
    const grid = productGrid({ pageSize: 2 });
    grid.toggleSort('price');
    grid.setSearch('o');
    grid.goToPage(1);
    const json = grid.query.toJSON();
    const query = GridQuery.fromJSON(json);

    expect(query.sorts.map((s) => s.fingerprint)).toEqual(
      grid.query.sorts.map((s) => s.fingerprint),
    );
    expect(query.search).toBe('o');
    expect(query.offset).toBe(2);
    expect(query.limit).toBe(2);
    expect(query.searchFields).toEqual(grid.query.searchFields);
  });

  it('takes aggregations back as code, since they carry functions', () => {
    const query = GridQuery.fromJSON(
      new GridQuery({ groups: [new GroupSpec('category')] }).toJSON(),
      { aggregations: [Aggregation.sum('price')] },
    );
    expect(query.groups).toHaveLength(1);
    expect(query.groups[0]?.field).toBe('category');
    expect(query.aggregations).toHaveLength(1);
    expect(query.aggregations[0]?.field).toBe('price');
  });

  it('reads an empty object as an empty query, not an error', () => {
    const query = GridQuery.fromJSON({});
    expect(query.sorts).toEqual([]);
    expect(query.filter).toBeNull();
    expect(query.limit).toBeNull();
  });

  it('survives a filter tree through the round trip', () => {
    const filter = FilterGroup.or([
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.startsWith,
        value: 'M',
      }),
      new FilterCondition({
        field: 'price',
        operator: FilterOperator.greaterThan,
        value: 100,
      }),
    ]);
    const query = GridQuery.fromJSON(new GridQuery({ filter }).toJSON());
    expect(query.filter?.fingerprint).toBe(filter.fingerprint);
  });
});
