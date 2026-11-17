/**
 * The headline numbers, which are grid aggregates and nothing else.
 *
 * They move with the filters because the engine recomputes them with the
 * pipeline — there is no second query behind these tiles.
 */
import type { GridController } from 'datagrid-core';
import { formatCompact, formatMoney, formatPercent } from '../data/format';

export interface StatsProps<T> {
  grid: GridController<T>;
}

export function Stats<T>({ grid }: StatsProps<T>) {
  const aggregates = grid.aggregates;
  const revenue = aggregates.get('revenue.sum');
  const margin = aggregates.get('margin.average');
  const customers = aggregates.get('customer.countDistinct');
  const largest = aggregates.get('revenue.largest');
  const shown = grid.matchedCount;
  const total = grid.totalCount;
  const share = total > 0 ? shown / total : 0;

  return (
    <div className="stats">
      <Tile
        label="Matching orders"
        value={formatCompact(shown)}
        foot={
          shown === total
            ? `all ${formatCompact(total)} rows`
            : `${formatPercent(share)} of ${formatCompact(total)}`
        }
      />
      <Tile
        label="Revenue"
        value={typeof revenue === 'number' ? `$${formatCompact(revenue)}` : '—'}
        foot={typeof largest === 'number' ? `largest ${formatMoney(largest)}` : ''}
      />
      <Tile
        label="Average margin"
        value={typeof margin === 'number' ? formatPercent(margin) : '—'}
        foot="one order, one vote"
      />
      <Tile
        label="Customers"
        value={formatCompact(customers)}
        foot={grid.isGrouped ? `${grid.groups.length} grouping level(s)` : 'distinct count'}
      />
    </div>
  );
}

function Tile({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-foot">{foot}</div>
    </div>
  );
}
