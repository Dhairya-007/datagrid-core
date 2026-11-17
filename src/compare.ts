/**
 * Ordering primitives shared by sorting, grouping and range filters.
 *
 * @module
 */

/** Anything a cell can hold. The engine never assumes more than this. */
export type CellValue = unknown;

/** Two-argument ordering function, negative / zero / positive. */
export type Comparator<V> = (a: V, b: V) => number;

/**
 * An object that knows how to order itself against its own kind, the way
 * Dart's `Comparable` does. Implement it on a value class to give a column a
 * natural order without writing a comparator.
 */
export interface Comparable<T = unknown> {
  compareTo(other: T): number;
}

function isComparable(value: unknown): value is Comparable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { compareTo?: unknown }).compareTo === 'function'
  );
}

/**
 * Orders two JavaScript numbers totally.
 *
 * `NaN` sorts after every other number and equals itself, and `-0` sorts
 * below `0`. Without both rules a column holding either value orders
 * differently depending on the input order, which breaks the sort contract
 * the rest of the engine relies on.
 */
export function compareNumbers(a: number, b: number): number {
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN || bNaN) {
    if (aNaN && bNaN) return 0;
    return aNaN ? 1 : -1;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === 0 && b === 0) {
    const aNeg = Object.is(a, -0);
    const bNeg = Object.is(b, -0);
    if (aNeg === bNeg) return 0;
    return aNeg ? -1 : 1;
  }
  return 0;
}

/** Orders two strings by UTF-16 code unit, which is a total order. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const RANK_BOOL = 0;
const RANK_NUMBER = 1;
const RANK_DATE = 2;
const RANK_STRING = 3;
const RANK_OTHER = 4;

function typeRank(value: NonNullable<unknown>): number {
  switch (typeof value) {
    case 'boolean':
      return RANK_BOOL;
    case 'number':
    case 'bigint':
      return RANK_NUMBER;
    case 'string':
      return RANK_STRING;
    default:
      return value instanceof Date ? RANK_DATE : RANK_OTHER;
  }
}

/**
 * Compares two numeric values, which may mix `number` and `bigint`.
 *
 * A `bigint` compared by its string form sorted `10n` below `9`. Mixed
 * comparisons use the relational operators, which JavaScript evaluates
 * exactly for a bigint against a number rather than by coercing either side.
 */
function compareNumeric(a: number | bigint, b: number | bigint): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return compareNumbers(a, b);
  }
  if (typeof a === 'number' && Number.isNaN(a)) return 1;
  if (typeof b === 'number' && Number.isNaN(b)) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Whether a value is null or undefined, the two ways a cell can be empty. */
export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Compares two arbitrary cell values in a total, null-safe order.
 *
 * Nulls sort last. Values are ranked by type class first — booleans, then
 * numbers (including `bigint`), then `Date`, then strings, then anything
 * else — and only compared within a class. Ranking by class first is what
 * makes the order *total*: comparing across classes by their string forms
 * made the relation intransitive, so a column holding `9`, `10` and `'5'`
 * ordered differently depending on the input order and broke the sort's
 * contract.
 *
 * Within the "anything else" class, two values of the same constructor that
 * implement {@link Comparable} compare naturally, and everything else
 * compares by its string form so that ordering is at least stable between
 * rebuilds.
 */
export function compareValues(a: CellValue, b: CellValue): number {
  const aNull = isNullish(a);
  const bNull = isNullish(b);
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  // The fast path: the overwhelmingly common case is two values of the same
  // primitive type, and it must not pay for the type ranking below.
  if (typeof a === 'number' && typeof b === 'number') {
    return compareNumbers(a, b);
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return compareStrings(a, b);
  }
  if (a instanceof Date && b instanceof Date) {
    return compareNumbers(a.getTime(), b.getTime());
  }

  const rankA = typeRank(a as NonNullable<unknown>);
  const rankB = typeRank(b as NonNullable<unknown>);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;

  switch (rankA) {
    case RANK_BOOL: {
      const ba = a as boolean;
      const bb = b as boolean;
      if (ba === bb) return 0;
      return ba ? 1 : -1;
    }
    case RANK_NUMBER:
      return compareNumeric(a as number | bigint, b as number | bigint);
    case RANK_DATE:
      return compareNumbers((a as Date).getTime(), (b as Date).getTime());
    case RANK_STRING:
      return compareStrings(a as string, b as string);
    default: {
      if (
        isComparable(a) &&
        isComparable(b) &&
        Object.getPrototypeOf(a) === Object.getPrototypeOf(b)
      ) {
        return a.compareTo(b);
      }
      return compareStrings(stringify(a), stringify(b));
    }
  }
}

