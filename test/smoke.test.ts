import { describe, expect, it } from 'vitest';
import {
  Aggregation,
  ColumnType,
  GridColumn,
  GridController,
  InMemoryDataSource,
  isDataRow,
} from '../src/index';

interface Employee {
  id: number;
  name: string;
  department: string;
  salary: number;
}

const employees: Employee[] = [
  { id: 1, name: 'Ada', department: 'Engineering', salary: 120 },
  { id: 2, name: 'Grace', department: 'Engineering', salary: 140 },
  { id: 3, name: 'Alan', department: 'Research', salary: 110 },
];

function makeGrid(): GridController<Employee> {
  return new GridController<Employee>({
    columns: [
      new GridColumn<Employee>({ field: 'name', value: (e) => e.name }),
      new GridColumn<Employee>({
        field: 'salary',
        type: ColumnType.number,
        value: (e) => e.salary,
        setValue: (e, v) => ({ ...e, salary: v as number }),
      }),
      new GridColumn<Employee>({
        field: 'department',
        value: (e) => e.department,
      }),
    ],
    dataSource: new InMemoryDataSource(employees),
    aggregations: [Aggregation.sum('salary')],
    rowKey: (e) => e.id,
  });
}

describe('the engine end to end', () => {
  it('shows every row on the first render, without awaiting', () => {
    const grid = makeGrid();
    expect(grid.rowCount).toBe(3);
    expect(grid.totalCount).toBe(3);
  });

  it('sorts by a column when its header is clicked', () => {
    const grid = makeGrid();
    grid.toggleSort('salary');
    const first = grid.visibleRows.at(0);
    expect(isDataRow(first) && first.data.name).toBe('Alan');
    grid.toggleSort('salary');
    const highest = grid.visibleRows.at(0);
    expect(isDataRow(highest) && highest.data.name).toBe('Grace');
  });

  it('searches across every filterable column', () => {
    const grid = makeGrid();
    grid.setSearch('research');
    expect(grid.rowCount).toBe(1);
    expect(grid.matchedCount).toBe(1);
    expect(grid.totalCount).toBe(3);
  });

  it('groups rows with a subtotal per group', () => {
    const grid = makeGrid();
    grid.groupBy('department');
    expect(grid.rowCount).toBe(5);
    const header = grid.visibleRows.at(0);
    expect(header.kind).toBe('group');
  });

  it('sums the salary column for the footer', () => {
    const grid = makeGrid();
    expect(grid.aggregates.get('salary.sum')).toBe(370);
  });
});
