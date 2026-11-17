/** Formatters shared by the columns, the footer and the group headers. */

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const moneyExact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integer = new Intl.NumberFormat('en-US');

const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const day = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatMoney(value: unknown): string {
  return typeof value === 'number' ? money.format(value) : '';
}

export function formatMoneyExact(value: unknown): string {
  return typeof value === 'number' ? moneyExact.format(value) : '';
}

export function formatInteger(value: unknown): string {
  return typeof value === 'number' ? integer.format(value) : '';
}

export function formatPercent(value: unknown): string {
  return typeof value === 'number' ? percent.format(value) : '';
}

export function formatDay(value: unknown): string {
  return value instanceof Date ? day.format(value) : '—';
}

/** A big number shortened for a stat tile: 12.4M, 318k, 942. */
export function formatCompact(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${Math.round(value / 1e3)}k`;
  return integer.format(Math.round(value));
}
