/**
 * Turning a `CellDecoration` into pixels.
 *
 * Conditional formatting is decided in the engine — it holds the column
 * statistics, so it is the only side that knows where a value sits in its
 * column — and arrives as a tone, an intensity from 0 to 1, an optional bar
 * fraction and a weight. Choosing what those look like is the renderer's half
 * of the deal, and it is done in CSS so that light and dark can carry their
 * own steps rather than one being an automatic flip of the other.
 *
 * The tones map onto a reserved status palette (good, warning, serious,
 * critical) plus one sequential hue for magnitude, so a shade never has to be
 * read as an identity.
 */
import type { CSSProperties } from 'react';
import type { CellDecoration } from 'datagrid-core';

export interface DecorationProps {
  'data-tone'?: string;
  'data-bold'?: '' | undefined;
  style?: CSSProperties;
}

/** The attributes a decorated cell carries; the stylesheet does the rest. */
export function decorationProps(decoration: CellDecoration): DecorationProps {
  if (decoration.isEmpty) return {};
  const style = { '--intensity': decoration.intensity } as CSSProperties;
  return {
    // A bar already encodes the magnitude, so it does not also get a tint.
    'data-tone': decoration.bar == null && decoration.tone !== 'neutral' ? decoration.tone : undefined,
    'data-bold': decoration.bold ? '' : undefined,
    style,
  };
}

export function barProps(decoration: CellDecoration): { style: CSSProperties; tone: string } | null {
  if (decoration.bar == null) return null;
  return {
    tone: decoration.tone,
    style: { width: `${Math.max(1.5, decoration.bar * 100).toFixed(2)}%` },
  };
}
