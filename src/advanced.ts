/**
 * The engine's pipeline, for code that runs it rather than uses it.
 *
 * The package root is the surface an application needs: a controller,
 * columns, a data source, and the specs that describe what to show. This
 * entry point adds the stages the controller drives — the sorter, the
 * grouper, the aggregator, the flatteners — plus the few implementation types
 * they hand back.
 *
 * Reach for it when you are writing a `GridDataSource` of your own and want
 * to run part of the pipeline locally, or an adapter for another framework.
 * Everything here is lower level and shaped by what the engine needs rather
 * than by what reads well at a call site; the everyday entry point
 * deliberately does not export it, so that a published API is a promise about
 * the things applications actually hold.
 *
 * @module
 */

export * from './index';

export { computeAggregates } from './aggregate';
export { computeColumnStats } from './decoration';
export { compileCondition } from './filter';
export { buildGroups } from './group';
export {
  collectGroupPaths,
  DetailRowList,
  flattenGroups,
  GroupedRowList,
  LazyDataRowList,
  RowSlice,
  withDetailRows,
} from './rows';
export { buildComparator, sortOrder, sortRows } from './sort';
export { describeHeaderProblems } from './stacked-header';
export { collectTreePaths, flattenTree, rootsOf } from './tree';
