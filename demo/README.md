# The datagrid-core demo

A React application that renders [`datagrid-core`](https://www.npmjs.com/package/datagrid-core),
published at **<https://dhairya-007.github.io/datagrid-core/>**.

It exists to answer the question a headless library always raises: _what do I
have to write myself?_ The answer is this folder — about 1,200 lines of plain
React, no grid dependency beyond the engine, no UI framework.

```sh
npm install
npm run dev      # http://localhost:5173/datagrid-core/
npm run build    # typechecks, then writes dist/
```

The demo installs `datagrid-core` **from npm**, not from the parent checkout, so
a green build here is also a check that the published package works in a real
application.

## What is where

| File                    | What it is                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `src/grid/DataGrid.tsx` | The renderer: virtualized rows, frozen panes, the header, editing, the keyboard map          |
| `src/grid/useGrid.ts`   | The entire React binding — a subscription that bumps a revision                              |
| `src/grid/panes.tsx`    | The pane model every row walks, so a pinned column is pinned everywhere                      |
| `src/grid/FilterCell.tsx` | The filter row, built from `operatorsForField` and `distinctValuesFor`                     |
| `src/data/columns.ts`   | Columns: types, formatters, validators, conditional formatting rules, stacked headers        |
| `src/views/`            | Three grids: in-memory, server-backed, and a tree                                            |
| `src/panels/`           | Toolbar, stat tiles and the inspector that prints the query, the change sets and saved views |

## Things worth looking at in the code

- **The binding is four hooks.** `useGridRevision` subscribes and re-renders;
  nothing about the grid's state lives in React.
- **The renderer never computes grid state.** Which rows exist, how wide a
  column is, what a cell says, how it is shaded, whether an edit is valid — all
  of it is asked of the controller.
- **Virtualization is `RowMetrics`.** Uniform metrics are a closed form; the
  variable form is only built when an open detail panel has actually made the
  rows different heights.
- **Columns are windowed too.** `layout.visibleScrollingColumns` means a wide
  grid draws the columns in the viewport and nothing else.
- **The stacked headers use `layoutHeaderRow`**, which is what gets a band
  spanning the frozen boundary drawn correctly in both panes.
