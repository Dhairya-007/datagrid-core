// The package root is a promise; this says what is in it.
//
// Anything exported is something a user can hold, and taking it back later is
// a breaking change. The pipeline stages and the few implementation types the
// engine hands around live in `gridcore/advanced` instead, so that the
// surface an application sees is the surface it needs.
import { describe, expect, it } from 'vitest';
import * as advanced from '../src/advanced';
import * as root from '../src/index';

describe('the package root', () => {
  it('carries what an application holds', () => {
    // A compile-time assertion as much as a test: if any of these stopped
    // being exported, this file would not typecheck.
    for (const name of [
      'GridController',
      'GridColumn',
      'GridQuery',
      'GridResult',
      'GridDataSource',
      'InMemoryDataSource',
      'AsyncDataSource',
      'SourceCapabilities',
      'GridViewState',
      'TreeSpec',
      'EditHistory',
      'EditSession',
      'PasteResult',
      'FetchSignal',
      'SelectionState',
      'CellAddress',
      'GroupSpec',
      'SortSpec',
      'Aggregation',
      'CsvExporter',
      // An adapter needs these to draw: row geometry, the layout and the
      // stacked header bands.
      'RowMetrics',
      'computeLayout',
      'layoutHeaderRow',
      'orderColumnsForDisplay',
    ]) {
      expect(root, `${name} must stay exported`).toHaveProperty(name);
    }
    expect(root.GridChange.rows).toBe('rows');
    expect(
      root.RowMetrics.uniform({ rowCount: 1, rowHeight: 1 }),
    ).toBeDefined();
  });

  it('keeps the pipeline stages out of the everyday surface', () => {
    for (const name of [
      'sortRows',
      'sortOrder',
      'buildComparator',
      'buildGroups',
      'flattenGroups',
      'collectGroupPaths',
      'flattenTree',
      'collectTreePaths',
      'rootsOf',
      'computeAggregates',
      'computeColumnStats',
      'describeHeaderProblems',
      'LazyDataRowList',
      'GroupedRowList',
      'DetailRowList',
      'RowSlice',
      'withDetailRows',
      'compileCondition',
    ]) {
      expect(root, `${name} belongs in advanced`).not.toHaveProperty(name);
    }
  });
});

describe('the advanced entry point', () => {
  it('reaches every pipeline stage', () => {
    for (const name of [
      'sortRows',
      'sortOrder',
      'buildComparator',
      'buildGroups',
      'flattenGroups',
      'collectGroupPaths',
      'flattenTree',
      'collectTreePaths',
      'rootsOf',
      'computeAggregates',
      'computeColumnStats',
      'describeHeaderProblems',
      'compileCondition',
    ]) {
      expect(advanced).toHaveProperty(name);
      expect(typeof (advanced as Record<string, unknown>)[name]).toBe(
        'function',
      );
    }
  });

  it('is a superset, so one import is enough', () => {
    for (const name of Object.keys(root)) {
      expect(advanced, `advanced must re-export ${name}`).toHaveProperty(name);
    }
    expect(advanced).toHaveProperty('LazyDataRowList');
    expect(advanced).toHaveProperty('GroupedRowList');
    expect(advanced).toHaveProperty('RowSlice');
  });
});
