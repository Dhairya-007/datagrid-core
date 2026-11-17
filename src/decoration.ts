/**
 * Conditional formatting: turning a value into visual emphasis.
 *
 * The rules live in the engine, not in the view, for the same reason sorting
 * does: deciding that 1 200 ms is "severe" and that it fills 94% of a data
 * bar is a judgement about data, it is testable without rendering a frame,
 * and every adapter should make it identically. What the engine deliberately
 * does **not** decide is what severe looks like — that is a colour, and
 * colours belong to the theme.
 *
 * @module
 */

import { compareValues, type CellValue } from './compare';
import { clamp } from './util';

/**
 * The meaning of a cell's emphasis, which an adapter maps to real colours.
 *
 * Semantic rather than literal so one rule set reads correctly in light and
 * dark, and so a design system can substitute its own palette.
 */
export const CellTone = {
  neutral: 'neutral',
  info: 'info',
  positive: 'positive',
  caution: 'caution',
  severe: 'severe',
} as const;

export type CellTone = (typeof CellTone)[keyof typeof CellTone];

/** Options for a {@link CellDecoration}. */
export interface CellDecorationOptions {
  tone?: CellTone;
  intensity?: number;
  bar?: number | null;
  bold?: boolean;
}

/**
 * How a cell should be emphasised.
 *
 * A value type with no colours in it: {@link CellDecoration.tone} says what
 * it means, {@link CellDecoration.intensity} says how strongly, and
 * {@link CellDecoration.bar} asks for a proportional bar behind the text.
 */
export class CellDecoration {
  /** The emphasis a plain cell carries. */
  static readonly none: CellDecoration = new CellDecoration();

  readonly tone: CellTone;

  /** How strongly to apply {@link tone}, from 0 (not at all) to 1. */
  readonly intensity: number;

  /** Fraction of the cell to fill with a bar, or null for no bar. */
  readonly bar: number | null;

  /** Whether the value should be emphasised in weight as well as colour. */
  readonly bold: boolean;

  constructor(options: CellDecorationOptions = {}) {
    const { tone = CellTone.neutral, intensity = 1, bar, bold = false } = options;
    this.tone = tone;
    this.intensity = intensity;
    this.bar = bar ?? null;
    this.bold = bold;
    Object.freeze(this);
  }

  get isEmpty(): boolean {
    return this.tone === CellTone.neutral && this.bar === null && !this.bold;
  }

  copyWith(options: CellDecorationOptions): CellDecoration {
    return new CellDecoration({
      tone: options.tone ?? this.tone,
      intensity: options.intensity ?? this.intensity,
      bar: options.bar === undefined ? this.bar : options.bar,
      bold: options.bold ?? this.bold,
    });
  }

  equals(other: unknown): boolean {
    return (
      other instanceof CellDecoration &&
      other.tone === this.tone &&
      other.intensity === this.intensity &&
      other.bar === this.bar &&
      other.bold === this.bold
    );
  }

  toString(): string {
    return `CellDecoration(${this.tone}, intensity: ${this.intensity}, bar: ${String(this.bar)})`;
  }
}

/** Options for {@link ColumnStats}. */
export interface ColumnStatsOptions {
  min: CellValue;
  max: CellValue;
  count: number;
  nullCount: number;
  sum?: number | null;
  numberCount?: number;
}

/**
 * Range of a column's values, so a rule can place one value against the rest.
 *
 * Computed once per data revision by the data source, not per cell: a data
 * bar needs the column's minimum and maximum, and recomputing those while
 * scrolling would make scrolling O(rows) per frame.
 */
export class ColumnStats {
  /** The stats of a column with nothing in it. */
  static readonly empty: ColumnStats = new ColumnStats({
    min: null,
    max: null,
    count: 0,
    nullCount: 0,
  });

  /** Smallest and largest non-null values, by {@link compareValues}. */
  readonly min: CellValue;
  readonly max: CellValue;

  /** Non-null values seen. */
  readonly count: number;

  readonly nullCount: number;

  /** Total of the numeric values, when the column held any. */
  readonly sum: number | null;

  /**
   * How many of the values were numbers.
   *
   * Distinct from {@link count}, which counts every non-null value: a column
   * holding `[10, 'n/a']` has a count of 2 and one number, and dividing the
   * sum by the count made its mean 5.
   */
  readonly numberCount: number;

  constructor(options: ColumnStatsOptions) {
    this.min = options.min;
    this.max = options.max;
    this.count = options.count;
    this.nullCount = options.nullCount;
    this.sum = options.sum ?? null;
    this.numberCount = options.numberCount ?? 0;
    Object.freeze(this);
  }

  get minNumber(): number | null {
    return typeof this.min === 'number' ? this.min : null;
  }

  get maxNumber(): number | null {
    return typeof this.max === 'number' ? this.max : null;
  }

