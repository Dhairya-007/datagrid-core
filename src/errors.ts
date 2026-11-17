/**
 * The error types the engine throws.
 *
 * Named types rather than bare `Error`s so a caller can tell a programming
 * mistake (a column that does not exist) from bad input (a saved view written
 * by a newer build) with `instanceof` instead of by matching on a message.
 *
 * @module
 */

/** A call that cannot be satisfied in the engine's current state. */
export class GridStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridStateError';
  }
}

/** An argument that is outside what the engine accepts. */
export class GridArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridArgumentError';
  }
}

/** Serialised input the engine cannot read. */
export class GridFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridFormatError';
  }
}
