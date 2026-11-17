/**
 * Undo and redo for committed edits.
 *
 * @module
 */

import type { CellValue } from './compare';
import { GridArgumentError } from './errors';

/**
 * One cell's value before and after an edit.
 *
 * Changes are recorded per cell rather than per row so that undo works
 * whatever shape the row model has. An immutable model could be restored by
 * keeping the old row object, but a model whose setter mutates in place
 * cannot: the "old row" and the new one are the same object. Replaying a
 * value through the column's setter is the one move that works for both.
 */
export class CellEdit<T> {
  /**
   * The row as it was when the change was made.
   *
   * Used to find the row again. A grid with a `rowKey` matches by identity,
   * so this need not still be the instance the source holds; without one it
   * has to be, which is why an immutable row model wants a key.
   */
  readonly row: T;

  readonly field: string;

  /** The value the cell held before the edit, and after it. */
  readonly before: CellValue;
  readonly after: CellValue;

  constructor(options: {
    row: T;
    field: string;
    before: CellValue;
    after: CellValue;
  }) {
    this.row = options.row;
    this.field = options.field;
    this.before = options.before;
    this.after = options.after;
    Object.freeze(this);
  }

  /** This change, the other way round. */
  get inverse(): CellEdit<T> {
    return new CellEdit<T>({
      row: this.row,
      field: this.field,
      before: this.after,
      after: this.before,
    });
  }

  toString(): string {
    return `CellEdit(${this.field}: ${String(this.before)} -> ${String(this.after)})`;
  }
}

/**
 * One step of undo: everything a single user action changed.
 *
 * A paste over a range changes many cells and has to come back in one
 * keystroke, so the unit of history is the action and not the cell.
 */
export class EditAction<T> {
  /** What the user did, for an "Undo paste" menu item. */
  readonly label: string;

  readonly changes: readonly CellEdit<T>[];

  constructor(options: { label: string; changes: readonly CellEdit<T>[] }) {
    this.label = options.label;
    this.changes = options.changes;
    Object.freeze(this);
  }

  get isEmpty(): boolean {
    return this.changes.length === 0;
  }

  /** The action that undoes this one. */
  get inverse(): EditAction<T> {
    return new EditAction<T>({
      label: this.label,
      changes: [...this.changes].reverse().map((change) => change.inverse),
    });
  }

  toString(): string {
    return `EditAction(${this.label}, ${this.changes.length} cells)`;
  }
}

/**
 * A bounded undo/redo stack of {@link EditAction}s.
 *
 * Bounded because the alternative is a grid that holds every row it has ever
 * edited: at a few hundred cells per paste, an unbounded history over a
 * session is a leak with a user-visible cause and no user-visible symptom.
 */
export class EditHistory<T> {
  /** How many actions are kept. The oldest is dropped past this. */
  readonly limit: number;

  private readonly undoStack: EditAction<T>[] = [];
  private readonly redoStack: EditAction<T>[] = [];

  constructor(options: { limit?: number } = {}) {
    const limit = options.limit ?? 50;
    if (!(limit > 0)) {
      throw new GridArgumentError('An edit history limit must be positive.');
    }
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Labels of the actions that would be undone and redone next, for menu
   * items. Null when there is nothing to undo or redo.
   */
  get undoLabel(): string | null {
    return this.peekUndo()?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.peekRedo()?.label ?? null;
  }

  get length(): number {
    return this.undoStack.length;
  }

  /**
   * Records an action the user has just done, which clears the redo stack:
   * once they edit again, the future they undid is no longer reachable.
   */
  record(action: EditAction<T>): void {
    if (action.isEmpty) return;
    this.undoStack.push(action);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /**
   * The next action to undo, without moving it.
   *
   * Peeking is what lets a caller try to apply an action and only then commit
   * the move: {@link takeUndo} moved the action to the redo stack before
   * anyone knew whether it could be applied, so an undo that failed — a row
   * that could not be found — consumed the step anyway and the edit became
   * permanently unrepeatable.
   */
  peekUndo(): EditAction<T> | null {
    return this.undoStack.length === 0
      ? null
      : (this.undoStack[this.undoStack.length - 1] as EditAction<T>);
  }

  /** The next action to redo, without moving it. */
  peekRedo(): EditAction<T> | null {
    return this.redoStack.length === 0
      ? null
      : (this.redoStack[this.redoStack.length - 1] as EditAction<T>);
  }

  /** Moves the action {@link peekUndo} returned onto the redo stack. */
  commitUndo(): void {
    const action = this.undoStack.pop();
    if (action !== undefined) this.redoStack.push(action);
  }

  /** Moves the action {@link peekRedo} returned back onto the undo stack. */
  commitRedo(): void {
    const action = this.redoStack.pop();
    if (action !== undefined) this.undoStack.push(action);
  }

  /**
   * Takes the next action to undo, moving it to the redo stack.
   *
   * Prefer {@link peekUndo} with {@link commitUndo}: this moves the action
   * whether or not it can be applied.
   */
  takeUndo(): EditAction<T> | null {
    const action = this.undoStack.pop();
    if (action === undefined) return null;
    this.redoStack.push(action);
    return action;
  }

  /** Takes the next action to redo, moving it back to the undo stack. */
  takeRedo(): EditAction<T> | null {
    const action = this.redoStack.pop();
    if (action === undefined) return null;
    this.undoStack.push(action);
    return action;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

/**
 * What came of applying one {@link EditAction}.
 *
 * An undo is not a yes-or-no: the rows an action touched may be on another
 * page, inside a closed group or filtered out of view, and some of them may
 * be gone from the data altogether. An `undo()` returning a bare boolean
 * could not tell "nothing to undo" from "half of it was undone", which is how
 * a paste over two rows came to be half taken back with no way to finish the
 * job.
 */
export class ReplayOutcome {
  /** Cells written back. */
  readonly applied: number;

  /** Cells whose row could not be found, and which were therefore skipped. */
  readonly unresolved: number;

  constructor(options: { applied: number; unresolved: number }) {
    this.applied = options.applied;
    this.unresolved = options.unresolved;
    Object.freeze(this);
  }

  /** Nothing was applied, because there was nothing to apply. */
  static nothing(): ReplayOutcome {
    return new ReplayOutcome({ applied: 0, unresolved: 0 });
  }

  /** Whether every cell the action named was written. */
  get isComplete(): boolean {
    return this.unresolved === 0 && this.applied > 0;
  }

  /** Whether anything at all was written. */
  get didAnything(): boolean {
    return this.applied > 0;
  }

  toString(): string {
    return `ReplayOutcome(${this.applied} applied, ${this.unresolved} unresolved)`;
  }
}