  /** Mean of the *numeric* values, or null when there were none. */
  get mean(): number | null {
    if (this.sum === null || this.numberCount === 0) return null;
    return this.sum / this.numberCount;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Where `value` sits between {@link min} and {@link max}, as 0..1.
   *
   * Returns null when the range cannot be measured: a non-numeric column, an
   * empty one, or one where every value is the same.
   */
  fractionOf(value: CellValue): number | null {
    if (typeof value !== 'number') return null;
    const low = this.minNumber;
    const high = this.maxNumber;
    if (low === null || high === null) return null;
    const span = high - low;
    if (span <= 0) return value === low ? 1 : null;
    return clamp((value - low) / span, 0, 1);
  }

  toString(): string {
    return `ColumnStats(${String(this.min)}..${String(this.max)}, ${this.count} values)`;
  }
}

/** Computes {@link ColumnStats} for one column's values. */
export function computeColumnStats(values: Iterable<CellValue>): ColumnStats {
  let min: CellValue = null;
  let max: CellValue = null;
  let count = 0;
  let nullCount = 0;
  let sum: number | null = null;
  let numberCount = 0;
  for (const value of values) {
    if (value === null || value === undefined) {
      nullCount++;
      continue;
    }
    count++;
    if (min === null || compareValues(value, min) < 0) min = value;
    if (max === null || compareValues(value, max) > 0) max = value;
    if (typeof value === 'number') {
      // A non-finite value would make the total NaN and every data bar with
      // it, so it counts as a value and not as a number.
      if (Number.isFinite(value)) {
        sum = (sum ?? 0) + value;
        numberCount++;
      }
    }
  }
  return new ColumnStats({ min, max, count, nullCount, sum, numberCount });
}

/**
 * Decides how one cell should look, given its value and its column's range.
 *
 * Rules are pure functions of the value: no row, no index, no render context.
 * That keeps them cheap enough to run for every visible cell on every frame,
 * and testable without a grid.
 */
export interface CellRule {
  /** The emphasis for `value`, or null to leave the cell plain. */
  decorate(value: CellValue, stats: ColumnStats): CellDecoration | null;
}

/** Options for {@link DataBarRule}. */
export interface DataBarRuleOptions {
  tone?: CellTone;
  fromZero?: boolean;
  minimumFraction?: number;
}

/**
 * Fills part of the cell in proportion to the value's place in the column.
 *
 * The spreadsheet "data bar": the cheapest way to make a column of numbers
 * readable at a glance.
 */
export class DataBarRule implements CellRule {
  readonly tone: CellTone;

  /**
   * Measures the bar from zero rather than from the column's minimum.
   *
   * From zero is honest when the values are counts or amounts; from the
   * minimum shows more contrast when they are clustered, at the cost of
   * exaggerating small differences.
   */
  readonly fromZero: boolean;

  /** Smallest bar drawn for a non-zero value, so it does not vanish. */
  readonly minimumFraction: number;

  constructor(options: DataBarRuleOptions = {}) {
    this.tone = options.tone ?? CellTone.info;
    this.fromZero = options.fromZero ?? false;
    this.minimumFraction = options.minimumFraction ?? 0.02;
  }

  decorate(value: CellValue, stats: ColumnStats): CellDecoration | null {
    if (typeof value !== 'number') return null;
    let fraction: number | null;
    if (this.fromZero) {
      const high = stats.maxNumber;
      if (high === null || high <= 0) return null;
      fraction = clamp(value / high, 0, 1);
    } else {
      fraction = stats.fractionOf(value);
    }
    if (fraction === null) return null;
    const shown =
      fraction === 0
        ? 0
        : fraction < this.minimumFraction
          ? this.minimumFraction
          : fraction;
    return new CellDecoration({ tone: this.tone, intensity: 1, bar: shown });
  }
}

/** Options for {@link ColorScaleRule}. */
export interface ColorScaleRuleOptions {
  low?: CellTone;
  high?: CellTone;
  midpoint?: number;
  reverse?: boolean;
}

/** Tints the cell by where the value sits in the column's range. */
export class ColorScaleRule implements CellRule {
  /** Tone at the bottom and the top of the range. */
  readonly low: CellTone;
  readonly high: CellTone;

  /** Fraction at which {@link low} gives way to {@link high}. */
  readonly midpoint: number;

  /** Swaps the ends, for columns where small is bad. */
  readonly reverse: boolean;

  constructor(options: ColorScaleRuleOptions = {}) {
    this.low = options.low ?? CellTone.positive;
    this.high = options.high ?? CellTone.severe;
    this.midpoint = options.midpoint ?? 0.5;
    this.reverse = options.reverse ?? false;
  }