/** The display-free string form the engine falls back to for ordering. */
function stringify(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/**
 * Case- and accent-insensitive variant of {@link compareValues} for text
 * columns.
 *
 * Folded equality is broken by the exact comparison, so the order stays total
 * and `'Apple'` and `'apple'` keep a stable relative position. Filters must
 * not use this — an equality test wants {@link compareValuesFolded}, where
 * two values that differ only in case or accent compare equal.
 */
export function compareValuesCaseInsensitive(
  a: CellValue,
  b: CellValue,
): number {
  if (typeof a === 'string' && typeof b === 'string') {
    const byFold = compareStrings(foldText(a), foldText(b));
    // Fall back to the exact comparison so the order stays total.
    return byFold !== 0 ? byFold : compareStrings(a, b);
  }
  return compareValues(a, b);
}

/**
 * Compares values with case and accents folded away and *no* tiebreak, so
 * that `'Apple'`, `'apple'` and `'ápple'` all compare equal.
 *
 * This is the comparison a case-insensitive filter needs. The tiebreaking
 * variant, {@link compareValuesCaseInsensitive}, is correct for a sort order
 * and wrong here: it reports `'Apple' === 'apple'` as a difference, which
 * made a case-insensitive `equals` filter case-sensitive in practice, and
 * made `>=` exclude a value it had just called equal.
 */
export function compareValuesFolded(a: CellValue, b: CellValue): number {
  if (typeof a === 'string' && typeof b === 'string') {
    return compareStrings(foldText(a), foldText(b));
  }
  return compareValues(a, b);
}

/** Whether `a` and `b` are the same value, ignoring case and accents in text. */
export function valuesEqualFolded(a: CellValue, b: CellValue): boolean {
  return compareValuesFolded(a, b) === 0;
}

/**
 * Lowercases `text` and strips the diacritics the Latin alphabet writes with,
 * so that `Crème` folds to `creme` and sorts next to `cream`.
 *
 * Used by case-insensitive sorting, filtering and search. It covers Latin-1
 * Supplement and Latin Extended-A, which is what European data arrives in; it
 * is deliberately not a full Unicode collation, which would need tables this
 * package will not carry.
 */
export function foldText(text: string): string {
  // Text that is already lower-case ASCII folds to itself, and that is the
  // overwhelmingly common case: it is returned unchanged, without the scan
  // and the copy `toLowerCase` would make. A sort that folds a key per row
  // depends on this being free when there is nothing to do.
  let needsWork = false;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if ((unit >= 0x41 && unit <= 0x5a) || unit > 0x7f) {
      needsWork = true;
      break;
    }
  }
  if (!needsWork) return text;

  const lower = text.toLowerCase();
  let needsFolding = false;
  for (let i = 0; i < lower.length; i++) {
    if (lower.charCodeAt(i) > 0x7f) {
      needsFolding = true;
      break;
    }
  }
  if (!needsFolding) return lower;

  let out = '';
  for (let i = 0; i < lower.length; i++) {
    const unit = lower.charCodeAt(i);
    if (unit <= 0x7f) {
      out += lower[i];
      continue;
    }
    const folded = DIACRITICS.get(unit);
    out += folded ?? lower[i];
  }
  return out;
}

/**
 * Lowercase accented code unit -> its unaccented form.
 *
 * Only lowercase keys appear, because {@link foldText} lowercases first. A
 * few entries expand to two letters (`æ` -> `ae`), which is why the values
 * are strings.
 */
