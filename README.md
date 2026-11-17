<h1 align="center">datagrid-core</h1>

<p align="center">
  <em>A headless data grid engine for TypeScript and JavaScript.<br/>
  It does the hard parts — frozen columns, multi-column sorting, a filter row,
  grouping with subtotals, tree rows,<br/>virtual scrolling, range selection,
  inline editing, CSV export — and draws nothing at all.<br/>
  No framework, no DOM, no licence key, no paid tier.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/datagrid-core"><img alt="npm" src="https://img.shields.io/npm/v/datagrid-core.svg?color=cb3837"/></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/licence-MIT-blue.svg"/></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178c6.svg"/>
  <img alt="dependencies: none" src="https://img.shields.io/badge/dependencies-none-success.svg"/>
  <img alt="729 tests" src="https://img.shields.io/badge/tests-729-success.svg"/>
</p>

<p align="center">
  <b><a href="https://dhairya-007.github.io/datagrid-core/">Live demo</a></b> ·
  <a href="https://www.npmjs.com/package/datagrid-core">npm</a> ·
  <a href="demo/">the demo's source</a>
</p>

---

Every serious data grid for the web ships its own renderer, and most ship a
licence key with it. `datagrid-core` is the other half of the problem: the
**engine**, with no renderer at all. You keep your own markup, your own
framework, your own design system — React, Vue, Svelte, Solid, Lit, or a
`<table>` you wrote by hand — and the engine answers the questions that are
genuinely hard.

```ts
import {
  Aggregation,
  GridColumn,
  GridController,
  InMemoryDataSource,
  isDataRow,
  numberRange,
} from 'datagrid-core';

const grid = new GridController<Employee>({
  columns: [
    new GridColumn<Employee>({
      field: 'name',
      value: (e) => e.name,
      pin: 'start',
    }),
    new GridColumn<Employee>({
      field: 'salary',
      type: 'number',
      value: (e) => e.salary,
      setValue: (e, v) => ({ ...e, salary: v as number }),
      validator: numberRange({ min: 0 }),
    }),
    new GridColumn<Employee>({
      field: 'department',
      value: (e) => e.department,
    }),
  ],
  dataSource: new InMemoryDataSource(employees),
  aggregations: [Aggregation.sum('salary')],
  rowKey: (e) => e.id,
});

grid.addListener(render);

function render() {
  for (const row of grid.visibleRows) {
    if (isDataRow(row)) draw(row.data); // row.kind is 'data' | 'group' | 'detail'
  }
}

grid.toggleSort('salary'); // and the listener fires
grid.groupBy('department');
grid.setSearch('eng');
```

That is the whole integration: construct it, listen, read `visibleRows`, and
call methods from your event handlers. The longer version of that snippet is
[`examples/quickstart.ts`](examples/quickstart.ts), which is typechecked and
run in CI so it cannot drift from the API.

## Install

```sh
npm install datagrid-core
```

Ships ESM and CJS, with types. **No runtime dependencies**, and nothing that
touches the DOM — it runs in a browser, in Node, in a worker, or on the
server.

## See it running

**<https://dhairya-007.github.io/datagrid-core/>**

A React application with no grid dependency but this one, in
[`demo/`](demo/) — about 1,200 lines, which is the honest answer to "what do I
have to write myself?". Three grids share one renderer:

- **In memory** — up to 100,000 generated rows with multi-column sorting, a
  filter row with per-type operators and value lists, grouping with subtotals,
  frozen columns and rows, stacked headers, range selection, inline editing with
  validation and undo, detail panels, conditional formatting, paging, CSV export
  and saved views.
- **Server-backed** — the same grid against a fake backend with adjustable
  latency, showing the debounce on a typed word, the cancellation of superseded
  fetches, server-side paging and infinite scrolling, and optimistic writes that
  roll back when the write fails.
- **Tree rows** — a flat list with a parent reference, nested by the engine,
  with roll-ups and lazily kept branches.

