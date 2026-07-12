/**
 * engine/trees.ts - Oak-tree canopy geometry (GDD 9 trees).
 *
 * Pure geometry, no grid access: one shape function shared by the three places
 * a tree takes form so they can never drift apart -
 *   - simulation.growSapling (a growing tip matures -> tufts/crown appear),
 *   - worldgen.plantOak      (initial forests at mixed growth stages),
 *   - survivor.fellTree      (the clear box that removes a felled oak's crown).
 *
 * A tree is a TRUNK column of height `h` rooted on DIRT, topped at `topY`.
 * While GROWING (h < TREE_TRUNK_MAX) it carries side TUFTS - FOLIAGE flanking
 * the upper trunk, widening as the tree ages - and a SAPLING growing tip in
 * the cell above the trunk top (which the tuft shape must therefore never
 * fill). At FULL height it crowns: a wide oak canopy blob centred over the
 * trunk top, including the cells directly above it (nothing grows past a
 * crown).
 */

import { TREE_TRUNK_MAX } from '../config';

/** Horizontal tuft/crown reach for a trunk of height h (cells either side). */
export function canopyRadius(h: number): number {
  if (h >= TREE_TRUNK_MAX) return 3; // full crown
  if (h >= 6) return 2;
  return 1;
}

/** Widest canopy any oak ever grows - the felling clear box uses this. */
export const CANOPY_MAX_RADIUS = 3;
/** Rows a full crown extends above the trunk top (felling clear box). */
export const CANOPY_MAX_UP = 4;

/**
 * Enumerate the canopy cells for a trunk whose TOP cell is (x, topY) at height
 * h. Callers write FOLIAGE only into cells that are currently AIR - the shape
 * is advisory, never destructive. Cells may repeat across growth stages (the
 * canopy fills in as the tree ages); duplicates are harmless because writes
 * are idempotent.
 *
 * Growing (h < TREE_TRUNK_MAX): side tufts beside the top two trunk cells,
 * radius canopyRadius(h). The column x itself is NEVER emitted - the growing
 * tip (a SAPLING) lives at (x, topY - 1) and must not be overgrown.
 *
 * Full (h >= TREE_TRUNK_MAX): a rounded oak crown - an ellipse rx=3, ry=2
 * centred one row above the trunk top - including the on-column cells.
 */
export function forEachCanopyCell(
  x: number,
  topY: number,
  h: number,
  cb: (cx: number, cy: number) => void,
): void {
  if (h < 2) return; // a 1-cell sapling trunk has no foliage yet

  if (h >= TREE_TRUNK_MAX) {
    // Full crown: ellipse centred at (x, topY - 1), rx=3 / ry=2.
    const cy0 = topY - 1;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if ((dx * dx) / (3.3 * 3.3) + (dy * dy) / (2.3 * 2.3) > 1) continue;
        cb(x + dx, cy0 + dy);
      }
    }
    return;
  }

  // Growing: tufts flanking the top two trunk cells, never the tip column.
  const r = canopyRadius(h);
  for (let dy = 0; dy <= 1 && dy < h; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0) continue; // keep the growing-tip column clear
      if (Math.abs(dx) + dy > r + 1) continue; // taper the lower row
      cb(x + dx, topY + dy);
    }
  }
}
