import { describe, expect, it } from 'vitest';
import {
  FilterCondition,
  FilterOperator,
  GridArgumentError,
  GridColumn,
  GridController,
  InMemoryDataSource,
  isDataRow,
  isGroupRow,
  SortDirection,
  SortSpec,
  TreeSpec,
} from '../src/index';

/**
 * A flat model with a parent reference, which is what a staff table, a file
 * table and a bill of materials all look like.
 */
class Person {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly managerId: string | null = null,
  ) {}
}

/** A nested model, which is what an API that returns a tree looks like. */
class Node {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly children: Node[] = [],
  ) {}
}

function staff(): Person[] {
  return [
    new Person('a', 'Ada'),
    new Person('b', 'Bo', 'a'),
    new Person('c', 'Cy', 'a'),
    new Person('d', 'Di', 'b'),
    new Person('e', 'Eve'),
  ];
}

function staffGrid(
  options: {
    expanded?: boolean;
    rows?: Person[];
    sorts?: SortSpec[];
  } = {},
): GridController<Person> {
  return new GridController<Person>({
    columns: [
      new GridColumn<Person>({ field: 'name', value: (p) => p.name }),
      new GridColumn<Person>({ field: 'id', value: (p) => p.id }),
    ],
    dataSource: new InMemoryDataSource<Person>(options.rows ?? staff()),
    rowKey: (p) => p.id,
    tree: new TreeSpec<Person>({ parentOf: (p) => p.managerId }),
    treeExpandedByDefault: options.expanded ?? true,
    sorts: options.sorts ?? [],
  });
}

function namesOf(grid: GridController<Person>): string[] {
  const out: string[] = [];
  for (const row of grid.visibleRows) {
    if (!isDataRow(row)) continue;
    out.push(`${'  '.repeat(row.depth)}${row.data.name}`);
  }
  return out;
}

describe('a flat model with a parent reference', () => {
  it('nests the rows under their parents', () => {
    expect(namesOf(staffGrid())).toEqual([
      'Ada',
      '  Bo',
      '    Di',
      '  Cy',
      'Eve',
    ]);
  });

  it('marks which rows are parents', () => {
    const grid = staffGrid();
    const rows = grid.visibleRows.toArray().filter(isDataRow);
    expect(rows[0]?.hasChildren).toBe(true);
    expect(rows[2]?.hasChildren).toBe(false);
    expect(rows[rows.length - 1]?.hasChildren).toBe(false);
  });

  it('hides a whole subtree when a branch is closed', () => {
    const grid = staffGrid();
    grid.toggleRow(grid.treePathFor('b'));
    expect(namesOf(grid)).toEqual(['Ada', '  Bo', '  Cy', 'Eve']);
    grid.toggleRow(grid.treePathFor('a'));
    expect(namesOf(grid)).toEqual(['Ada', 'Eve']);
  });

  it('closes branches the user never opened with collapseAllRows', () => {
    const grid = staffGrid();
    grid.collapseAllRows();
    expect(namesOf(grid)).toEqual(['Ada', 'Eve']);
    grid.expandAllRows();
    expect(namesOf(grid)).toHaveLength(5);
  });

  it('starts closed when that is the default', () => {
    expect(namesOf(staffGrid({ expanded: false }))).toEqual(['Ada', 'Eve']);
  });

  it('keeps a branch open when the rows are re-sorted', () => {
    const grid = staffGrid({ expanded: false });
    grid.setRowExpanded(grid.treePathFor('a'), true);
    expect(namesOf(grid)).toEqual(['Ada', '  Bo', '  Cy', 'Eve']);
    grid.setSorts([
      new SortSpec('name', { direction: SortDirection.descending }),
    ]);
    expect(namesOf(grid)).toEqual(['Eve', 'Ada', '  Cy', '  Bo']);
  });

  it('makes a row whose parent is filtered out a root', () => {
    const grid = staffGrid();
    grid.setColumnFilter(
      'id',
      new FilterCondition({
        field: 'id',
        operator: FilterOperator.notEquals,
        value: 'a',
      }),
    );
    expect(namesOf(grid)).toEqual(['Bo', '  Di', 'Cy', 'Eve']);
  });

  it('renders a cycle once rather than for ever', () => {
    const grid = staffGrid({
      rows: [new Person('a', 'Ada', 'b'), new Person('b', 'Bo', 'a')],
    });
    expect(namesOf(grid)).toHaveLength(2);
  });

  it('treats a parent reference to a row that does not exist as a root', () => {
    const grid = staffGrid({ rows: [new Person('x', 'Xu', 'nobody')] });
    expect(namesOf(grid)).toEqual(['Xu']);
  });

  it('keeps the selection on the row, not on the screen position', () => {
    const grid = staffGrid();
    grid.selectRow(1);
    expect(grid.selectedData).toHaveLength(1);
    expect(grid.selectedData[0]?.name).toBe('Bo');
    grid.toggleRow(grid.treePathFor('b'));
    expect(grid.selectedData[0]?.name).toBe('Bo');
  });

  it('reads an empty grid as an empty tree', () => {
    expect(namesOf(staffGrid({ rows: [] }))).toEqual([]);
  });

  it('does not overflow the stack on a deep chain', () => {
    // A folder tree or a bill of materials from real data reaches thousands
    // of levels; the recursive version crashed with no bad input to point at.
    const rows: Person[] = [new Person('0', 'root')];
    for (let i = 1; i < 6000; i++) {
      rows.push(new Person(String(i), `p${i}`, String(i - 1)));
    }
    const grid = staffGrid({ rows, expanded: false });
    expect(grid.rowCount).toBe(1);
    grid.expandAllRows();
    expect(grid.rowCount).toBe(6000);
  });
});