A panel beside the grid prints what the engine is actually saying: the
`GridQuery` a data source would receive, the change sets the controller emits,
and the JSON a saved view serialises to. The demo installs the package from
npm, so the deploy that publishes it also checks the published package.

## What you get

|                             |                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------ |
| **Sorting**                 | multi-column, stable, custom comparators, explicit null placement, natural order     |
| **Filtering**               | 16 operators, a serialisable condition tree, free-text search, a filter row          |
| **Grouping**                | nested levels, derived keys, per-group aggregates, collapsible headers, server-side  |
| **Tree data**               | parent/child rows, from a nested model or a parent reference, lazily loaded          |
| **Aggregates**              | sum, average, min, max, count, distinct count, custom reducers                       |
| **Frozen columns and rows** | leading and trailing panes, plus rows pinned to the top and bottom                   |
| **Stacked headers**         | header rows spanning several columns, following reorders and hidden columns          |
| **Column state**            | sort, pin, hide, resize, auto-size, drag to reorder                                  |
| **Virtualization**          | uniform and variable row heights, plus column windowing for wide grids               |
| **Selection**               | rows, cells, rectangular ranges, a tri-state checkbox, keyboard navigation, TSV copy |
| **Editing**                 | validated sessions, inline errors, optimistic writes, paste into a range, undo/redo  |
| **Paging**                  | local or server-driven, or infinite scrolling with `loadMore()`                      |
| **Detail panels**           | an expandable panel under a row, counted by virtualization like any other row        |
| **Export**                  | RFC 4180 CSV, grouped CSV, clipboard text — with formula injection neutralised       |
| **Saved views**             | the whole arrangement — query, column order, widths, pins — as JSON                  |
| **Conditional formatting**  | data bars, colour scales, thresholds and value tones, decided in the engine          |

## The shape of it

```
                    ┌──────────────────────────────┐
your UI  ────────▶  │  GridController              │
(React, Vue, …)     │    columns, selection,       │
   ▲   reads        │    editing, undo, export     │
   │ visibleRows    └───────────────┬──────────────┘
   │                                │  GridQuery
   └── addListener(…) ──────────▶    ▼
                    ┌──────────────────────────────┐
                    │  GridDataSource              │
                    │    InMemoryDataSource, or    │
                    │    your REST/SQL/stream      │
                    └──────────────────────────────┘
```

**`GridController`** owns every piece of state and the pipeline that turns it
into rows. **`GridDataSource`** is the seam: `InMemoryDataSource` runs the
whole pipeline locally, and `AsyncDataSource` wraps a callback so you can
point a grid at an endpoint in three lines.

### Rendering a frame

```ts
const layout = grid.layoutFor(viewportWidth); // frozen panes and widths
const metrics = RowMetrics.uniform({ rowCount: grid.rowCount, rowHeight: 36 });
const window = metrics.windowFor({ scrollOffset, viewportExtent });

for (let i = window.firstIndex; i <= window.lastIndex; i++) {
  const row = grid.visibleRows.at(i);
  if (isGroupRow(row)) drawHeader(row.label, row.rowCount, row.expanded);
  else if (isDataRow(row))
    drawRow(row.data, layout.visibleScrollingColumns({ scrollOffset: x }));
}
```

`visibleRows` is a `GridRowList`, not an array: it builds a row wrapper when
you read one, so an ungrouped 50,000-row grid allocates nothing per change.
Use `.at(i)`, `.length`, `.slice(a, b)` and iteration.

### Only repaint what changed

```ts
grid.addChangeListener((changes) => {
  if (changes.has('rows')) rebuildRows();
  if (changes.has('layout')) relayout();
  if (changes.has('selection')) repaintSelection(); // no row content changed
});
```

A bare "something changed" makes a large grid rebuild everything on a click.
Only the engine knows which it was, so it says.

### A server-backed source

