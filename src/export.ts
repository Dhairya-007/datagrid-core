/**
 * Exporting the current view to text formats.
 *
 * @module
 */

import { ColumnType, type GridColumn } from './column';
import { parseDecimal } from './editing';
import type { GroupNode } from './group';
import type { GridResult } from './query';
import type { GroupExpansionState } from './rows';

/** Shaping options shared by the text exporters. */
export interface ExportOptions {
  includeHeader?: boolean;

  /** Columns to export, in order. Defaults to every visible column. */
  fields?: readonly string[] | null;

  delimiter?: string;

  /** CRLF by default, which is what spreadsheet software expects of a CSV. */
  lineEnding?: string;

  includeGroupRows?: boolean;
  groupIndent?: string;

  /**
   * Whether to export display text (respecting each column's formatter) or
   * raw values. Raw is the right choice when the file will be re-imported.
   */
  formatted?: boolean;

  /**
   * Neutralises values a spreadsheet would execute as a formula.
   *
   * A cell beginning `=`, `+`, `-`, `@`, tab or carriage return is run as a
   * formula when the file is opened in Excel, Sheets or LibreOffice, which
   * makes an export of user-supplied data a delivery mechanism for
   * [CSV injection](https://owasp.org/www-community/attacks/CSV_Injection).
   *
   * On by default: the unsafe behaviour is only ever noticed after it has
   * been exploited, so it should not be what you get by forgetting. Turn it
   * off only for a file that is machine-read and must round-trip exactly.
   */
  sanitizeFormulas?: boolean;

  /**
   * Prepended to a value that would otherwise be read as a formula.
   *
   * A leading apostrophe is the spreadsheet convention for "treat this as
   * text"; it is consumed on import rather than shown as part of the value.
   */
  formulaPrefix?: string;

  /**
   * Whether a collapsed group exports as its header alone.
   *
   * On by default, because an export documents itself as matching what is on
   * screen and a collapsed group is not on screen. The expansion state was
   * accepted and never read, so every row came out whatever the user had
   * closed. Turn it off to export the whole result regardless.
   */
  respectCollapsed?: boolean;
}

/** Every export option resolved to a value. */
type ResolvedExportOptions = Required<Omit<ExportOptions, 'fields'>> & {
  fields: readonly string[] | null;
};

const defaultExportOptions: ResolvedExportOptions = {
  includeHeader: true,
  fields: null,
  delimiter: ',',
  lineEnding: '\r\n',
  includeGroupRows: true,
  groupIndent: '    ',
  formatted: true,
  sanitizeFormulas: true,
  formulaPrefix: "'",
  respectCollapsed: true,
};

/**
 * Writes rows as delimiter-separated text.
 *
 * Exports what the user is actually looking at — current order, current
 * filters, current grouping — because an export that silently differs from
 * the screen is a bug report waiting to happen.
 */
export class CsvExporter<T> {
  readonly columns: readonly GridColumn<T>[];
  readonly options: ResolvedExportOptions;

  constructor(columns: readonly GridColumn<T>[], options: ExportOptions = {}) {
    this.columns = columns;
    this.options = { ...defaultExportOptions, ...options };
  }

  private get exported(): GridColumn<T>[] {
    const fields = this.options.fields;
    if (fields === null) return this.columns.filter((c) => c.visible);
    const byField = new Map(this.columns.map((c) => [c.field, c]));
    const out: GridColumn<T>[] = [];
    for (const field of fields) {
      const column = byField.get(field);
      if (column !== undefined) out.push(column);
    }
    return out;
  }

  /** Exports a flat list of rows. */
  exportRows(rows: readonly T[]): string {
    const exported = this.exported;
    const numeric = numericFlags(exported);
    const out: string[] = [];
    if (this.options.includeHeader) {
      this.writeLine(
        out,
        exported.map((c) => c.title),
      );
    }
    const cells = new Array<string>(exported.length).fill('');
    for (const row of rows) {
      for (let i = 0; i < exported.length; i++) {
        cells[i] = this.cell(exported[i] as GridColumn<T>, row);
      }
      this.writeLine(out, cells, numeric);
    }
    return out.join('');
  }

