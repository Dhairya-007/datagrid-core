import { describe, expect, it } from 'vitest';
import {
  GridController,
  GroupSpec,
  InMemoryDataSource,
  isDataRow,
  isGroupRow,
  SortSpec,
  type GridRowList,
} from '../src/index';
import { Product, productColumns, sampleProducts } from './fixtures';

function grid(
  options: {
    top?: number;
    bottom?: number;
    rows?: Product[];
    sorts?: SortSpec[];
    groups?: GroupSpec[];
  } = {},
): GridController<Product> {
  return new GridController<Product>({
    columns: productColumns(),
    dataSource: new InMemoryDataSource<Product>(
      options.rows ?? sampleProducts(),
    ),
    frozenRowCount: options.top ?? 0,
    frozenRowCountBottom: options.bottom ?? 0,
    sorts: options.sorts ?? [],
    groups: options.groups ?? [],
  });
}

function namesOf(rows: GridRowList<Product>): string[] {
  return rows.map((row) => (isDataRow(row) ? row.data.name : 'GROUP'));
}

describe('splitting the rows', () => {
  it('freezes nothing by default', () => {
    const g = grid();
    expect(g.effectiveFrozenTop).toBe(0);
    expect(g.effectiveFrozenBottom).toBe(0);
    expect(g.frozenTopRows.isEmpty).toBe(true);
    expect(g.frozenBottomRows.isEmpty).toBe(true);
    expect(g.scrollableRows.length).toBe(6);
  });

  it('takes the top band off the front', () => {
    const g = grid({ top: 2 });
    expect(namesOf(g.frozenTopRows)).toEqual(['Keyboard', 'Mouse']);
    expect(namesOf(g.scrollableRows)[0]).toBe('Monitor');
    expect(g.scrollableRows.length).toBe(4);
  });

  it('takes the bottom band off the end', () => {
    const g = grid({ bottom: 2 });
    expect(namesOf(g.frozenBottomRows)).toEqual(['Dock', 'Webcam']);
    const scrolling = namesOf(g.scrollableRows);
    expect(scrolling[scrolling.length - 1]).toBe('Laptop');
  });

  it('leaves the middle scrolling with both bands at once', () => {
    const g = grid({ top: 1, bottom: 1 });
    expect(namesOf(g.frozenTopRows)).toEqual(['Keyboard']);
    expect(namesOf(g.frozenBottomRows)).toEqual(['Webcam']);
    expect(namesOf(g.scrollableRows)).toEqual([
      'Mouse',
      'Monitor',
      'Laptop',
      'Dock',
    ]);
  });

  it('always reconstructs the visible rows from the three bands', () => {
    for (const [top, bottom] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [2, 2],
      [5, 5],
    ] as const) {
      const g = grid({ top, bottom });
      expect(
        g.frozenTopRows.length +
          g.scrollableRows.length +
          g.frozenBottomRows.length,
        `with top ${top} and bottom ${bottom}`,
      ).toBe(g.rowCount);
    }
  });
});

describe('refusing to freeze everything', () => {
  it('leaves one row scrolling when more rows are frozen than exist', () => {
    const g = grid({ top: 99 });
    expect(g.effectiveFrozenTop).toBe(5);
    expect(g.scrollableRows.length).toBe(1);
  });

  it('gives the top band priority when the two would overlap', () => {
    const g = grid({ top: 4, bottom: 4 });
    expect(g.effectiveFrozenTop).toBe(4);
    expect(g.effectiveFrozenBottom).toBe(1);
    expect(g.scrollableRows.length).toBe(1);
  });

  it('freezes nothing in an empty grid', () => {
    const g = grid({ top: 3, bottom: 3, rows: [] });
    expect(g.effectiveFrozenTop).toBe(0);
    expect(g.effectiveFrozenBottom).toBe(0);
    expect(g.scrollableRows.isEmpty).toBe(true);
  });

  it('never freezes a single row away entirely', () => {
    const g = grid({
      top: 1,
      rows: [new Product({ id: 1, name: 'Only', category: 'X', price: 1 })],
    });
    expect(g.effectiveFrozenTop).toBe(0);
    expect(namesOf(g.scrollableRows)).toEqual(['Only']);
  });

  it('treats a negative count as none', () => {
    const g = grid();
    g.frozenRowCount = -5;
    expect(g.frozenRowCount).toBe(0);
    expect(g.effectiveFrozenTop).toBe(0);
  });
});

describe('freezing by position, not identity', () => {
  it('changes which rows are pinned when sorting', () => {
    const g = grid({ top: 1 });
    expect(namesOf(g.frozenTopRows)).toEqual(['Keyboard']);
    g.setSorts([new SortSpec('price')]);
    expect(namesOf(g.frozenTopRows)).toEqual(['Mouse']);
  });

  it('re-picks the pinned rows when filtering', () => {
    const g = grid({ top: 1 });
    g.setSearch('Compute');
    expect(namesOf(g.frozenTopRows)).toEqual(['Laptop']);
  });

  it('pins the first row of the current page', () => {
    const g = grid({ top: 1 });
    g.setPageSize(2);
    expect(namesOf(g.frozenTopRows)).toEqual(['Keyboard']);
    g.nextPage();
    expect(namesOf(g.frozenTopRows)).toEqual(['Monitor']);
  });

  it('can pin a group header', () => {
    const g = grid({ top: 1, groups: [new GroupSpec('category')] });
    expect(g.frozenTopRows.length).toBe(1);
    expect(isGroupRow(g.frozenTopRows.at(0))).toBe(true);
  });
});

describe('isRowFrozen', () => {
  it('identifies both bands and the middle', () => {
    const g = grid({ top: 2, bottom: 1 });
    expect(g.isRowFrozen(0)).toBe(true);
    expect(g.isRowFrozen(1)).toBe(true);
    expect(g.isRowFrozen(2)).toBe(false);
    expect(g.isRowFrozen(4)).toBe(false);
    expect(g.isRowFrozen(5)).toBe(true);
  });

  it('freezes nothing when nothing is pinned', () => {
    const g = grid();
    for (let i = 0; i < g.rowCount; i++) {
      expect(g.isRowFrozen(i)).toBe(false);
    }
  });
});

describe('notification', () => {
  it('notifies once when a count changes', () => {
    const g = grid();
    let notified = 0;
    g.addListener(() => notified++);
    g.frozenRowCount = 2;
    expect(notified).toBe(1);
    expect(g.effectiveFrozenTop).toBe(2);
  });

  it('does not notify when the same count is set', () => {
    const g = grid({ top: 2 });
    let notified = 0;
    g.addListener(() => notified++);
    g.frozenRowCount = 2;
    expect(notified).toBe(0);
  });
});
