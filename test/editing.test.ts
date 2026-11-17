import { describe, expect, it } from 'vitest';
import {
  CellAddress,
  coerceValue,
  ColumnType,
  combineValidators,
  EditOutcome,
  EditSession,
  numberRange,
  requiredValue,
} from '../src/index';
import { Product, productColumnMap } from './fixtures';

function product(): Product {
  return new Product({
    id: 1,
    name: 'Keyboard',
    category: 'Input',
    price: 80,
    stock: 12,
  });
}

function session(field: string, row: Product): EditSession<Product> {
  const column = productColumnMap().get(field);
  if (column === undefined) throw new Error(`no column ${field}`);
  return new EditSession<Product>({
    cell: new CellAddress(0, field),
    column,
    row,
    initialValue: column.value(row),
  });
}

describe('EditSession', () => {
  it('starts clean on the current value', () => {
    const edit = session('name', product());
    expect(edit.value).toBe('Keyboard');
    expect(edit.originalValue).toBe('Keyboard');
    expect(edit.isDirty).toBe(false);
    expect(edit.isValid).toBe(true);
  });

  it('tracks dirtiness as the user types', () => {
    const edit = session('name', product());
    edit.update('Keypad');
    expect(edit.isDirty).toBe(true);
    edit.update('Keyboard');
    expect(edit.isDirty).toBe(false);
  });

  it('validates on change, not only on commit', () => {
    const edit = session('name', product());
    edit.update('');
    expect(edit.error).toBe('Required');
    expect(edit.isValid).toBe(false);
  });

  it('writes through to the row on a valid commit', () => {
    const row = product();
    const edit = session('name', row);
    edit.update('Keypad');
    const result = edit.commit();
    expect(result.isCommitted).toBe(true);
    expect(result.row?.name).toBe('Keypad');
    expect(row.name).toBe('Keypad');
  });

  it('rejects an invalid commit and leaves the row untouched', () => {
    const row = product();
    const edit = session('name', row);
    edit.update('');
    const result = edit.commit();
    expect(result.isRejected).toBe(true);
    expect(result.error).toBe('Required');
    expect(result.row).toBeNull();
    expect(row.name).toBe('Keyboard');
  });

  it('keeps the typed value after a rejection, so it can be corrected', () => {
    const edit = session('price', product());
    edit.update(-5);
    expect(edit.commit().isRejected).toBe(true);
    expect(edit.value).toBe(-5);
    edit.update(10);
    expect(edit.commit().isCommitted).toBe(true);
  });

  it('restores the original value on cancel', () => {
    const row = product();
    const edit = session('name', row);
    edit.update('Nonsense');
    const result = edit.cancel();
    expect(result.outcome).toBe(EditOutcome.cancelled);
    expect(edit.value).toBe('Keyboard');
    expect(edit.error).toBeNull();
    expect(row.name).toBe('Keyboard');
  });

  it('cannot commit a column without a setter', () => {
    const edit = session('category', product());
    edit.update('Other');
    const result = edit.commit();
    expect(result.isRejected).toBe(true);
    expect(result.error).toBe('Column is not editable');
  });

  it('follows its row to a new index when one moves under it', () => {
    const edit = session('name', product());
    edit.update('Keypad');
    edit.relocate(4);
    expect(edit.cell.row).toBe(4);
    expect(edit.value).toBe('Keypad');
  });
});

describe('coerceValue', () => {
  it('parses numbers and rejects nonsense', () => {
    expect(coerceValue('42', ColumnType.number)).toBe(42);
    expect(coerceValue('3.5', ColumnType.number)).toBe(3.5);
    expect(coerceValue('abc', ColumnType.number)).toBeNull();
  });

  it('refuses the numbers no user typed', () => {
    // `Number('0x10')` is 16, and Infinity poisons every sum over the column.
    expect(coerceValue('0x10', ColumnType.number)).toBeNull();
    expect(coerceValue('Infinity', ColumnType.number)).toBeNull();
    expect(coerceValue('NaN', ColumnType.number)).toBeNull();
  });

  it('parses the usual spellings of a boolean', () => {
    expect(coerceValue('true', ColumnType.boolean)).toBe(true);
    expect(coerceValue('YES', ColumnType.boolean)).toBe(true);
    expect(coerceValue('1', ColumnType.boolean)).toBe(true);
    expect(coerceValue('no', ColumnType.boolean)).toBe(false);
    expect(coerceValue('0', ColumnType.boolean)).toBe(false);
    expect(coerceValue('maybe', ColumnType.boolean)).toBeNull();
  });

  it('parses ISO dates', () => {
    expect(coerceValue('2026-03-04', ColumnType.date)).toEqual(
      new Date(2026, 2, 4),
    );
    expect(coerceValue('not a date', ColumnType.date)).toBeNull();
  });

  it('keeps text verbatim, including its whitespace', () => {
    expect(coerceValue('  hello  ', ColumnType.text)).toBe('  hello  ');
  });

  it('turns blank text into null for every type', () => {
    expect(coerceValue('   ', ColumnType.text)).toBeNull();
    expect(coerceValue('', ColumnType.number)).toBeNull();
  });
});

describe('validators', () => {
  it('rejects null and blank text with requiredValue', () => {
    const validate = requiredValue();
    expect(validate(null)).toBe('Required');
    expect(validate('   ')).toBe('Required');
    expect(validate('x')).toBeNull();
    expect(validate(0)).toBeNull();
  });

  it('takes a custom message', () => {
    expect(requiredValue('Name needed')(null)).toBe('Name needed');
  });

  it('bounds a value at both ends with numberRange', () => {
    const validate = numberRange({ min: 0, max: 10 });
    expect(validate(-1)).not.toBeNull();
    expect(validate(11)).not.toBeNull();
    expect(validate(5)).toBeNull();
    expect(validate(0)).toBeNull();
    expect(validate(10)).toBeNull();
  });

  it('passes null through for a required check to catch', () => {
    expect(numberRange({ min: 0 })(null)).toBeNull();
  });

  it('rejects a non-number', () => {
    expect(numberRange({ min: 0 })('abc')).toBe('Must be a number');
  });

  it('rejects NaN, which compares false against every bound', () => {
    expect(numberRange({ min: 0, max: 10 })(Number.NaN)).toBe(
      'Must be a finite number',
    );
  });

  it('reports the first failure when validators are combined', () => {
    const validate = combineValidators([
      requiredValue(),
      numberRange({ min: 10 }),
    ]);
    expect(validate(null)).toBe('Required');
    expect(validate(5)).toBe('Must be at least 10');
    expect(validate(15)).toBeNull();
  });
});
