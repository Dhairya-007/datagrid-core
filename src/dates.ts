/**
 * Date handling, kept in one place so every part of the engine agrees.
 *
 * @module
 */

/**
 * Parses an ISO 8601 date or date-time, returning null for anything else.
 *
 * Deliberately stricter than `new Date(text)`, which accepts `"next week's
 * numbers"` as an invalid date but also quietly accepts locale forms such as
 * `"6/1/2026"` whose meaning depends on where the reader is. A filter operand
 * or a pasted cell that is not unambiguously a date should stay text rather
 * than become the wrong instant.
 *
 * A value with no zone is read as local time, matching what a user typing a
 * date into a filter means by it.
 */
export function tryParseDate(text: string): Date | null {
  const match = ISO_8601.exec(text.trim());
  if (match === null) return null;

  const years = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  const hour = match[4] === undefined ? 0 : Number.parseInt(match[4], 10);
  const minute = match[5] === undefined ? 0 : Number.parseInt(match[5], 10);
  const second = match[6] === undefined ? 0 : Number.parseInt(match[6], 10);
  const fraction = match[7] === undefined ? 0 : millisecondsOf(match[7]);

  // A day the month does not have — 31 April, 29 February in a common year —
  // is a typo rather than a date, and `Date` would roll it into the next
  // month instead of saying so.
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(years, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const zone = match[8];
  let stamp: number;
  if (zone === undefined) {
    stamp = localStamp(years, month, day, hour, minute, second, fraction);
  } else {
    stamp = utcStamp(years, month, day, hour, minute, second, fraction);
    const sign = match[10]?.trim();
    if (sign !== undefined && sign.length > 0) {
      const offsetHours = Number.parseInt(match[11] as string, 10);
      const offsetMinutes =
        match[12] === undefined ? 0 : Number.parseInt(match[12], 10);
      if (offsetHours > 23 || offsetMinutes > 59) return null;
      const offset = (offsetHours * 60 + offsetMinutes) * 60000;
      stamp += sign === '-' ? offset : -offset;
    }
  }
  if (Number.isNaN(stamp)) return null;
  return new Date(stamp);
}

const ISO_8601 =
  /^([+-]\d{6}|\d{4})-?(\d\d)-?(\d\d)(?:[ T](\d\d)(?::?(\d\d)(?::?(\d\d)(?:[.,](\d+))?)?)?(( ?[zZ])|( ?[+-])(\d\d)(?::?(\d\d))?)?)?$/;

function millisecondsOf(fraction: string): number {
  const padded = (fraction + '000').slice(0, 3);
  return Number.parseInt(padded, 10);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return MONTH_LENGTHS[month - 1] as number;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Local-time stamp, with years 0-99 kept out of the 1900s. */
function localStamp(
  years: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const date = new Date(years, month - 1, day, hour, minute, second, ms);
  if (years >= 0 && years < 100) date.setFullYear(years);
  return date.getTime();
}

/** UTC stamp, with the same century correction. */
function utcStamp(
  years: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const stamp = Date.UTC(years, month - 1, day, hour, minute, second, ms);
  if (years >= 0 && years < 100) {
    const date = new Date(stamp);
    date.setUTCFullYear(years);
    return date.getTime();
  }
  return stamp;
}

/** Whether `value` is a usable `Date`. */
export function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * The calendar day `value` falls on, at local midnight, or null when it is
 * not a date.
 */
export function startOfDay(value: unknown): Date | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  if (Number.isNaN(time)) return null;
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/** ISO 8601 text for `value`, the form {@link tryParseDate} reads back. */
export function toIsoString(value: Date): string {
  return value.toISOString();
}