```ts
const source = new AsyncDataSource<Row>(
  async (query) => {
    const res = await fetch(`/api/rows?${toParams(query)}`, {
      signal: query.signal?.abortSignal, // the grid cancels superseded fetches
    });
    const { rows, total } = await res.json();
    return new GridResult({ rows, totalCount: total });
  },
  { onCommit: (original, updated) => save(updated) },
);

const grid = new GridController({
  columns,
  dataSource: source,
  fetchDebounceMs: 250, // a typed word is one request
  rowKey: (r) => r.id,
});
```

`query.toJSON()` is a stamped, serialisable description of everything the grid
wants — sorts, the filter tree, the search, grouping, offset and limit — so a
backend can translate it into SQL or query parameters.

## Two entry points

```ts
import { GridController } from 'datagrid-core'; // what an application holds
import { sortRows, buildGroups } from 'datagrid-core/advanced'; // the pipeline stages
```

The root is a promise: everything in it is something you can hold, and taking
it back is a breaking change. `datagrid-core/advanced` adds the stages the
controller drives — the sorter, the grouper, the aggregator, the flatteners —
for when you are writing a data source of your own or an adapter for another
framework.

## Performance

The in-memory source memoises the pipeline in three stages — matched, then
ordered, then grouped — each keyed by the part of the query it depends on.
Turning a page only re-slices; reversing a sort does not re-filter; editing
one cell patches the result rather than rebuilding it.

`npm run bench` measures the operations a user drives. On a 2024 MacBook
Pro, from cold — the timing includes building the rows — a 10,000-row grid
sorts one column in ~9 ms, searches the whole table in ~6 ms and groups with
a subtotal in ~4 ms, so every one of them fits inside a 16.7 ms frame. At
50,000 rows the same three take ~62 ms, ~42 ms and ~30 ms, which reads as a
stall rather than a dropped frame.

So: up to around 20k rows everything stays inside a frame. Between there and
100k, sorting and a whole-table search cross it. Past 100k, prefer a source
that pushes the work into a database — which is what `GridDataSource` is
for.

Some of the decisions that are load-bearing, in case you are reading the
source:

- Select-all is a flag with a set of exceptions, not a set of every index, so
  selecting a million rows is O(1) and so is every membership test.
- A grouped row list holds an index over the _groups_, so opening one group
  is O(groups) and touches no row.
- Quick search runs against a folded text index built once per revision, not
  by formatting every cell per keystroke.
- A filter is compiled before it is run, which turns `isIn` over a thousand
  checkbox values into one hash lookup per row.

## Correctness

729 tests, including a differential suite that applies 1,300 randomised edits
and compares the memoised pipeline against a source that has cached nothing,
and a property-based suite that checks eleven invariants against 120 randomly
generated arrangements of the grid.

Two of the rules those exist to protect:

- **An ordering is total.** `compareValues` ranks by type class before
  comparing, because comparing across classes by their string forms made the
  relation intransitive — and a column holding `9`, `10` and `'5'` then sorted
  differently depending on the input order.
- **An export is what is on screen.** Columns come out in screen order,
  pinning included, and a collapsed group exports as its header alone.

## A note on where this came from

`datagrid-core` is a TypeScript port of
[`lattice_core`](https://github.com/Dhairya-007/lattice), the pure-Dart engine
behind the Lattice data grid for Flutter. The engine was kept separate from
the widgets precisely so it could grow past one toolkit; this is that.

The port is faithful to the behaviour and idiomatic in the destination
language: `copyWith` takes `null` to clear and `undefined` to keep, enums are
const objects plus a union type so `'start'` and `ColumnPin.start` both work,
`FetchSignal` wraps an `AbortController`, and anything keyed by a value uses a
tagged string key — because a JavaScript `Map` compares object keys by
identity, which otherwise put every row of a date column in its own group.

## Support

The engine, the Flutter grid it came from and the demo are all MIT, built in the
open and free to use. If they saved you a week of work and you would like to say
thank you:

**UPI — `ozadhairya73@oksbi`**

A star on the repository is just as welcome.

## Licence

MIT.
