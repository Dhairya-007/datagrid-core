/**
 * The main view: one in-memory source, every feature that does not need a
 * server.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  GridController,
  InMemoryDataSource,
  sortBy,
  type SelectionMode,
} from 'datagrid-core';
import {
  FOOTER_AGGREGATES,
  orderAggregations,
  orderColumns,
  orderHeaders,
} from '../data/columns';
import { formatDay, formatMoney, formatMoneyExact, formatPercent } from '../data/format';
import { CATEGORICAL_FIELDS, makeOrders, type Order } from '../data/orders';
import { DataGrid } from '../grid/DataGrid';
import { useChangeLog, useGridRevision, useTimedAction } from '../grid/useGrid';
import { ColumnsMenu, Pager, Segmented } from '../panels/Controls';
import { Inspector } from '../panels/Inspector';
import { Stats } from '../panels/Stats';
import { Toolbar } from '../panels/Toolbar';

const GROUP_FIELDS = [
  { field: 'region', label: 'Region' },
  { field: 'country', label: 'Country' },
  { field: 'channel', label: 'Channel' },
  { field: 'category', label: 'Category' },
  { field: 'status', label: 'Status' },
  { field: 'priority', label: 'Priority' },
  { field: 'rep', label: 'Rep' },
];

const AGGREGATE_BY_FIELD: Record<string, string> = {
  ref: 'ref.count',
  units: 'units.sum',
  revenue: 'revenue.sum',
  margin: 'margin.average',
  customer: 'customer.countDistinct',
};

const SIZES = [
  { value: '5000', label: '5k' },
  { value: '25000', label: '25k' },
  { value: '100000', label: '100k' },
] as const;

export function OrdersView() {
  const [size, setSize] = useState<string>('25000');
  const [generation, setGeneration] = useState(0);
  const [mode, setMode] = useState<SelectionMode>('cellRange');
  const [frozen, setFrozen] = useState<string>('0');

  const grid = useMemo(() => {
    void generation;
    const rowCount = Number(size);
    return new GridController<Order>({
      columns: orderColumns(),
      dataSource: new InMemoryDataSource<Order>(makeOrders(rowCount)),
      aggregations: orderAggregations(),
      stackedHeaders: orderHeaders(),
      // Opening on a sort rather than on insertion order, so the data bars in
      // the revenue column mean something on the first screen.
      sorts: [sortBy('revenue', { direction: 'descending' })],
      rowKey: (order) => order.id,
      selectionMode: 'cellRange',
      detailHeight: 176,
      groupsExpandedByDefault: false,
      columnFit: 'stretch',
    });
  }, [size, generation]);

  useEffect(() => () => grid.dispose(), [grid]);

  useEffect(() => {
    grid.selection.mode = mode;
    grid.clearSelection();
  }, [grid, mode]);

  useEffect(() => {
    grid.frozenRowCount = Number(frozen);
  }, [grid, frozen]);

  const revision = useGridRevision(grid);
  const changes = useChangeLog(grid);
  const [timing, run] = useTimedAction();

  return (
    <div className="view">
      <Stats grid={grid} />
      <Toolbar grid={grid} run={run} groupFields={GROUP_FIELDS} fileName="orders.csv">
        <Segmented
          label="Rows"
          value={size}
          options={SIZES.map((entry) => ({ ...entry }))}
          onChange={setSize}
        />
        <Pager grid={grid} run={run} />
        <ColumnsMenu grid={grid} run={run} />
        <Segmented
          label="Select"
          value={mode}
          options={[
            { value: 'cellRange', label: 'cells', title: 'Rectangular cell ranges' },
            { value: 'multiRow', label: 'rows', title: 'Whole rows' },
            { value: 'singleRow', label: 'one', title: 'One row at a time' },
          ]}
          onChange={setMode}
        />
        <Segmented
          label="Freeze"
          value={frozen}
          options={[
            { value: '0', label: 'none' },
            { value: '2', label: '2 rows' },
            { value: '5', label: '5 rows' },
          ]}
          onChange={setFrozen}
        />
        <div className="group">
          <button
            onClick={() => {
              setSize('25000');
              setFrozen('0');
              setMode('cellRange');
              setGeneration((value) => value + 1);
            }}
          >
            Reset
          </button>
        </div>
      </Toolbar>

      <div className="workspace">
        <DataGrid
          grid={grid}
          revision={revision}
          run={run}
          valueListFields={CATEGORICAL_FIELDS}
          aggregateIdFor={(field) => AGGREGATE_BY_FIELD[field] ?? null}
          renderDetail={(order) => <OrderDetail order={order} />}
        />
        <Inspector grid={grid} changes={changes} timing={timing} />
      </div>

      <p className="hint">
        {FOOTER_AGGREGATES.length} aggregates run with the pipeline · double-click a
        cell to edit it · the <b>›</b> beside a checkbox opens a detail panel, which
        virtualization counts as a row of its own height
      </p>
    </div>
  );
}

function OrderDetail({ order }: { order: Order }) {
  return (
    <div className="detail">
      <div className="detail-head">
        <span className="detail-ref">{order.ref}</span>
        <span className="detail-customer">{order.customer}</span>
        <span className="detail-pill" data-tone={toneOf(order.status)}>
          {order.status}
        </span>
      </div>
      <div className="detail-grid">
        <Field label="Market" value={`${order.region} · ${order.country}`} />
        <Field label="Channel" value={order.channel} />
        <Field label="Account rep" value={order.rep} />
        <Field label="Line" value={`${order.category} — ${order.product}`} />
        <Field
          label="Pricing"
          value={`${order.units} × ${formatMoneyExact(order.unitPrice)} = ${formatMoney(order.revenue)}`}
        />
        <Field label="Margin" value={formatPercent(order.margin)} />
        <Field label="Placed" value={formatDay(order.placed)} />
        <Field label="Ships" value={formatDay(order.ships)} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-field">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function toneOf(status: string): string {
  switch (status) {
    case 'Paid':
      return 'positive';
    case 'Overdue':
      return 'severe';
    case 'Refunded':
      return 'caution';
    case 'Invoiced':
      return 'info';
    default:
      return 'neutral';
  }
}
