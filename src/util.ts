/**
 * Small internal helpers. Not part of the public surface.
 *
 * @module
 */

/** Clamps `value` into `[low, high]`, with `NaN` resolving to `low`. */
export function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/** Index of the first element at or after `value`, over a sorted array. */
export function lowerBound(
  sorted: readonly number[],
  value: number,
  from = 0,
  to = sorted.length,
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] as number) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Whether two arrays hold the same values in the same order. */
export function listEquals<V>(
  a: readonly V[] | undefined,
  b: readonly V[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Whether two sets hold the same members. */
export function setEquals<V>(a: ReadonlySet<V>, b: ReadonlySet<V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}
