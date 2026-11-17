/**
 * Tree rows.
 *
 * The source holds a flat list and a `TreeSpec` says how to find a row's
 * parent; the engine nests them, keeps the open branches by row identity, and
 * still runs the pipeline over the flat list first — so a search re-roots the
 * tree around whatever matched instead of emptying it.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Aggregation,
  ColorScaleRule,
  DataBarRule,
  GridController,
  InMemoryDataSource,
  TreeSpec,
  ValueToneRule,
  column,
  numberRange,
  type CellTone,
} from 'datagrid-core';
import { formatInteger, formatMoney, formatPercent } from '../data/format';
import { makePortfolio, type Initiative } from '../data/portfolio';
import { DataGrid } from '../grid/DataGrid';
import { useChangeLog, useGridRevision, useTimedAction } from '../grid/useGrid';
import { Segmented } from '../panels/Controls';
import { Inspector } from '../panels/Inspector';
import { Toolbar } from '../panels/Toolbar';

const HEALTH_TONES: Record<string, CellTone> = {
  'On track': 'positive',
  'At risk': 'caution',
  'Off track': 'severe',
  Complete: 'info',
};

const KIND_TONES: Record<string, CellTone> = {
  Division: 'info',
  Programme: 'neutral',
  Project: 'neutral',
  Workstream: 'neutral',
};

const AGGREGATE_BY_FIELD: Record<string, string> = {
  name: 'name.count',
  team: 'team.sum',
  budget: 'budget.sum',
  spend: 'spend.sum',
  variance: 'variance.average',
};

function variance(row: Initiative): number | null {
  return row.budget > 0 ? row.spend / row.budget - 1 : null;
}

export function TreeView() {
  const [expanded, setExpanded] = useState<'open' | 'closed'>('open');

  const grid = useMemo(
    () =>
      new GridController<Initiative>({
        columns: [
          column<Initiative>({
            field: 'name',
            title: 'Initiative',
            value: (row) => row.name,
            width: 280,
            pin: 'start',
          }),
          column<Initiative>({
            field: 'kind',
            title: 'Level',
            value: (row) => row.kind,
            width: 118,
            rule: new ValueToneRule(KIND_TONES),
          }),
          column<Initiative>({
            field: 'owner',
            title: 'Owner',
            value: (row) => row.owner,
            width: 150,
          }),
          column<Initiative>({
            field: 'stage',
            title: 'Stage',
            value: (row) => row.stage,
            width: 118,
          }),
          column<Initiative>({
            field: 'health',
            title: 'Health',
            value: (row) => row.health,
            width: 124,
            rule: new ValueToneRule(HEALTH_TONES, { bold: true }),
            setValue: (row, value) => ({ ...row, health: String(value) }),
            validator: (value) =>
              Object.keys(HEALTH_TONES).includes(String(value))
                ? null
                : `One of ${Object.keys(HEALTH_TONES).join(', ')}`,
          }),
          column<Initiative>({
            field: 'team',
            title: 'People',
            type: 'number',
            value: (row) => row.team,
            width: 104,
            align: 'end',
            format: formatInteger,
            setValue: (row, value) => ({ ...row, team: Math.round(Number(value)) }),
            validator: numberRange({ min: 0, max: 500 }),
          }),
          column<Initiative>({
            field: 'budget',
            title: 'Budget',
            type: 'number',
            value: (row) => row.budget,
            width: 142,
            align: 'end',
            format: formatMoney,
            rule: new DataBarRule({ tone: 'info', fromZero: true }),
          }),
          column<Initiative>({
            field: 'spend',
            title: 'Spend',
            type: 'number',
            value: (row) => row.spend,
            width: 142,
            align: 'end',
            format: formatMoney,
          }),
          column<Initiative>({
            field: 'variance',
            title: 'Variance',
            type: 'number',
            value: variance,
            width: 122,
            align: 'end',
            format: (value) => (typeof value === 'number' ? formatPercent(value) : '—'),
            rule: new ColorScaleRule({ low: 'positive', high: 'severe', midpoint: 0 }),
            tooltip: 'Spend against budget — a derived column, which the engine sorts and filters like any other',
          }),
        ],
        dataSource: new InMemoryDataSource<Initiative>(makePortfolio()),
        aggregations: [
          Aggregation.count('name', { label: 'Rows' }),
          Aggregation.sum('team', { format: formatInteger }),
          Aggregation.sum('budget', { format: formatMoney }),
          Aggregation.sum('spend', { format: formatMoney }),
          Aggregation.average('variance', {
            format: (value) => (typeof value === 'number' ? formatPercent(value) : '—'),
          }),
        ],
        rowKey: (row) => row.id,
        tree: new TreeSpec<Initiative>({ parentOf: (row) => row.parentId }),
        treeExpandedByDefault: expanded === 'open',
        selectionMode: 'cellRange',
        columnFit: 'stretch',
      }),
    [expanded],
  );

  useEffect(() => () => grid.dispose(), [grid]);

  const revision = useGridRevision(grid);
  const changes = useChangeLog(grid);
  const [timing, run] = useTimedAction();

  return (
    <div className="view">
      <Toolbar
        grid={grid}
        run={run}
        groupFields={[
          { field: 'kind', label: 'Level' },
          { field: 'owner', label: 'Owner' },
          { field: 'stage', label: 'Stage' },
          { field: 'health', label: 'Health' },
        ]}
        fileName="portfolio.csv"
      >
        <Segmented
          label="Branches"
          value={expanded}
          options={[
            { value: 'open', label: 'open' },
            { value: 'closed', label: 'closed' },
          ]}
          onChange={setExpanded}
        />
        <div className="group">
          <button onClick={() => run('expandAllRows', () => grid.expandAllRows())}>
            Expand all
          </button>
          <button onClick={() => run('collapseAllRows', () => grid.collapseAllRows())}>
            Collapse all
          </button>
        </div>
      </Toolbar>

      <div className="workspace">
        <DataGrid
          grid={grid}
          revision={revision}
          run={run}
          valueListFields={new Set(['kind', 'owner', 'stage', 'health'])}
          aggregateIdFor={(field) => AGGREGATE_BY_FIELD[field] ?? null}
          emptyMessage="No initiative matches."
        />
        <Inspector grid={grid} changes={changes} timing={timing} />
      </div>

      <p className="hint">
        Search for <b>cutover</b>: a match whose parent did not survive the filter
        becomes a root of its own, so nothing is stranded inside a branch that is no
        longer there. Grouping wins over a tree — group by <b>Owner</b> and the
        indent becomes the group's, because two hierarchies cannot share one.
      </p>
    </div>
  );
}
