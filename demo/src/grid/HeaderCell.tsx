/**
 * A column header: sort, multi-sort, resize, drag to reorder, and a menu for
 * the rest of the column state the engine owns.
 */
import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { sortBy, type ColumnLayout, type GridController } from 'datagrid-core';
import { Popover } from './Popover';

export interface HeaderCellProps<T> {
  grid: GridController<T>;
  cell: ColumnLayout<T>;
  dragField: string | null;
  onDragField: (field: string | null) => void;
  run: (label: string, action: () => void) => void;
  measure: (text: string) => number;
}

export function HeaderCell<T>({
  grid,
  cell,
  dragField,
  onDragField,
  run,
  measure,
}: HeaderCellProps<T>) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null);
  const column = cell.column;
  const sort = grid.sortFor(column.field);
  const priority = grid.sortPriority(column.field);
  const filtered = grid.columnFilters.has(column.field);
  const grouped = grid.groups.some((g) => g.field === column.field);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = grid.widthOf(column.field);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      grid.resizeColumn(column.field, startWidth + (e.clientX - startX));
    };
    const up = () => {
      target.releasePointerCapture(event.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const canDrop = dragField !== null && dragField !== column.field;

  return (
    <div
      className={[
        'head',
        sort ? 'is-sorted' : '',
        grouped ? 'is-grouped' : '',
        dragField === column.field ? 'is-dragging' : '',
        canDrop && dropSide ? `drop-${dropSide}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ justifyContent: column.effectiveAlign === 'end' ? 'flex-end' : undefined }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', column.field);
        onDragField(column.field);
      }}
      onDragEnd={() => {
        onDragField(null);
        setDropSide(null);
      }}
      onDragOver={(event) => {
        if (!canDrop) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        setDropSide(event.clientX < box.left + box.width / 2 ? 'left' : 'right');
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(event) => {
        event.preventDefault();
        const moved = event.dataTransfer.getData('text/plain') || dragField;
        setDropSide(null);
        onDragField(null);
        if (!moved || moved === column.field) return;
        const target = dropSide === 'right' ? cell.index + 1 : cell.index;
        run('moveColumn', () => grid.moveColumn(moved, target));
      }}
      onClick={(event) => {
        if (!column.sortable) return;
        run('toggleSort', () =>
          grid.toggleSort(column.field, { additive: event.shiftKey || event.altKey }),
        );
      }}
      title={column.tooltip ?? `${column.title} — click to sort, shift-click to add a level`}
    >
      <span className="head-title">{column.title}</span>
      {filtered ? <span className="head-flag" title="Filtered">▾</span> : null}
      <span className={`head-sort ${sort ? 'on' : ''}`}>
        {sort ? (sort.isAscending ? '▲' : '▼') : '⋮⋮'}
        {priority != null && grid.sorts.length > 1 ? (
          <b className="head-priority">{priority + 1}</b>
        ) : null}
      </span>
      <button
        className="head-menu"
        aria-label={`${column.title} menu`}
        onClick={(event) => {
          event.stopPropagation();
          setMenu(menu ? null : event.currentTarget);
        }}
      >
        ⋯
      </button>
      {column.resizable ? (
        <div
          className="head-grip"
          onPointerDown={startResize}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => {
            event.stopPropagation();
            run('autoSizeColumn', () => grid.autoSizeColumn(column.field, { measure }));
          }}
          title="Drag to resize, double-click to fit the contents"
        />
      ) : null}
      {menu ? (
        <ColumnMenu
          grid={grid}
          cell={cell}
          anchor={menu}
          run={run}
          measure={measure}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

function ColumnMenu<T>({
  grid,
  cell,
  anchor,
  run,
  measure,
  onClose,
}: {
  grid: GridController<T>;
  cell: ColumnLayout<T>;
  anchor: HTMLElement;
  run: (label: string, action: () => void) => void;
  measure: (text: string) => number;
  onClose: () => void;
}) {
  const column = cell.column;
  const grouped = grid.groups.some((g) => g.field === column.field);
  const sort = grid.sortFor(column.field);

  function act(label: string, action: () => void) {
    run(label, action);
    onClose();
  }

  return (
    <Popover anchor={anchor} onClose={onClose} align="end" width={248}>
      <div className="popover-title">{column.title}</div>
      <div className="popover-section">
        <button
          className={sort?.isAscending ? 'on' : ''}
          onClick={() =>
            act('setSorts', () =>
              grid.setSorts([sortBy(column.field, { direction: 'ascending' })]),
            )
          }
        >
          Sort ascending
        </button>
        <button
          className={sort && !sort.isAscending ? 'on' : ''}
          onClick={() =>
            act('setSorts', () =>
              grid.setSorts([sortBy(column.field, { direction: 'descending' })]),
            )
          }
        >
          Sort descending
        </button>
        <button disabled={!sort} onClick={() => act('clearSorts', () => grid.clearSorts())}>
          Clear sorting
        </button>
      </div>
      <div className="popover-section">
        <button
          disabled={!column.groupable}
          className={grouped ? 'on' : ''}
          onClick={() =>
            act('groupBy', () =>
              grouped ? grid.ungroup(column.field) : grid.groupBy(column.field),
            )
          }
        >
          {grouped ? 'Remove from grouping' : 'Group by this column'}
        </button>
      </div>
      <div className="popover-section">
        <div className="popover-row">
          <span>Pin</span>
          <div className="segmented">
            {(['start', 'none', 'end'] as const).map((pin) => (
              <button
                key={pin}
                className={column.pin === pin ? 'on' : ''}
                onClick={() => act('setColumnPin', () => grid.setColumnPin(column.field, pin))}
              >
                {pin === 'none' ? 'off' : pin}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="popover-section">
        <button onClick={() => act('autoSizeColumn', () => grid.autoSizeColumn(column.field, { measure }))}>
          Fit to contents
        </button>
        <button onClick={() => act('resetColumnWidth', () => grid.resetColumnWidth(column.field))}>
          Reset width
        </button>
        <button onClick={() => act('setColumnVisible', () => grid.setColumnVisible(column.field, false))}>
          Hide column
        </button>
      </div>
    </Popover>
  );
}
