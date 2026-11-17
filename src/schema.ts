/**
 * Versioning for everything the engine serialises.
 *
 * @module
 */

import { GridFormatError } from './errors';

/**
 * The schema version this build writes.
 *
 * A saved view or a stored query is a user's work, kept outside the app and
 * read back by a later version of it. Stamping the format means a format
 * change can be migrated rather than silently misread — and that "their saved
 * layouts stopped working" is a thing that cannot happen quietly.
 */
export const GRID_SCHEMA_VERSION = 1;

/**
 * Key the version is stored under. Short, because it appears in every
 * document.
 */
export const GRID_SCHEMA_VERSION_KEY = 'v';

/** A serialised document: plain JSON, as written by `toJSON`. */
export type JsonMap = Record<string, unknown>;

/**
 * Reads and checks the version of a serialised `what`.
 *
 * A document with no version is treated as version 1: documents written
 * before versioning existed are valid version 1 documents, and refusing them
 * would break exactly the saved layouts this is meant to protect.
 *
 * Throws {@link GridFormatError} for a version this build does not
 * understand, which is a newer one. Failing loudly is the point: silently
 * reading a future format produces a grid arranged some way nobody asked for.
 */
export function requireSupportedSchema(json: JsonMap, what: string): number {
  const raw = json[GRID_SCHEMA_VERSION_KEY];
  if (raw === null || raw === undefined) return 1;
  const version =
    typeof raw === 'number' && Number.isInteger(raw)
      ? raw
      : parseVersion(String(raw));
  if (version === null) {
    throw new GridFormatError(
      `${what} has a malformed schema version: ${String(raw)}`,
    );
  }
  if (version > GRID_SCHEMA_VERSION) {
    throw new GridFormatError(
      `${what} was written by a newer version of datagrid-core (schema v${version}; ` +
        `this build understands up to v${GRID_SCHEMA_VERSION}).`,
    );
  }
  return version;
}

function parseVersion(text: string): number | null {
  if (!/^-?\d+$/.test(text.trim())) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
