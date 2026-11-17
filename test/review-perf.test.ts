// The behaviour behind the performance fixes in the 0.4.0 review.
//
// Timings belong in bench/; these assert the shapes that made the timings
// what they were — a select-all that builds no set, a row band that is a view
// rather than a copy, a group toggle that touches no row.
import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  flattenGroups,
  GridColumn,
  GridController,
  GroupExpansionState,
  GroupedRowList,
  GroupNode,
  GroupSpec,
  InMemoryDataSource,
  isDataRow,
  isGroupRow,
  RowSlice,
  SelectionCoverage,
  SelectionState,
  togglingModifier,
  type CellValue,
} from '../src/advanced';
import { Product, productColumns, sampleProducts } from './fixtures';

type Row = Record<string, CellValue>;

describe('select-all', () => {
  it('is a flag, not a set of every index', () => {
    const selection = new SelectionState();
    selection.selectAll(1_000_000);
    expect(selection.isEverythingSelected).toBe(true);
    expect(selection.rowCount).toBe(1_000_000);
    expect(selection.isRowSelected(999_999)).toBe(true);
    expect(selection.isRowSelected(1_000_000)).toBe(false);
    // Nothing to follow across a rebuild.
    expect([...selection.followedRows]).toEqual([]);
    expect(selection.coverageOf(1_000_000)).toBe(SelectionCoverage.all);
  });

  it('leaves the rest selected when one row is deselected', () => {
    const selection = new SelectionState();
    selection.selectAll(100);
    selection.selectRow(7, togglingModifier);
    expect(selection.isRowSelected(7)).toBe(false);
    expect(selection.isRowSelected(8)).toBe(true);
    expect(selection.rowCount).toBe(99);
    expect(selection.coverageOf(100)).toBe(SelectionCoverage.some);
    expect(selection.selectedRows).toHaveLength(99);
    expect([...selection.followedRows]).toEqual([7]);
  });

  it('survives a re-sort with everything selected', () => {
    const selection = new SelectionState();
    selection.selectAll(5);
    // Reverse the order.
    selection.remapRows((i) => 4 - i, 5);
    expect(selection.rowCount).toBe(5);
    expect(selection.isEverythingSelected).toBe(true);
  });

  it('follows a hole to its row across a re-sort', () => {
    const selection = new SelectionState();
    selection.selectAll(5);
    selection.selectRow(0, togglingModifier);
    selection.remapRows((i) => 4 - i, 5);
    expect(selection.isRowSelected(4)).toBe(false);
    expect(selection.isRowSelected(0)).toBe(true);
    expect(selection.rowCount).toBe(4);
  });

  it('clamps when the grid shrinks under it', () => {
    const selection = new SelectionState();
    selection.selectAll(100);
    selection.clampTo(3);
    expect(selection.rowCount).toBe(3);
    expect(selection.selectedRows).toEqual([0, 1, 2]);
  });

  it('caches the selected list between reads', () => {
    const selection = new SelectionState();
    selection.selectAll(10);
    const first = selection.selectedRows;
    expect(selection.selectedRows).toBe(first);
    selection.selectRow(1, togglingModifier);
    expect(selection.selectedRows).not.toBe(first);
  });
});

describe('the frozen bands', () => {
  it('are views onto the visible rows, not copies of them', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      frozenRowCount: 1,
      frozenRowCountBottom: 1,
    });
    expect(grid.scrollableRows).toBeInstanceOf(RowSlice);
    expect(grid.scrollableRows.length).toBe(grid.rowCount - 2);
    const first = grid.scrollableRows.at(0);
    expect(
      isDataRow(first) && first.index,
      'indices stay positions in the full list',
    ).toBe(1);
    expect(grid.frozenTopRows.length).toBe(1);
    expect(grid.frozenBottomRows.length).toBe(1);
    expect(() => grid.scrollableRows.at(99)).toThrow(RangeError);
    grid.dispose();
  });
});

describe('the column map', () => {
  it('is cached, and dropped when the columns change', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
    });
    const first = grid.columnsByField;
    expect(grid.columnsByField).toBe(first);
    grid.setColumnVisible('price', false);
    expect(grid.columnsByField).not.toBe(first);
    expect(grid.column('price')?.visible).toBe(false);
    grid.dispose();
  });
});

/** The lazy grouped row list, which is what makes a group toggle O(groups). */
describe('GroupedRowList', () => {
  const columns = new Map([
    ['cat', new GridColumn<Row>({ field: 'cat' })],
    ['sub', new GridColumn<Row>({ field: 'sub' })],
  ]);

  const rows = (): Row[] => {
    const out: Row[] = [];
    for (let i = 0; i < 20; i++) {
      out.push({ cat: `c${i % 2}`, sub: `s${i % 4}`, id: i });
    }
    return out;
  };

  it('reads the same rows the eager flattening produces', () => {
    for (const specs of [
      [new GroupSpec('cat')],
      [new GroupSpec('cat'), new GroupSpec('sub')],
    ]) {
      const nodes = buildGroups(rows(), specs, columns);
      for (const collapsed of [false, true]) {
        const expansion = new GroupExpansionState();
        if (collapsed) {
          expansion.setExpanded(nodes[0]?.path as string, false);
        }
        const eager = flattenGroups(nodes, expansion);
        const lazy = new GroupedRowList(nodes, expansion);
        expect(lazy.length).toBe(eager.length);
        for (let i = 0; i < eager.length; i++) {
          const a = eager[i];
          const b = lazy.at(i);
          expect(b.index).toBe(a?.index);
          expect(b.depth).toBe(a?.depth);
          expect(b.kind).toBe(a?.kind);
          if (a !== undefined && isGroupRow(a)) {
            expect(isGroupRow(b) && b.path).toBe(a.path);
            expect(isGroupRow(b) && b.expanded).toBe(a.expanded);
          } else if (a !== undefined && isDataRow(a)) {
            expect(isDataRow(b) && b.data['id']).toBe(a.data['id']);
          }
        }
      }
    }
  });

  it('shows a header alone while its contents are in flight', () => {
    const node = new GroupNode<Row>({
      field: 'cat',
      key: 'c0',
      label: 'c0',
      depth: 0,
      path: 'cat=s:c0',
      declaredCount: 9,
      loaded: false,
    });
    const list = new GroupedRowList([node], new GroupExpansionState(), {
      loadingPaths: new Set([node.path]),
    });
    expect(list.length).toBe(1);
    const header = list.at(0);
    expect(isGroupRow(header) && header.loading).toBe(true);
  });

  it('refuses a read past its end', () => {
    const nodes = buildGroups(rows(), [new GroupSpec('cat')], columns);
    const list = new GroupedRowList(nodes, new GroupExpansionState());
    expect(() => list.at(list.length)).toThrow(RangeError);
    expect(() => list.at(-1)).toThrow(RangeError);
  });

  it('does not touch the rows it is not showing', () => {
    let reads = 0;
    const watched = new Map([
      [
        'cat',
        new GridColumn<Row>({
          field: 'cat',
          value: (r) => {
            reads++;
            return r['cat'];
          },
        }),
      ],
    ]);
    const nodes = buildGroups(rows(), [new GroupSpec('cat')], watched);
    const expansion = new GroupExpansionState();
    reads = 0;
    const list = new GroupedRowList(nodes, expansion);
    expect(list.length).toBe(22);
    expect(reads, 'building the index reads no values').toBe(0);
  });
});
