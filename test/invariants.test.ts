// Invariants that must hold for *any* arrangement of the grid, checked
// against randomly generated ones.
//
// The five bugs fixed in 0.3.0 of the Dart original were all of this shape:
// each held for the arrangement someone happened to try and broke for
// another. An example-based test proves one case; these state the rule and
// let the generator look for the case that breaks it.
//
// The seed is fixed, so a failure is reproducible and CI cannot go red for a
// different reason than it went red locally. Raise CASES when hunting.
import { describe, expect, it } from 'vitest';
import {
  CellAddress,
  ColumnPin,
  FilterCondition,
  FilterOperator,
  GridChange,
  GridController,
  GroupSpec,
  isDataRow,
  isGroupRow,
  NullsPosition,
  SelectionMode,
  SortDirection,
  SortSpec,
  type CellValue,
  type DataGridRow,
} from '../src/index';
import { labelsOf, Product, productGrid } from './fixtures';

const CASES = 120;
const SEED = 20261114;

/** A seeded generator, so a failure can be reproduced. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dear = (value: CellValue): CellValue => (value as number) > 100;

const FIELDS = ['name', 'category', 'price', 'stock', 'active'];

/** One randomly generated arrangement of the grid. */
class Arrangement {
  readonly sorts: SortSpec[];
  readonly search: string;
  readonly filter: FilterCondition | null;
  readonly groups: GroupSpec[];
  readonly pageSize: number | null;
  readonly pins: Map<string, ColumnPin>;
  readonly hidden: Set<string>;

  constructor(random: () => number) {
    const int = (bound: number): number => Math.floor(random() * bound);
    const bool = (): boolean => random() < 0.5;

    const shuffled = [...FIELDS];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const swap = shuffled[i] as string;
      shuffled[i] = shuffled[j] as string;
      shuffled[j] = swap;
    }
    const sortCount = int(3);
    this.sorts = [];
    for (let i = 0; i < sortCount; i++) {
      this.sorts.push(
        new SortSpec(shuffled[i] as string, {
          direction: bool() ? SortDirection.ascending : SortDirection.descending,
          nulls: bool() ? NullsPosition.first : NullsPosition.last,
        }),
      );
    }

    const needles = ['', '', '', 'o', 'mo', 'e', 'zzz'];
    this.search = needles[int(needles.length)] as string;

    if (int(3) === 0) {
      this.filter = null;
    } else {
      const options = [
        new FilterCondition({
          field: 'category',
          operator: FilterOperator.equals,
          value: 'Input',
        }),
        new FilterCondition({
          field: 'price',
          operator: FilterOperator.greaterThan,
          value: 70,
        }),
        new FilterCondition({
          field: 'stock',
          operator: FilterOperator.isNotNull,
        }),
        new FilterCondition({
          field: 'active',
          operator: FilterOperator.equals,
          value: true,
        }),
      ];
      this.filter = options[int(options.length)] as FilterCondition;
    }

    switch (int(4)) {
      case 0:
        this.groups = [new GroupSpec('category')];
        break;
      case 1:
        this.groups = [new GroupSpec('active'), new GroupSpec('category')];
        break;
      case 2:
        this.groups = [new GroupSpec('price', { keyOf: dear })];
        break;
      default:
        this.groups = [];
    }

    const sizes = [null, null, 1, 2, 4, 100];
    this.pageSize = sizes[int(sizes.length)] as number | null;

    this.pins = new Map<string, ColumnPin>();
    for (const field of FIELDS) {
      switch (int(6)) {
        case 0:
          this.pins.set(field, ColumnPin.start);
          break;
        case 1:
          this.pins.set(field, ColumnPin.end);
          break;
        default:
          break;
      }
    }

    this.hidden = new Set<string>();
    for (const field of FIELDS) {
      // Never hide them all: a grid with no columns is its own test.
      if (int(8) === 0 && this.hidden.size < 3) this.hidden.add(field);
    }
  }

  /** Builds a controller in this arrangement. */
  build(options: { identified?: boolean } = {}): GridController<Product> {
    const grid = productGrid({
      identified: options.identified ?? true,
      selectionMode: SelectionMode.cellRange,
    });
    grid.batch(() => {
      grid.setSorts(this.sorts);
      grid.setSearch(this.search);
      if (this.filter !== null) grid.setFilter(this.filter);
      grid.setGroups(this.groups);
      grid.setPageSize(this.pageSize);
      for (const [field, pin] of this.pins) grid.setColumnPin(field, pin);
      for (const field of this.hidden) grid.setColumnVisible(field, false);
    });
    return grid;
  }

  toString(): string {
    return (
      `Arrangement(sorts: [${this.sorts.join(', ')}], search: "${this.search}", ` +
      `filter: ${String(this.filter)}, groups: [${this.groups.join(', ')}], ` +
      `pageSize: ${String(this.pageSize)}, pins: ${JSON.stringify([...this.pins])}, ` +
      `hidden: ${JSON.stringify([...this.hidden])})`
    );
  }
}

const random = seeded(SEED);
const arrangements: Arrangement[] = [];
for (let i = 0; i < CASES; i++) arrangements.push(new Arrangement(random));