describe('a nested model', () => {
  it('walks the children each row reports', () => {
    const rows = [
      new Node('1', 'Assembly', [
        new Node('1.1', 'Frame'),
        new Node('1.2', 'Motor', [new Node('1.2.1', 'Bearing')]),
      ]),
      new Node('2', 'Spare'),
    ];
    const grid = new GridController<Node>({
      columns: [new GridColumn<Node>({ field: 'name', value: (n) => n.name })],
      dataSource: new InMemoryDataSource<Node>(rows),
      rowKey: (n) => n.id,
      tree: new TreeSpec<Node>({ childrenOf: (n) => n.children }),
    });
    const names: string[] = [];
    for (const row of grid.visibleRows) {
      if (isDataRow(row))
        names.push(`${'  '.repeat(row.depth)}${row.data.name}`);
    }
    expect(names).toEqual([
      'Assembly',
      '  Frame',
      '  Motor',
      '    Bearing',
      'Spare',
    ]);
  });
});

describe('TreeSpec', () => {
  it('needs exactly one way of finding the children', () => {
    expect(() => new TreeSpec<Person>({})).toThrow(GridArgumentError);
    expect(
      () =>
        new TreeSpec<Person>({
          childrenOf: () => [],
          parentOf: () => null,
        }),
    ).toThrow(GridArgumentError);
  });

  it('needs a row key to remember its branches', () => {
    expect(
      () =>
        new GridController<Person>({
          columns: [
            new GridColumn<Person>({ field: 'name', value: (p) => p.name }),
          ],
          dataSource: new InMemoryDataSource<Person>(staff()),
          tree: new TreeSpec<Person>({ parentOf: (p) => p.managerId }),
        }),
    ).toThrow(GridArgumentError);
  });
});

describe('grouping wins over a tree', () => {
  it('because two hierarchies cannot share one indent', () => {
    const grid = staffGrid();
    expect(grid.isTree).toBe(true);
    grid.groupBy('id');
    expect(grid.isTree).toBe(false);
    expect(isGroupRow(grid.visibleRows.at(0))).toBe(true);
  });
});
