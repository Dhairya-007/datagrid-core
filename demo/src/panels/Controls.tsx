/**
 * Small controls shared by the three views: paging, column visibility, and a
 * segmented switch.
 */
import { useState } from 'react';
import type { GridController } from 'datagrid-core';
import { Popover } from '../grid/Popover';

export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string; title?: string }>;
  onChange: (value: V) => void;
}) {
  return (
    <div className="group">
      <span className="group-label">{label}</span>
      <div className="segmented">
        {options.map((option) => (
          <button
            key={option.value}
            className={option.value === value ? 'on' : ''}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Pager<T>({
  grid,
  run,
}: {
  grid: GridController<T>;
  run: (label: string, action: () => void) => void;
}) {
  const sizes = [0, 50, 200, 1000];
  return (
    <div className="group">
      <span className="group-label">Page</span>
      <div className="segmented">
        {sizes.map((size) => (
          <button
            key={size}
            className={(grid.pageSize ?? 0) === size ? 'on' : ''}
            onClick={() => run('setPageSize', () => grid.setPageSize(size === 0 ? null : size))}
          >
            {size === 0 ? 'off' : size}
          </button>
        ))}
      </div>
      {grid.pageSize != null ? (
        <>
          <button
            disabled={!grid.hasPreviousPage}
            onClick={() => run('previousPage', () => grid.previousPage())}
          >
            ‹
          </button>
          <span className="page-of">
            {grid.pageIndex + 1} / {Math.max(1, grid.pageCount)}
          </span>
          <button
            disabled={!grid.hasNextPage}
            onClick={() => run('nextPage', () => grid.nextPage())}
          >
            ›
          </button>
        </>
      ) : null}
    </div>
  );
}

export function ColumnsMenu<T>({
  grid,
  run,
}: {
  grid: GridController<T>;
  run: (label: string, action: () => void) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const hidden = grid.columns.length - grid.visibleColumns.length;

  return (
    <div className="group">
      <button onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
        Columns{hidden > 0 ? ` (${hidden} hidden)` : ''}
      </button>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={268}>
          <div className="popover-title">Columns</div>
          <div className="popover-list">
            {grid.columns.map((column) => (
              <label key={column.field}>
                <input
                  type="checkbox"
                  checked={column.visible}
                  onChange={(event) =>
                    run('setColumnVisible', () =>
                      grid.setColumnVisible(column.field, event.target.checked),
                    )
                  }
                />
                <span>{column.title}</span>
                <small>{column.pin === 'none' ? '' : `pinned ${column.pin}`}</small>
              </label>
            ))}
          </div>
          <div className="popover-section">
            <button
              onClick={() =>
                run('setColumnVisible', () => {
                  for (const column of [...grid.columns]) {
                    if (!column.visible) grid.setColumnVisible(column.field, true);
                  }
                })
              }
            >
              Show all
            </button>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
