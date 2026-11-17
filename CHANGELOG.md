# Changelog

## 0.1.0

First release.

A headless data grid engine for TypeScript: sorting, filtering, search,
grouping with aggregates, tree rows, virtualization, selection, cell editing
with undo, paste, detail panels, saved views, conditional formatting and CSV
export — with no renderer, no framework and no runtime dependencies.

Ported from [`lattice_core`](https://github.com/Dhairya-007/lattice) 0.4.1,
the pure-Dart engine behind the Lattice data grid for Flutter, including its
test suite: 729 tests, among them a differential suite that checks the
memoised pipeline against a cold one over 1,300 randomised edits, and a
property-based suite that checks eleven invariants against 120 generated
arrangements of the grid.

Where the port is not a transliteration, it is because JavaScript needed
something else:

- `visibleRows` is a `GridRowList` with `at(i)`, `length`, `slice` and
  iteration, not an array. TypeScript has no index operator to overload, and
  the lazy row lists are what keep an ungrouped 50,000-row grid from
  allocating a wrapper per row on every change.
- `copyWith` takes `null` to clear a field and `undefined` to keep it, which
  is the idiomatic form of the `clearX` flags the Dart original needed.
- Enums are const objects plus a union type, so both `ColumnPin.start` and
  `'start'` are accepted and JSON round-trips without a mapping.
- `FetchSignal` wraps an `AbortController` and exposes `abortSignal`, so a
  source can hand the grid's cancellation straight to `fetch()`.
- Group buckets, distinct values and pending writes key on a tagged string,
  because a JavaScript `Map` compares object keys by identity — which
  otherwise put every row of a date column in a group of its own.
- Dates parse strictly as ISO 8601 rather than through `new Date(text)`,
  which accepts locale forms whose meaning depends on the reader.
- `parseDecimal` is used wherever the Dart original used `num.tryParse`, so
  `0x10` and `Infinity` are not numbers a user typed.