  /**
   * Exports a grouped result, writing one indented header line per group.
   *
   * Only the first cell of a row is indented. Indenting every cell turned
   * each number into text with leading spaces — `"    1450"` — so a
   * spreadsheet read the whole column as text and its sums came out empty.
   */
  exportGroups(
    groups: readonly GroupNode<T>[],
    expansion: GroupExpansionState,
  ): string {
    const exported = this.exported;
    const numeric = numericFlags(exported);
    if (exported.length === 0) return '';
    const out: string[] = [];
    if (this.options.includeHeader) {
      this.writeLine(
        out,
        exported.map((c) => c.title),
      );
    }

    const walk = (level: readonly GroupNode<T>[]): void => {
      for (const node of level) {
        if (this.options.includeGroupRows) {
          const label =
            this.options.groupIndent.repeat(node.depth) +
            `${node.label} (${node.rowCount})`;
          // An export with a single column has no trailing cells to pad.
          const padding = new Array<string>(
            Math.max(0, exported.length - 1),
          ).fill('');
          this.writeLine(out, [label, ...padding]);
        }
        // A collapsed group is not on screen, and the export says it matches
        // what is on screen.
        if (this.options.respectCollapsed && !expansion.isExpanded(node.path)) {
          continue;
        }
        if (node.isLeafGroup) {
          const indent = this.options.groupIndent.repeat(node.depth + 1);
          const cells = new Array<string>(exported.length).fill('');
          for (const row of node.rows) {
            for (let i = 0; i < exported.length; i++) {
              const value = this.cell(exported[i] as GridColumn<T>, row);
              cells[i] = i === 0 ? `${indent}${value}` : value;
            }
            this.writeLine(out, cells, numeric);
          }
        } else {
          walk(node.children);
        }
      }
    };

    walk(groups);
    return out.join('');
  }

  /** Exports whichever shape `result` carries. */
  exportResult(
    result: GridResult<T>,
    expansion: GroupExpansionState,
  ): string {
    return result.isGrouped
      ? this.exportGroups(result.groups, expansion)
      : this.exportRows(result.rows);
  }

  private cell(column: GridColumn<T>, row: T): string {
    if (this.options.formatted) return column.formattedValue(row);
    const raw = column.value(row);
    return raw === null || raw === undefined ? '' : String(raw);
  }

  /** Writes one escaped line into `out`. */
  private writeLine(
    out: string[],
    cells: readonly string[],
    numeric?: readonly boolean[],
  ): void {
    for (let i = 0; i < cells.length; i++) {
      if (i > 0) out.push(this.options.delimiter);
      this.writeEscaped(
        out,
        cells[i] as string,
        numeric === undefined || i >= numeric.length || !numeric[i],
      );
    }
    out.push(this.options.lineEnding);
  }

  /**
   * Whether a spreadsheet would execute `value` rather than show it.
   *
   * Leading spaces are skipped: spreadsheets trim them on import, so
   * `"   =cmd"` is executed just as `"=cmd"` is. A grouped export indents its
   * rows, which would otherwise hide a formula from this check. Tabs and
   * carriage returns are not skipped — they are starters in their own right.
   */
  static isFormula(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit === 0x20) continue;
      if (!FORMULA_STARTERS.has(unit)) return false;
      // A negative number starts with `-` and is not a formula. Prefixing it
      // made every negative value in an export read as text.
      return parseDecimal(value.trim()) === null;
    }
    return false;
  }

  /**
   * RFC 4180 quoting: wrap in quotes when the value contains the delimiter, a
   * quote or a newline, and double any embedded quotes.
   */
  private writeEscaped(out: string[], rawValue: string, sanitize = true): void {
    // Sanitise before quoting: the prefix has to end up inside the quotes, or
    // the reader strips it along with them.
    const value =
      sanitize &&
      this.options.sanitizeFormulas &&
      CsvExporter.isFormula(rawValue)
        ? `${this.options.formulaPrefix}${rawValue}`
        : rawValue;
    const delimiterUnit =
      this.options.delimiter.length === 0
        ? -1
        : this.options.delimiter.charCodeAt(0);
    let needsQuotes = false;
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      // " \n \r, or the first code unit of the delimiter.
      if (unit === 0x22 || unit === 0x0a || unit === 0x0d) {
        needsQuotes = true;
        break;
      }
      if (unit === delimiterUnit) {
        needsQuotes = true;
        break;
      }
    }
    if (!needsQuotes) {
      out.push(value);
      return;
    }
    out.push('"', value.replace(/"/g, '""'), '"');
  }
}