  decorate(value: CellValue, stats: ColumnStats): CellDecoration | null {
    let fraction = stats.fractionOf(value);
    if (fraction === null) return null;
    if (this.reverse) fraction = 1 - fraction;
    const isHigh = fraction >= this.midpoint;
    // Intensity ramps from nothing at the midpoint to full at the end, so
    // the middle of a column stays quiet instead of everything being shouted.
    const distance = isHigh
      ? (fraction - this.midpoint) / clamp(1 - this.midpoint, 0.0001, 1)
      : (this.midpoint - fraction) / clamp(this.midpoint, 0.0001, 1);
    return new CellDecoration({
      tone: isHigh ? this.high : this.low,
      intensity: clamp(distance, 0, 1),
    });
  }
}

/** Options for {@link ThresholdRule}. */
export interface ThresholdRuleOptions {
  threshold: NonNullable<CellValue>;
  tone?: CellTone;
  above?: boolean;
  bold?: boolean;
}

/** Applies a tone once the value passes a threshold. */
export class ThresholdRule implements CellRule {
  readonly threshold: NonNullable<CellValue>;

  readonly tone: CellTone;

  /** Whether the rule fires above the threshold or below it. */
  readonly above: boolean;

  readonly bold: boolean;

  constructor(options: ThresholdRuleOptions) {
    this.threshold = options.threshold;
    this.tone = options.tone ?? CellTone.severe;
    this.above = options.above ?? true;
    this.bold = options.bold ?? false;
  }

  decorate(value: CellValue, _stats: ColumnStats): CellDecoration | null {
    if (value === null || value === undefined) return null;
    const cmp = compareValues(value, this.threshold);
    const fires = this.above ? cmp >= 0 : cmp <= 0;
    if (!fires) return null;
    return new CellDecoration({ tone: this.tone, bold: this.bold });
  }
}

/** Options for {@link ValueToneRule}. */
export interface ValueToneRuleOptions {
  caseSensitive?: boolean;
  bold?: boolean;
}

/** Maps discrete values to tones, for status and severity columns. */
export class ValueToneRule implements CellRule {
  /**
   * Value to tone, e.g. `new Map([['error', 'severe'], ['warn', 'caution']])`.
   * A plain object is accepted too, for string keys.
   */
  readonly tones: ReadonlyMap<CellValue, CellTone>;

  readonly caseSensitive: boolean;
  readonly bold: boolean;

  constructor(
    tones: ReadonlyMap<CellValue, CellTone> | Record<string, CellTone>,
    options: ValueToneRuleOptions = {},
  ) {
    this.tones =
      tones instanceof Map
        ? tones
        : new Map<CellValue, CellTone>(
            Object.entries(tones as Record<string, CellTone>),
          );
    this.caseSensitive = options.caseSensitive ?? false;
    this.bold = options.bold ?? true;
  }

  decorate(value: CellValue, _stats: ColumnStats): CellDecoration | null {
    if (value === null || value === undefined) return null;
    let tone = this.tones.get(value);
    if (tone === undefined && !this.caseSensitive && typeof value === 'string') {
      const lowered = value.toLowerCase();
      for (const [key, candidate] of this.tones) {
        if (typeof key === 'string' && key.toLowerCase() === lowered) {
          tone = candidate;
          break;
        }
      }
    }
    if (tone === undefined) return null;
    return new CellDecoration({ tone, bold: this.bold });
  }
}

/**
 * Applies the first rule that fires, in order.
 *
 * Later rules act as fallbacks, so a threshold can take precedence over a
 * colour scale without either knowing about the other.
 */
export class FirstMatchRule implements CellRule {
  readonly rules: readonly CellRule[];

  constructor(rules: readonly CellRule[]) {
    this.rules = rules;
  }

  decorate(value: CellValue, stats: ColumnStats): CellDecoration | null {
    for (const rule of this.rules) {
      const decoration = rule.decorate(value, stats);
      if (decoration !== null) return decoration;
    }
    return null;
  }
}

/**
 * Merges every rule that fires, later ones winning on conflicts.
 *
 * How a data bar and a severity tone combine on the same cell.
 */
export class MergedRule implements CellRule {
  readonly rules: readonly CellRule[];

  constructor(rules: readonly CellRule[]) {
    this.rules = rules;
  }

  decorate(value: CellValue, stats: ColumnStats): CellDecoration | null {
    let merged: CellDecoration | null = null;
    for (const rule of this.rules) {
      const decoration = rule.decorate(value, stats);
      if (decoration === null) continue;
      merged =
        merged === null
          ? decoration
          : merged.copyWith({
              tone:
                decoration.tone === CellTone.neutral
                  ? merged.tone
                  : decoration.tone,
              intensity: decoration.intensity,
              bar: decoration.bar ?? merged.bar,
              bold: merged.bold || decoration.bold,
            });
    }
    return merged;
  }
}
