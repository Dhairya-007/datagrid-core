/**
 * A minimal listenable, so the engine stays free of any UI framework.
 *
 * @module
 */

import { GridStateError } from './errors';

/** Callback invoked when an observable object changes. */
export type GridListener = () => void;

/** Callback invoked with what changed. */
export type GridChangeListener = (changes: ReadonlySet<GridChange>) => void;

/**
 * What changed, so a listener can repaint only what depends on it.
 *
 * A bare "something changed" forces an adapter to rebuild everything: click
 * one cell and every visible row and cell is rebuilt, because the adapter has
 * no way to tell a selection change from a new set of rows. On a large grid
 * that is the single biggest avoidable cost, and only the engine knows which
 * it was.
 */
export const GridChange = {
  /**
   * The rows themselves: a new result, a different order, a different page, a
   * group opened, a value written.
   */
  rows: 'rows',

  /** Column geometry: widths, order, pinning, visibility, stacked headers. */
  layout: 'layout',

  /** Selection, the active cell or the range. */
  selection: 'selection',

  /** The edit session: opened, retyped, committed or cancelled. */
  edit: 'edit',

  /** Chrome around the rows: loading, a fetch error, a pending write. */
  status: 'status',
} as const;
export type GridChange = (typeof GridChange)[keyof typeof GridChange];

/** Every kind of change, which is what a caller that does not say means. */
export const everyGridChange: ReadonlySet<GridChange> = new Set<GridChange>([
  GridChange.rows,
  GridChange.layout,
  GridChange.selection,
  GridChange.edit,
  GridChange.status,
]);

/**
 * The smallest useful observable: add a listener, get notified, dispose.
 *
 * A framework's own observable would do the job, but depending on one would
 * drag that framework into the engine and shut the door on every other
 * adapter. A React adapter bridges this to `useSyncExternalStore` in a few
 * lines instead.
 */
export class GridChangeNotifier {
  private readonly listeners: GridListener[] = [];
  private readonly changeListeners: GridChangeListener[] = [];
  private disposed = false;
  private muteDepth = 0;
  private dirtyWhileMuted = false;
  private mutedChanges = new Set<GridChange>();
  private changesOfLastNotification: ReadonlySet<GridChange> = everyGridChange;

  get hasListeners(): boolean {
    return this.listeners.length > 0 || this.changeListeners.length > 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * What the most recent notification was about.
   *
   * For a listener registered with {@link addListener}, which is not given
   * the set but can read it during the callback.
   */
  get lastChanges(): ReadonlySet<GridChange> {
    return this.changesOfLastNotification;
  }

  /** Registers a listener, and returns the call that removes it again. */
  addListener(listener: GridListener): () => void {
    this.assertAlive();
    this.listeners.push(listener);
    return () => {
      this.removeListener(listener);
    };
  }

  removeListener(listener: GridListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  /**
   * Registers a listener that is told what changed, and returns the call that
   * removes it again.
   *
   * Repaint what depends on the set and leave the rest alone: a
   * `GridChange.selection` notification means no row's content has changed.
   */
  addChangeListener(listener: GridChangeListener): () => void {
    this.assertAlive();
    this.changeListeners.push(listener);
    return () => {
      this.removeChangeListener(listener);
    };
  }

  removeChangeListener(listener: GridChangeListener): void {
    const index = this.changeListeners.indexOf(listener);
    if (index >= 0) this.changeListeners.splice(index, 1);
  }

  /**
   * Notifies listeners, unless a {@link batch} is in progress.
   *
   * `changes` says what happened. Omitting it means everything may have
   * changed, which is always safe and never informative; the engine passes a
   * specific set, and so should a source that knows.
   */
  notifyListeners(
    changes?: ReadonlySet<GridChange> | readonly GridChange[],
  ): void {
    if (this.disposed) return;
    const asSet =
      changes === undefined
        ? everyGridChange
        : changes instanceof Set
          ? (changes as ReadonlySet<GridChange>)
          : new Set<GridChange>(changes as readonly GridChange[]);
    const what = asSet.size === 0 ? everyGridChange : asSet;
    if (this.muteDepth > 0) {
      this.dirtyWhileMuted = true;
      // A batch notifies once for the union of what it did, so nothing a
      // listener needed to know about is dropped.
      for (const change of what) this.mutedChanges.add(change);
      return;
    }
    this.changesOfLastNotification = what;
    // Iterate a copy: a listener may add or remove listeners while running.
    //
    // Every listener runs even if one throws. A view that threw while
    // rebuilding used to stop every listener registered after it, so one
    // broken cell froze the rest of the grid; the first error is rethrown
    // once they have all had their turn, so it is still reported.
    let firstError: unknown = null;
    let failed = false;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
      }
    }
    for (const listener of [...this.changeListeners]) {
      try {
        listener(what);
      } catch (error) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
      }
    }
    if (failed) throw firstError;
  }

  /**
   * Runs `action`, emitting at most one notification afterwards.
   *
   * Nested batches collapse into the outermost one, so composing operations
   * that each notify never produces a storm of rebuilds.
   */
  batch<R>(action: () => R): R {
    this.muteDepth++;
    try {
      return action();
    } finally {
      this.muteDepth--;
      if (this.muteDepth === 0 && this.dirtyWhileMuted) {
        this.dirtyWhileMuted = false;
        const changes = this.mutedChanges;
        this.mutedChanges = new Set<GridChange>();
        this.notifyListeners(changes);
      }
    }
  }

  dispose(): void {
    this.listeners.length = 0;
    this.changeListeners.length = 0;
    this.disposed = true;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new GridStateError(
        `${this.constructor.name} was used after being disposed.`,
      );
    }
  }
}
