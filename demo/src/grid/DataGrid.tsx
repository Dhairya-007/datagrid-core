/**
 * The renderer.
 *
 * It owns no grid state at all. Every question it asks — which rows exist,
 * how wide a column is, which cells are selected, what a cell says, how it
 * should be shaded, whether an edit is valid — is answered by the engine; the
 * only things this file decides are pixels, colours and which keystroke maps
 * to which method.
 *
 * Virtualization is the engine's `RowMetrics`: it resolves a scroll offset to
 * a window of row indices, and only those rows are built. Horizontal
 * windowing comes from the layout, so a wide grid draws the columns in the
 * viewport and nothing else.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  RowMetrics,
  cell as cellAt,
  coerceValue,
  isDataRow,
  isDetailRow,
  isGroupRow,
  layoutHeaderRow,
  type CellValue,
  type ColumnLayout,
  type GridController,
  type GridRow,
  type HeaderBand,
  type HeaderBandLayout,
} from 'datagrid-core';
import { FilterCell } from './FilterCell';
import { HeaderCell } from './HeaderCell';
import { barProps, decorationProps } from './cells';
import { paneCells, paneModelFor, type PaneModel } from './panes';

const BAND_HEIGHT = 28;
const TITLE_HEIGHT = 38;
const FILTER_HEIGHT = 34;
const FOOTER_HEIGHT = 38;
const CHECKBOX_WIDTH = 42;

export interface DataGridProps<T> {
  grid: GridController<T>;
  /** Bumped by `useGridRevision`; it is what invalidates the memos below. */
  revision: number;
  run: (label: string, action: () => void) => void;
  rowHeight?: number;
  checkboxes?: boolean;
  filterRow?: boolean;
  valueListFields?: ReadonlySet<string>;
  /** The aggregate a column shows on a group header and in the footer. */
  aggregateIdFor?: (field: string) => string | null;
  renderDetail?: (row: T) => ReactNode;
  emptyMessage?: string;
  /** Called while the window is near the end, for infinite scrolling. */
  onReachEnd?: () => void;
}