const DIACRITICS = new Map<number, string>([
  [0xe0, 'a'],
  [0xe1, 'a'],
  [0xe2, 'a'],
  [0xe3, 'a'],
  [0xe4, 'a'],
  [0xe5, 'a'],
  [0xe6, 'ae'],
  [0xe7, 'c'],
  [0xe8, 'e'],
  [0xe9, 'e'],
  [0xea, 'e'],
  [0xeb, 'e'],
  [0xec, 'i'],
  [0xed, 'i'],
  [0xee, 'i'],
  [0xef, 'i'],
  [0xf0, 'd'],
  [0xf1, 'n'],
  [0xf2, 'o'],
  [0xf3, 'o'],
  [0xf4, 'o'],
  [0xf5, 'o'],
  [0xf6, 'o'],
  [0xf8, 'o'],
  [0xf9, 'u'],
  [0xfa, 'u'],
  [0xfb, 'u'],
  [0xfc, 'u'],
  [0xfd, 'y'],
  [0xff, 'y'],
  [0xfe, 'th'],
  [0xdf, 'ss'],
  [0x101, 'a'],
  [0x103, 'a'],
  [0x105, 'a'],
  [0x107, 'c'],
  [0x109, 'c'],
  [0x10b, 'c'],
  [0x10d, 'c'],
  [0x10f, 'd'],
  [0x111, 'd'],
  [0x113, 'e'],
  [0x115, 'e'],
  [0x117, 'e'],
  [0x119, 'e'],
  [0x11b, 'e'],
  [0x11d, 'g'],
  [0x11f, 'g'],
  [0x121, 'g'],
  [0x123, 'g'],
  [0x125, 'h'],
  [0x127, 'h'],
  [0x129, 'i'],
  [0x12b, 'i'],
  [0x12d, 'i'],
  [0x12f, 'i'],
  [0x131, 'i'],
  [0x135, 'j'],
  [0x137, 'k'],
  [0x13a, 'l'],
  [0x13c, 'l'],
  [0x13e, 'l'],
  [0x140, 'l'],
  [0x142, 'l'],
  [0x144, 'n'],
  [0x146, 'n'],
  [0x148, 'n'],
  [0x14d, 'o'],
  [0x14f, 'o'],
  [0x151, 'o'],
  [0x153, 'oe'],
  [0x155, 'r'],
  [0x157, 'r'],
  [0x159, 'r'],
  [0x15b, 's'],
  [0x15d, 's'],
  [0x15f, 's'],
  [0x161, 's'],
  [0x163, 't'],
  [0x165, 't'],
  [0x167, 't'],
  [0x169, 'u'],
  [0x16b, 'u'],
  [0x16d, 'u'],
  [0x16f, 'u'],
  [0x171, 'u'],
  [0x173, 'u'],
  [0x175, 'w'],
  [0x177, 'y'],
  [0x17a, 'z'],
  [0x17c, 'z'],
  [0x17e, 'z'],
]);

const ZERO = 0x30;
const NINE = 0x39;

function isDigit(unit: number): boolean {
  return unit >= ZERO && unit <= NINE;
}

/**
 * Compares values the way a human reads embedded numbers, so that `item2`
 * sorts before `item10`.
 *
 * Digit runs compare as numbers of any length — `a99999999999999999999` and
 * `a100000000000000000000` order correctly, though neither is a safe integer
 * — and the text between them compares with case and accents folded, broken
 * by the exact comparison so the order stays total.
 *
 * The comparison allocates nothing and builds no `RegExp`: doing either on
 * every call made it dozens of times slower than the default sort over 50k
 * rows. A column that sorts naturally over a large grid should still prefer
 * `GridColumn.sortKey`, which pays per row instead of per comparison.
 */
export function compareValuesNatural(a: CellValue, b: CellValue): number {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return compareValues(a, b);
  }
  const byChunk = compareNaturalFolded(a, b);
  // Equal but for case or accent: break the tie exactly, so the order is
  // total and two spellings keep a stable relative position.
  return byChunk !== 0 ? byChunk : compareStrings(a, b);
}

