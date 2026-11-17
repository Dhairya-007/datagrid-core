/**
 * The controls, which are a thin layer over engine methods.
 *
 * Nearly every button here is one call: `setSearch`, `groupBy`, `setPageSize`,
 * `exportCsv`, `saveState`. The toolbar holds no state of its own except the
 * text in the search box.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { GridViewState, type GridController } from 'datagrid-core';

const VIEW_KEY = 'datagrid-core-demo.view';

export interface ToolbarProps<T> {
  grid: GridController<T>;
  run: (label: string, action: () => void) => void;
  groupFields: ReadonlyArray<{ field: string; label: string }>;
  fileName: string;
  children?: ReactNode;
}

export function Toolbar<T>({ grid, run, groupFields, fileName, children }: ToolbarProps<T>) {
  const [text, setText] = useState(grid.search);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  const grouped = new Set(grid.groups.map((group) => group.field));

  function download() {
    // Columns come out in screen order, pinning included, and a collapsed
    // group exports as its header alone — the engine's rule, not ours.
    const csv = grid.exportCsv({
      includeGroupRows: grid.isGrouped,
      respectCollapsed: true,
    });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    setNotice(`${fileName} — ${(csv.length / 1024).toFixed(0)} kB of CSV`);
  }

  async function copySelection() {
    const text_ = grid.copySelectionAsText({ includeHeader: true });
    if (!text_) {
      setNotice('Select some cells first');
      return;
    }
    await navigator.clipboard?.writeText(text_);
    setNotice(`${text_.split('\n').length - 1} rows copied as TSV`);
  }

  function saveView() {
    localStorage.setItem(VIEW_KEY, JSON.stringify(grid.saveState().toJSON()));
    setNotice('View saved to this browser');
  }

  function loadView() {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) {
      setNotice('No saved view yet');
      return;
    }
    const warnings: string[] = [];
    const state = GridViewState.fromJSON(JSON.parse(raw) as Record<string, unknown>, warnings);
    run('restoreState', () => grid.restoreState(state));
    setNotice(warnings.length ? `Restored with ${warnings.length} warning(s)` : 'View restored');
  }

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <label className="search">
          <span className="search-icon">⌕</span>
          <input
            value={text}
            placeholder="Search every column"
            onChange={(event) => {
              setText(event.target.value);
              run('setSearch', () => grid.setSearch(event.target.value));
            }}
          />
          {text ? (
            <button
              onClick={() => {
                setText('');
                run('setSearch', () => grid.setSearch(''));
              }}
            >
              ×
            </button>
          ) : null}
        </label>

        <div className="chips">
          <span className="chips-label">Group by</span>
          {groupFields.map(({ field, label }) => (
            <button
              key={field}
              className={`chip ${grouped.has(field) ? 'on' : ''}`}
              onClick={() =>
                run('groupBy', () =>
                  grouped.has(field) ? grid.ungroup(field) : grid.groupBy(field),
                )
              }
            >
              {label}
              {grouped.has(field) ? (
                <i>{grid.groups.findIndex((group) => group.field === field) + 1}</i>
              ) : null}
            </button>
          ))}
          {grid.isGrouped ? (
            <>
              <button className="chip ghost" onClick={() => run('expandAllGroups', () => grid.expandAllGroups())}>
                expand
              </button>
              <button className="chip ghost" onClick={() => run('collapseAllGroups', () => grid.collapseAllGroups())}>
                collapse
              </button>
              <button className="chip ghost" onClick={() => run('clearGroups', () => grid.clearGroups())}>
                clear
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="toolbar-row">
        {children}

        <div className="group">
          <button
            disabled={!grid.canUndo}
            title={grid.history.undoLabel ?? 'Nothing to undo'}
            onClick={() => run('undo', () => grid.undo())}
          >
            ↶ Undo
          </button>
          <button
            disabled={!grid.canRedo}
            title={grid.history.redoLabel ?? 'Nothing to redo'}
            onClick={() => run('redo', () => grid.redo())}
          >
            ↷ Redo
          </button>
        </div>

        <div className="group">
          <button onClick={download}>Export CSV</button>
          <button onClick={() => void copySelection()}>Copy selection</button>
        </div>

        <div className="group">
          <button onClick={saveView}>Save view</button>
          <button onClick={loadView}>Restore</button>
        </div>

        {notice ? <span className="notice">{notice}</span> : null}
      </div>
    </div>
  );
}
