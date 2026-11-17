/**
 * The pane model, shared by every row the grid draws.
 *
 * `layoutFor(width)` hands back three bands — the columns frozen to the
 * leading edge, the ones that scroll, and the ones frozen to the trailing edge
 * — and `visibleScrollingColumns` narrows the middle band to what is actually
 * on screen. Everything that draws a row (the header, the filter row, a data
 * row, the footer) walks the same model, so a pinned column is pinned
 * everywhere without any row knowing what pinning is.
 */
import type { ReactNode } from 'react';
import type { ColumnLayout, GridLayout } from 'datagrid-core';

export interface PaneModel<T> {
  leading: readonly ColumnLayout<T>[];
  scrolling: readonly ColumnLayout<T>[];
  trailing: readonly ColumnLayout<T>[];
  spacerBefore: number;
  spacerAfter: number;
  leadingWidth: number;
  trailingWidth: number;
  totalWidth: number;
  /** Width of the renderer's own checkbox column, which the engine never sees. */
  gutter: number;
}

export function paneModelFor<T>(
  layout: GridLayout<T>,
  options: { scrollLeft: number; gutter: number },
): PaneModel<T> {
  const { scrollLeft, gutter } = options;
  const leadingWidth = layout.leadingWidth + gutter;
  const trailingWidth = layout.trailingWidth;
  const viewportWidth = Math.max(0, layout.viewportWidth - leadingWidth - trailingWidth);

  // Column windowing: a 40-column grid draws the eight columns in the
  // viewport, which is what keeps a wide grid as cheap as a narrow one.
  const scrolling = layout.visibleScrollingColumns({
    scrollOffset: scrollLeft,
    viewportWidth,
    overscan: 2,
  });

  const first = scrolling[0];
  const last = scrolling[scrolling.length - 1];
  return {
    leading: layout.leading,
    scrolling,
    trailing: layout.trailing,
    spacerBefore: first ? first.offset : layout.scrollingWidth,
    spacerAfter: last ? layout.scrollingWidth - last.end : 0,
    leadingWidth,
    trailingWidth,
    totalWidth: layout.totalWidth + gutter,
    gutter,
  };
}

export type CellRenderer<T> = (
  cell: ColumnLayout<T>,
  band: 'leading' | 'scrolling' | 'trailing',
) => ReactNode;

/** Draws one row's cells in pane order, with the frozen bands made sticky. */
export function paneCells<T>(pane: PaneModel<T>, render: CellRenderer<T>): ReactNode[] {
  const out: ReactNode[] = [];
  for (const cell of pane.leading) {
    const last = cell === pane.leading[pane.leading.length - 1];
    out.push(
      <div
        key={`l-${cell.column.field}`}
        className={`pane pane-leading${last ? ' pane-edge-start' : ''}`}
        style={{ width: cell.width, left: pane.gutter + cell.offset }}
      >
        {render(cell, 'leading')}
      </div>,
    );
  }
  out.push(<div key="spacer-before" className="pane-spacer" style={{ width: pane.spacerBefore }} />);
  for (const cell of pane.scrolling) {
    out.push(
      <div key={`s-${cell.column.field}`} className="pane" style={{ width: cell.width }}>
        {render(cell, 'scrolling')}
      </div>,
    );
  }
  out.push(<div key="spacer-after" className="pane-spacer" style={{ width: pane.spacerAfter }} />);
  for (const cell of pane.trailing) {
    const first = cell === pane.trailing[0];
    out.push(
      <div
        key={`t-${cell.column.field}`}
        className={`pane pane-trailing${first ? ' pane-edge-end' : ''}`}
        style={{ width: cell.width, right: pane.trailingWidth - cell.end }}
      >
        {render(cell, 'trailing')}
      </div>,
    );
  }
  return out;
}
