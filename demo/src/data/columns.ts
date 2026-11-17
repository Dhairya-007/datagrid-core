/**
 * The column set, which is where most of a grid's behaviour is declared.
 *
 * Types, formatters, comparators, editability, validation and conditional
 * formatting all hang off a column, so the renderer stays dumb: it asks the
 * engine for a formatted value and a decoration and draws what it is told.
 */
import {
  Aggregation,
  ColorScaleRule,
  DataBarRule,
  HeaderBand,
  HeaderRow,
  ThresholdRule,
  ValueToneRule,
  column,
  combineValidators,
  numberRange,
  requiredValue,
  type CellTone,
  type CellValue,
  type GridColumn,
} from 'datagrid-core';
import {
  formatDay,
  formatInteger,
  formatMoney,
  formatMoneyExact,
  formatPercent,
} from './format';
import type { Order } from './orders';

const STATUS_TONES: Record<string, CellTone> = {
  Paid: 'positive',
  Invoiced: 'info',
  Pending: 'neutral',
  Overdue: 'severe',
  Refunded: 'caution',
  Draft: 'neutral',
};

const PRIORITY_TONES: Record<string, CellTone> = {
  Critical: 'severe',
  High: 'caution',
  Normal: 'neutral',
  Low: 'info',
};

const ALLOWED_STATUSES = new Set(Object.keys(STATUS_TONES));

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function orderColumns(): GridColumn<Order>[] {
  return [
    column<Order>({
      field: 'ref',
      title: 'Order',
      value: (o) => o.ref,
      width: 124,
      pin: 'start',
      groupable: false,
    }),
    column<Order>({
      field: 'customer',
      title: 'Customer',
      value: (o) => o.customer,
      width: 184,
      pin: 'start',
      setValue: (o, v) => ({ ...o, customer: String(v).trim() }),
      validator: requiredValue('A customer is required'),
    }),
    column<Order>({
      field: 'revenue',
      title: 'Revenue',
      type: 'number',
      value: (o) => o.revenue,
      width: 150,
      align: 'end',
      format: formatMoney,
      rule: new DataBarRule({ tone: 'info', fromZero: true }),
      tooltip: 'Units × unit price, with a data bar scaled to the column',
    }),
    column<Order>({
      field: 'margin',
      title: 'Margin',
      type: 'number',
      value: (o) => o.margin,
      width: 106,
      align: 'end',
      format: formatPercent,
      rule: new ColorScaleRule({ low: 'severe', high: 'positive', midpoint: 0.35 }),
      setValue: (o, v) => ({ ...o, margin: Number(v) }),
      validator: combineValidators([
        numberRange({ min: 0, max: 1, message: 'A fraction between 0 and 1' }),
      ]),
    }),
    column<Order>({
      field: 'status',
      title: 'Status',
      value: (o) => o.status,
      width: 118,
      rule: new ValueToneRule(STATUS_TONES, { bold: true }),
      setValue: (o, v) => ({ ...o, status: String(v).trim() }),
      validator: (v) =>
        ALLOWED_STATUSES.has(String(v).trim())
          ? null
          : `One of ${[...ALLOWED_STATUSES].join(', ')}`,
    }),
    column<Order>({
      field: 'priority',
      title: 'Priority',
      value: (o) => o.priority,
      width: 108,
      rule: new ValueToneRule(PRIORITY_TONES),
    }),
    column<Order>({
      field: 'region',
      title: 'Region',
      value: (o) => o.region,
      width: 96,
    }),
    column<Order>({
      field: 'country',
      title: 'Country',
      value: (o) => o.country,
      width: 128,
    }),
    column<Order>({
      field: 'channel',
      title: 'Channel',
      value: (o) => o.channel,
      width: 110,
    }),
    column<Order>({
      field: 'rep',
      title: 'Account rep',
      value: (o) => o.rep,
      width: 150,
    }),
    column<Order>({
      field: 'category',
      title: 'Category',
      value: (o) => o.category,
      width: 128,
    }),
    column<Order>({
      field: 'product',
      title: 'Product',
      value: (o) => o.product,
      width: 158,
    }),
    column<Order>({
      field: 'units',
      title: 'Units',
      type: 'number',
      value: (o) => o.units,
      width: 96,
      align: 'end',
      format: formatInteger,
      rule: new ThresholdRule({ threshold: 80, tone: 'caution', bold: true }),
      setValue: (o, v) => {
        const units = Math.round(Number(v));
        return { ...o, units, revenue: round2(units * o.unitPrice) };
      },
      validator: numberRange({ min: 1, max: 9999, message: '1 to 9,999 units' }),
    }),
    column<Order>({
      field: 'unitPrice',
      title: 'Unit price',
      type: 'number',
      value: (o) => o.unitPrice,
      width: 122,
      align: 'end',
      format: formatMoneyExact,
      setValue: (o, v) => {
        const unitPrice = round2(Number(v));
        return { ...o, unitPrice, revenue: round2(o.units * unitPrice) };
      },
      validator: numberRange({ min: 0, max: 1_000_000 }),
    }),
    column<Order>({
      field: 'placed',
      title: 'Placed',
      type: 'date',
      value: (o) => o.placed,
      width: 128,
      format: formatDay,
    }),
    column<Order>({
      field: 'ships',
      title: 'Ships',
      type: 'date',
      value: (o) => o.ships,
      width: 128,
      format: formatDay,
      pin: 'end',
    }),
  ];
}

