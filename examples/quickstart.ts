/**
 * The README's quickstart, as code the typechecker reads.
 *
 * A snippet in a README rots the moment the API moves. This file is in the
 * `tsc --noEmit` pass and in CI, so it cannot.
 *
 * Run it with `npx tsx examples/quickstart.ts`, or read it where it is.
 */
import {
  Aggregation,
  GridColumn,
  GridController,
  InMemoryDataSource,
  isDataRow,
  isGroupRow,
  numberRange,
  RowMetrics,
  type CellValue,
} from '../src/index';

interface Employee {
  id: number;
  name: string;
  department: string;
  salary: number;
}

const employees: Employee[] = [
  { id: 1, name: 'Ada', department: 'Engineering', salary: 120_000 },
  { id: 2, name: 'Grace', department: 'Engineering', salary: 140_000 },
  { id: 3, name: 'Alan', department: 'Research', salary: 110_000 },
];

const grid = new GridController<Employee>({
  columns: [
    new GridColumn<Employee>({
      field: 'name',
      value: (e) => e.name,
      pin: 'start',
    }),
    new GridColumn<Employee>({
      field: 'salary',
      type: 'number',
      value: (e) => e.salary,
      setValue: (e, v) => ({ ...e, salary: v as number }),
      validator: numberRange({ min: 0 }),
      format: (v: CellValue) => `${Number(v).toLocaleString('en-US')} USD`,
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

/** What an adapter does on every notification. */
function render(): string[] {
  const out: string[] = [];
  // The geometry, which the engine resolves without measuring anything.
  const layout = grid.layoutFor(900);
  const metrics = RowMetrics.uniform({
    rowCount: grid.rowCount,
    rowHeight: 36,
  });
  const window = metrics.windowFor({ scrollOffset: 0, viewportExtent: 400 });
  const fields = layout.allColumns.map((c) => c.column.field);

  for (let i = window.firstIndex; i <= window.lastIndex; i++) {
    const row = grid.visibleRows.at(i);
    if (isGroupRow(row)) {
      out.push(`${'  '.repeat(row.depth)}${row.label} (${row.rowCount})`);
      continue;
    }
    if (!isDataRow(row)) continue;
    const cells = fields.map(
      (field) => grid.column(field)?.formattedValue(row.data) ?? '',
    );
    out.push(`${'  '.repeat(row.depth)}${cells.join('  ')}`);
  }
  return out;
}

grid.addListener(() => {
  // A real adapter would schedule a repaint here.
  void render();
});

// Sort, group, search, edit — each one re-runs the pipeline and notifies.
grid.toggleSort('salary');
grid.groupBy('department');

const lines = render();
const total = grid.aggregates.get('salary.sum');

console.log(lines.join('\n'));
console.log(`\n${grid.rowCount} rows, salary total ${String(total)}`);
console.log(`\n${grid.exportCsv()}`);