/**
 * Characters that start a formula in Excel, Sheets and LibreOffice.
 *
 * The tab and carriage return are included because a leading one is stripped
 * by some readers, exposing the character after it — so `\t=cmd` becomes
 * `=cmd` on import.
 */
const FORMULA_STARTERS = new Set([0x3d, 0x2b, 0x2d, 0x40, 0x09, 0x0d]);

function numericFlags<T>(exported: readonly GridColumn<T>[]): boolean[] {
  return exported.map((c) => c.type === ColumnType.number);
}

/**
 * Splits clipboard text back into a grid of cells: the inverse of
 * {@link toClipboardText}.
 *
 * Accepts the three line endings a clipboard can carry, because the text may
 * have come from any application on any platform. A trailing newline does not
 * produce an empty last row — spreadsheets add one — but an empty line in the
 * middle does, since that is a row of blanks the user copied.
 *
 * Quoted fields are understood, RFC 4180 style: a field wrapped in double
 * quotes may contain the delimiter, a newline, or a doubled `""` quote.
 * Excel, Sheets and LibreOffice all quote such a cell, and reading the text
 * literally split one cell containing a line break into two rows.
 */
export function parseClipboardText(
  text: string,
  options: { delimiter?: string } = {},
): string[][] {
  const delimiter = options.delimiter ?? '\t';
  if (text.length === 0) return [];
  // A trailing line break is punctuation — spreadsheets add one — so it is
  // taken off before parsing rather than becoming a row of one empty cell.
  const body = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n') || text.endsWith('\r')
      ? text.slice(0, -1)
      : text;
  if (body.length === 0) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };

  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < body.length) {
    const char = body[i] as string;
    if (quoted) {
      if (char === '"') {
        if (i + 1 < body.length && body[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      i++;
      continue;
    }
    if (delimiter.length > 0 && body.startsWith(delimiter, i)) {
      endField();
      i += delimiter.length;
      continue;
    }
    if (char === '\r' || char === '\n') {
      endRow();
      i += char === '\r' && i + 1 < body.length && body[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += char;
    i++;
  }
  endRow();
  return rows;
}

/**
 * Serialises a cell range as tab-separated text, the format spreadsheets and
 * most editors accept from the clipboard.
 *
 * A cell containing the delimiter, a line break or a quote is wrapped in
 * quotes with its own quotes doubled, which is what a spreadsheet does and
 * what {@link parseClipboardText} reads back. Writing such a cell literally
 * made one cell holding two lines paste as two rows.
 *
 * Sanitises formulas by default for the same reason the CSV exporter does:
 * pasting a copied range into a spreadsheet is exactly the path
 * {@link CsvExporter.isFormula} guards against.
 */
export function toClipboardText(
  cells: readonly (readonly string[])[],
  options: {
    delimiter?: string;
    sanitizeFormulas?: boolean;
    formulaPrefix?: string;
  } = {},
): string {
  const delimiter = options.delimiter ?? '\t';
  const sanitizeFormulas = options.sanitizeFormulas ?? true;
  const formulaPrefix = options.formulaPrefix ?? "'";

  const cell = (value: string): string => {
    const sanitised =
      sanitizeFormulas && CsvExporter.isFormula(value)
        ? `${formulaPrefix}${value}`
        : value;
    const needsQuotes =
      sanitised.includes('"') ||
      sanitised.includes('\n') ||
      sanitised.includes('\r') ||
      (delimiter.length > 0 && sanitised.includes(delimiter));
    if (!needsQuotes) return sanitised;
    return `"${sanitised.replace(/"/g, '""')}"`;
  };

  return cells.map((row) => row.map(cell).join(delimiter)).join('\n');
}