/** Header rows drawn above the titles, spanning groups of columns. */
export function orderHeaders(): HeaderRow[] {
  return [
    new HeaderRow([
      new HeaderBand({ title: 'Account', fields: ['ref', 'customer'] }),
      new HeaderBand({
        title: 'Money',
        fields: ['revenue', 'margin'],
        align: 'center',
      }),
      new HeaderBand({
        title: 'State',
        fields: ['status', 'priority'],
        align: 'center',
      }),
      new HeaderBand({
        title: 'Market',
        fields: ['region', 'country', 'channel', 'rep'],
        align: 'center',
      }),
      new HeaderBand({
        title: 'Line item',
        fields: ['category', 'product', 'units', 'unitPrice'],
        align: 'center',
      }),
      new HeaderBand({
        title: 'Dates',
        fields: ['placed', 'ships'],
        align: 'center',
      }),
    ]),
  ];
}

export function orderAggregations(): Aggregation[] {
  return [
    Aggregation.count('ref', { label: 'Orders', format: formatInteger }),
    Aggregation.sum('units', { label: 'Units', format: formatInteger }),
    Aggregation.sum('revenue', { label: 'Revenue', format: formatMoney }),
    Aggregation.average('margin', { label: 'Avg margin', format: formatPercent }),
    Aggregation.max('revenue', {
      id: 'revenue.largest',
      label: 'Largest order',
      format: formatMoney,
    }),
    Aggregation.countDistinct('customer', {
      label: 'Customers',
      format: formatInteger,
    }),
  ];
}

/** The aggregate ids the footer and group headers read, in order. */
export const FOOTER_AGGREGATES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'ref.count', label: 'Orders' },
  { id: 'customer.countDistinct', label: 'Customers' },
  { id: 'units.sum', label: 'Units' },
  { id: 'revenue.sum', label: 'Revenue' },
  { id: 'margin.average', label: 'Avg margin' },
  { id: 'revenue.largest', label: 'Largest' },
];

/** Formats an aggregate for display, since the footer reads ids not specs. */
export function formatAggregate(id: string, value: CellValue): string {
  if (value == null) return '—';
  if (id === 'revenue.sum' || id === 'revenue.largest') return formatMoney(value);
  if (id === 'margin.average') return formatPercent(value);
  return formatInteger(typeof value === 'number' ? value : Number(value));
}
