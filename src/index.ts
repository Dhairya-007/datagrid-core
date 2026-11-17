/**
 * A framework-agnostic data grid engine.
 *
 * Everything a data grid does other than paint — sorting, filtering,
 * grouping, aggregation, virtualization, selection, editing and export —
 * lives here in plain TypeScript, with no dependency on React, Vue, Svelte or
 * any other UI library, and no DOM. {@link GridController} is the entry
 * point: give it columns and a {@link GridDataSource}, then render
 * `controller.visibleRows`.
 *
 * @module
 */

export {
  AggregateResult,
  AggregateType,
  Aggregation,
  type AggregateReducer,
  type AggregationOptions,
} from './aggregate';

export {
  column,
  ColumnAlign,
  ColumnPin,
  ColumnType,
  GridColumn,
  type GridColumnOptions,
  type GridColumnPatch,
  type SortKeyGetter,
  type ValueFormatter,
  type ValueGetter,
  type ValueSetter,
  type ValueValidator,
} from './column';

export {
  compareNumbers,
  compareStrings,
  compareValues,
  compareValuesCaseInsensitive,
  compareValuesFolded,
  compareValuesNatural,
  foldText,
  isNullish,
  naturalSortKey,
  valuesEqualFolded,
  type CellValue,
  type Comparable,
  type Comparator,
} from './compare';

export { GridController, type GridControllerOptions } from './controller';

export {
  AsyncDataSource,
  DistinctValues,
  GridDataSource,
  GroupChildren,
  InMemoryDataSource,
  RowUpdate,
  searchFilter,
  SourceCapabilities,
} from './data-source';

export { isDate, startOfDay, toIsoString, tryParseDate } from './dates';

export {
  CellDecoration,
  CellTone,
  ColorScaleRule,
  ColumnStats,
  DataBarRule,
  FirstMatchRule,
  MergedRule,
  ThresholdRule,
  ValueToneRule,
  type CellDecorationOptions,
  type CellRule,
  type ColorScaleRuleOptions,
  type ColumnStatsOptions,
  type DataBarRuleOptions,
  type ThresholdRuleOptions,
  type ValueToneRuleOptions,
} from './decoration';

export {
  coerceValue,
  combineValidators,
  EditOutcome,
  EditResult,
  EditSession,
  numberRange,
  parseDecimal,
  requiredValue,
  type EditSessionOptions,
} from './editing';

export { GridArgumentError, GridFormatError, GridStateError } from './errors';

export {
  CsvExporter,
  parseClipboardText,
  toClipboardText,
  type ExportOptions,
} from './export';

export { FetchCancelled, FetchSignal } from './fetch';

export {
  alwaysTrue,
  coerceFilterOperand,
  CompiledFilter,
  decodeFilterOperand,
  encodeFilterOperand,
  FILTER_BIGINT_KEY,
  FILTER_DATE_KEY,
  Filter,
  FilterCondition,
  FilterGroup,
  FilterJoin,
  FilterOperator,
  filtersEqual,
  operatorLabel,
  operatorNeedsSecondValue,
  operatorNeedsValue,
  operatorNeedsValueSet,
  operatorsFor,
  pruneFilter,
  where,
  type FieldReader,
  type FilterConditionOptions,
} from './filter';

export {
  groupBy,
  GroupKey,
  GroupNode,
  groupPathSegment,
  GroupSpec,
  pathKeySegment,
  type GroupKeyOf,
  type GroupLabelOf,
  type GroupNodeOptions,
  type GroupSpecOptions,
} from './group';

export { CellEdit, EditAction, EditHistory, ReplayOutcome } from './history';

export {
  ColumnFit,
  ColumnLayout,
  computeLayout,
  GridLayout,
  orderColumnsForDisplay,
  type ComputeLayoutOptions,
} from './layout';

export {
  everyGridChange,
  GridChange,
  GridChangeNotifier,
  type GridChangeListener,
  type GridListener,
} from './notifier';

export { PasteRejection, PasteResult, type PasteResultOptions } from './paste';

export {
  GridQuery,
  GridResult,
  type GridQueryOptions,
  type GridResultOptions,
} from './query';

export {
  DataGridRow,
  DetailGridRow,
  emptyRowList,
  GridRow,
  GridRowKind,
  GridRowList,
  GroupExpansionState,
  GroupGridRow,
  isDataRow,
  isDetailRow,
  isGroupRow,
  MaterialisedRowList,
  TreeRowInfo,
  type DataGridRowOptions,
  type RowKey,
} from './rows';

export {
  GRID_SCHEMA_VERSION,
  GRID_SCHEMA_VERSION_KEY,
  requireSupportedSchema,
  type JsonMap,
} from './schema';

export {
  cell,
  CellAddress,
  CellRange,
  extendingModifier,
  noModifiers,
  SelectionCoverage,
  SelectionMode,
  SelectionState,
  togglingModifier,
  type CellRangeOptions,
  type SelectionModifiers,
} from './selection';

export {
  cycleSort,
  defaultCompareFor,
  NullsPosition,
  sortBy,
  SortDirection,
  SortSpec,
  type SortSpecOptions,
} from './sort';

export {
  HeaderBand,
  HeaderBandLayout,
  HeaderRow,
  layoutHeaderRow,
} from './stacked-header';

export {
  flattenNestedRows,
  NestedRows,
  TreeSpec,
  type FlattenTreeOptions,
  type TreeSpecOptions,
} from './tree';

export {
  ColumnViewState,
  GridViewState,
  type GridViewStateOptions,
} from './view-state';

export { RowMetrics, RowWindow } from './virtualization';
