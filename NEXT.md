# Where this got to

The engine is fully ported from `09-lattice/packages/lattice_core` and the
test suite is about two-thirds across. Everything committed is green:
`npx tsc --noEmit` is clean and `npx vitest run` passes 562 tests in 26
files.

## Done

All 25 engine modules, under `src/`:

compare, dates, schema, errors, util, column, decoration, sort, selection,
editing, paste, filter, fetch, aggregate, group, rows, tree, notifier,
history, virtualization, layout, stacked-header, view-state, query, export,
data-source, controller — plus `index.ts` and `advanced.ts`.

Ported test files: compare, foundations, sort, filter, filter-metadata,
group, data-source, selection, controller, editing, history, paste, write,
export, layout, virtualization, decoration, stacked-header, view-state,
tree, navigation, frozen-rows, checkbox-selection, row-identity, fetch,
smoke.

## Left to port

From `09-lattice/packages/lattice_core/test/`:

- `api_surface_test.dart`
- `cache_test.dart`
- `invariants_test.dart`
- `issue_features_test.dart`
- `lazy_group_test.dart`
- `review_async_test.dart`
- `review_columns_test.dart`
- `review_data_source_test.dart`
- `review_export_test.dart`
- `review_patch_test.dart`
- `review_perf_test.dart`
- `review_structure_test.dart`
- `review_write_test.dart`

## Then

- README with the anatomy of the API and a quickstart
- `.github/workflows/ci.yml`: typecheck, lint, format check, test, build
- `npm run build` and `npm pack --dry-run` to check what ships
- CHANGELOG, CONTRIBUTING, SECURITY, LICENCE headers to match the Dart repo
- Decide on the GitHub repo and the first publish

## Notes carried over from the port

- `visibleRows` is a `GridRowList`, not an array: `at(i)`, `length`,
  `slice`, iteration. There is no index operator in TypeScript, and an
  ungrouped 50k-row grid must not allocate a wrapper per row per change.
- `copyWith` takes `null` to clear a field and `undefined` to keep it,
  replacing Dart's `clearX` flags.
- Enums are `const` objects plus a union type, so `ColumnPin.start` and
  `'start'` both work and JSON round-trips without a mapping.
- Group buckets and distinct values are keyed by a tagged string, because a
  JavaScript `Map`/`Set` compares object keys by identity — two equal dates
  were two buckets.
- `FetchSignal` wraps an `AbortController`, so a source can hand the grid's
  cancellation straight to `fetch()`.
