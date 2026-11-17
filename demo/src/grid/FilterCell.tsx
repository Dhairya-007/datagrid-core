/**
 * The filter row.
 *
 * Every piece of this comes out of the engine: `operatorsForField` says which
 * operators a column's type supports, `distinctValuesFor` builds the value
 * list for a checkbox filter, and `setColumnFilter` takes a `FilterCondition`
 * — a serialisable node, not a closure, which is why a saved view can carry it
 * and a server can translate it.
 *
 * Operands are left as typed text: the engine coerces them to the column's
 * type when it compiles the filter, so `'50'` in a number column compares as
 * 50 rather than as a string.
 */
import { useMemo, useState } from 'react';
import {
  FilterCondition,
  operatorLabel,
  operatorNeedsSecondValue,
  operatorNeedsValue,
  type ColumnLayout,
  type FilterOperator,
  type GridController,
} from 'datagrid-core';
import { Popover } from './Popover';

export interface FilterCellProps<T> {
  grid: GridController<T>;
  cell: ColumnLayout<T>;
  valueListFields: ReadonlySet<string>;
  run: (label: string, action: () => void) => void;
}

const DEFAULT_OPERATOR: Record<string, FilterOperator> = {
  text: 'contains',
  number: 'greaterOrEqual',
  date: 'greaterThan',
  boolean: 'equals',
  custom: 'contains',
};

export function FilterCell<T>({ grid, cell, valueListFields, run }: FilterCellProps<T>) {
  const column = cell.column;
  const condition = grid.columnFilters.get(column.field) ?? null;

  if (!column.filterable) return <div className="filter-cell is-off" />;

  if (valueListFields.has(column.field)) {
    return <ValueListFilter grid={grid} cell={cell} condition={condition} run={run} />;
  }

  return <OperatorFilter grid={grid} cell={cell} condition={condition} run={run} />;
}

