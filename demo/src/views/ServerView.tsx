/**
 * The same grid, pointed at a "server".
 *
 * The fake backend is an `InMemoryDataSource` behind an artificial delay: the
 * query the grid hands over is enough to answer with, which is the whole claim
 * `GridQuery` makes. What this view is really showing is everything around the
 * request — the debounce on a typed word, the cancellation of a superseded
 * fetch, server-side paging and infinite scrolling, and an optimistic write
 * that rolls back when the write fails.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AsyncDataSource,
  FetchCancelled,
  GridController,
  InMemoryDataSource,
  sortBy,
  type FetchSignal,
  type GridQuery,
  type GridResult,
} from 'datagrid-core';
import { orderAggregations, orderColumns, orderHeaders } from '../data/columns';
import { CATEGORICAL_FIELDS, makeOrders, type Order } from '../data/orders';
import { DataGrid } from '../grid/DataGrid';
import { useChangeLog, useGridRevision, useTimedAction } from '../grid/useGrid';
import { Segmented } from '../panels/Controls';
import { Inspector, type RequestEntry } from '../panels/Inspector';
import { Stats } from '../panels/Stats';
import { Toolbar } from '../panels/Toolbar';

const GROUP_FIELDS = [
  { field: 'region', label: 'Region' },
  { field: 'channel', label: 'Channel' },
  { field: 'category', label: 'Category' },
  { field: 'status', label: 'Status' },
];

const AGGREGATE_BY_FIELD: Record<string, string> = {
  ref: 'ref.count',
  units: 'units.sum',
  revenue: 'revenue.sum',
  margin: 'margin.average',
};

function sleep(ms: number, signal: FetchSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.onCancel(() => {
      clearTimeout(timer);
      reject(new FetchCancelled('superseded by a newer query'));
    });
  });
}

function describe(query: GridQuery): string {
  const parts: string[] = [];
  if (query.sorts.length > 0) {
    parts.push(`sort ${query.sorts.map((sort) => sort.field).join(', ')}`);
  }
  if (query.filter) parts.push('filter');
  if (query.hasSearch) parts.push(`search "${query.search}"`);
  if (query.isGrouped) parts.push(`group ${query.groups.map((g) => g.field).join(', ')}`);
  parts.push(`offset ${query.offset}`);
  if (query.limit != null) parts.push(`limit ${query.limit}`);
  return parts.join(' · ');
}

export function ServerView() {
  const [paging, setPaging] = useState<'pages' | 'infinite'>('pages');
  const [latency, setLatency] = useState('450');
  const [flaky, setFlaky] = useState('off');
  const [requests, setRequests] = useState<RequestEntry[]>([]);
  const nextRequest = useRef(1);
  const latencyRef = useRef(Number(latency));
  const flakyRef = useRef(false);
  latencyRef.current = Number(latency);
  flakyRef.current = flaky === 'on';

  const columns = useMemo(() => orderColumns(), []);

  // Stands in for the database. The grid never touches it directly.
  const backend = useMemo(() => {
    const source = new InMemoryDataSource<Order>(makeOrders(50_000));
    source.columns = new Map(columns.map((column) => [column.field, column]));
    return source;
  }, [columns]);

  const source = useMemo(
    () =>
      new AsyncDataSource<Order>(
        async (query): Promise<GridResult<Order>> => {
          const id = nextRequest.current++;
          const started = performance.now();
          const label = describe(query);
          setRequests((log) =>
            [{ id, label, state: 'pending' as const, ms: null }, ...log].slice(0, 24),
          );
          try {
            await sleep(latencyRef.current, query.signal);
            const result = backend.fetchSync(query);
            setRequests((log) =>
              log.map((entry) =>
                entry.id === id
                  ? { ...entry, state: 'done' as const, ms: performance.now() - started }
                  : entry,
              ),
            );
            return result;
          } catch (error) {
            setRequests((log) =>
              log.map((entry) =>
                entry.id === id
                  ? {
                      ...entry,
                      state: 'cancelled' as const,
                      ms: performance.now() - started,
                    }
                  : entry,
              ),
            );
            throw error;
          }
        },
        {
          onCommit: async (original, updated) => {
            await sleep(latencyRef.current, null);
            if (flakyRef.current && Math.random() < 0.45) {
              throw new Error(`The server rejected the write to ${original.ref}`);
            }
            const index = backend.indexOfRow(original);
            if (index >= 0) backend.replaceAt(index, updated);
            return updated;
          },
        },
      ),
    [backend],
  );

  // The controller fetches as soon as it is constructed, so there is nothing
  // to kick off here.
  const grid = useMemo(
    () =>
      new GridController<Order>({
        columns,
        dataSource: source,
        aggregations: orderAggregations(),
        stackedHeaders: orderHeaders(),
        sorts: [sortBy('revenue', { direction: 'descending' })],
        rowKey: (order) => order.id,
        selectionMode: 'cellRange',
        // A typed word is one request, not one per keystroke.
        fetchDebounceMs: 250,
        keepRowsOnError: true,
        groupsExpandedByDefault: false,
        columnFit: 'stretch',
        ...(paging === 'pages' ? { pageSize: 100 } : { loadMoreSize: 200 }),
      }),
    [columns, source, paging],
  );

  useEffect(() => () => grid.dispose(), [grid]);

  const revision = useGridRevision(grid);
  const changes = useChangeLog(grid);
  const [timing, run] = useTimedAction();

  return (
    <div className="view">
      <Stats grid={grid} />
      <Toolbar grid={grid} run={run} groupFields={GROUP_FIELDS} fileName="orders-page.csv">
        <Segmented
          label="Paging"
          value={paging}
          options={[
            { value: 'pages', label: '100 a page' },
            { value: 'infinite', label: 'infinite' },
          ]}
          onChange={setPaging}
        />
        <Segmented
          label="Latency"
          value={latency}
          options={[
            { value: '120', label: '120 ms' },
            { value: '450', label: '450 ms' },
            { value: '1500', label: '1.5 s' },
          ]}
          onChange={setLatency}
        />
        <Segmented
          label="Writes"
          value={flaky}
          options={[
            { value: 'off', label: 'reliable' },
            { value: 'on', label: 'flaky' },
          ]}
          onChange={setFlaky}
        />
        <div className="group">
          <span className="group-label">State</span>
          <span className="server-state">
            {grid.isLoading ? 'fetching' : grid.isFetchPending ? 'debouncing' : 'idle'}
            {grid.isLoadingMore ? ' · appending' : ''}
          </span>
        </div>
        {paging === 'pages' ? (
          <div className="group">
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
          </div>
        ) : (
          <div className="group">
            <span className="group-label">Loaded</span>
            <span className="server-state">
              {grid.loadedRowCount.toLocaleString()} of {grid.matchedCount.toLocaleString()}
            </span>
          </div>
        )}
      </Toolbar>

      {grid.writeError ? (
        <div className="banner">
          {String((grid.writeError as Error).message ?? grid.writeError)} — the row was
          rolled back.
          <button onClick={() => grid.clearWriteError()}>Dismiss</button>
        </div>
      ) : null}

      <div className="workspace">
        <DataGrid
          grid={grid}
          revision={revision}
          run={run}
          valueListFields={CATEGORICAL_FIELDS}
          aggregateIdFor={(field) => AGGREGATE_BY_FIELD[field] ?? null}
          emptyMessage={grid.isLoading ? 'Fetching…' : 'The server returned nothing.'}
          onReachEnd={paging === 'infinite' ? () => void grid.loadMore() : undefined}
        />
        <Inspector grid={grid} changes={changes} timing={timing} requests={requests} />
      </div>

      <p className="hint">
        Type in the search box and watch the request list: keystrokes coalesce into
        one fetch, and a fetch that is overtaken is cancelled rather than left to
        land out of order. Edits are applied optimistically and rolled back if the
        write fails — turn on <b>flaky</b> and edit a number.
      </p>
    </div>
  );
}
