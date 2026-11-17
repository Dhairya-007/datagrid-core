/**
 * The engine, on screen.
 *
 * A demo of a headless library should show what the renderer is reading, so
 * this panel prints the query a data source would receive, the change sets the
 * controller emits, and the saved view the whole arrangement serialises to.
 */
import { useState } from 'react';
import type { GridController } from 'datagrid-core';
import type { ChangeEntry } from '../grid/useGrid';

const TABS = ['Query', 'Changes', 'View', 'Engine', 'Keys'] as const;
type Tab = (typeof TABS)[number];

export interface RequestEntry {
  id: number;
  label: string;
  state: 'pending' | 'done' | 'cancelled';
  ms: number | null;
}

export interface InspectorProps<T> {
  grid: GridController<T>;
  changes: ChangeEntry[];
  timing: { label: string; ms: number } | null;
  requests?: readonly RequestEntry[];
}

export function Inspector<T>({ grid, changes, timing, requests }: InspectorProps<T>) {
  const [tab, setTab] = useState<Tab>('Query');

  return (
    <aside className="inspector">
      <nav className="inspector-tabs">
        {TABS.map((candidate) => (
          <button
            key={candidate}
            className={tab === candidate ? 'on' : ''}
            onClick={() => setTab(candidate)}
          >
            {candidate}
          </button>
        ))}
      </nav>

      {tab === 'Query' ? (
        <>
          <p className="inspector-note">
            What <code>GridDataSource.fetch</code> is handed. It is serialisable on
            purpose: a REST or SQL backend translates this instead of guessing.
          </p>
          <pre className="code">{JSON.stringify(grid.query.toJSON(), null, 2)}</pre>
          {requests ? (
            <>
              <h4>Requests</h4>
              <ul className="requests">
                {requests.map((request) => (
                  <li key={request.id} className={`state-${request.state}`}>
                    <b>#{request.id}</b>
                    <span>{request.label}</span>
                    <i>
                      {request.state}
                      {request.ms == null ? '' : ` · ${Math.round(request.ms)} ms`}
                    </i>
                  </li>
                ))}
                {requests.length === 0 ? <li className="muted">No fetches yet</li> : null}
              </ul>
            </>
          ) : null}
        </>
      ) : null}

      {tab === 'Changes' ? (
        <>
          <p className="inspector-note">
            <code>addChangeListener</code> says <em>what</em> changed, so a click on a
            row repaints the selection instead of rebuilding every row.
          </p>
          <ul className="changes">
            {changes.map((entry) => (
              <li key={entry.id}>
                <span className="changes-time">
                  {new Date(entry.at).toLocaleTimeString('en-GB')}
                </span>
                {entry.changes.map((change) => (
                  <span key={change} className={`change change-${change}`}>
                    {change}
                  </span>
                ))}
              </li>
            ))}
            {changes.length === 0 ? <li className="muted">Interact with the grid</li> : null}
          </ul>
        </>
      ) : null}

      {tab === 'View' ? (
        <>
          <p className="inspector-note">
            <code>saveState()</code> — sorts, filters, grouping, column order, widths,
            pins and paging, as JSON. Store it per user and the grid comes back as they
            left it.
          </p>
          <pre className="code">{JSON.stringify(grid.saveState().toJSON(), null, 2)}</pre>
        </>
      ) : null}

      {tab === 'Engine' ? (
        <>
          <p className="inspector-note">
            Timings are the engine alone: the clock stops before React paints.
          </p>
          <dl className="facts">
            <Fact
              label="Last operation"
              value={timing ? `${timing.label} · ${timing.ms.toFixed(1)} ms` : '—'}
            />
            <Fact label="Visible rows" value={grid.rowCount.toLocaleString()} />
            <Fact label="Matched rows" value={grid.matchedCount.toLocaleString()} />
            <Fact label="Total rows" value={grid.totalCount.toLocaleString()} />
            <Fact
              label="Columns"
              value={`${grid.visibleColumns.length} of ${grid.columns.length}`}
            />
            <Fact label="Sort levels" value={String(grid.sorts.length)} />
            <Fact label="Column filters" value={String(grid.columnFilters.size)} />
            <Fact label="Selected rows" value={grid.selection.rowCount.toLocaleString()} />
            <Fact label="Selection coverage" value={grid.selectionCoverage} />
            <Fact label="Undo depth" value={String(grid.history.length)} />
            <Fact label="Pending writes" value={grid.hasPendingWrites ? 'yes' : 'none'} />
            <Fact label="Source" value={grid.sourceCapabilities.isLocal ? 'in memory' : 'async'} />
          </dl>
        </>
      ) : null}

      {tab === 'Keys' ? (
        <dl className="facts">
          <Fact label="Arrows" value="move the active cell" />
          <Fact label="Shift + arrows" value="extend the range" />
          <Fact label="Home / End" value="first / last column" />
          <Fact label="Ctrl + Home / End" value="first / last cell" />
          <Fact label="PageUp / PageDown" value="a screenful" />
          <Fact label="Tab" value="next editable cell" />
          <Fact label="Enter or F2" value="edit the active cell" />
          <Fact label="Escape" value="cancel the edit" />
          <Fact label="Space" value="select the row" />
          <Fact label="Ctrl + A" value="select every row" />
          <Fact label="Ctrl + C / V" value="copy as TSV / paste a range" />
          <Fact label="Ctrl + Z / Y" value="undo / redo" />
          <Fact label="Click a header" value="sort — shift-click adds a level" />
          <Fact label="Drag a header" value="reorder; drag its edge to resize" />
          <Fact label="Double-click an edge" value="fit the column to its contents" />
        </dl>
      ) : null}
    </aside>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