export function DataGrid<T>({
  grid,
  revision,
  run,
  rowHeight = 36,
  checkboxes = true,
  filterRow = true,
  valueListFields = new Set<string>(),
  aggregateIdFor,
  renderDetail,
  emptyMessage = 'Nothing matches the current filters.',
  onReachEnd,
}: DataGridProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [dragField, setDragField] = useState<string | null>(null);

  // Text measurement is the one thing a headless engine cannot do, so
  // `autoSizeColumn` asks for it. A canvas does it without touching the DOM.
  const measure = useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) {
      context.font =
        '13px ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif';
    }
    return (text: string) => context?.measureText(text).width ?? text.length * 7.2;
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const sync = () => {
      setViewport((current) =>
        current.width === element.clientWidth && current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight },
      );
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const headerHeight =
    (grid.stackedHeaders.length > 0 ? BAND_HEIGHT * grid.stackedHeaders.length : 0) +
    TITLE_HEIGHT +
    (filterRow ? FILTER_HEIGHT : 0);

  const detailHeight = grid.detailHeight ?? 168;
  const heightOfRow = useCallback(
    (row: GridRow<T>) => (isDetailRow(row) ? row.height || detailHeight : rowHeight),
    [detailHeight, rowHeight],
  );

  const frozenTop = grid.effectiveFrozenTop;
  const frozenBottom = grid.effectiveFrozenBottom;
  const scrollableCount = Math.max(0, grid.rowCount - frozenTop - frozenBottom);

  // Uniform metrics are a closed form — no table, nothing to walk. The
  // variable form is only built when an open detail panel has actually made
  // the rows different heights.
  const metrics = useMemo(() => {
    void revision;
    if (grid.openDetails.size === 0) {
      return RowMetrics.uniform({ rowCount: scrollableCount, rowHeight });
    }
    const rows = grid.visibleRows;
    return RowMetrics.variable({
      rowCount: scrollableCount,
      heightOf: (index) => heightOfRow(rows.at(frozenTop + index)),
    });
  }, [grid, revision, scrollableCount, rowHeight, frozenTop, heightOfRow]);

  const frozenTopHeight = frozenTop * rowHeight;
  const frozenBottomHeight = frozenBottom * rowHeight;
  const bodyExtent = Math.max(
    0,
    viewport.height - headerHeight - frozenTopHeight - frozenBottomHeight - FOOTER_HEIGHT,
  );

  const layout = useMemo(
    () => grid.layoutFor(Math.max(320, viewport.width)),
    [grid, revision, viewport.width],
  );
  const pane = useMemo(
    () => paneModelFor(layout, { scrollLeft: scroll.left, gutter: checkboxes ? CHECKBOX_WIDTH : 0 }),
    [layout, scroll.left, checkboxes],
  );

  const window_ = metrics.windowFor({
    scrollOffset: scroll.top,
    viewportExtent: bodyExtent,
    overscan: 4,
  });

  // Keep the active cell on screen when the keyboard moves it.
  const activeCell = grid.selection.activeCell;
  const activeKey = activeCell ? activeCell.key : '';
  const lastActive = useRef('');
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !activeCell || activeKey === lastActive.current) return;
    lastActive.current = activeKey;
    const index = activeCell.row - frozenTop;
    if (index >= 0 && index < metrics.rowCount) {
      element.scrollTop = metrics.scrollOffsetToReveal(index, {
        viewportExtent: bodyExtent,
        currentOffset: element.scrollTop,
        padding: rowHeight,
      });
    }
    const column = layout.allColumns.find((c) => c.column.field === activeCell.field);
    if (column && column.column.pin === 'none') {
      const left = column.offset;
      const width = layout.scrollViewportWidth - pane.gutter;
      if (left < element.scrollLeft) element.scrollLeft = left;
      else if (left + column.width > element.scrollLeft + width) {
        element.scrollLeft = left + column.width - width;
      }
    }
  }, [activeKey, activeCell, bodyExtent, frozenTop, layout, metrics, pane.gutter, rowHeight]);

  useEffect(() => {
    if (!onReachEnd || scrollableCount === 0) return;
    if (window_.lastIndex >= scrollableCount - 12) onReachEnd();
  }, [onReachEnd, scrollableCount, window_.lastIndex]);

  const onKeyDown = useKeyboard(grid, run, { rowsPerPage: Math.max(1, Math.floor(bodyExtent / rowHeight)) });

  const rows: ReactNode[] = [];
  if (scrollableCount > 0) {
    for (let index = window_.firstIndex; index <= window_.lastIndex; index++) {
      const absolute = frozenTop + index;
      const row = grid.visibleRows.at(absolute);
      rows.push(
        <RowView
          key={absolute}
          grid={grid}
          row={row}
          pane={pane}
          top={metrics.offsetOf(index)}
          height={heightOfRow(row)}
          run={run}
          renderDetail={renderDetail}
          aggregateIdFor={aggregateIdFor}
        />,
      );
    }
  }

  return (
    <div className="grid-shell">
      <div
        className="grid-scroll"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          const element = event.currentTarget;
          setScroll((current) =>
            current.left === element.scrollLeft && current.top === element.scrollTop
              ? current
              : { left: element.scrollLeft, top: element.scrollTop },
          );
        }}
      >
        <div className="grid-content" style={{ width: pane.totalWidth }}>
          <div className="grid-head" style={{ height: headerHeight }}>
            {grid.stackedHeaders.map((headerRow, depth) => {
              // The engine resolves a band into segments per pane, marking the
              // ones that continue a band already drawn in an earlier pane —
              // which is what a band spanning the frozen boundary needs.
              const drawn = new Set<HeaderBand>();
              const lead = layoutHeaderRow(pane.leading, headerRow, { drawn });
              const middle = layoutHeaderRow(pane.scrolling, headerRow, { drawn });
              const tail = layoutHeaderRow(pane.trailing, headerRow, { drawn });
              return (
                <div className="grid-row grid-bands" key={depth} style={{ height: BAND_HEIGHT }}>
                  {checkboxes ? (
                    <div
                      className="pane pane-leading gutter"
                      style={{ width: CHECKBOX_WIDTH, left: 0 }}
                    />
                  ) : null}
                  {lead.map((segment, index) => (
                    <Band
                      key={`l${index}`}
                      segment={segment}
                      className="pane-leading"
                      style={{ width: segment.width, left: pane.gutter + segment.offset }}
                    />
                  ))}
                  <div className="pane-spacer" style={{ width: pane.spacerBefore }} />
                  {middle.map((segment, index) => (
                    <Band key={`s${index}`} segment={segment} style={{ width: segment.width }} />
                  ))}
                  <div className="pane-spacer" style={{ width: pane.spacerAfter }} />
                  {tail.map((segment, index) => (
                    <Band
                      key={`t${index}`}
                      segment={segment}
                      className="pane-trailing"
                      style={{
                        width: segment.width,
                        right: pane.trailingWidth - (segment.offset + segment.width),
                      }}
                    />
                  ))}
                </div>
              );
            })}
            <div className="grid-row grid-titles" style={{ height: TITLE_HEIGHT }}>
              {checkboxes ? (
                <div className="pane pane-leading gutter" style={{ width: CHECKBOX_WIDTH, left: 0 }}>
                  <SelectAllBox grid={grid} run={run} />
                </div>
              ) : null}
              {paneCells(pane, (column) => (
                <HeaderCell
                  grid={grid}
                  cell={column}
                  dragField={dragField}
                  onDragField={setDragField}
                  run={run}
                  measure={measure}
                />
              ))}
            </div>
            {filterRow ? (
              <div className="grid-row grid-filters" style={{ height: FILTER_HEIGHT }}>
                {checkboxes ? (
                  <div className="pane pane-leading gutter" style={{ width: CHECKBOX_WIDTH, left: 0 }}>
                    <button
                      className="filter-clear-all"
                      title="Clear every column filter"
                      disabled={grid.columnFilters.size === 0}
                      onClick={() => run('clearFilters', () => grid.clearFilters())}
                    >
                      ⌫
                    </button>
                  </div>
                ) : null}
                {paneCells(pane, (column) => (
                  <FilterCell
                    grid={grid}
                    cell={column}
                    valueListFields={valueListFields}
                    run={run}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {frozenTop > 0 ? (
            <div className="grid-frozen top" style={{ top: headerHeight, height: frozenTopHeight }}>
              {Array.from({ length: frozenTop }, (_, index) => (
                <RowView
                  key={`ft-${index}`}
                  grid={grid}
                  row={grid.visibleRows.at(index)}
                  pane={pane}
                  top={index * rowHeight}
                  height={rowHeight}
                  run={run}
                  aggregateIdFor={aggregateIdFor}
                  frozen
                />
              ))}
            </div>
          ) : null}

          <div className="grid-body" style={{ height: metrics.totalExtent }}>
            {rows}
          </div>

          {frozenBottom > 0 ? (
            <div
              className="grid-frozen bottom"
              style={{ bottom: FOOTER_HEIGHT, height: frozenBottomHeight }}
            >
              {Array.from({ length: frozenBottom }, (_, index) => {
                const absolute = grid.rowCount - frozenBottom + index;
                return (
                  <RowView
                    key={`fb-${absolute}`}
                    grid={grid}
                    row={grid.visibleRows.at(absolute)}
                    pane={pane}
                    top={index * rowHeight}
                    height={rowHeight}
                    run={run}
                    aggregateIdFor={aggregateIdFor}
                    frozen
                  />
                );
              })}
            </div>
          ) : null}

          <div className="grid-foot" style={{ height: FOOTER_HEIGHT }}>
            <div className="grid-row" style={{ height: FOOTER_HEIGHT }}>
              {checkboxes ? (
                <div className="pane pane-leading gutter" style={{ width: CHECKBOX_WIDTH, left: 0 }}>
                  Σ
                </div>
              ) : null}
              {paneCells(pane, (column) => {
                const id = aggregateIdFor?.(column.column.field);
                const value = id ? grid.aggregates.get(id) : null;
                const aggregation = id
                  ? grid.aggregations.find((candidate) => candidate.id === id)
                  : undefined;
                return (
                  <div
                    className="foot-cell"
                    style={{ justifyContent: column.column.effectiveAlign === 'end' ? 'flex-end' : undefined }}
                  >
                    {value == null ? '' : (aggregation?.formatted(value) ?? String(value))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {grid.isEmpty && !grid.isLoading ? <div className="grid-empty">{emptyMessage}</div> : null}
      {grid.isLoading ? <div className="grid-loading"><span /> Fetching</div> : null}
    </div>
  );
}

/** One segment of a stacked header row. */
function Band<T>({
  segment,
  className = '',
  style,
}: {
  segment: HeaderBandLayout<T>;
  className?: string;
  style: React.CSSProperties;
}) {
  const band = segment.band;
  return (
    <div
      className={[
        'pane',
        'band',
        className,
        band ? '' : 'is-gap',
        segment.isContinuation ? 'is-continuation' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      title={band?.tooltip ?? band?.title ?? ''}
    >
      <span
        style={{
          width: '100%',
          textAlign: band?.align === 'center' ? 'center' : 'left',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {band ? band.title : ''}
      </span>
    </div>
  );
}

function SelectAllBox<T>({
  grid,
  run,
}: {
  grid: GridController<T>;
  run: (label: string, action: () => void) => void;
}) {
  const coverage = grid.selectionCoverage;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = coverage === 'some';
  }, [coverage]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={coverage === 'all'}
      title="Select every row — a flag with exceptions, not a set of a million indices"
      onChange={() => run('toggleSelectAll', () => grid.toggleSelectAll())}
    />
  );
}

interface RowViewProps<T> {
  grid: GridController<T>;
  row: GridRow<T>;
  pane: PaneModel<T>;
  top: number;
  height: number;
  run: (label: string, action: () => void) => void;
  renderDetail?: (row: T) => ReactNode;
  aggregateIdFor?: (field: string) => string | null;
  frozen?: boolean;
}

function RowView<T>(props: RowViewProps<T>) {
  const { grid, row, pane, top, height, run, renderDetail, aggregateIdFor, frozen } = props;

  if (isGroupRow(row)) {
    const expanded = row.expanded;
    return (
      <div
        className={`grid-row group-row depth-${Math.min(row.depth, 3)}`}
        style={{ top, height, width: pane.totalWidth }}
        onClick={() => run('toggleGroup', () => grid.toggleGroup(row.path))}
      >
        <div
          className="pane pane-leading group-label"
          style={{ width: pane.leadingWidth, left: 0, paddingLeft: 10 + row.depth * 16 }}
        >
          <span className={`twisty ${expanded ? 'open' : ''}`}>▶</span>
          <span className="group-field">{grid.column(row.field)?.title ?? row.field}</span>
          <span className="group-value">{row.label}</span>
          <span className="group-count">{row.rowCount.toLocaleString()}</span>
          {row.loading ? <span className="group-loading">loading…</span> : null}
        </div>
        <div className="pane-spacer" style={{ width: pane.spacerBefore }} />
        {pane.scrolling.map((column) => {
          const id = aggregateIdFor?.(column.column.field);
          const value = id ? row.aggregates.get(id) : null;
          const aggregation = id
            ? grid.aggregations.find((candidate) => candidate.id === id)
            : undefined;
          return (
            <div
              key={column.column.field}
              className="pane group-aggregate"
              style={{
                width: column.width,
                justifyContent: column.column.effectiveAlign === 'end' ? 'flex-end' : undefined,
              }}
            >
              {value == null ? '' : (aggregation?.formatted(value) ?? String(value))}
            </div>
          );
        })}
        <div className="pane-spacer" style={{ width: pane.spacerAfter }} />
        {pane.trailing.map((column) => (
          <div
            key={column.column.field}
            className="pane pane-trailing group-aggregate"
            style={{ width: column.width, right: pane.trailingWidth - column.end }}
          />
        ))}
      </div>
    );
  }

  if (isDetailRow(row)) {
    return (
      <div className="grid-row detail-row" style={{ top, height, width: pane.totalWidth }}>
        <div className="detail-panel" style={{ width: pane.leadingWidth + 760 }}>
          {renderDetail ? renderDetail(row.data) : null}
        </div>
      </div>
    );
  }

  if (!isDataRow(row)) return null;

  const index = row.index;
  const selected = grid.selection.isRowSelected(index);
  const active = grid.selection.activeCell;
  const current = active?.row === index;

  return (
    <div
      className={[
        'grid-row data-row',
        selected ? 'is-selected' : '',
        current ? 'is-current' : '',
        frozen ? 'is-frozen' : '',
        index % 2 ? 'is-odd' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ top, height, width: pane.totalWidth }}
    >
      {pane.gutter > 0 ? (
        <div className="pane pane-leading gutter" style={{ width: pane.gutter, left: 0 }}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) =>
              run('setRowSelected', () => grid.setRowSelected(index, event.target.checked))
            }
          />
          {grid.hasDetailPanels || grid.detailHeight != null ? (
            <button
              className={`detail-toggle ${grid.isDetailOpen(grid.keyFor(row.data)) ? 'open' : ''}`}
              title="Open the detail panel"
              onClick={() => {
                const key = grid.keyFor(row.data);
                if (key != null) run('toggleDetail', () => grid.toggleDetail(key));
              }}
            >
              ›
            </button>
          ) : null}
        </div>
      ) : null}
      {paneCells(pane, (column) => (
        <DataCell
          grid={grid}
          column={column}
          row={row.data}
          index={index}
          depth={row.depth}
          tree={grid.isTree && column.index === 0 ? row : null}
          run={run}
        />
      ))}
    </div>
  );
}

function DataCell<T>({
  grid,
  column,
  row,
  index,
  depth,
  tree,
  run,
}: {
  grid: GridController<T>;
  column: ColumnLayout<T>;
  row: T;
  index: number;
  depth: number;
  tree: { hasChildren: boolean; expanded: boolean; treePath: string; isLoadingChildren: boolean } | null;
  run: (label: string, action: () => void) => void;
}) {
  const field = column.column.field;
  const address = cellAt(index, field);
  const editing = grid.isEditing(address);
  const session = editing ? grid.editSession : null;
  const selected = grid.selection.isCellSelected(address);
  const active = grid.selection.activeCell?.equals(address) ?? false;
  const decoration = grid.decorationFor(field, row);
  // A tone on a text column is a state, so it is drawn as a pill; on a number
  // column it is a position in a range, so it washes the whole cell.
  const asPill =
    decoration.bar == null &&
    decoration.tone !== 'neutral' &&
    column.column.type === 'text';
  const deco = asPill ? {} : decorationProps(decoration);
  const bar = barProps(decoration);
  const align = column.column.effectiveAlign;

  if (editing && session) {
    return (
      <div className={`cell is-editing ${session.isValid ? '' : 'is-invalid'}`}>
        <input
          autoFocus
          className="cell-input"
          style={{ textAlign: align === 'end' ? 'right' : 'left' }}
          defaultValue={editableText(column.column.value(row))}
          onChange={(event) =>
            grid.updateEdit(coerceValue(event.target.value, column.column.type) as CellValue)
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              run('commitEdit', () => grid.commitEdit());
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              grid.cancelEdit();
            } else if (event.key === 'Tab') {
              event.preventDefault();
              event.stopPropagation();
              run('commitEdit', () => {
                grid.commitEdit();
                grid.moveToNextEditableCell({ backwards: event.shiftKey });
              });
            }
          }}
          onBlur={() => {
            if (session.isValid) run('commitEdit', () => grid.commitEdit());
            else grid.cancelEdit();
          }}
        />
        {session.error ? <div className="cell-error">{session.error}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={[
        'cell',
        selected ? 'in-range' : '',
        active ? 'is-active' : '',
        align === 'end' ? 'align-end' : '',
        column.column.editable ? 'is-editable' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...deco}
      style={{ ...deco.style, paddingLeft: tree ? 8 + depth * 16 : undefined }}
      onMouseDown={(event) => {
        if (event.shiftKey) {
          grid.extendSelectionTo(address);
          return;
        }
        grid.selectCell(address, {
          toggle: event.ctrlKey || event.metaKey,
        });
      }}
      onDoubleClick={() => {
        if (column.column.editable) run('beginEdit', () => grid.beginEdit(address));
      }}
    >
      {bar ? <span className="cell-bar" data-tone={bar.tone} style={bar.style} /> : null}
      {asPill ? (
        <span className="cell-pill" data-tone={decoration.tone} data-bold={decoration.bold ? '' : undefined}>
          {column.column.formattedValue(row)}
        </span>
      ) : null}
      {tree?.hasChildren ? (
        <button
          className={`twisty ${tree.expanded ? 'open' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            run('toggleRow', () => grid.toggleRow(tree.treePath));
          }}
        >
          {tree.isLoadingChildren ? '◌' : '▶'}
        </button>
      ) : tree ? (
        <span className="twisty-gap" />
      ) : null}
      {asPill ? null : (
        <span className="cell-text">{column.column.formattedValue(row)}</span>
      )}
    </div>
  );
}

/**
 * What an editor starts with: the raw value, not the formatted one.
 *
 * `$1,240.00` is what a reader wants and not what an editor wants, since it
 * has to survive `coerceValue` on the way back in.
 */
function editableText(value: CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Every key the grid answers to, mapped onto engine methods. */
function useKeyboard<T>(
  grid: GridController<T>,
  run: (label: string, action: () => void) => void,
  options: { rowsPerPage: number },
) {
  const { rowsPerPage } = options;
  return useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const mod = event.ctrlKey || event.metaKey;
      const extend = event.shiftKey;
      const active = grid.selection.activeCell;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          grid.moveActiveCell(1, 0, { extend });
          return;
        case 'ArrowUp':
          event.preventDefault();
          grid.moveActiveCell(-1, 0, { extend });
          return;
        case 'ArrowLeft':
          event.preventDefault();
          grid.moveActiveCell(0, -1, { extend });
          return;
        case 'ArrowRight':
          event.preventDefault();
          grid.moveActiveCell(0, 1, { extend });
          return;
        case 'PageDown':
          event.preventDefault();
          grid.movePages(1, { rowsPerPage, extend });
          return;
        case 'PageUp':
          event.preventDefault();
          grid.movePages(-1, { rowsPerPage, extend });
          return;
        case 'Home':
          event.preventDefault();
          if (mod) grid.moveToGridEdge({ start: true, extend });
          else grid.moveToLineEdge({ start: true, extend });
          return;
        case 'End':
          event.preventDefault();
          if (mod) grid.moveToGridEdge({ start: false, extend });
          else grid.moveToLineEdge({ start: false, extend });
          return;
        case 'Tab':
          event.preventDefault();
          grid.moveToNextEditableCell({ backwards: extend });
          return;
        case 'Enter':
        case 'F2':
          if (active) {
            event.preventDefault();
            run('beginEdit', () => grid.beginEdit(active));
          }
          return;
        case 'Escape':
          grid.cancelEdit();
          grid.clearSelection();
          return;
        case ' ':
          if (active) {
            event.preventDefault();
            run('setRowSelected', () =>
              grid.setRowSelected(active.row, !grid.selection.isRowSelected(active.row)),
            );
          }
          return;
        case 'a':
        case 'A':
          if (mod) {
            event.preventDefault();
            run('selectAllRows', () => grid.selectAllRows());
          }
          return;
        case 'c':
        case 'C':
          if (mod) {
            event.preventDefault();
            const text = grid.copySelectionAsText({ includeHeader: extend });
            if (text) void navigator.clipboard?.writeText(text);
          }
          return;
        case 'v':
        case 'V':
          if (mod) {
            event.preventDefault();
            void navigator.clipboard?.readText().then((text) => {
              if (text) run('pasteText', () => grid.pasteText(text));
            });
          }
          return;
        case 'z':
        case 'Z':
          if (mod) {
            event.preventDefault();
            if (extend) run('redo', () => grid.redo());
            else run('undo', () => grid.undo());
          }
          return;
        case 'y':
        case 'Y':
          if (mod) {
            event.preventDefault();
            run('redo', () => grid.redo());
          }
          return;
        default:
          return;
      }
    },
    [grid, run, rowsPerPage],
  );
}