function OperatorFilter<T>({
  grid,
  cell,
  condition,
  run,
}: {
  grid: GridController<T>;
  cell: ColumnLayout<T>;
  condition: FilterCondition | null;
  run: (label: string, action: () => void) => void;
}) {
  const column = cell.column;
  const operators = grid.operatorsForField(column.field);
  const operator =
    condition?.operator ?? DEFAULT_OPERATOR[column.type] ?? ('contains' as FilterOperator);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  function apply(next: {
    operator?: FilterOperator;
    value?: unknown;
    secondValue?: unknown;
  }) {
    const resolved = next.operator ?? operator;
    const value = 'value' in next ? next.value : condition?.value;
    const secondValue = 'secondValue' in next ? next.secondValue : condition?.secondValue;
    const built = new FilterCondition({
      field: column.field,
      operator: resolved,
      value: value as never,
      secondValue: secondValue as never,
    });
    run('setColumnFilter', () =>
      grid.setColumnFilter(column.field, built.isEmpty ? null : built),
    );
  }

  const needsValue = operatorNeedsValue(operator);
  const needsSecond = operatorNeedsSecondValue(operator);
  const inputType = column.type === 'date' ? 'date' : 'text';

  return (
    <div className={`filter-cell ${condition ? 'is-on' : ''}`}>
      <button
        className="filter-op"
        title={`${column.title} ${operatorLabel(operator)}`}
        onClick={(event) => setMenu(menu ? null : event.currentTarget)}
      >
        {SHORT[operator] ?? '≡'}
      </button>
      {needsValue ? (
        <input
          className="filter-input"
          type={inputType}
          value={asText(condition?.value)}
          placeholder={operatorLabel(operator)}
          onChange={(event) => apply({ value: event.target.value })}
        />
      ) : (
        <span className="filter-fixed">{operatorLabel(operator)}</span>
      )}
      {needsSecond ? (
        <input
          className="filter-input"
          type={inputType}
          value={asText(condition?.secondValue)}
          placeholder="and"
          onChange={(event) => apply({ secondValue: event.target.value })}
        />
      ) : null}
      {condition ? (
        <button
          className="filter-clear"
          title="Clear this filter"
          onClick={() => run('setColumnFilter', () => grid.setColumnFilter(column.field, null))}
        >
          ×
        </button>
      ) : null}
      {menu ? (
        <Popover anchor={menu} onClose={() => setMenu(null)} width={200}>
          <div className="popover-title">{column.title}</div>
          <div className="popover-section">
            {operators.map((candidate) => (
              <button
                key={candidate}
                className={candidate === operator ? 'on' : ''}
                onClick={() => {
                  apply({ operator: candidate });
                  setMenu(null);
                }}
              >
                {operatorLabel(candidate)}
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

function ValueListFilter<T>({
  grid,
  cell,
  condition,
  run,
}: {
  grid: GridController<T>;
  cell: ColumnLayout<T>;
  condition: FilterCondition | null;
  run: (label: string, action: () => void) => void;
}) {
  const column = cell.column;
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [needle, setNeedle] = useState('');

  const selected = useMemo(() => {
    const raw = condition?.operator === 'isIn' ? condition.value : null;
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  }, [condition]);

  // Asked of the engine, not computed here: the in-memory source caches the
  // distinct values per revision and scopes them to the other active filters.
  const values = useMemo(
    () => (menu ? grid.distinctValuesFor(column.field, 400).values.map(String) : []),
    [menu, grid, column.field, condition],
  );

  const shown = values.filter((v) => v.toLowerCase().includes(needle.toLowerCase()));

  function commit(next: Set<string>) {
    run('setColumnFilter', () => {
      if (next.size === 0) {
        grid.setColumnFilter(column.field, null);
        return;
      }
      grid.setColumnFilter(
        column.field,
        new FilterCondition({ field: column.field, operator: 'isIn', value: [...next] }),
      );
    });
  }

  return (
    <div className={`filter-cell ${condition ? 'is-on' : ''}`}>
      <button
        className="filter-list"
        onClick={(event) => setMenu(menu ? null : event.currentTarget)}
        title={selected.size ? [...selected].join(', ') : 'Any value'}
      >
        <span>{selected.size === 0 ? 'Any' : `${selected.size} selected`}</span>
        <i>▾</i>
      </button>
      {condition ? (
        <button
          className="filter-clear"
          title="Clear this filter"
          onClick={() => run('setColumnFilter', () => grid.setColumnFilter(column.field, null))}
        >
          ×
        </button>
      ) : null}
      {menu ? (
        <Popover anchor={menu} onClose={() => setMenu(null)} width={248}>
          <div className="popover-title">{column.title}</div>
          <div className="popover-search">
            <input
              autoFocus
              value={needle}
              placeholder={`Search ${shown.length} values`}
              onChange={(event) => setNeedle(event.target.value)}
            />
          </div>
          <div className="popover-list">
            {shown.map((value) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={selected.has(value)}
                  onChange={() => {
                    const next = new Set(selected);
                    if (next.has(value)) next.delete(value);
                    else next.add(value);
                    commit(next);
                  }}
                />
                <span>{value}</span>
              </label>
            ))}
            {shown.length === 0 ? <div className="popover-empty">No values</div> : null}
          </div>
          <div className="popover-section">
            <button onClick={() => commit(new Set(shown))}>Select all shown</button>
            <button disabled={selected.size === 0} onClick={() => commit(new Set())}>
              Clear
            </button>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

const SHORT: Partial<Record<FilterOperator, string>> = {
  equals: '=',
  notEquals: '≠',
  contains: '∋',
  notContains: '∌',
  startsWith: 'a·',
  endsWith: '·z',
  greaterThan: '>',
  greaterOrEqual: '≥',
  lessThan: '<',
  lessOrEqual: '≤',
  between: '↔',
  isIn: '∈',
  isNull: '∅',
  isNotNull: '≢',
  isEmpty: '""',
  isNotEmpty: '≠""',
};

function asText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