function compareNaturalFolded(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(j);
    const aDigit = isDigit(ca);
    const bDigit = isDigit(cb);
    if (aDigit && bDigit) {
      // Skip leading zeros: '007' and '7' are the same number, and the
      // length comparison below needs the significant digits only.
      let si = i;
      while (si < a.length && a.charCodeAt(si) === ZERO) si++;
      let sj = j;
      while (sj < b.length && b.charCodeAt(sj) === ZERO) sj++;
      let ei = si;
      while (ei < a.length && isDigit(a.charCodeAt(ei))) ei++;
      let ej = sj;
      while (ej < b.length && isDigit(b.charCodeAt(ej))) ej++;
      const lenA = ei - si;
      const lenB = ej - sj;
      // More significant digits means a larger number, whatever the digits
      // are, which is what makes this exact beyond 2^53.
      if (lenA !== lenB) return lenA < lenB ? -1 : 1;
      for (let k = 0; k < lenA; k++) {
        const da = a.charCodeAt(si + k);
        const db = b.charCodeAt(sj + k);
        if (da !== db) return da < db ? -1 : 1;
      }
      i = ei;
      j = ej;
      continue;
    }
    if (aDigit !== bDigit) {
      // A digit run and a letter at the same position: order by the
      // characters, so 'a1' and 'ab' stay in a defined order.
      return ca < cb ? -1 : 1;
    }
    const fa = foldUnit(ca);
    const fb = foldUnit(cb);
    if (fa !== fb) return fa < fb ? -1 : 1;
    i++;
    j++;
  }
  const restA = a.length - i;
  const restB = b.length - j;
  if (restA === restB) return 0;
  return restA < restB ? -1 : 1;
}

/**
 * Folds one code unit for the natural comparison: ASCII upper case to lower,
 * and a single-letter diacritic to its base letter.
 *
 * Multi-letter expansions such as `æ` cannot be represented by one unit, so
 * they fall through unchanged here; {@link compareValuesNatural}'s exact
 * tiebreak keeps the order total either way.
 */
function foldUnit(unit: number): number {
  if (unit >= 0x41 && unit <= 0x5a) return unit + 0x20;
  if (unit <= 0x7f) return unit;
  const folded = DIACRITICS.get(unit) ?? DIACRITICS.get(lowerUnit(unit));
  if (folded !== undefined && folded.length === 1) return folded.charCodeAt(0);
  return unit;
}

function lowerUnit(unit: number): number {
  const lower = String.fromCharCode(unit).toLowerCase();
  return lower.length === 1 ? lower.charCodeAt(0) : unit;
}

/**
 * A key that sorts like {@link compareValuesNatural} under a plain string
 * comparison, for use as a `GridColumn.sortKey`.
 *
 * Each digit run is rewritten as its length (base 36, itself length-prefixed)
 * followed by its significant digits, so that a longer number always sorts
 * above a shorter one. Computing this once per row turns a natural sort from
 * a per-comparison cost into a per-row one.
 */
export function naturalSortKey(value: CellValue): string {
  if (typeof value !== 'string') {
    return isNullish(value) ? '' : foldText(String(value));
  }
  const text = foldText(value);
  // No digits means no chunking to do, and the folded text is already the
  // key — worth testing for, because building the key character by character
  // allocates where returning the text does not.
  let hasDigit = false;
  for (let i = 0; i < text.length; i++) {
    if (isDigit(text.charCodeAt(i))) {
      hasDigit = true;
      break;
    }
  }
  if (!hasDigit) return text;

  let out = '';
  let i = 0;
  while (i < text.length) {
    const unit = text.charCodeAt(i);
    if (!isDigit(unit)) {
      out += text[i];
      i++;
      continue;
    }
    let start = i;
    while (start < text.length && text.charCodeAt(start) === ZERO) start++;
    let end = start;
    while (end < text.length && isDigit(text.charCodeAt(end))) end++;
    const digits = text.slice(start, end);
    const length = digits.length.toString(36);
    // The length of the length, so that keys with very long digit runs still
    // compare in the right order.
    out += '\u0000';
    out += length.length.toString(36);
    out += length;
    out += digits;
    i = end === i ? i + 1 : end;
  }
  return out;
}
