/**
 * The whole React binding for the engine: four hooks.
 *
 * `GridController` is a listenable object that mutates in place, so the
 * binding is a subscription that bumps a revision. Rendering reads the
 * controller directly — there is no copy of the grid's state in React, which
 * is the point of a headless engine.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GridChange, GridController } from 'datagrid-core';

/** Re-renders on every notification, and returns a revision to key memos on. */
export function useGridRevision<T>(grid: GridController<T>): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setRevision((r) => r + 1);
    return grid.addListener(() => setRevision((r) => r + 1));
  }, [grid]);
  return revision;
}

export interface ChangeEntry {
  id: number;
  at: number;
  changes: GridChange[];
}

/**
 * The last `limit` change notifications, which the inspector shows.
 *
 * This is the engine's own `addChangeListener`: an adapter that repaints
 * everything on any change is leaving the cheapest optimisation on the table,
 * so the demo puts the stream on screen.
 */
export function useChangeLog<T>(grid: GridController<T>, limit = 40): ChangeEntry[] {
  const [log, setLog] = useState<ChangeEntry[]>([]);
  const nextId = useRef(1);
  useEffect(() => {
    setLog([]);
    return grid.addChangeListener((changes) => {
      const entry: ChangeEntry = {
        id: nextId.current++,
        at: Date.now(),
        changes: [...changes],
      };
      setLog((previous) => [entry, ...previous].slice(0, limit));
    });
  }, [grid, limit]);
  return log;
}

/** The live pixel size of an element, which the layout and window need. */
export function useElementSize<E extends HTMLElement>(): [
  React.RefObject<E>,
  { width: number; height: number },
] {
  const ref = useRef<E>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** Times a grid operation, so the toolbar can show what it cost. */
export function useTimedAction(): [
  { label: string; ms: number } | null,
  (label: string, action: () => void) => void,
] {
  const [last, setLast] = useState<{ label: string; ms: number } | null>(null);
  const run = useCallback((label: string, action: () => void) => {
    const start = performance.now();
    action();
    setLast({ label, ms: performance.now() - start });
  }, []);
  return [last, run];
}
