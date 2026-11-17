// The comparison primitives, which every other stage orders by.
//
// A grid's sort has to be a total order: `Array.sort` may do anything at all
// with a comparator that contradicts itself, so an intransitive comparison is
// not a cosmetic bug but a source of results that differ between runs.
import { describe, expect, it } from 'vitest';
import {
  compareStrings,
  compareValues,
  compareValuesCaseInsensitive,
  compareValuesFolded,
  compareValuesNatural,
  foldText,
  naturalSortKey,
  valuesEqualFolded,
  type CellValue,
} from '../src/index';

describe('compareValues', () => {
  it('orders by type class, so mixed values stay transitive', () => {
    // 9 < 10 numerically, 10 < '5' as text, '5' < 9 as text: a cycle, and a
    // cycle is what made a mixed column sort differently each run.
    expect(compareValues(9, 10)).toBeLessThan(0);
    expect(compareValues(10, '5')).toBeLessThan(0);
    expect(compareValues('5', 9)).toBeGreaterThan(0);

    const values: CellValue[] = [10, '5', 9, true, new Date(2024, 0, 1)];
    for (const a of values) {
      for (const b of values) {
        for (const c of values) {
          if (compareValues(a, b) < 0 && compareValues(b, c) < 0) {
            expect(
              compareValues(a, c),
              `a<b and b<c must mean a<c for ${String(a)}, ${String(b)}, ${String(c)}`,
            ).toBeLessThan(0);
          }
        }
      }
    }
  });

  it('compares a bigint as a number, not as text', () => {
    expect(compareValues(10n, 9)).toBeGreaterThan(0);
    expect(compareValues(9n, 10)).toBeLessThan(0);
    expect(compareValues(2n, 10n)).toBeLessThan(0);
    expect(compareValues(99999999999999999999n, 1.5)).toBeGreaterThan(0);
  });

  it('places nulls last whichever side they are on', () => {
    expect(compareValues(null, 1)).toBeGreaterThan(0);
    expect(compareValues(1, null)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
  });

  it('treats undefined as the same absence as null', () => {
    expect(compareValues(undefined, 1)).toBeGreaterThan(0);
    expect(compareValues(undefined, null)).toBe(0);
  });

  it('orders NaN after every number and -0 below 0', () => {
    expect(compareValues(Number.NaN, 1)).toBeGreaterThan(0);
    expect(compareValues(Number.NaN, Number.NaN)).toBe(0);
    expect(compareValues(-0, 0)).toBeLessThan(0);
  });
});

describe('folding', () => {
  it('folds case and the diacritics Latin text is written with', () => {
    expect(foldText('Crème Brûlée')).toBe('creme brulee');
    expect(foldText('ÉCOLE')).toBe('ecole');
    expect(foldText('straße')).toBe('strasse');
    expect(foldText('plain ascii')).toBe('plain ascii');
  });

  it('sorts an accented word next to its unaccented spelling', () => {
    // Code-unit order puts every accent after `z`, so `école` sorted below
    // `zebra` even though a reader looks for it under E.
    expect(compareValuesCaseInsensitive('école', 'zebra')).toBeLessThan(0);
    expect(compareValuesCaseInsensitive('Apple', 'apricot')).toBeLessThan(0);
  });

  it('breaks a folded tie exactly, so the order stays total', () => {
    expect(compareValuesCaseInsensitive('Apple', 'apple')).not.toBe(0);
    expect(compareValuesCaseInsensitive('apple', 'Apple')).toBe(
      -compareValuesCaseInsensitive('Apple', 'apple'),
    );
  });

  it('calls two spellings equal when folded, with no tiebreak', () => {
    // This is the comparison a case-insensitive filter needs: the tiebreaking
    // variant reports a difference, which is what made `equals: 'apple'` miss
    // `'Apple'`.
    expect(compareValuesFolded('Apple', 'apple')).toBe(0);
    expect(compareValuesFolded('ápple', 'APPLE')).toBe(0);
    expect(valuesEqualFolded('Apple', 'apple')).toBe(true);
    expect(valuesEqualFolded('Apple', 'apricot')).toBe(false);
    expect(compareValuesFolded(5, 5)).toBe(0);
  });
});

describe('compareValuesNatural', () => {
  it('reads embedded numbers the way a human does', () => {
    const codes = ['item10', 'item2', 'item1'].sort(compareValuesNatural);
    expect(codes).toEqual(['item1', 'item2', 'item10']);
  });

  it('orders digit runs that are not safe integers', () => {
    // Both of these are past 2^53, so parsing them gave the same value and
    // the comparison fell back to text.
    expect(
      compareValuesNatural('a99999999999999999999', 'a100000000000000000000'),
    ).toBeLessThan(0);
    expect(
      compareValuesNatural('x000000000000000000007', 'x7'),
      // equal numbers; the exact tiebreak decides
    ).toBeLessThan(0);
  });

  it('ignores leading zeros when comparing numbers', () => {
    const codes = ['v007', 'v10', 'v2'].sort(compareValuesNatural);
    expect(codes).toEqual(['v2', 'v007', 'v10']);
  });

  it('folds case in the text between numbers', () => {
    expect(compareValuesNatural('Item2', 'item10')).toBeLessThan(0);
  });

  it('orders like the comparison naturalSortKey replaces', () => {
    const codes = [
      'item10',
      'item2',
      'Item1',
      'item99999999999999999999',
      'item100000000000000000000',
    ];
    const byComparison = [...codes].sort(compareValuesNatural);
    const byKey = [...codes].sort((a, b) =>
      compareStrings(naturalSortKey(a), naturalSortKey(b)),
    );
    expect(byKey).toEqual(byComparison);
  });
});