describe('every arrangement', () => {
  it('has group counts that add up to the rows that matched', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      if (!grid.isGrouped) continue;
      const top = grid.visibleRows
        .toArray()
        .filter(isGroupRow)
        .filter((h) => h.depth === 0);
      const counted = top.reduce((sum, h) => sum + h.rowCount, 0);
      expect(counted, String(arrangement)).toBe(grid.matchedCount);
    }
  });

  it('shows only rows the filters admitted', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      const shown = grid.visibleRows
        .toArray()
        .filter(isDataRow)
        .map((row) => row.data);
      expect(shown.length, String(arrangement)).toBeLessThanOrEqual(
        grid.matchedCount,
      );
      const filter = arrangement.filter;
      if (filter !== null) {
        for (const row of shown) {
          expect(
            filter.matchesRow((f) => grid.column(f)?.value(row)),
            `${row.name} fails the filter in ${String(arrangement)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('exports the same columns as the screen, in the same order', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      // Compared against the layout, not against visibleFields: the layout is
      // what gets painted, so it is the only ground truth for "the screen".
      // Checking one derived order against another would pass while both were
      // wrong together.
      const onScreen = grid
        .layoutFor(1800)
        .allColumns.map((c) => c.column.title);
      if (onScreen.length === 0) continue;
      expect(
        (grid.exportCsv().split('\r\n')[0] as string).split(','),
        String(arrangement),
      ).toEqual(onScreen);
    }
  });

  it('lays the panes out as the display order, split in three', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      const laid = grid.layoutFor(1800).allColumns.map((c) => c.column.field);
      expect(laid, String(arrangement)).toEqual(grid.visibleFields);
    }
  });

  it('walks the columns one screen position at a time', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      // Taken from the layout for the same reason the export invariant is.
      const fields = grid
        .layoutFor(1800)
        .allColumns.map((c) => c.column.field);
      if (fields.length === 0 || grid.rowCount === 0) continue;
      grid.selectCell(new CellAddress(0, fields[0] as string));
      for (let i = 1; i < fields.length; i++) {
        grid.moveActiveCell(0, 1);
        expect(grid.selection.activeCell?.field, String(arrangement)).toBe(
          fields[i],
        );
      }
    }
  });

  it('keeps the selection on the same row across a re-sort', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      const index = grid.visibleRows.findIndex((r) => isDataRow(r));
      if (index < 0) continue;
      grid.selectRow(index);
      const before = grid.selectedData[0]?.id;

      grid.setSorts([
        new SortSpec('price', { direction: SortDirection.descending }),
        new SortSpec('name'),
      ]);
      if (grid.selection.rowCount === 0) {
        // Only legitimate if that row is no longer on screen at all: a paged
        // grid can sort the row onto another page.
        const onScreen = grid.visibleRows
          .toArray()
          .filter(isDataRow)
          .map((row) => row.data.id);
        expect(onScreen, String(arrangement)).not.toContain(before);
        continue;
      }
      expect(grid.selectedData[0]?.id, String(arrangement)).toBe(before);
    }
  });

  it('slices the matched rows into pages that cover them once each', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      const size = grid.pageSize;
      if (size === null || grid.isGrouped) continue;
      const seen: number[] = [];
      for (let page = 0; page < grid.pageCount; page++) {
        grid.goToPage(page);
        expect(grid.rowCount, String(arrangement)).toBeLessThanOrEqual(size);
        seen.push(
          ...grid.visibleRows
            .toArray()
            .filter(isDataRow)
            .map((row) => row.data.id),
        );
      }
      expect(seen.length, String(arrangement)).toBe(grid.matchedCount);
      expect(
        new Set(seen).size,
        `a row appeared on two pages in ${String(arrangement)}`,
      ).toBe(seen.length);
    }
  });

  it('copies the whole visible range as one line per row of the span', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      const fields = grid.visibleFields;
      const rows = grid.visibleRows.toArray().filter(isDataRow);
      if (fields.length === 0 || rows.length < 2) continue;
      const first = rows[0] as DataGridRow<Product>;
      const last = rows[rows.length - 1] as DataGridRow<Product>;
      grid.selectCell(new CellAddress(first.index, fields[0] as string));
      grid.extendSelectionTo(
        new CellAddress(last.index, fields[fields.length - 1] as string),
      );
      const lines = grid.copySelectionAsText().split('\n');
      // The range spans the group headers between the rows as well, so the
      // count is the span, not the row count.
      expect(lines.length, String(arrangement)).toBe(
        last.index - first.index + 1,
      );
      for (const line of lines) {
        expect(line.split('\t').length, String(arrangement)).toBe(
          fields.length,
        );
      }
    }
  });

  it('gives the same rows when it is run again', () => {
    for (const arrangement of arrangements) {
      const first = labelsOf(arrangement.build());
      const second = labelsOf(arrangement.build());
      expect(first, String(arrangement)).toEqual(second);
    }
  });

  it('restores from a saved view exactly as it was', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      const restored = productGrid({ identified: true });
      restored.restoreState(grid.saveState(), {
        resolveGroup: (g) =>
          g.field === 'price' ? g.restore({ keyOf: dear }) : g,
      });
      expect(labelsOf(restored), String(arrangement)).toEqual(labelsOf(grid));
      expect(restored.visibleFields, String(arrangement)).toEqual(
        grid.visibleFields,
      );
      expect(restored.matchedCount, String(arrangement)).toBe(
        grid.matchedCount,
      );
    }
  });

  it('never claims the rows changed in a selection notification', () => {
    for (const arrangement of arrangements) {
      const grid = arrangement.build();
      if (grid.rowCount === 0) continue;
      const seen: ReadonlySet<GridChange>[] = [];
      grid.addChangeListener((changes) => seen.push(changes));
      grid.selectRow(0);
      grid.clearSelection();
      for (const changes of seen) {
        expect(changes, String(arrangement)).toEqual(
          new Set([GridChange.selection]),
        );
      }
    }
  });
});
